/**
 * 真实工具的往返验证 —— FS Tools 与 shell。
 *
 * 与 `verify-tool-protocol.ts` 的分工：那边测**协议语义**（取消、超时、
 * 终态、错误码），这边测**工具真的能干那件事**。两者都会失败，但症状不同：
 * 协议错会表现为「取消是个摆设」，工具错会表现为「模型说写成功了其实没写」。
 *
 * ⚠️ 这些断言会**真的建目录、真的写文件、真的 spawn 进程**。
 * 全部落在受管根目录下一个带时间戳的临时子目录里，测完删掉——
 * 不能在真实工作目录里做这些测试，那样一次失败就留下垃圾给用户。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { cancelExecution, clearExecutions, runExecution } from '@/backstage/services/execution.service'
import { getSandbox } from '@/backstage/lib/config'
import { findTool } from '@/backstage/tools'

type Checker = {
  check: (name: string, fn: () => void | Promise<void>) => Promise<void>
  fail: (name: string, detail: string) => void
  skip: (name: string, reason: string) => void
}

type ToolOutput = Record<string, unknown>

/** 走协议跑一次工具，拿到终态。工具报错时抛出来，测试里好断言。 */
async function call(
  toolName: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number; executionId?: string } = {}
): Promise<ToolOutput> {
  const executor = findTool(toolName)
  if (!executor) throw new Error(`工具未注册：${toolName}`)
  const result = await runExecution({
    executionId: options.executionId ?? `exe_tools_${Math.random().toString(36).slice(2, 10)}`,
    toolName,
    workspaceId: 'workspace',
    timeoutMs: options.timeoutMs ?? 30_000,
    // runExecution 只给 { executionId, signal }；workspaceId 是协议层已经校验过的
    // 那一份，由调用方补进 ToolContext —— 与 gateway route 里的做法一致。
    work: ({ executionId, signal }) =>
      executor.execute(args, { workspaceId: 'workspace', executionId, signal }),
  })
  if (result.status !== 'ok') {
    // ⚠️ 报错必须带上参数：只说「read 失败」的话，一屏十几条断言里根本认不出
    //是哪条路径 —— 而这类失败的排查时间几乎全花在「到底是哪一个」上。
    throw new Error(`${toolName} ${JSON.stringify(args)} 失败：${result.error?.code} ${result.error?.message}`)
  }
  return result.output as ToolOutput
}

/**
 * 断言这次调用会失败，并返回错误文本。
 *
 * ⚠️ **不要写成 `try { 期待它抛 } catch {}`** —— 那样「期待的那次 throw」会被
 * 自己的 catch 吃掉，断言变成永远通过。这类假通过比失败更糟：它让后面所有
 * 依赖它的断言都建立在「它确实报错了」这个未经验证的假设上。
 */
