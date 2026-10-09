import { spawn } from 'node:child_process'
import { getConfig, getSandbox } from '@/backstage/lib/config'
import { armGracefulKill, OutputSink } from '@/backstage/lib/proc'
import { parseRelativePath, SandboxError } from '@/backstage/lib/sandbox'
import { defineTool, optionalNumber, optionalString, requireString, requireStringArray } from './registry'

/**
 * Shell 工具。
 *
 * ## 为什么是 argv 而不是一整行命令
 *
 * 主路径是 `{ command, args[] }` **直接 spawn，不经过 shell**。
 * 这样做的理由不是「安全」，而是**可预测**：命令与参数在协议层就是分开的字段，
 * 工具调用记录里能看清每个参数是什么。走 `sh -c 'a && b'` 的话，
 * 一切都被压成一个字符串 —— 引号、空格、重定向全靠模型自己拼对，
 * 而拼错的症状是「命令 mysteriously 不一样」，极难查。
 *
 * 需要管道 / 重定向时**显式**传 `command: 'sh'` + `args: ['-c', '...']`：
 * 解释器是模型自己挑的、写进调用记录、也在允许清单里，不是隐式发生的。
 * `shell.allowShellSyntax: false` 可以把这条路也关掉。
 *
 * ## 借来的四条纪律
 *
 * 全部来自 `backstage/lib/proc.ts`（与脚本运行器共用一份，**不是抄的**）：
 * 进程组 kill、输出按字节封顶且封顶后继续读、SIGTERM→3s→SIGKILL 两段收尾。
 * 加上 `context.signal` —— 协议保证 `cancelExecution` 真的能刹住车。
 */

const MAX_COMMAND_BYTES = 4096
const MAX_ARGS = 64

defineTool({
  name: 'raven.shell.exec',
  title: '执行命令',
  description:
    '在 raven 的受管工作目录下执行一条命令并返回 stdout / stderr / 退出码。**不会经过 shell** ——管道与重定向要自己写 `command: "sh"` + `args: ["-c", "..."]`。命令默认在受管根目录执行，cwd 可以改成其下的子目录（不能跑到外面去）。超时或被取消会连整个进程组一起收掉。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '可执行文件名或路径，例如 ls、rg、node' },
      args: {
        type: 'array',
        description: '参数数组，逐个传入不经shell 解析。需要管道时传 ["-c", "完整命令"]',
        items: { type: 'string' },
      },
      cwd: { type: 'string', description: '相对受管根目录的工作目录。留空表示根目录' },
      timeoutMs: { type: 'number', description: '墙钟超时，默认 60000，上限 600000' },
    },
    required: ['command'],
  },
  risk: 'write',
  timeoutMs: 60_000,
  confirmationPhrase: null,
  async execute(args, context) {
    const { config } = getConfig()
    if (!config.shell.enabled) {
      throw new SandboxError('shell_disabled', 'shell 工具已被配置关闭（shell.enabled = false）。', 403)
    }

    const command = requireString(args, 'command')
    const argv = args.args === undefined ? [] : requireStringArray(args, 'args')
    if (argv.length > MAX_ARGS) {
      throw new SandboxError('args_too_long', `参数最多 ${MAX_ARGS} 个，收到 ${argv.length} 个。`, 400)
    }
    if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
      throw new SandboxError('args_too_long', `命令长度超过 ${MAX_COMMAND_BYTES} 字节。`, 400)
    }
    // NUL 会让 spawn 直接抛EINVAL，而那在协议里会被说成「raven 崩了」。
    if (command.includes('\0') || argv.some((item) => item.includes('\0'))) {
      throw new SandboxError('invalid_path', '命令或参数里不能有 NUL 字节。', 400)
    }
    if (!config.shell.allowShellSyntax && isShellInterpreter(command)) {
      throw new SandboxError(
        'shell_syntax_disabled',
        '配置关闭了 shell 语法解释（shell.allowShellSyntax = false），不能直接调用 sh / bash。',
        403
      )
    }

    const sandbox = getSandbox()
    await sandbox.ensureRoots()
    const cwd = await resolveCwd(sandbox, optionalString(args, 'cwd'))

    const requested = optionalNumber(args, 'timeoutMs')
    const timeoutMs = Math.min(
      Math.max(1000, Math.trunc(requested ?? config.shell.timeoutMs)),
      Math.min(config.shell.timeoutMs, 600_000)
    )

    const limit = config.scripts.execution.maxOutputBytes
    const stdout = new OutputSink(limit)
    const stderr = new OutputSink(limit)
    const startedAt = Date.now()

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, argv, {
          cwd,
          // ⚠️ 继承父进程环境：命令要靠 PATH 找 ffmpeg / rg / git，
          // 只给 RAVEN_* 会造成「本机能跑、容器里跑不了」。
          env: { ...process.env, ...config.scripts.env, RAVEN_SHELL_EXECUTION_ID: context.executionId },
          // 自成进程组，超时/取消才能整组杀 —— 否则孙子进程会继续往磁盘写。
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(wrapSpawnError(error, command))
        return
      }

      let timedOut = false
      let cancelled = false
      let settled = false
      let timer: NodeJS.Timeout | null = null
      let cancelKill: (() => void) | null = null

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (cancelKill !== null) cancelKill()
        context.signal.removeEventListener('abort', onAbort)
        stdout.finish()
        stderr.finish()
        fn()
      }

      // 只收尾一次：取消与超时都可能先到，重复 arm 会漏掉前一个 kill 定时器。
      const stop = (): void => {
        if (cancelKill !== null) return
        cancelKill = armGracefulKill(child)
      }

      // 协议的两段式取消：signal 落地 → 进程真的收尾。
      // 只做前者是「假取消」，只做后者则查不到这次执行。
      const onAbort = (): void => {
        cancelled = true
        stop()
      }
      if (context.signal.aborted) onAbort()
      else context.signal.addEventListener('abort', onAbort, { once: true })

      timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.once('error', (error) => finish(() => reject(wrapSpawnError(error, command))))
      child.once('close', (code, signal) =>
        finish(() => {
          // ⚠️退出码非 0 **不是协议错误**：命令跑了，跑了并失败了。
          // 报成 error 会让runtime以为「换个参数重试」，而它重试一万次也是同样结果。
          // 该不该由调用方判断，看的是 exitCode，不是这里。
          resolve({
            command,
            args: argv,
            cwd,
            exitCode: code,
            signal: signal ?? null,
            stdout: stdout.text(),
            stderr: stderr.text(),
            truncated: stdout.isTruncated || stderr.isTruncated,
            timedOut,
            cancelled,
            durationMs: Date.now() - startedAt,
          })
        })
      )
    })
  },
})

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'])

