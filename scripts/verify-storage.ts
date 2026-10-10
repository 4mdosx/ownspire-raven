/**
 * 存储 / 剪切板 / 脚本运行三块的自检（`npm run verify:storage`）。
 *
 * ──────────────────────────────────────────────────────────────
 * 为什么是这个形状
 *
 * 1. `config/env.ts` 在**模块加载期**就把 dataDir 与 db 路径定下来，而
 *    `database.ts` 更是 import 时就 `resolveDbFile()`。所以环境变量必须在
 *    任何 raven 模块被 import 之前设好 —— 本文件顶层只 import node 内置模块，
 *    所有 raven 模块都在 `runStorageChecks()` 里动态 import。
 * 2. tsx 以 CJS 输出，静态路径不支持 top-level await，所以入口包在 `main()`。
 * 3. 这个文件同时被 `scripts/verify-raven.ts` 动态 import（它要
 *    `runStorageChecks(checker, { temp })`），也要能单跑。区别只在：
 *    **单跑时**自己去设 `RAVEN_DATA_DIR`/`RAVEN_DB_FILE`；被总入口 import 时
 *    绝不能覆盖 —— 总入口刻意让各段共享一份 DB/dataDir，覆盖会让后面的
 *    dashboard 段写进我这边马上要删掉的临时目录。
 * 4. `RAVEN_CONFIG` 两处都要换成本段的临时配置（根目录、64KiB 配额、
 *    maxItems=3 这些都是断言的前提），跑完恢复原值。
 * ──────────────────────────────────────────────────────────────
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 临时根与环境（必须早于任何 raven 模块的 import）
// ---------------------------------------------------------------------------

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-storage-'))
const storageRoot = path.join(tempRoot, 'root')
// 被总入口 import 时临时目录是它给的那个，所以这个路径是可重指的。
let configFile = path.join(tempRoot, 'storage.config.json')

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.env.RAVEN_DATA_DIR = path.join(tempRoot, 'data')
  process.env.RAVEN_DB_FILE = path.join(tempRoot, 'data', 'raven.db')
  process.env.RAVEN_CONFIG = configFile
  fs.mkdirSync(process.env.RAVEN_DATA_DIR, { recursive: true })
}

const QUOTA_BYTES = 64 * 1024
const MAX_ITEMS = 3
const MAX_TEXT_BYTES = 1024
const MAX_OUTPUT_BYTES = 4096
const RUN_TIMEOUT_MS = 60_000
/** 覆盖目标时的删除门禁上限：真实默认值由 file.service 导出，下面会断言。 */
const EXPECTED_DELETE_LIMIT = 1000

// ---------------------------------------------------------------------------
// 断言小工具（不引测试框架）
// ---------------------------------------------------------------------------

type Checker = {
  check: (name: string, fn: () => void | Promise<void>) => Promise<void>
  fail: (name: string, detail: string) => void
  skip?: (name: string, reason: string) => void
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

type Failure = { code: string; status: number; message: string }

async function catchFailure(work: () => Promise<unknown>): Promise<Failure> {
  try {
    await work()
  } catch (error) {
    const candidate = error as { code?: unknown; status?: unknown; message?: unknown }
    return {
      code: typeof candidate.code === 'string' ? candidate.code : '',
      status: typeof candidate.status === 'number' ? candidate.status : 0,
      message: typeof candidate.message === 'string' ? candidate.message : String(error),
    }
  }
  throw new Error('期望抛错，但调用成功返回了。')
}

async function expectFailure(expected: string, work: () => Promise<unknown>, status?: number): Promise<Failure> {
  const failure = await catchFailure(work)
  if (failure.code !== expected) {
    throw new Error(`期望错误码 ${expected}，实际 ${failure.code === '' ? '(没有 code)' : failure.code}：${failure.message}`)
  }
  if (status !== undefined && failure.status !== status) {
    throw new Error(`期望 HTTP ${status}，实际 ${failure.status}：${failure.message}`)
  }
  return failure
}

async function expectFailureOneOf(expected: string[], work: () => Promise<unknown>): Promise<Failure> {
  const failure = await catchFailure(work)
  if (!expected.includes(failure.code)) {
    throw new Error(`期望错误码 ${expected.join(' / ')} 之一，实际 ${failure.code === '' ? '(没有 code)' : failure.code}：${failure.message}`)
  }
  return failure
}

function webStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function repeatingStream(total: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024)
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close()
        return
      }
      const size = Math.min(chunk.length, total - sent)
      controller.enqueue(chunk.subarray(0, size))
      sent += size
    },
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 进程还活着吗？僵尸（Z）不算活着 —— 它已经不再写磁盘了。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return state !== '' && !state.startsWith('Z')
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 临时配置
// ---------------------------------------------------------------------------

function configBody(
  root: string,
  allowScriptExecution = true,
  quotaBytes: number | null = QUOTA_BYTES
): Record<string, unknown> {
  return {
    rootPath: root,
    workspace: {
      name: 'workspace',
      quotaBytes,
      allowScriptExecution,
      scriptsDir: 'scripts',
    },
    clipboard: { maxItems: MAX_ITEMS, maxTextBytes: MAX_TEXT_BYTES },
    auth: { sessionHours: 1 },
    scripts: {
      // 占位符展开是这里断言的一部分：`{workspace}` 必须变成真实路径。
      env: { VERIFY_GREETING: 'hi-{workspace}', VERIFY_ROOT: '{root}', VERIFY_UNKNOWN: '{nope}' },
      execution: { timeoutMs: RUN_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES, maxConcurrent: 2 },
      tempDir: 'tmp',
    },
    services: {
      collect: false,
      sampleIntervalSeconds: 30,
      defs: [{ id: 'fake', title: '假服务', baseUrl: 'http://127.0.0.1:9/' }],
    },
  }
}

/** 重写配置并强制改 mtime：getConfig() 是按 (file, mtimeMs) 缓存的。 */
function writeConfig(
  root: string,
  allowScriptExecution = true,
  bump = 1000,
  quotaBytes: number | null = QUOTA_BYTES
): void {
  fs.writeFileSync(
    configFile,
    JSON.stringify(configBody(root, allowScriptExecution, quotaBytes), null, 2),
    'utf8'
  )
  const future = new Date(Date.now() + bump)
  fs.utimesSync(configFile, future, future)
}

// ---------------------------------------------------------------------------
// 入口（给总入口用的导出）
// ---------------------------------------------------------------------------

/**
 * 跑完 storage 段。
 *
 * `options.temp` 是调用方给的临时目录（总入口传它自己那个），本段的沙箱根建在
 * 它下面的 `storage-root/`，退出时不留东西。
 */
export async function runStorageChecks(checker: Checker, options: { temp: string }): Promise<void> {
  const base = options.temp ?? tempRoot
  fs.mkdirSync(base, { recursive: true })
  const root = path.join(base, 'storage-root')
  fs.mkdirSync(root, { recursive: true })
  configFile = path.join(base, 'storage.config.json')
  writeConfig(root)

  const previousConfig = process.env.RAVEN_CONFIG
  process.env.RAVEN_CONFIG = configFile
  try {
    await runChecks(checker, root)
  } finally {
    if (previousConfig === undefined) delete process.env.RAVEN_CONFIG
    else process.env.RAVEN_CONFIG = previousConfig
  }
}

// ---------------------------------------------------------------------------
// 断言主体
// ---------------------------------------------------------------------------