async function expectFailure(run: () => Promise<unknown>): Promise<string> {
  let message = ''
  try {
    await run()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (message === '') throw new Error('本该失败的调用成功了 —— 后面的断言全建立在假前提上')
  return message
}

/** 从错误文本里抠出协议错误码。call() 的报错格式是固定的，所以能这么取。 */
function codeOf(message: string): string | undefined {
  return message.match(/失败：(\w+)/)?.[1] ?? message.match(/：(\w+)/)?.[1]
}

export async function runToolChecks(checker: Checker): Promise<void> {
  const sandbox = getSandbox()
  await sandbox.ensureRoots()
  // 带时间戳：万一上一次测试崩了没清理，也不会撞上残留目录被误认为「已存在」。
  const dir = `verify-tools-${Date.now().toString(36)}`
  const at = (name: string): string => (dir === '' ? name : `${dir}/${name}`)

  try {
    // ── FS Tools ──────────────────────────────────────────────
    await checker.check('mkdir → write → read 往返，路径被规范化成相对串', async () => {
      const created = await call('raven.files.mkdir', { path: at('a/b') })
      if (created.kind !== 'dir') throw new Error(`mkdir 应返回目录条目，实际 ${String(created.kind)}`)
      await call('raven.files.write', { path: at('a/b/note.txt'), text: '你好，世界' })
      const read = await call('raven.files.read', { path: at('a/b/note.txt') })
      if (read.text !== '你好，世界') throw new Error(`读回来是 ${JSON.stringify(read.text)}`)
      if (read.path !== at('a/b/note.txt')) {
        throw new Error(`path 应回显相对路径，实际 ${String(read.path)}`)
      }
    })

    await checker.check('write 是整体覆盖，不是追加', async () => {
      await call('raven.files.write', { path: at('a/b/note.txt'), text: '第二次' })
      const read = await call('raven.files.read', { path: at('a/b/note.txt') })
      if (read.text !== '第二次') throw new Error(`应只剩新内容，实际 ${JSON.stringify(read.text)}`)
    })

    await checker.check('createOnly 不会覆盖已有文件', async () => {
      // 关键在错误码：`exists` 必须映射成 invalid_input，
      // 否则会被说成「raven 崩了」，runtime 就会去反复重试。
      const message = await expectFailure(() =>
        call('raven.files.write', { path: at('a/b/note.txt'), text: 'x', createOnly: true })
      )
      if (codeOf(message) !== 'invalid_input') {
        throw new Error(`createOnly 冲突应是 invalid_input，实际：${message}`)
      }
      const unchanged = await call('raven.files.read', { path: at('a/b/note.txt') })
      if (unchanged.text !== '第二次') throw new Error('被拒的写入不该动原文件')
    })

    await checker.check('list 能看到刚写的文件', async () => {
      const listing = await call('raven.files.list', { path: dir })
      const entries = listing.entries as Array<{ name: string; kind: string }>
      // 只建过 `a/b` 这一条路径，所以根下应该正好一个 `a`。写成「期望 b」的话，
      // 以后有人调整了测试里的目录结构，这条断言会以「工具坏了」的形式误报。
      if (entries.length !== 1 || entries[0].name !== 'a' || entries[0].kind !== 'dir') {
        throw new Error(`list 结果不对：${JSON.stringify(entries)}`)
      }
    })

    await checker.check('move / copy / rename：默认都不覆盖', async () => {
      await call('raven.files.move', { from: at('a/b/note.txt'), to: at('a/moved.txt') })
      await call('raven.files.copy', { from: at('a/moved.txt'), to: at('a/copied.txt') })
      await call('raven.files.rename', { from: at('a/copied.txt'), to: at('a/renamed.txt') })
      for (const name of ['a/moved.txt', 'a/renamed.txt']) {
        const read = await call('raven.files.read', { path: at(name) })
        if (read.text !== '第二次') throw new Error(`${name} 内容不对`)
      }
      // 覆盖必须显式：漏写一个字段就吃掉目标文件是不能接受的后果。
      const refused = await expectFailure(() =>
        call('raven.files.move', { from: at('a/moved.txt'), to: at('a/renamed.txt') })
      )
      if (codeOf(refused) !== 'invalid_input') {
        throw new Error(`目标已存在应是 invalid_input，实际：${refused}`)
      }
      const still = await call('raven.files.read', { path: at('a/renamed.txt') })
      if (still.text !== '第二次') throw new Error('被拒绝的 move 不该动目标文件')
    })

    await checker.check('沙箱挡住 `..` 与绝对路径（工具层不重复判定，直接透出沙箱错误）', async () => {
      for (const bad of ['../escape.txt', '/etc/passwd']) {
        const message = await expectFailure(() => call('raven.files.write', { path: bad, text: 'x' }))
        const code = codeOf(message)
        if (code !== 'invalid_input' && code !== 'outside_root') {
          throw new Error(`${bad} 的错误码不对：${message}`)
        }
      }
    })

    await checker.check('remove 删掉整棵子树，且返回真实计数', async () => {
      const removed = await call('raven.files.remove', { paths: [at('a')] })
      // 算术：move 把 note.txt 挪上来、copy 复制一份、rename 只是改名 ——
      // 最后树里剩 2 个文件、2 个目录。写死 2 是故意的：count 算错（比如把
      // rename 也计成新增）会直接在这里露出来，而不是等到某次删除静默少删。
      if (removed.count !== 2) throw new Error(`应删掉 2 个文件，实际 ${String(removed.count)}`)
      // 只删了 `a`，外层那层 `dir` 理应还在（工具不该替调用方多删一层），
      // 所以这里查的是「`a` 没了」，不是「`dir` 没了」。
      const inside = await call('raven.files.list', { path: dir })
      const left = inside.entries as Array<{ name: string }>
      if (left.some((entry) => entry.name === 'a')) {
        throw new Error(`子树还在：${JSON.stringify(left)}`)
      }
    })

    await checker.check('remove 的任一路径不合法 → 整批都不删', async () => {
      await call('raven.files.write', { path: at('keep1.txt'), text: '1' })
      await call('raven.files.write', { path: at('keep2.txt'), text: '2' })
      const refused = await expectFailure(() =>
        call('raven.files.remove', { paths: [at('keep1.txt'), '../nope'] })
      )
      if (codeOf(refused) !== 'invalid_input') {
        throw new Error(`混入越界路径应是 invalid_input，实际：${refused}`)
      }
      for (const name of ['keep1.txt', 'keep2.txt']) {
        await call('raven.files.read', { path: at(name) })
      }
    })

    // ── shell ────────────────────────────────────────────────
    await checker.check('shell.exec：argv 直传不经shell，退出码与输出如实返回', async () => {
      const result = await call('raven.shell.exec', {
        command: 'node',
        args: ['-e', 'process.stdout.write("out:" + process.cwd())'],
      })
      if (result.exitCode !== 0) throw new ExitSignal(result)
      const printed = String(result.stdout)
      if (!printed.startsWith('out:')) throw new Error(`stdout 不对：${JSON.stringify(result.stdout)}`)
      // 比较 realpath：macOS 上 os.tmpdir() 给的是 /var/...，而 resolveExisting
      // 返回的一律是 /private/var/... —— 直接比字符串会得到一个莫名其妙的失败。
      const expected = await fsp.realpath(sandbox.filesRoot)
      if (printed.slice('out:'.length) !== expected) {
        throw new Error(`默认 cwd 应是 filesRoot ${expected}，实际 ${printed.slice(4)}`)
      }
    })

    await checker.check('shell.exec：退出码非 0 是结果，不是协议错误', async () => {
      // 这条最容易被写错：把 exitCode≠0 报成 error 会让 runtime 换参数重试，
      // 而它重试一万次也是同一个退出码。
      const result = await call('raven.shell.exec', {
        command: 'node',
        args: ['-e', 'process.stderr.write("boom"); process.exit(3)'],
      })
      if (result.exitCode !== 3) throw new Error(`应返回 exitCode 3，实际 ${String(result.exitCode)}`)
      if (String(result.stderr) !== 'boom') throw new Error(`stderr 不对：${JSON.stringify(result.stderr)}`)
    })

    await checker.check('shell.exec：cwd 生效且只能落在受管根内', async () => {
      await call('raven.files.mkdir', { path: at('sub') })
      const inside = await call('raven.shell.exec', {
        command: 'node',
        args: ['-e', 'process.stdout.write(process.cwd())'],
        cwd: at('sub'),
      })
      if (!String(inside.stdout).includes(at('sub'))) {
        throw new Error(`cwd 没生效：${String(inside.stdout)}`)
      }
      const escaped = await expectFailure(() =>
        call('raven.shell.exec', { command: 'ls', cwd: '../..' })
      )
      if (codeOf(escaped) !== 'invalid_input') {
        throw new Error(`cwd 越界应是 invalid_input，实际：${escaped}`)
      }
    })

    await checker.check('shell.exec：命令不存在 → not_found（而不是「raven 崩了」）', async () => {
      const message = await expectFailure(() =>
        call('raven.shell.exec', { command: 'definitely-not-a-real-binary-xyz' })
      )
      if (codeOf(message) !== 'not_found') {
        throw new Error(`命令不存在应是 not_found，实际：${message}`)
      }
    })

    await checker.check('shell.exec：取消真的刹住车（进程组被收掉，不是只改状态）', async () => {
      const executionId = 'exe_tools_cancel'
      const pending = runExecution({
        executionId,
        toolName: 'raven.shell.exec',
        workspaceId: 'workspace',
        timeoutMs: 60_000,
        work: ({ executionId: id, signal }) =>
          findTool('raven.shell.exec')!.execute(
            {
              command: 'node',
              // 子进程再拉一个孙进程：不杀进程组的话，孙进程会活下来继续跑。
              args: ['-e', 'setTimeout(() => {}, 60000); require("child_process").spawn("sleep", ["60"], {stdio:"ignore"})'],
            },
            { workspaceId: 'workspace', executionId: id, signal }
          ),
      })
      // 给它一点时间真的 spawn 出去，再取消 —— 否则测的是「取消比 spawn 还快」。
      await new Promise((resolve) => setTimeout(resolve, 300))
      cancelExecution(executionId)
      const result = await pending
      if (result.status !== 'cancelled') {
        throw new Error(`应为 cancelled，实际 ${result.status}（${result.error?.code ?? ''}）`)
      }
    })

    await checker.check('shell.exec：超时钉成 timeout', async () => {
      const started = Date.now()
      const result = await runExecution({
        executionId: 'exe_tools_timeout',
        toolName: 'raven.shell.exec',
        workspaceId: 'workspace',
        timeoutMs: 1000,
        work: ({ executionId: id, signal }) =>
          findTool('raven.shell.exec')!.execute(
            { command: 'node', args: ['-e', 'setTimeout(() => {}, 30000)'] },
            { workspaceId: 'workspace', executionId: id, signal }
          ),
      })
      if (result.status !== 'timeout') throw new Error(`应为 timeout，实际 ${result.status}`)
      // SIGTERM 的子进程正常退出很快；留 3 秒宽限是为了不误判超时机制失灵。
      if (Date.now() - started > 8000) throw new Error('超时收尾太慢，宽限定时器可能没被清')
    })
  } finally {
    clearExecutions()
    await fsp.rm(path.join(sandbox.filesRoot, dir), { recursive: true, force: true }).catch(() => {})
  }
}

/** 退出码不对时把整个结果摊开看 —— 只报 exitCode 等于让人自己再跑一遍。 */
class ExitSignal extends Error {
  constructor(result: ToolOutput) {
    super(`退出码 ${String(result.exitCode)}：${JSON.stringify({ stdout: result.stdout, stderr: result.stderr })}`)
  }
}