function isShellInterpreter(command: string): boolean {
  const base = command.split('/').pop() ?? command
  return SHELL_INTERPRETERS.has(base)
}

/**
 * 把 cwd 解析成受管根目录下的一个真实目录。
 *
 * ⚠️ **必须带上 workspace 名前缀。** `PathSandbox` 的路径是相对 `rootPath` 的，
 * 而工具协议里的路径是相对 `filesRoot`（= `<rootPath>/<workspace>`）的 ——
 * 差的就是这一段。漏掉它时 `resolveExisting` 报的是 `not_found`，
 * 症状看起来像「目录明明建了」，而真因是查错了地方。
 *
 * 用 `resolveExisting` 而不是 `resolveWrite`：cwd 必须**已经存在**，
 * 而让 spawn 去报错只会得到一个 ENOENT —— 说不清是「路径不存在」还是「路径被沙箱挡了」。
 */
async function resolveCwd(sandbox: ReturnType<typeof getSandbox>, requested: string | undefined): Promise<string> {
  const { config } = getConfig()
  const segments = parseRelativePath(requested ?? '', { allowEmpty: true })
  if (segments.length === 0) return sandbox.filesRoot
  return sandbox.resolveExisting([config.workspace.name, ...segments].join('/'), 'read')
}

/**
 * spawn 失败归一成协议错误。
 *
 * ENOENT（命令不存在）是**调用方的错** —— 模型拼错了名字，改参数就能救，
 * 所以必须是 `invalid_input` 而不是 `internal_error`。后者会让 runtime 反复重试。
 */
function wrapSpawnError(error: unknown, command: string): SandboxError {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') {
    return new SandboxError('command_not_found', `找不到命令：${command}。用 which 确认它存在。`, 404)
  }
  if (code === 'EACCES') {
    return new SandboxError('permission_denied', `没有权限执行：${command}。`, 403)
  }
  return new SandboxError('spawn_failed', `启动 ${command} 失败：${(error as Error).message}`, 500)
}