async function runChecks(checker: Checker, root: string): Promise<void> {
  const fileService = await import('@/backstage/services/file.service')
  const clipboardService = await import('@/backstage/services/clipboard.service')
  const runner = await import('@/backstage/services/runner.service')
  const { getConfig } = await import('@/backstage/lib/config')
  const { createSseStream } = await import('@/backstage/lib/sse')

  const { sandbox } = getConfig()
  const workspace = sandbox.filesRoot
  const scriptsRoot = sandbox.scriptsRoot
  const clipboardRoot = sandbox.clipboardRoot
  const runTempRoot = sandbox.tempRoot
  await sandbox.ensureRoots()

  // 一个真正在沙箱之外、且不属于受管树任何一段的目录：软链逃逸用例的目标。
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret', 'utf8')

  try {
    // ----------------------------------------------------------------- 路径
    await checker.check('沙箱根就绪：filesRoot / scriptsRoot / clipboardRoot 都在受管根内', async () => {
      assert(fs.existsSync(workspace), `filesRoot 不存在：${workspace}`)
      assert(fs.existsSync(scriptsRoot), `scriptsRoot 不存在：${scriptsRoot}`)
      assert(fs.existsSync(clipboardRoot), `clipboardRoot 不存在：${clipboardRoot}`)
      assert(workspace.startsWith(root), `${workspace} 不在 ${root} 下`)
    })

    for (const bad of ['../x', '/etc/passwd', 'a/../../b']) {
      await checker.check(`路径穿越被拒：${bad}`, async () => {
        await expectFailureOneOf(['invalid_path', 'outside_root'], () => fileService.listDirectory({ path: bad }))
      })
    }

    await checker.check('路径穿越：软链指向树外（link/../../x 与 link 本身）一律被拒', async () => {
      fs.symlinkSync(outside, path.join(workspace, 'link'))
      await expectFailureOneOf(['invalid_path', 'outside_root'], () => fileService.listDirectory({ path: 'link/../../x' }))
      await expectFailureOneOf(['outside_root', 'invalid_path'], () => fileService.listDirectory({ path: 'link' }))
      await expectFailureOneOf(['outside_root', 'invalid_path'], () => fileService.readTextFile({ path: 'link/secret.txt' }))
      await expectFailureOneOf(['outside_root', 'invalid_path'], () =>
        fileService.upload({ path: 'link/evil.txt', stream: webStream('x') })
      )
      await expectFailureOneOf(['outside_root', 'invalid_path'], () =>
        fileService.writeTextFile({ path: 'link/evil.txt', text: 'x' })
      )
      await expectFailureOneOf(['outside_root', 'invalid_path'], () => fileService.createDirectory({ path: 'link/sub' }))
      assert(!fs.existsSync(path.join(outside, 'evil.txt')), '越界写不该在树外留下文件')
    })

    await checker.check('软链：指向树内的软链仍可读，且 linkInside 为 true', async () => {
      fs.writeFileSync(path.join(workspace, 'target.txt'), 'inner', 'utf8')
      fs.symlinkSync(path.join(workspace, 'target.txt'), path.join(workspace, 'inner-link.txt'))
      const read = await fileService.readTextFile({ path: 'inner-link.txt' })
      assert(read.text === 'inner', read.text)
      const listing = await fileService.listDirectory({ path: '' })
      const entry = listing.entries.find((item) => item.name === 'inner-link.txt')
      assert(entry?.kind === 'symlink', `kind=${entry?.kind}`)
      assert(entry.linkInside === true, `linkInside=${String(entry.linkInside)}`)
      const outsideEntry = listing.entries.find((item) => item.name === 'link')
      assert(outsideEntry?.kind === 'symlink' && outsideEntry.linkInside === false, '指向树外的软链应标记 linkInside=false')
    })

    // ------------------------------------------------------------- 列目录
    await fileService.createDirectory({ path: 'docs' })
    await fileService.writeTextFile({ path: 'docs/a.txt', text: 'aaa' })
    await fileService.writeTextFile({ path: 'docs/b.txt', text: 'bbbbbb' })
    await fileService.writeTextFile({ path: 'docs/zz.dat', text: 'z' })
    await fileService.writeTextFile({ path: 'root.txt', text: 'r' })

    await checker.check('列目录：根目录 path/parent 与条目形状（kind/size/mime/editable）', async () => {
      const listing = await fileService.listDirectory({ path: '' })
      assert(listing.path === '', `path=${listing.path}`)
      assert(listing.parent === null, `parent=${String(listing.parent)}`)
      const docs = listing.entries.find((item) => item.name === 'docs')
      assert(docs?.kind === 'dir', `docs.kind=${docs?.kind}`)
      assert(docs.size === 0, `目录 size 应为 0，实际 ${docs.size}`)
      assert(docs.extension === '' && docs.mime === '', '目录的 extension/mime 应为空')
      const rootTxt = listing.entries.find((item) => item.name === 'root.txt')
      assert(rootTxt?.kind === 'file', `root.txt.kind=${rootTxt?.kind}`)
      assert(rootTxt.extension === 'txt', `extension=${rootTxt.extension}`)
      assert(rootTxt.mime.startsWith('text/plain'), `mime=${rootTxt.mime}`)
      assert(rootTxt.editable === true, '文本小文件应可编辑')
      assert(rootTxt.path === 'root.txt', `path=${rootTxt.path}`)
      assert(rootTxt.size === 1, `size=${rootTxt.size}`)
    })

    await checker.check('列目录：子目录的 parent 是根（不是 "."）', async () => {
      const listing = await fileService.listDirectory({ path: 'docs' })
      assert(listing.path === 'docs', `path=${listing.path}`)
      assert(listing.parent === '', `parent=${JSON.stringify(listing.parent)}`)
      assert(listing.entries.length === 3, `条目数=${listing.entries.length}`)
    })

    await checker.check('列目录：search 按名字子串过滤，且大小写不敏感', async () => {
      const listing = await fileService.listDirectory({ path: 'docs', search: 'A.T' })
      const names = listing.entries.map((item) => item.name)
      assert(names.length === 1 && names[0] === 'a.txt', `命中=${names.join(',')}`)
    })

    await checker.check('列目录：sort=size desc / sort=name asc 顺序正确', async () => {
      const bySize = await fileService.listDirectory({ path: 'docs', sort: 'size', order: 'desc' })
      const sizes = bySize.entries.map((item) => item.size)
      assert(
        sizes.every((value, index) => index === 0 || sizes[index - 1] >= value),
        `size 降序失败：${sizes.join(',')}`
      )
      const byName = await fileService.listDirectory({ path: 'docs', sort: 'name', order: 'asc' })
      const names = byName.entries.map((item) => item.name).join(',')
      assert(names === 'a.txt,b.txt,zz.dat', `name 升序失败：${names}`)
      const byMtime = await fileService.listDirectory({ path: 'docs', sort: 'mtime', order: 'asc' })
      assert(byMtime.entries.length === 3, '按 mtime 排序应返回同样多的条目')
    })

    // --------------------------------------------------------------- 上传
    await checker.check('上传：字节数按真实写入计，内容与磁盘一致', async () => {
      const content = '你好，raven'
      const expected = Buffer.byteLength(content, 'utf8')
      const result = await fileService.upload({
        path: 'docs/up.txt',
        stream: webStream(content),
        expectedBytes: expected,
      })
      assert(result.bytes === expected, `bytes=${result.bytes}，期望 ${expected}`)
      assert(result.entry.size === expected, `entry.size=${result.entry.size}`)
      assert(result.entry.path === 'docs/up.txt', `entry.path=${result.entry.path}`)
      const read = await fileService.readTextFile({ path: 'docs/up.txt' })
      assert(read.text === content, `内容不一致：${read.text}`)
    })

    await checker.check('上传：目标已存在 → 409 exists；overwrite=1 才覆盖', async () => {
      const failure = await expectFailure('exists', () => fileService.upload({ path: 'docs/up.txt', stream: webStream('x') }), 409)
      assert(/已存在/.test(failure.message), `文案里应说清冲突：${failure.message}`)
      const replaced = await fileService.upload({
        path: 'docs/up.txt',
        stream: webStream('覆盖后的内容'),
        overwrite: true,
      })
      assert(replaced.bytes === Buffer.byteLength('覆盖后的内容'), `bytes=${replaced.bytes}`)
      const read = await fileService.readTextFile({ path: 'docs/up.txt' })
      assert(read.text === '覆盖后的内容', read.text)
    })

    await checker.check('上传：写入过程中超配额 → 507 且不残留 .part、不产生目标文件', async () => {
      await expectFailure(
        'quota_exceeded',
        () => fileService.upload({ path: 'docs/big.bin', stream: webStream('x'.repeat(96 * 1024)) }),
        507
      )
      assert(!fs.existsSync(path.join(workspace, 'docs', 'big.bin')), '超配额的文件不该出现在最终位置')
      const leftovers = fs
        .readdirSync(path.join(workspace, 'docs'))
        .filter((name) => name.includes('.part'))
      assert(leftovers.length === 0, `残留 .part 文件：${leftovers.join(',')}`)
    })

    await checker.check('上传：expectedBytes 提前超限也在开始前被拒（不落盘）', async () => {
      await expectFailure(
        'quota_exceeded',
        () => fileService.upload({ path: 'docs/never.bin', stream: webStream('tiny'), expectedBytes: 10 * 1024 * 1024 }),
        507
      )
      assert(!fs.existsSync(path.join(workspace, 'docs', 'never.bin')), '被拒的上传不该落盘')
    })

    await checker.check('配额：失败后预留量已归还，remainingBytes 与用量对得上', async () => {
      const summary = await fileService.stats()
      assert(summary.quotaBytes === QUOTA_BYTES, `quotaBytes=${String(summary.quotaBytes)}`)
      assert(summary.filesRoot === workspace, `filesRoot=${summary.filesRoot}`)
      assert(summary.bytes > 0, `bytes=${summary.bytes}`)
      assert(summary.remainingBytes === QUOTA_BYTES - summary.bytes, `remaining=${String(summary.remainingBytes)} bytes=${summary.bytes}`)
      assert(summary.usedRatio !== null && summary.usedRatio >= 0 && summary.usedRatio <= 1, `usedRatio=${String(summary.usedRatio)}`)
      assert(summary.files > 0 && summary.dirs > 0, `files=${summary.files} dirs=${summary.dirs}`)
    })

    await checker.check('配额：释放之后小文件仍能正常上传', async () => {
      const result = await fileService.upload({ path: 'docs/after.txt', stream: webStream('ok') })
      assert(result.bytes === 2, `bytes=${result.bytes}`)
    })

    // ----------------------------------------------------------- 文本读写
    await checker.check('文本：写入/读回往返一致，size 是字节数', async () => {
      const text = '第一行\n第二行'
      const entry = await fileService.writeTextFile({ path: 'docs/round.txt', text })
      assert(entry.size === Buffer.byteLength(text, 'utf8'), `size=${entry.size}`)
      const read = await fileService.readTextFile({ path: 'docs/round.txt' })
      assert(read.text === text, `内容不一致：${read.text}`)
      assert(read.size === Buffer.byteLength(text, 'utf8'), `size=${read.size}`)
      assert(read.encoding === 'utf8' && read.truncated === false, `encoding=${read.encoding} truncated=${read.truncated}`)
    })

    await checker.check('文本：createOnly 撞已有文件 → 409', async () => {
      await expectFailure('exists', () => fileService.writeTextFile({ path: 'docs/round.txt', text: 'x', createOnly: true }), 409)
    })

    await checker.check('文本：maxBytes 截断并置 truncated（不假装读全了）', async () => {
      const read = await fileService.readTextFile({ path: 'docs/round.txt', maxBytes: 5 })
      assert(read.truncated === true, 'truncated 应为 true')
      assert(read.size === Buffer.byteLength('第一行\n第二行', 'utf8'), `size=${read.size}`)
      // 截断点是**字节**，切在汉字中间时解码会补一个 U+FFFD（3 字节），
      // 所以只能断言「没读到后面的内容」，不能断言字节数 ≤ maxBytes。
      assert(read.text.startsWith('第'), `前缀不对：${read.text}`)
      assert(!read.text.includes('二'), `不该读到后面的内容：${read.text}`)
    })

    // ------------------------------------------------------- 改名/复制/移动
    await checker.check('改名：内容保留；目标已存在 → 409（不静默覆盖）', async () => {
      const entry = await fileService.rename({ from: 'docs/a.txt', to: 'docs/a-renamed.txt' })
      assert(entry.name === 'a-renamed.txt' && entry.path === 'docs/a-renamed.txt', `entry=${entry.path}`)
      assert((await fileService.readTextFile({ path: 'docs/a-renamed.txt' })).text === 'aaa', '内容应保留')
      await expectFailure('exists', () => fileService.rename({ from: 'docs/a-renamed.txt', to: 'docs/b.txt' }), 409)
      assert((await fileService.readTextFile({ path: 'docs/b.txt' })).text === 'bbbbbb', '目标不该被吃掉')
    })

    await checker.check('复制：新位置内容一致、源还在；无 overwrite 时 409，有则覆盖', async () => {
      const entry = await fileService.copy({ from: 'docs/a-renamed.txt', to: 'copies/a.txt' })
      assert(entry.path === 'copies/a.txt', `path=${entry.path}`)
      assert((await fileService.readTextFile({ path: 'docs/a-renamed.txt' })).text === 'aaa', '源文件应保留')
      await expectFailure('exists', () => fileService.copy({ from: 'docs/a-renamed.txt', to: 'copies/a.txt' }), 409)
      await fileService.copy({ from: 'docs/round.txt', to: 'copies/a.txt', overwrite: true })
      assert((await fileService.readTextFile({ path: 'copies/a.txt' })).text.startsWith('第一行'), '覆盖后应是新内容')
    })

    await checker.check('移动：跨目录移动、覆盖已存在目标、拒绝移动到自己里面', async () => {
      const entry = await fileService.move({ from: 'copies/a.txt', to: 'docs/moved.txt' })
      assert(entry.name === 'moved.txt', `name=${entry.name}`)
      assert(!fs.existsSync(path.join(workspace, 'copies', 'a.txt')), '移动后源不该还在')
      await expectFailure('exists', () => fileService.move({ from: 'docs/moved.txt', to: 'docs/b.txt' }), 409)
      await fileService.move({ from: 'docs/moved.txt', to: 'docs/b.txt', overwrite: true })
      assert((await fileService.readTextFile({ path: 'docs/b.txt' })).text.startsWith('第一行'), '覆盖后应是移动过来的内容')
      await fileService.createDirectory({ path: 'nest' })
      await expectFailure('invalid_path', () => fileService.move({ from: 'nest', to: 'nest/inner' }), 400)
    })

    // --------------------------------------------------------------- 删除
    await checker.check('删除：目录按递归统计给回执（count / bytes / kind）', async () => {
      await fileService.createDirectory({ path: 'trash' })
      await fileService.createDirectory({ path: 'trash/sub' })
      await fileService.writeTextFile({ path: 'trash/one.txt', text: '111' })
      await fileService.writeTextFile({ path: 'trash/sub/two.txt', text: '2222' })
      await fileService.writeTextFile({ path: 'trash/sub/three.txt', text: '3' })
      const receipt = await fileService.remove({ paths: ['trash'] })
      assert(receipt.count === 3, `count=${receipt.count}`)
      assert(receipt.removed.length === 1, `removed 条数=${receipt.removed.length}`)
      assert(receipt.removed[0].kind === 'dir' && receipt.removed[0].path === 'trash', JSON.stringify(receipt.removed[0]))
      assert(receipt.removed[0].bytes === 8, `bytes=${receipt.removed[0].bytes}`)
      assert(!fs.existsSync(path.join(workspace, 'trash')), '目录应被删掉')
    })

    await checker.check("删除：拒绝删除工作目录本身（path: ''）", async () => {
      await expectFailure('invalid_path', () => fileService.remove({ paths: [''] }), 400)
      assert(fs.existsSync(workspace), '工作目录必须还在')
    })

    await checker.check('删除门禁：默认上限常量为 1000', async () => {
      assert(
        fileService.MAX_DELETE_FILES === EXPECTED_DELETE_LIMIT,
        `MAX_DELETE_FILES=${fileService.MAX_DELETE_FILES}，期望 ${EXPECTED_DELETE_LIMIT}`
      )
    })

    await checker.check('删除门禁：单请求超过 1000 个文件被拒，且一个文件都不动', async () => {
      const bulk = path.join(workspace, 'bulk')
      await fs.promises.mkdir(bulk, { recursive: true })
      const total = EXPECTED_DELETE_LIMIT + 5
      // 分批并发：一次性开 1005 个 fd 会撞 EMFILE，而这个上限与断言无关。
      for (let start = 0; start < total; start += 50) {
        const batch = Math.min(50, total - start)
        await Promise.all(
          Array.from({ length: batch }, (_, index) =>
            fs.promises.writeFile(path.join(bulk, `f${String(start + index).padStart(4, '0')}.txt`), '')
          )
        )
      }
      const failure = await expectFailure('too_many_files', () => fileService.remove({ paths: ['bulk'] }), 400)
      assert(/1005/.test(failure.message), `拒绝原因里应带上数量：${failure.message}`)
      assert(fs.readdirSync(bulk).length === total, '被拒的删除不该动任何文件')
      await fs.promises.rm(bulk, { recursive: true, force: true })
    })

    // ------------------------------------------------------------ 剪切板
    await checker.check('剪切板：插入即入队，position=1 是最新，list 顺序正确', async () => {
      await clipboardService.clear()
      const first = await clipboardService.createText({ text: '第一条' })
      const second = await clipboardService.createText({ text: '第二条' })
      // 创建时它确实是最新的那条。注意 `first.entry.position` 是**创建那一刻**的
      // 快照（那时它也是 1），位置要看新查询的结果，别拿旧对象比。
      assert(second.entry.position === 1, `新条目的 position=${second.entry.position}`)
      const listing = await clipboardService.list({})
      assert(listing.entries[0].id === second.entry.id, '队首应是最新插入的')
      assert(listing.entries[1].id === first.entry.id, '队尾应是最早插入的')
      assert(listing.total === 2, `total=${listing.total}`)
      assert(listing.maxItems === MAX_ITEMS, `maxItems=${listing.maxItems}`)
      assert(listing.entries[0].position === 1 && listing.entries[1].position === 2, '位置应连续')
    })

    await checker.check('剪切板：idemKey 重发不产生第二条，也不改变队列顺序', async () => {
      await clipboardService.clear()
      const first = await clipboardService.createText({ text: '一', idemKey: 'k1' })
      await clipboardService.createText({ text: '二' })
      const again = await clipboardService.createText({ text: '一', idemKey: 'k1' })
      assert(again.entry.id === first.entry.id, '同一个 idemKey 应返回原来那条')
      assert(again.evicted.length === 0, '重发不该淘汰任何东西')
      const listing = await clipboardService.list({})
      assert(listing.total === 2, `total=${listing.total}`)
    })

    await checker.check('剪切板：超长文本被拒（413 text_too_large），不截断、不入队', async () => {
      await clipboardService.clear()
      await clipboardService.createText({ text: 'x'.repeat(MAX_TEXT_BYTES) })
      await expectFailure('text_too_large', () => clipboardService.createText({ text: 'y'.repeat(MAX_TEXT_BYTES + 1) }), 413)
      const listing = await clipboardService.list({})
      assert(listing.total === 1, `被拒的文本不该入队：total=${listing.total}`)
      assert(listing.entries[0].text.length === MAX_TEXT_BYTES, '已有条目不该被改写')
    })

    await checker.check('剪切板：空文本被拒；有附件时空文本可以', async () => {
      await clipboardService.clear()
      await expectFailure('empty_text', () => clipboardService.createText({ text: '' }), 400)
      const withAttachment = await clipboardService.createWithAttachments({
        text: '',
        attachments: [{ name: 'a.txt', stream: webStream('a') }],
      })
      assert(withAttachment.entry.text === '', `text=${withAttachment.entry.text}`)
      assert(withAttachment.entry.attachments.length === 1, '应有一条附件')
    })

    await checker.check('剪切板：附件名消毒（路径分隔符 / .. / 前导点 / 空名）', async () => {
      await clipboardService.clear()
      const created = await clipboardService.createWithAttachments({
        text: '消毒',
        attachments: [
          { name: '../../etc/passwd', stream: webStream('evil') },
          { name: '.hidden', stream: webStream('h') },
          { name: 'C:\\windows\\evil.txt', stream: webStream('w') },
          { name: '', stream: webStream('anon') },
        ],
      })
      const names = created.entry.attachments.map((item) => item.name)
      assert(names[0] === 'passwd', `names=${JSON.stringify(names)}`)
      assert(names[1] === 'hidden', `names=${JSON.stringify(names)}`)
      assert(names[2] === 'evil.txt', `names=${JSON.stringify(names)}`)
      assert(names[3] === 'attachment-4', `names=${JSON.stringify(names)}`)
      assert(created.entry.attachBytes === 4 + 1 + 1 + 4, `attachBytes=${created.entry.attachBytes}`)
      const dir = path.join(clipboardRoot, created.entry.id)
      assert(fs.existsSync(dir), `附件目录应存在：${dir}`)
      assert(fs.readdirSync(dir).length === 4, `附件目录里应有 4 个文件：${fs.readdirSync(dir).join(',')}`)
      const absolute = await clipboardService.clipboardAttachmentPath(created.entry.id, 'passwd')
      // 服务层返回的是 realpath（macOS 上 /var → /private/var），比之前先归一。
      assert(absolute.startsWith(`${fs.realpathSync(clipboardRoot)}${path.sep}`), `附件路径越界：${absolute}`)
      assert(fs.readFileSync(absolute, 'utf8') === 'evil', '附件内容应是上传的字节')
    })

    await checker.check('剪切板：附件名不在清单里 / 含路径分隔符 / 非法 id 都被拒', async () => {
      const listing = await clipboardService.list({})
      const entry = listing.entries[0]
      await expectFailure('not_found', () => clipboardService.clipboardAttachmentPath(entry.id, 'nope.txt'), 404)
      await expectFailure('invalid_path', () => clipboardService.clipboardAttachmentPath(entry.id, '../passwd'), 400)
      await expectFailure('invalid_path', () => clipboardService.clipboardAttachmentPath('../etc', 'passwd'), 400)
      await expectFailure('not_found', () => clipboardService.clipboardAttachmentPath('0'.repeat(26), 'passwd'), 404)
    })

    await checker.check('剪切板：32MiB 附件上限（常量 + 超限回滚，不留目录）', async () => {
      assert(
        clipboardService.MAX_ATTACHMENT_BYTES === 32 * 1024 * 1024,
        `MAX_ATTACHMENT_BYTES=${clipboardService.MAX_ATTACHMENT_BYTES}`
      )
      const before = fs.readdirSync(clipboardRoot).length
      // ⚠️ 单条上限与受管根配额是**两个**约束，而本段的配额只有 64KiB：
      // 不放开的话 32MiB 的写入会在第一块就撞 `quota_exceeded`（磁盘确实不够，
      // 那也是对的），这条断言就永远验不到它想验的东西。配额语义由本段另外
      // 几条断言覆盖，这里只验「产品上限自己会拦住」。
      writeConfig(root, true, 2000, null)
      try {
        await expectFailure(
          'attachments_too_large',
          () =>
            clipboardService.createWithAttachments({
              text: '',
              attachments: [{ name: 'huge.bin', stream: repeatingStream(33 * 1024 * 1024) }],
            }),
          413
        )
        assert(fs.readdirSync(clipboardRoot).length === before, '超限的粘贴不该留下附件目录')
      } finally {
        writeConfig(root, true, 3000)
      }
    })

    await checker.check('剪切板：超过 maxItems 从队尾淘汰，并删掉被淘汰那条的附件目录', async () => {
      await clipboardService.clear()
      const victim = await clipboardService.createWithAttachments({
        text: '待淘汰',
        attachments: [{ name: 'v.txt', stream: webStream('v') }],
      })
      const victimDir = path.join(clipboardRoot, victim.entry.id)
      assert(fs.existsSync(victimDir), '附件目录应已落盘')
      await clipboardService.createText({ text: '填充一' })
      await clipboardService.createText({ text: '填充二' })
      const created = await clipboardService.createText({ text: '压垮骆驼的第四条' })
      assert(created.evicted.includes(victim.entry.id), `evicted=${JSON.stringify(created.evicted)}`)
      assert(!fs.existsSync(victimDir), '被淘汰的附件目录应被删掉')
      await expectFailure('not_found', () => clipboardService.clipboardAttachmentPath(victim.entry.id, 'v.txt'), 404)
      const listing = await clipboardService.list({})
      assert(listing.total === MAX_ITEMS, `淘汰后队列长度=${listing.total}`)
      assert(listing.entries[0].id === created.entry.id, '新条目应在队首')
    })

    await checker.check('剪切板：纠错只改文本与字节数，不动队列位置', async () => {
      await clipboardService.clear()
      const first = await clipboardService.createText({ text: '111' })
      await clipboardService.createText({ text: '222' })
      const updated = await clipboardService.updateText(first.entry.id, '111111')
      assert(updated.text === '111111', `text=${updated.text}`)
      assert(updated.bytes === 6, `bytes=${updated.bytes}`)
      assert(updated.position === 2, `纠错后 position=${updated.position}`)
      const listing = await clipboardService.list({})
      assert(listing.entries[1].text === '111111', '纠错后仍在队尾')
      await expectFailure('empty_text', () => clipboardService.updateText(first.entry.id, ''), 400)
    })

    await checker.check('剪切板：remove 连附件目录一起删；clear 清空队列与目录', async () => {
      await clipboardService.clear()
      const created = await clipboardService.createWithAttachments({
        text: 'x',
        attachments: [{ name: 'a.txt', stream: webStream('a') }],
      })
      const dir = path.join(clipboardRoot, created.entry.id)
      assert(fs.existsSync(dir), '附件目录应存在')
      const removed = await clipboardService.remove(created.entry.id)
      assert(removed.removed === true, 'remove 应报告删掉了')
      assert(!fs.existsSync(dir), '附件目录应随条目删除')
      await clipboardService.createText({ text: 'y' })
      const cleared = await clipboardService.clear()
      assert(cleared.removed === 1, `clear removed=${cleared.removed}`)
      assert((await clipboardService.list({})).total === 0, '清空后队列应为空')
      assert(fs.readdirSync(clipboardRoot).length === 0, '清空后不该留下附件目录')
    })

    await checker.check('剪切板：list 的 limit/offset/q 生效', async () => {
      await clipboardService.clear()
      await clipboardService.createText({ text: '苹果' })
      await clipboardService.createText({ text: '香蕉' })
      await clipboardService.createText({ text: '苹果派' })
      const page = await clipboardService.list({ limit: 2, offset: 1 })
      assert(page.entries.length === 2, `entries=${page.entries.length}`)
      assert(page.entries[0].position === 2, `分页后 position=${page.entries[0].position}`)
      const filtered = await clipboardService.list({ query: '苹果' })
      assert(filtered.entries.length === 2, `命中=${filtered.entries.length}`)
      assert(filtered.total === 3, `total 应是队列总长：${filtered.total}`)
    })

    // ----------------------------------------------------------- SSE 形状
    await checker.check('SSE：响应头、事件帧、work 抛错 → HTTP 200 + error 事件', async () => {
      const response = createSseStream(async (emit) => {
        emit.start({ script: 'x.mjs', startedAt: 1, origin: 'workspace' })
        emit.stdout('hello')
        emit.metrics([{ metric: 'm', value: 1, unit: 'B' }])
        emit.done({
          status: 'ok',
          exitCode: 0,
          signal: '',
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
          stdout: 'hello',
          stderr: '',
          truncated: false,
          recordId: 1,
        })
      })
      assert(response.headers.get('content-type') === 'text/event-stream; charset=utf-8', `content-type=${response.headers.get('content-type')}`)
      assert(response.headers.get('cache-control') === 'no-cache, no-transform', `cache-control=${response.headers.get('cache-control')}`)
      assert(response.headers.get('x-accel-buffering') === 'no', `x-accel-buffering=${response.headers.get('x-accel-buffering')}`)
      const text = await response.text()
      assert(text.includes('event: start\n'), text.slice(0, 120))
      assert(text.includes('event: stdout\ndata: {"chunk":"hello"}\n\n'), text.slice(0, 200))
      assert(text.includes('event: metrics\ndata: {"items":[{"metric":"m","value":1,"unit":"B"}]}'), text.slice(0, 240))
      assert(text.includes('event: done\n'), text.slice(0, 240))

      const failing = createSseStream(async () => {
        throw new Error('故意炸一次')
      })
      assert(failing.status === 200, `错误流的状态码=${failing.status}`)
      const failingText = await failing.text()
      assert(
        failingText.includes('event: error\ndata: {"code":"internal_error","error":"故意炸一次"}'),
        failingText
      )
    })

    // --------------------------------------------------------- 响应头编码
    await checker.check('Content-Disposition：中文名走 RFC 5987，且 CR/LF 被剔除', async () => {
      const header = fileService.contentDisposition('报表 2026.csv', 'attachment')
      assert(header.startsWith('attachment; filename='), header)
      assert(header.includes("filename*=UTF-8''"), `缺少 filename*：${header}`)
      assert(header.includes(encodeURIComponent('报表 2026.csv')), `编码不对：${header}`)
      const injected = fileService.contentDisposition('bad\r\nX-Evil: 1.txt', 'inline')
      assert(!/[\r\n]/.test(injected), `响应头里不该有换行：${JSON.stringify(injected)}`)
      assert(injected.startsWith('inline; '), injected)
    })

    // ------------------------------------------------------------ 脚本运行
    fs.writeFileSync(
      path.join(scriptsRoot, 'ok.mjs'),
      [
        '// 示例：验证用脚本',
        "import fs from 'node:fs'",
        "console.log('ENV:' + JSON.stringify({",
        '  workspace: process.env.RAVEN_WORKSPACE,',
        '  uploads: process.env.RAVEN_UPLOADS,',
        "  uploadsExists: fs.existsSync(process.env.RAVEN_UPLOADS ?? ''),",
        '  root: process.env.RAVEN_ROOT,',
        '  scripts: process.env.RAVEN_SCRIPTS,',
        '  clipboard: process.env.RAVEN_CLIPBOARD,',
        '  tmp: process.env.RAVEN_TMPDIR,',
        "  tmpExists: fs.existsSync(process.env.RAVEN_TMPDIR ?? ''),",
        '  args: process.env.RAVEN_SCRIPT_ARGS,',
        '  name: process.env.RAVEN_SCRIPT_NAME,',
        '  greeting: process.env.VERIFY_GREETING,',
        '  unknown: process.env.VERIFY_UNKNOWN,',
        '  api: process.env.RAVEN_API,',
        '  runId: process.env.RAVEN_RUN_ID,',
        '}))',
        "console.log('RTOKEN:' + (process.env.RAVEN_TOKEN ?? ''))",
        "console.log('CWD:' + process.cwd())",
        "console.log('done')",
        '',
      ].join('\n'),
      'utf8'
    )
    fs.writeFileSync(path.join(scriptsRoot, 'fail.mjs'), 'process.exit(3)\n', 'utf8')
    fs.writeFileSync(
      path.join(scriptsRoot, 'sleep.mjs'),
      [
        "import { spawn } from 'node:child_process'",
        "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })",
        "console.log('GRANDCHILD:' + String(grandchild.pid))",
        'setTimeout(() => {}, 60000)',
        '',
      ].join('\n'),
      'utf8'
    )
    fs.writeFileSync(
      path.join(scriptsRoot, 'stubborn.mjs'),
      ["process.on('SIGTERM', () => {})", "console.log('READY')", 'setTimeout(() => {}, 60000)', ''].join('\n'),
      'utf8'
    )
    fs.writeFileSync(path.join(scriptsRoot, 'big-output.mjs'), "process.stdout.write('x'.repeat(50000))\n", 'utf8')
    fs.writeFileSync(
      path.join(scriptsRoot, 'wait.mjs'),
      [
        "const ms = Number(process.argv[2] ?? '500')",
        "const label = process.argv[3] ?? 't'",
        "console.log('START:' + label)",
        "setTimeout(() => { console.log('END:' + label); process.exit(0) }, ms)",
        '',
      ].join('\n'),
      'utf8'
    )
    fs.writeFileSync(path.join(scriptsRoot, 'notes.txt'), '不是脚本，不该出现在 listScripts 里\n', 'utf8')

    await checker.check('脚本列表：只收 *.mjs/*.js（非递归），描述取第一行注释', async () => {
      const scripts = await runner.listScripts()
      const names = scripts.map((item) => item.name)
      assert(names.includes('ok.mjs'), `names=${names.join(',')}`)
      assert(!names.includes('notes.txt'), 'notes.txt 不该被当成脚本')
      const ok = scripts.find((item) => item.name === 'ok.mjs')
      assert(ok?.description === '示例：验证用脚本', `description=${JSON.stringify(ok?.description)}`)
      assert(ok.bytes > 0 && ok.mtimeMs > 0, `bytes=${ok.bytes} mtimeMs=${ok.mtimeMs}`)
    })

    await checker.check('运行：exit 0 → ok，且环境变量与占位符展开符合契约', async () => {
      const result = await runner.runWorkspaceScript({ name: 'ok.mjs', args: ['--flag', '值'], triggeredBy: 'verify' })
      assert(result.status === 'ok', `status=${result.status} stderr=${result.stderr}`)
      assert(result.exitCode === 0, `exitCode=${String(result.exitCode)}`)
      assert(result.signal === '', `signal=${result.signal}`)
      assert(result.stdout.includes('done'), `stdout=${result.stdout}`)
      assert(result.durationMs >= 0 && result.endedAt >= result.startedAt, '时间戳不合理')
      assert(result.recordId > 0, `recordId=${result.recordId}`)

      const envLine = result.stdout.split('\n').find((line) => line.startsWith('ENV:'))
      assert(envLine !== undefined, `没有 ENV 行：${result.stdout}`)
      const env = JSON.parse((envLine as string).slice(4)) as Record<string, unknown>
      assert(env.workspace === workspace, `RAVEN_WORKSPACE=${String(env.workspace)}，期望 ${workspace}`)
      assert(env.root === root, `RAVEN_ROOT=${String(env.root)}`)
      assert(env.scripts === scriptsRoot, `RAVEN_SCRIPTS=${String(env.scripts)}`)
      assert(env.clipboard === clipboardRoot, `RAVEN_CLIPBOARD=${String(env.clipboard)}`)
      assert(env.uploads === path.join(workspace, 'uploads'), `RAVEN_UPLOADS=${String(env.uploads)}`)
      assert(env.uploadsExists === true, 'RAVEN_UPLOADS 应自动建好')
      assert(typeof env.tmp === 'string' && env.tmp.startsWith(runTempRoot), `RAVEN_TMPDIR=${String(env.tmp)}`)
      assert(env.tmpExists === true, '运行期 RAVEN_TMPDIR 必须存在')
      assert(env.args === JSON.stringify(['--flag', '值']), `RAVEN_SCRIPT_ARGS=${String(env.args)}`)
      assert(env.name === 'ok.mjs', `RAVEN_SCRIPT_NAME=${String(env.name)}`)
      assert(env.greeting === `hi-${workspace}`, `配置 env 的 {workspace} 没展开：${String(env.greeting)}`)
      assert(env.unknown === '{nope}', `未知占位符应原样保留：${String(env.unknown)}`)
      assert(env.runId === String(result.recordId), `RAVEN_RUN_ID=${String(env.runId)}，recordId=${result.recordId}`)
      assert(typeof env.api === 'string' && env.api.startsWith('http'), `RAVEN_API=${String(env.api)}`)
      // getcwd() 返回的是规范化路径（macOS 上 /var 是 /private/var 的软链），
      // 所以这里要比 realpath，否则永远是假失败。
      assert(
        result.stdout.includes(`CWD:${fs.realpathSync(workspace)}`),
        `workspace 脚本的 cwd 应是 filesRoot：${result.stdout}`
      )

      const tokenLine = result.stdout.split('\n').find((line) => line.startsWith('RTOKEN:'))
      const token = (tokenLine as string).slice('RTOKEN:'.length)
      assert(token.length >= 32, `RAVEN_TOKEN 看起来不对：${token}`)
      const consumed = runner.consumeRunToken(token)
      assert(consumed?.runId === result.recordId, `consumeRunToken 没对上：${JSON.stringify(consumed)}`)
      assert(consumed.script === 'ok.mjs', `script=${consumed.script}`)
    })

    await checker.check('运行：exit 3 → failed 且 exitCode=3', async () => {
      const result = await runner.runWorkspaceScript({ name: 'fail.mjs' })
      assert(result.status === 'failed', `status=${result.status}`)
      assert(result.exitCode === 3, `exitCode=${String(result.exitCode)}`)
      assert(result.signal === '', `signal=${result.signal}`)
    })

    await checker.check('运行：输出超上限 → 截断并置 truncated，但进程照样跑完', async () => {
      const result = await runner.runWorkspaceScript({ name: 'big-output.mjs' })
      assert(result.status === 'ok', `status=${result.status}`)
      assert(result.truncated === true, 'truncated 应为 true')
      assert(Buffer.byteLength(result.stdout, 'utf8') <= MAX_OUTPUT_BYTES, `stdout 字节数=${Buffer.byteLength(result.stdout, 'utf8')}`)
      const row = await runner.getRun(result.recordId)
      assert(row !== undefined, '库里应有这条运行记录')
      assert(row.truncated === 1, `库里 truncated=${row.truncated}`)
      assert(Buffer.byteLength(row.stdout, 'utf8') <= MAX_OUTPUT_BYTES, `库里 stdout 字节数=${Buffer.byteLength(row.stdout, 'utf8')}`)
    })

    await checker.check('运行：超时 → timeout，孙子进程也一起被杀干净', async () => {
      const result = await runner.runWorkspaceScript({ name: 'sleep.mjs', timeoutMs: 1500 })
      assert(result.status === 'timeout', `status=${result.status} stderr=${result.stderr}`)
      assert(result.exitCode === null, `exitCode=${String(result.exitCode)}`)
      assert(result.signal === 'SIGTERM' || result.signal === 'SIGKILL', `signal=${result.signal}`)
      assert(result.durationMs >= 1500, `durationMs=${result.durationMs} 不该短于超时时间`)
      const match = /GRANDCHILD:(\d+)/.exec(result.stdout)
      assert(match !== null, `没拿到孙子进程 pid：${result.stdout}`)
      const pid = Number.parseInt((match as RegExpExecArray)[1], 10)
      let alive = true
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        await sleep(100)
        alive = processAlive(pid)
      }
      assert(!alive, `孙子进程 ${pid} 超时后还活着：进程组没被杀干净`)
    })

    await checker.check('运行：脚本无视 SIGTERM 时 3 秒后升级 SIGKILL（exitCode=null / signal=SIGKILL）', async () => {
      const startedAt = Date.now()
      const result = await runner.runWorkspaceScript({ name: 'stubborn.mjs', timeoutMs: 1000 })
      const elapsed = Date.now() - startedAt
      assert(result.status === 'timeout', `status=${result.status}`)
      assert(result.exitCode === null, `exitCode=${String(result.exitCode)}`)
      assert(result.signal === 'SIGKILL', `signal=${result.signal}`)
      assert(elapsed >= 3500, `升级到 SIGKILL 应等满 3 秒宽限，实际 ${elapsed}ms`)
    })

    await checker.check('运行：每次运行恰好一条 run_records，结束状态与 RunResult 一致', async () => {
      const before = await runner.listRuns(500)
      const result = await runner.runWorkspaceScript({ name: 'ok.mjs' })
      const after = await runner.listRuns(500)
      assert(after.length === before.length + 1, `运行前后条数：${before.length} → ${after.length}`)
      const row = await runner.getRun(result.recordId)
      assert(row !== undefined, 'getRun 应能拿到刚写完的记录')
      assert(row.status === result.status, `库里 status=${row.status}，RunResult=${result.status}`)
      assert(row.exitCode === result.exitCode, `库里 exitCode=${String(row.exitCode)}`)
      assert(row.stdout === result.stdout, '库里 stdout 应与 RunResult 一致')
      assert(row.triggeredBy === 'api', `triggeredBy=${row.triggeredBy}`)
      assert(row.origin === 'workspace', `origin=${row.origin}`)
      const recent = await runner.listRuns(5)
      assert(recent[0].id === result.recordId, '最新一条应是刚跑完的这次')
    })

    await checker.check('运行：并发闸门 maxConcurrent=2 生效，priority 直接绕过闸门', async () => {
      const first = runner.runWorkspaceScript({ name: 'wait.mjs', args: ['600', 'n1'] })
      const second = runner.runWorkspaceScript({ name: 'wait.mjs', args: ['600', 'n2'] })
      await sleep(50)
      // 两个普通任务占满槽位：普通任务 q1 必须排队，priority 的 p1 立刻跑。
      const queued = runner.runWorkspaceScript({ name: 'wait.mjs', args: ['200', 'q1'] })
      const priority = runner.runWorkspaceScript({ name: 'wait.mjs', args: ['50', 'p1'], priority: true })
      const [normalOne, normalTwo, queuedResult, priorityResult] = await Promise.all([first, second, queued, priority])
      for (const result of [normalOne, normalTwo, queuedResult, priorityResult]) {
        assert(result.status === 'ok', `status=${result.status} stderr=${result.stderr}`)
      }
      assert(
        priorityResult.endedAt < queuedResult.startedAt,
        `priority 应绕过闸门先跑完：priority 结束 ${priorityResult.endedAt}，排队任务开始 ${queuedResult.startedAt}`
      )
      assert(runner.MAX_PRIORITY_INFLIGHT === 4, `MAX_PRIORITY_INFLIGHT=${runner.MAX_PRIORITY_INFLIGHT}`)
    })

    await checker.check('运行：临时脚本跑完即删（含失败路径），名字被消毒', async () => {
      const result = await runner.runTempScript({
        name: '../evil name.js',
        content: [
          "console.log('TMP:' + String(process.env.RAVEN_TMPDIR))",
          "console.log('NAME:' + String(process.env.RAVEN_SCRIPT_NAME))",
        ].join('\n'),
      })
      assert(result.status === 'ok', `status=${result.status} stderr=${result.stderr}`)
      const nameLine = result.stdout.split('\n').find((item) => item.startsWith('NAME:'))
      assert(nameLine?.slice(5).trim() === 'evil name.js', `RAVEN_SCRIPT_NAME=${String(nameLine)}`)
      const line = result.stdout.split('\n').find((item) => item.startsWith('TMP:'))
      assert(line !== undefined, `没有 TMP 行：${result.stdout}`)
      const tmpDir = (line as string).slice(4).trim()
      assert(tmpDir.startsWith(runTempRoot), `RAVEN_TMPDIR=${tmpDir}`)
      assert(!fs.existsSync(tmpDir), `临时目录应被删掉：${tmpDir}`)
      const failed = await runner.runTempScript({ name: 'boom.mjs', content: 'process.exit(2)' })
      assert(failed.status === 'failed' && failed.exitCode === 2, `status=${failed.status} exitCode=${String(failed.exitCode)}`)
      const sanitized = runner.sanitizeScriptName('..\\..\\x y.js')
      assert(!sanitized.includes('/') && !sanitized.includes('\\') && !sanitized.includes('..'), `sanitizeScriptName=${sanitized}`)
    })

    await checker.check('运行：跑完之后 tmp 根目录不留任何东西', async () => {
      const leftovers = fs.readdirSync(runTempRoot)
      assert(leftovers.length === 0, `tmp 里有残留：${leftovers.join(',')}`)
    })

    await checker.check('运行：临时脚本超过 1MiB 被拒（413）', async () => {
      await expectFailure(
        'script_too_large',
        () => runner.runTempScript({ name: 'big.mjs', content: '//' + 'x'.repeat(runner.MAX_TEMP_SCRIPT_BYTES + 10) }),
        413
      )
    })

    await checker.check('运行：allowScriptExecution=false 时拒绝执行 workspace 脚本（403）', async () => {
      writeConfig(root, false, 5000)
      await expectFailure('script_disabled', () => runner.runWorkspaceScript({ name: 'ok.mjs' }), 403)
      writeConfig(root, true, 9000)
      const result = await runner.runWorkspaceScript({ name: 'ok.mjs' })
      assert(result.status === 'ok', '恢复配置后应能继续跑')
    })

    await checker.check('令牌：register/consume/TTL 与 5 分钟清扫常量', async () => {
      assert(runner.RUN_TOKEN_TTL_MS === 5 * 60_000, `RUN_TOKEN_TTL_MS=${runner.RUN_TOKEN_TTL_MS}`)
      runner.registerRunToken('verify-token-1', { runId: 77, script: 'x.mjs' })
      const consumed = runner.consumeRunToken('verify-token-1')
      assert(consumed?.runId === 77 && consumed.script === 'x.mjs', JSON.stringify(consumed))
      assert(runner.consumeRunToken('verify-token-1')?.runId === 77, '有效期内应可重复使用（一次运行可能推多批指标）')
      assert(runner.consumeRunToken('not-registered') === null, '没登记的令牌必须返回 null')
      assert(runner.consumeRunToken('') === null, '空令牌必须返回 null')
      runner.clearRunTokens()
      assert(runner.consumeRunToken('verify-token-1') === null, 'clearRunTokens 之后应失效')
    })

    await checker.check('运行：listRuns / getRun 与 limit 收敛', async () => {
      const runs = await runner.listRuns(3)
      assert(runs.length <= 3, `limit 没生效：${runs.length}`)
      assert(runs.length > 0, '应该有运行记录')
      const detail = await runner.getRun(runs[0].id)
      assert(detail !== undefined && detail.id === runs[0].id, 'getRun 应返回同一条')
      assert(await runner.getRun(999_999_999) === undefined, '不存在的 id 应返回 undefined')
      const filtered = await runner.listRuns(50, 'ok.mjs')
      assert(filtered.every((row) => row.script === 'ok.mjs'), 'script 过滤没生效')
    })

    // ------------------------------------------------------------- 路由层
    //
    // 服务层过了不等于接口对了：信封形状、查询参数名、`params` 有没有 await、
    // 流式响应的 content-type、multipart 字段名 —— 这些都只有真调一次路由才发现。
    // 这里直接 import route handler 并喂 Request（不起 HTTP 服务）。
    const api = 'http://localhost/api'
    // 路由模块的 import 会连带拉进 `next/server`。依赖没装齐（`npm install` 跑了一半、
    // 或者只装了运行时子集）时，这属于**环境**问题，不该让上面 53 条服务层断言
    // 整段消失 —— 那种失败会把真正的行为错误一起埋掉。所以只对「找不到模块」跳过。
    type RouteSet = {
      files: typeof import('@/app/api/files/route')
      upload: typeof import('@/app/api/files/upload/route')
      download: typeof import('@/app/api/files/download/route')
      raw: typeof import('@/app/api/files/raw/route')
      content: typeof import('@/app/api/files/content/route')
      mkdir: typeof import('@/app/api/files/mkdir/route')
      rename: typeof import('@/app/api/files/rename/route')
      copy: typeof import('@/app/api/files/copy/route')
      move: typeof import('@/app/api/files/move/route')
      remove: typeof import('@/app/api/files/delete/route')
      stats: typeof import('@/app/api/files/stats/route')
      clipboard: typeof import('@/app/api/clipboard/route')
      clipboardAttachments: typeof import('@/app/api/clipboard/attachments/route')
      clipboardId: typeof import('@/app/api/clipboard/[id]/route')
      clipboardAttachment: typeof import('@/app/api/clipboard/[id]/attachment/route')
      scripts: typeof import('@/app/api/scripts/route')
      scriptRun: typeof import('@/app/api/scripts/run/route')
      scriptRunTemp: typeof import('@/app/api/scripts/run-temp/route')
      scriptRuns: typeof import('@/app/api/scripts/runs/route')
      scriptRunId: typeof import('@/app/api/scripts/runs/[id]/route')
    }
    let loadedRoutes: RouteSet | null = null
    try {
      loadedRoutes = {
        files: await import('@/app/api/files/route'),
        upload: await import('@/app/api/files/upload/route'),
        download: await import('@/app/api/files/download/route'),
        raw: await import('@/app/api/files/raw/route'),
        content: await import('@/app/api/files/content/route'),
        mkdir: await import('@/app/api/files/mkdir/route'),
        rename: await import('@/app/api/files/rename/route'),
        copy: await import('@/app/api/files/copy/route'),
        move: await import('@/app/api/files/move/route'),
        remove: await import('@/app/api/files/delete/route'),
        stats: await import('@/app/api/files/stats/route'),
        clipboard: await import('@/app/api/clipboard/route'),
        clipboardAttachments: await import('@/app/api/clipboard/attachments/route'),
        clipboardId: await import('@/app/api/clipboard/[id]/route'),
        clipboardAttachment: await import('@/app/api/clipboard/[id]/attachment/route'),
        scripts: await import('@/app/api/scripts/route'),
        scriptRun: await import('@/app/api/scripts/run/route'),
        scriptRunTemp: await import('@/app/api/scripts/run-temp/route'),
        scriptRuns: await import('@/app/api/scripts/runs/route'),
        scriptRunId: await import('@/app/api/scripts/runs/[id]/route'),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) throw error
      checker.skip?.('路由层断言（20 个 route handler）', `依赖没装齐，import 不到：${message.split('\n')[0]}`)
    }
    if (loadedRoutes === null) return
    const route = loadedRoutes

    /** 读信封：非 JSON 直接算失败（那说明有路由漏了 handle()）。 */
    const envelope = async (response: Response): Promise<Record<string, unknown>> => {
      const text = await response.text()
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`)
      }
    }
    const params = (id: string): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id }) })

    await checker.check('路由：PUT /api/files/upload 落盘；缺 path → 400 信封', async () => {
      const ok = await envelope(
        await route.upload.PUT(
          new Request(`${api}/files/upload?path=routes/hello.txt`, { method: 'PUT', body: new TextEncoder().encode('你好 raven') })
        )
      )
      assert(ok.ok === true, JSON.stringify(ok))
      assert(ok.bytes === Buffer.byteLength('你好 raven', 'utf8'), `bytes=${String(ok.bytes)}`)
      const missing = await route.upload.PUT(new Request(`${api}/files/upload`, { method: 'PUT', body: 'x' }))
      const body = await envelope(missing)
      assert(missing.status === 400 && body.ok === false && body.code === 'missing_param', JSON.stringify(body))
    })

    await checker.check('路由：GET /api/files 列目录；越界 → 信封错误（不是 HTML）', async () => {
      const listing = await envelope(await route.files.GET(new Request(`${api}/files?path=routes&sort=name&order=asc`)))
      assert(listing.ok === true, JSON.stringify(listing))
      const entries = listing.entries as Array<{ name: string }>
      assert(entries.some((item) => item.name === 'hello.txt'), JSON.stringify(entries))
      const escaped = await route.files.GET(new Request(`${api}/files?path=${encodeURIComponent('../etc')}`))
      const body = await envelope(escaped)
      assert(body.ok === false && typeof body.error === 'string' && body.error !== '', JSON.stringify(body))
    })

    await checker.check('路由：download 给 Content-Length + attachment；raw 给 nosniff + CSP', async () => {
      const download = await route.download.GET(new Request(`${api}/files/download?path=routes/hello.txt`))
      assert(download.headers.get('content-disposition')?.startsWith('attachment;') === true, String(download.headers.get('content-disposition')))
      assert(download.headers.get('content-length') === String(Buffer.byteLength('你好 raven', 'utf8')), String(download.headers.get('content-length')))
      assert((download.headers.get('content-disposition') ?? '').includes("filename*=UTF-8''"), '缺 RFC 5987')
      assert((await download.text()) === '你好 raven', '下载内容不对')
      const raw = await route.raw.GET(new Request(`${api}/files/raw?path=routes/hello.txt`))
      assert(raw.headers.get('x-content-type-options') === 'nosniff', '缺 nosniff')
      assert((raw.headers.get('content-security-policy') ?? '').includes("default-src 'none'"), '缺 CSP')
      assert((raw.headers.get('content-type') ?? '').startsWith('text/plain'), String(raw.headers.get('content-type')))
    })

    await checker.check('路由：content 读写往返；text 非字符串 → 400', async () => {
      const put = await envelope(
        await route.content.PUT(new Request(`${api}/files/content`, { method: 'PUT', body: JSON.stringify({ path: 'routes/note.md', text: '# 标题' }) }))
      )
      assert(put.ok === true, JSON.stringify(put))
      const read = await envelope(await route.content.GET(new Request(`${api}/files/content?path=routes/note.md`)))
      assert(read.text === '# 标题' && read.encoding === 'utf8', JSON.stringify(read))
      const bad = await route.content.PUT(
        new Request(`${api}/files/content`, { method: 'PUT', body: JSON.stringify({ path: 'routes/note.md', text: 42 }) })
      )
      assert((await envelope(bad)).code === 'invalid_body', 'text 非字符串应 400')
    })

    await checker.check('路由：mkdir/rename/copy/move/delete 全链路 + 删根被拒', async () => {
      const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
        envelope(await (path === 'mkdir'
          ? route.mkdir.POST(new Request(`${api}/files/mkdir`, { method: 'POST', body: JSON.stringify(body) }))
          : path === 'rename'
            ? route.rename.POST(new Request(`${api}/files/rename`, { method: 'POST', body: JSON.stringify(body) }))
            : path === 'copy'
              ? route.copy.POST(new Request(`${api}/files/copy`, { method: 'POST', body: JSON.stringify(body) }))
              : path === 'move'
                ? route.move.POST(new Request(`${api}/files/move`, { method: 'POST', body: JSON.stringify(body) }))
                : route.remove.POST(new Request(`${api}/files/delete`, { method: 'POST', body: JSON.stringify(body) }))))
      assert((await post('mkdir', { path: 'routes/work' })).ok === true, 'mkdir')
      assert((await post('rename', { from: 'routes/note.md', to: 'routes/work/note.md' })).ok === true, 'rename')
      assert((await post('copy', { from: 'routes/work/note.md', to: 'routes/work/copy.md' })).ok === true, 'copy')
      assert((await post('move', { from: 'routes/work/copy.md', to: 'routes/work/moved.md' })).ok === true, 'move')
      const deleted = await post('delete', { paths: ['routes/work'] })
      assert(deleted.ok === true && deleted.count === 2, JSON.stringify(deleted))
      const root = await post('delete', { paths: [''] })
      assert(root.code === 'invalid_path', `删根应被拒：${JSON.stringify(root)}`)
      const empty = await post('delete', { paths: [] })
      assert(empty.code === 'invalid_body', `空数组应被拒：${JSON.stringify(empty)}`)
    })

    await checker.check('路由：GET /api/files/stats 摊平返回配额字段', async () => {
      const body = await envelope(await route.stats.GET())
      assert(body.ok === true && body.quotaBytes === QUOTA_BYTES, JSON.stringify(body))
      assert(typeof body.bytes === 'number' && typeof body.remainingBytes === 'number', JSON.stringify(body))
      assert(typeof body.usedRatio === 'number', JSON.stringify(body))
    })

    await checker.check('路由：剪切板 POST/GET/PATCH + multipart 附件 + 附件下载 + DELETE', async () => {
      const created = await envelope(
        await route.clipboard.POST(new Request(`${api}/clipboard`, { method: 'POST', body: JSON.stringify({ text: '路由测试' }) }))
      )
      assert(created.ok === true, JSON.stringify(created))
      const id = (created.entry as { id: string }).id
      const listed = await envelope(await route.clipboard.GET(new Request(`${api}/clipboard?limit=10&offset=0&q=路由`)))
      assert((listed.entries as unknown[]).length === 1, JSON.stringify(listed))
      const patched = await envelope(
        await route.clipboardId.PATCH(
          new Request(`${api}/clipboard/${id}`, { method: 'PATCH', body: JSON.stringify({ text: '改过' }) }),
          params(id)
        )
      )
      assert((patched.entry as { text: string }).text === '改过', JSON.stringify(patched))

      const form = new FormData()
      form.append('text', '带附件')
      form.append('files', new File([new TextEncoder().encode('ABC')], '截图 1.png', { type: 'image/png' }))
      const withAttachment = await envelope(
        await route.clipboardAttachments.POST(new Request(`${api}/clipboard/attachments`, { method: 'POST', body: form }))
      )
      assert(withAttachment.ok === true, JSON.stringify(withAttachment))
      const entry = withAttachment.entry as { id: string; attachments: Array<{ name: string }>; attachBytes: number }
      assert(entry.attachments.length === 1 && entry.attachBytes === 3, JSON.stringify(entry))
      const name = entry.attachments[0].name
      const attachment = await route.clipboardAttachment.GET(
        new Request(`${api}/clipboard/${entry.id}/attachment?name=${encodeURIComponent(name)}`),
        params(entry.id)
      )
      assert(attachment.status === 200, `附件下载 status=${attachment.status}`)
      assert((await attachment.text()) === 'ABC', '附件内容不对')
      const removed = await envelope(await route.clipboardId.DELETE(new Request(`${api}/clipboard/${entry.id}`, { method: 'DELETE' }), params(entry.id)))
      assert(removed.removed === true, JSON.stringify(removed))
      const missing = await route.clipboardAttachment.GET(
        new Request(`${api}/clipboard/${'0'.repeat(26)}/attachment?name=a.png`),
        params('0'.repeat(26))
      )
      assert(missing.status === 404, `未知附件应 404，实际 ${missing.status}`)
    })

    await checker.check('路由：GET /api/scripts、/runs、/runs/[id] 的参数校验', async () => {
      const scripts = await envelope(await route.scripts.GET())
      assert(scripts.ok === true, JSON.stringify(scripts))
      assert((scripts.scripts as Array<{ name: string }>).some((item) => item.name === 'ok.mjs'), JSON.stringify(scripts.scripts))
      const runs = await envelope(await route.scriptRuns.GET(new Request(`${api}/scripts/runs?limit=5`)))
      assert(runs.ok === true && Array.isArray(runs.runs), JSON.stringify(runs))
      const bad = await route.scriptRunId.GET(new Request(`${api}/scripts/runs/abc`), params('abc'))
      assert((await envelope(bad)).code === 'invalid_param', 'id 非数字应 400')
      const missing = await route.scriptRunId.GET(new Request(`${api}/scripts/runs/999999`), params('999999'))
      assert(missing.status === 404, `未知运行记录应 404，实际 ${missing.status}`)
    })

    await checker.check('路由：POST /api/scripts/run → SSE（start/stdout/done）；未知脚本 → 404 信封', async () => {
      const response = await route.scriptRun.POST(
        new Request(`${api}/scripts/run`, { method: 'POST', body: JSON.stringify({ name: 'ok.mjs' }) })
      )
      assert(response.status === 200, `status=${response.status}`)
      assert(response.headers.get('content-type') === 'text/event-stream; charset=utf-8', String(response.headers.get('content-type')))
      const text = await response.text()
      assert(text.includes('event: start'), text.slice(0, 120))
      assert(text.includes('event: stdout') && text.includes('done'), text.slice(0, 200))
      assert(text.includes('"status":"ok"'), text.slice(-200))

      // 准入检查必须在开流之前：否则前端拿到的是 200 的事件流里塞一个 error。
      const missing = await route.scriptRun.POST(
        new Request(`${api}/scripts/run`, { method: 'POST', body: JSON.stringify({ name: 'nope.mjs' }) })
      )
      const body = await envelope(missing)
      assert(missing.status === 404 && body.ok === false && body.code === 'not_found', JSON.stringify(body))
    })

    await checker.check('路由：POST /api/scripts/run-temp multipart → SSE 并跑完', async () => {
      const form = new FormData()
      form.append('file', new File([new TextEncoder().encode("console.log('temp-ok:' + process.env.VERIFY_GREETING)")], 'temp.js'))
      form.append('args', JSON.stringify(['--a', 'b']))
      const response = await route.scriptRunTemp.POST(new Request(`${api}/scripts/run-temp`, { method: 'POST', body: form }))
      assert(response.status === 200, `status=${response.status}`)
      const text = await response.text()
      assert(text.includes('temp-ok:hi-'), text.slice(0, 300))
      assert(text.includes('event: done'), text.slice(-200))
    })
  } finally {
    // 沙箱之外那个目录不归沙箱管，得自己收。
    fs.rmSync(outside, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 单跑时的入口
// ---------------------------------------------------------------------------

/** 单跑用的极小 harness：`check(name, fn)`，失败把 detail 打出来。 */
function localChecker(): { checker: Checker; failures: string[]; passed: () => number } {
  const failures: string[] = []
  let count = 0
  const checker: Checker = {
    async check(name, fn) {
      try {
        await fn()
        count += 1
        console.log(`  ✓ ${name}`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        failures.push(`${name}：${detail}`)
        console.log(`  ✗ ${name}：${detail}`)
      }
    },
    fail(name, detail) {
      failures.push(`${name}：${detail}`)
      console.log(`  ✗ ${name}：${detail}`)
    },
    skip(name, reason) {
      console.log(`  ~ ${name} — SKIP：${reason}`)
    },
  }
  return { checker, failures, passed: () => count }
}

async function main(): Promise<void> {
  console.log(`临时根：${tempRoot}`)
  console.log(`临时库：${process.env.RAVEN_DB_FILE ?? '(由调用方指定)'}`)
  console.log('')
  console.log('── 文件 / 剪切板 / 脚本运行 ────────────────────')

  const { checker, failures, passed } = localChecker()
  try {
    await runStorageChecks(checker, { temp: tempRoot })
  } catch (error) {
    // 连段都跑不起来（配置不合法、依赖缺失）也算失败，但要把原因说清楚。
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    failures.push(`storage 段整体异常：${detail}`)
    console.log(`  ✗ storage 段整体异常：${detail}`)
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} 条失败：`)
    for (const failure of failures) console.log(`  ✗ ${failure}`)
    console.log(`临时目录保留在 ${tempRoot}，可以进去复查。`)
    process.exitCode = 1
    return
  }
  console.log(`✅ ${passed()} passed`)
  // 全部通过才清理：失败时留着临时目录，方便直接复现。
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
