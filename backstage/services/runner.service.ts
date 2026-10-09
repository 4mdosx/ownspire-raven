import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { dbRunFinish, dbRunGet, dbRunInsert, dbRunList, dbRunPrune, type RunRow } from '@/backstage/db/database'
import { RAVEN_VERSION } from '@/config/env'
import { getConfig } from '@/backstage/lib/config'
import { humanBytes } from '@/backstage/lib/format'
import { runTempName } from '@/backstage/lib/ids'
import { isInside, SandboxError } from '@/backstage/lib/sandbox'

/**
 * 脚本运行器。
 *
 * 这是 raven 里唯一会**执行外部代码**的地方，所以纪律比别处更硬：
 *
 * 1. **杀进程组**。`detached: true` + `process.kill(-pid)`。只杀直接子进程的话，
 *    yt-dlp / ffmpeg 这类会留下孙子进程继续往磁盘写 —— 那既绕过配额统计，
 *    也让「超时」变成一个假动作。
 * 2. **封顶之后继续读管道**。超了 `maxOutputBytes` 只是不再保存，绝不能停止消费：
 *    管道满了子进程会被 write 阻塞，表现是「脚本卡死」，而其实它在等我们读。
 * 3. **权威结果永远是 RunResult**。`onStdout` / `onStderr` 是尽力而为的流式展示，
 *    一次回调都没收到也要能跑完；库里的 `run_records` 才是事后追查的依据。
 * 4. **并发是排队，不是报错**。超过 `maxConcurrent` 的普通运行进 FIFO 队列；
 *    `priority: true` 只跳过闸门（健康/指标探针专用），计数与运行记录一条不少。
 */

export type RunStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'killed'

/** run_records.origin：谁发起的这次运行（docs/02 §5）。 */
export type RunOrigin = 'workspace' | 'temp' | 'probe' | 'metric' | 'action'

export type ScriptInfo = {
  name: string
  bytes: number
  mtimeMs: number
  /** 文件开头 80 字符的用途说明；脚本第一行注释会被当作描述。 */
  description: string
  /** 最近一次运行（可为空）。 */
  lastRun?: { status: RunStatus; exitCode: number | null; startedAt: number; durationMs: number }
}

export type RunResult = {
  status: RunStatus
  exitCode: number | null
  signal: string
  startedAt: number
  endedAt: number
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  recordId: number
}

export type RunScriptInput = {
  name: string
  args?: string[]
  triggeredBy?: string
  /** 覆盖 run_records.origin：探针/指标/动作要写自己的来源。 */
  origin?: RunOrigin
  /** 只跳过并发闸门（上限见 MAX_PRIORITY_INFLIGHT），不跳过任何计数与记录。 */
  priority?: boolean
  /** 覆盖配置里的墙钟超时（毫秒）；ProbeScript / ActionDef 可以自带。 */
  timeoutMs?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type RunTempScriptInput = RunScriptInput & { content: string }

/** 运行历史保留条数（docs/02 §5）。 */
const RUN_HISTORY_LIMIT = 1000

/** 优先级运行的在飞上限：绕过闸门，但不能无限绕。 */
export const MAX_PRIORITY_INFLIGHT = 4

/** 临时脚本体积上限。再大就不像「一次性的小脚本」了。 */
export const MAX_TEMP_SCRIPT_BYTES = 1 * 1024 * 1024

/** 一次性令牌有效期。 */
export const RUN_TOKEN_TTL_MS = 5 * 60_000

const MAX_ARGS_BYTES = 32 * 1024

// ---------------------------------------------------------------------------
// 运行令牌（RAVEN_TOKEN ↔ run_records.id）
// ---------------------------------------------------------------------------

const runTokens = new Map<string, { runId: number; script: string; expiresAt: number }>()

/**
 * 登记一次运行的一次性令牌。`POST /api/ingest/metrics` 用它把外部推来的
 * 指标记到对应的 `run_records.id` 上（并累加 metricCalls）。
 */
export function registerRunToken(token: string, info: { runId: number; script: string }): void {
  if (typeof token !== 'string' || token === '') return
  runTokens.set(token, { runId: info.runId, script: info.script, expiresAt: Date.now() + RUN_TOKEN_TTL_MS })
}

/**
 * 校验并取出令牌对应的运行。
 *
 * ⚠️ 这里是**有效期内的可重复使用**，不是「用一次就作废」：一个脚本在一次运行里
 * 可能分多批推指标（`run_records.metricCalls` 就是为此存在的），一次性核销会让
 * 第二批复指标全部 401。同时做滑动续期 —— 长任务（timeoutMs 上限 1 小时）
 * 不该在跑到一半时令牌失效，而闲置的令牌仍然会过期。
 */
export function consumeRunToken(token: unknown): { runId: number; script: string } | null {
  if (typeof token !== 'string' || token === '') return null
  const entry = runTokens.get(token)
  if (!entry) return null
  const now = Date.now()
  if (entry.expiresAt <= now) {
    runTokens.delete(token)
    return null
  }
  entry.expiresAt = now + RUN_TOKEN_TTL_MS
  return { runId: entry.runId, script: entry.script }
}

// 每分钟扫一次。`unref()` 是必须的：否则脚本跑完后进程会被这个定时器拖住不退出。
const tokenSweep = setInterval(() => {
  const now = Date.now()
  for (const [token, entry] of runTokens) {
    if (entry.expiresAt <= now) runTokens.delete(token)
  }
}, 60_000)
if (typeof tokenSweep.unref === 'function') tokenSweep.unref()

/** 验证脚本与测试用：清掉所有令牌。 */
export function clearRunTokens(): void {
  runTokens.clear()
}

// ---------------------------------------------------------------------------
// 并发闸门
// ---------------------------------------------------------------------------

type Waiter = { resolve: () => void }

let normalActive = 0
let priorityActive = 0
const normalQueue: Waiter[] = []
const priorityQueue: Waiter[] = []

function maxConcurrent(): number {
  return getConfig().config.scripts.execution.maxConcurrent
}

/**
 * 放行排队者。
 *
 * 优先级与普通运行是**两套计数**：priority 完全跳过 maxConcurrent，只受 4 个在飞
 * 上限约束。这样「两个 10 分钟的下载占满槽位」不会让 Dashboard 的健康探针停摆。
 */
function pump(): void {
  while (priorityActive < MAX_PRIORITY_INFLIGHT && priorityQueue.length > 0) {
    priorityActive += 1
    ;(priorityQueue.shift() as Waiter).resolve()
  }
  const max = maxConcurrent()
  while (normalActive < max && normalQueue.length > 0) {
    normalActive += 1
    ;(normalQueue.shift() as Waiter).resolve()
  }
}

async function acquireSlot(priority: boolean): Promise<void> {
  if (priority) {
    if (priorityActive < MAX_PRIORITY_INFLIGHT && priorityQueue.length === 0) {
      priorityActive += 1
      return
    }
    await new Promise<void>((resolve) => {
      priorityQueue.push({ resolve })
      pump()
    })
    return
  }
  if (normalActive < maxConcurrent() && normalQueue.length === 0) {
    normalActive += 1
    return
  }
  await new Promise<void>((resolve) => {
    normalQueue.push({ resolve })
    pump()
  })
}

function releaseSlot(priority: boolean): void {
  if (priority) priorityActive = Math.max(0, priorityActive - 1)
  else normalActive = Math.max(0, normalActive - 1)
  pump()
}

async function withSlot<T>(priority: boolean, work: () => Promise<T>): Promise<T> {
  await acquireSlot(priority)
  try {
    return await work()
  } finally {
    releaseSlot(priority)
  }
}

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

type PlaceholderVars = {
  workspace: string
  files: string
  uploads: string
  tmp: string
  clipboard: string
  scripts: string
  root: string
}

/**
 * 展开 `{workspace}` 这类占位符。
 *
 * 只认白名单里的键：写错的 `{workpsace}` 原样留着，比悄悄变成空串好查 ——
 * 空串会让脚本拿到一个「合法的空路径」，然后往 cwd 里写东西。
 */
function expandPlaceholders(value: string, vars: PlaceholderVars): string {
  return value.replace(/\{(workspace|files|uploads|tmp|clipboard|scripts|root)\}/g, (match, key: string) => {
    const resolved = vars[key as keyof PlaceholderVars]
    return resolved ?? match
  })
}

/**
 * 脚本的稳定环境变量接口（契约 §5 的表）。
 *
 * 直接调用时 `RAVEN_TMPDIR` 给的是 tempRoot（还没有「本次运行」）；真正跑一次
 * 运行时会覆盖成那一次的专属目录。
 *
 * ⚠️ 配置里的 `scripts.env` 先拼、稳定接口后拼：配置里写 `RAVEN_WORKSPACE`
 * 不能把脚本的「默认输出位置」改到别处，那是接口契约不是偏好设置。
 * 调用方要覆盖就走 `extra`（内部运行也走它）。
 */
export function buildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const { config, sandbox } = getConfig()
  const uploads = path.join(sandbox.filesRoot, 'uploads')
  try {
    // RAVEN_UPLOADS 是「约定俗成的上传落点」，脚本会直接往里写，所以得先存在。
    // buildEnv 是同步接口（探针在一堆 await 之间随手调），只能用 mkdirSync。
    fs.mkdirSync(uploads, { recursive: true })
  } catch (error) {
    console.error('[raven] 创建 uploads 目录失败：', uploads, error)
  }

  const vars: PlaceholderVars = {
    workspace: sandbox.filesRoot,
    files: sandbox.filesRoot,
    uploads,
    tmp: sandbox.tempRoot,
    clipboard: sandbox.clipboardRoot,
    scripts: sandbox.scriptsRoot,
    root: sandbox.root,
  }

  const fromConfig: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.scripts.env)) {
    if (key === '') continue
    // null → 空串：配置里显式写 null 通常是「这个键先占位」，
    // 给空串比让子进程完全没有这个变量更可预期（`env FOO=` 就是这样）。
    fromConfig[key] = expandPlaceholders(value === null ? '' : String(value), vars)
  }

  return {
    ...fromConfig,
    RAVEN_WORKSPACE: vars.workspace,
    RAVEN_FILES: vars.files,
    RAVEN_UPLOADS: vars.uploads,
    RAVEN_TMPDIR: vars.tmp,
    RAVEN_CLIPBOARD: vars.clipboard,
    RAVEN_SCRIPTS: vars.scripts,
    RAVEN_ROOT: vars.root,
    RAVEN_API: config.services.publicBaseUrl ?? `http://127.0.0.1:${process.env.PORT ?? '5800'}`,
    RAVEN_VERSION,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// 脚本列表
// ---------------------------------------------------------------------------

function clipDescription(text: string): string {
  return text.replace(/[\r\n]/g, ' ').trim().slice(0, 80)
}

/**
 * 从文件开头抽用途说明。
 *
 * 只认**第一段注释**：跳过 shebang 与空行，`//` 行直接取文本，`/* *\/`
 * 取块内第一行有内容的（并剥掉行首的 `*`）。遇到第一行非注释代码就收手 ——
 * 继续往文件深处找，会把随机一行代码里的注释当成用途说明。
 */
function extractDescription(head: string): string {
  let inBlock = false
  for (const rawLine of head.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#!')) continue
    if (inBlock) {
      const closed = line.includes('*/')
      const text = line.replace(/^\*+\s?/, '').replace(/\*\/\s*$/, '').trim()
      if (text !== '') return clipDescription(text)
      if (closed) return ''
      continue
    }
    if (line.startsWith('//')) {
      const text = line.replace(/^\/\/+/, '').trim()
      if (text !== '') return clipDescription(text)
      continue
    }
    if (line.startsWith('/*')) {
      const text = line.replace(/^\/\*+/, '').replace(/\*\/\s*$/, '').trim()
      if (text !== '') return clipDescription(text)
      inBlock = true
      continue
    }
    return ''
  }
  return ''
}

async function readDescription(absolute: string): Promise<string> {
  const handle = await fsp.open(absolute, 'r')
  try {
    // 只读开头 4KiB：scripts/ 下可能躺着几百 MB 的导出物，为了 80 个字符
    // 把整份读进内存不值得。
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return extractDescription(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await handle.close()
  }
}

const scriptNameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'variant' })

export async function listScripts(): Promise<ScriptInfo[]> {
  const { sandbox } = getConfig()
  await sandbox.ensureRoots()
  let dirents: fs.Dirent[]
  try {
    dirents = await fsp.readdir(sandbox.scriptsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const scripts: ScriptInfo[] = []
  for (const dirent of dirents) {
    // 只看这一层，且只认普通文件：软链一律不算（resolveScript 也会拒掉
    // 指向 scripts/ 之外的软链，列出来只会让用户点了才发现跑不了）。
    if (!dirent.isFile() || !/\.(mjs|js)$/i.test(dirent.name)) continue
    try {
      const stats = await fsp.stat(path.join(sandbox.scriptsRoot, dirent.name))
      if (!stats.isFile()) continue
      const info: ScriptInfo = {
        name: dirent.name,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        description: await readDescription(path.join(sandbox.scriptsRoot, dirent.name)),
      }
      const last = dbRunList(1, dirent.name)[0]
      if (last) {
        info.lastRun = {
          // 库里只会写这五种状态（见 RunStatus），直接收窄。
          status: last.status as RunStatus,
          exitCode: last.exitCode,
          startedAt: last.startedAt,
          durationMs: last.durationMs,
        }
      }
      scripts.push(info)
    } catch {
      // 列脚本期间文件被删/断链：跳过这一条，别让整个列表打不开。
      continue
    }
  }
  scripts.sort((a, b) => scriptNameCollator.compare(a.name, b.name))
  return scripts
}

// ---------------------------------------------------------------------------
// 输出采集
// ---------------------------------------------------------------------------

function resolveTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(3_600_000, Math.max(1000, Math.trunc(value)))
}

function normalizeArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const args = value.filter((item): item is string => typeof item === 'string').map((item) => item.replace(/\0/g, ''))
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGS_BYTES) {
    throw new SandboxError('args_too_long', `参数总长度超过 ${humanBytes(MAX_ARGS_BYTES)}，请改用脚本内的配置文件。`, 400)
  }
  return args
}

/**
 * 一路输出的采集器。
 *
 * 两个约束同时成立：
 * - **按字节封顶**（`maxOutputBytes` 是字节），而字符串长度不是字节数 ——
 *   中文脚本输出尤其明显。所以先按字节攒 Buffer，最后一次性解码。
 * - **封顶后仍然继续读**：`push()` 直接返回，但调用方照旧把 chunk 交过来，
 *   管道因此不会反压。截断之后也不再回调 `onStdout`：继续推流只会把浏览器
 *   的内存吃光，而这时前端已经有「已截断」的事实。
 */
class OutputSink {
  private readonly chunks: Buffer[] = []
  private readonly decoder = new StringDecoder('utf8')
  private bytes = 0
  private truncated = false

  constructor(private readonly limit: number, private readonly onChunk?: (chunk: string) => void) {}

  push(chunk: Buffer): void {
    if (this.truncated) return
    const room = this.limit - this.bytes
    if (chunk.length <= room) {
      this.chunks.push(chunk)
      this.bytes += chunk.length
      this.onChunk?.(this.decoder.write(chunk))
      return
    }
    if (room > 0) {
      const head = chunk.subarray(0, room)
      this.chunks.push(head)
      this.bytes += room
      this.onChunk?.(this.decoder.write(head))
    }
    this.truncated = true
  }

  finish(): void {
    if (this.truncated) return
    const tail = this.decoder.end()
    if (tail !== '') this.onChunk?.(tail)
  }

  get isTruncated(): boolean {
    return this.truncated
  }

  text(): string {
    // 权威文本按字节拼完再解码，不依赖回调路径。
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    // 负 pid = 整个进程组。孙子进程（ffmpeg/yt-dlp 是典型）就在这里被一起收掉。
    process.kill(-pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return // 组已经没了，正常收尾
    // 没有权限或没有进程组（比如已经 setsid 走了）：退回杀直接子进程。
    try {
      child.kill(signal)
    } catch {
      // 已经退出了。
    }
  }
}

// ---------------------------------------------------------------------------
// 单次运行
// ---------------------------------------------------------------------------

type ExecuteInput = {
  script: string
  origin: RunOrigin
  commandArgs: string[]
  cwd: string
  tempDir: string
  args: string[]
  timeoutMs: number
  triggeredBy: string
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

function verdict(timedOut: boolean, signal: NodeJS.Signals | null, code: number | null, failedToSpawn: boolean): RunStatus {
  if (failedToSpawn) return 'failed'
  // 超时了就报 timeout —— 哪怕进程是「优雅地」退出 3 的，那也是我们叫它停的。
  if (timedOut && (signal !== null || code !== 0)) return 'timeout'
  if (code === 0) return 'ok'
  if (signal !== null) return 'killed' // 被外部信号杀掉，不是脚本自己的判断
  return 'failed'
}

async function executeScript(input: ExecuteInput): Promise<RunResult> {
  const { config } = getConfig()
  const startedAt = Date.now()

  // 先插一条 running：脚本崩溃/机器断电时，历史里留下的是「跑到一半」而不是
  // 什么都没有 —— 后者会被误读成「从来没跑过」。
  const recordId = dbRunInsert({
    script: input.script,
    origin: input.origin,
    status: 'running',
    startedAt,
    triggeredBy: input.triggeredBy,
  })

  const token = randomBytes(24).toString('hex')
  registerRunToken(token, { runId: recordId, script: input.script })

  const env: NodeJS.ProcessEnv = {
    // ⚠️ 必须继承父进程环境：脚本要调 yt-dlp / ffmpeg（靠 PATH）、要 TZ、
    // 要 HOME 找缓存。只给 RAVEN_* 会让「本地能跑、raven 里跑不了」。
    // 直接铺 process.env（而不是自己过滤成 Record）是因为 Next 的类型把
    // ProcessEnv.NODE_ENV 标成必填，从索引签名构造出来的对象过不了类型检查。
    ...process.env,
    ...buildEnv(),
    RAVEN_TMPDIR: input.tempDir,
    RAVEN_SCRIPT_NAME: input.script,
    RAVEN_SCRIPT_ARGS: JSON.stringify(input.args),
    RAVEN_TOKEN: token,
    RAVEN_RUN_ID: String(recordId),
  }

  const limit = config.scripts.execution.maxOutputBytes
  const stdoutSink = new OutputSink(limit, input.onStdout)
  const stderrSink = new OutputSink(limit, input.onStderr)

  // 用对象持有跨回调的状态：`let` 会被 TypeScript 在闭包外收窄成初始值，
  // 而这两个标志恰恰是「回调里写、回调外读」。
  const state: { spawnError: Error | null; timedOut: boolean } = { spawnError: null, timedOut: false }
  let outcome: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null }
  let timeoutTimer: NodeJS.Timeout | null = null
  let killTimer: NodeJS.Timeout | null = null

  try {
    let child: ChildProcess | null = null
    try {
      child = spawn(process.execPath, input.commandArgs, {
        cwd: input.cwd,
        env,
        detached: true, // 自成进程组，超时才能整组杀
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      state.spawnError = error as Error
    }

    if (child !== null) {
      // 收窄成 const 再进闭包：否则定时器回调里看到的是 `ChildProcess | null`。
      const proc = child
      proc.stdout?.on('data', (chunk: Buffer) => stdoutSink.push(chunk))
      proc.stderr?.on('data', (chunk: Buffer) => stderrSink.push(chunk))

      timeoutTimer = setTimeout(() => {
        state.timedOut = true
        killProcessGroup(proc, 'SIGTERM')
        // 3 秒宽限：ffmpeg/yt-dlp 收到 SIGTERM 要收尾（写 moov、关字幕），
        // 立刻 SIGKILL 会留下损坏的输出文件。宽限不是「再等等看」，到点就杀。
        killTimer = setTimeout(() => killProcessGroup(proc, 'SIGKILL'), 3000)
      }, input.timeoutMs)

      outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        let settled = false
        const settle = (value: { code: number | null; signal: NodeJS.Signals | null }): void => {
          if (settled) return
          settled = true
          resolve(value)
        }
        proc.once('error', (error) => {
          // spawn 失败（ENOENT 之类）走这里，close 也可能跟着来。
          state.spawnError = error
          settle({ code: null, signal: null })
        })
        proc.once('close', (code, signal) => settle({ code, signal }))
      })
    }
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer)
    if (killTimer !== null) clearTimeout(killTimer)
    stdoutSink.finish()
    stderrSink.finish()
  }

  const endedAt = Date.now()
  const status = verdict(state.timedOut, outcome.signal, outcome.code, state.spawnError !== null)
  const stdout = stdoutSink.text()
  const capturedStderr = stderrSink.text()
  const stderr =
    state.spawnError === null
      ? capturedStderr
      : capturedStderr === ''
        ? `启动失败：${state.spawnError.message}`
        : `${capturedStderr}\n启动失败：${state.spawnError.message}`

  // 库里存的是**同一份已截断文本**：运行历史和流式展示说的是同一件事，
  // 否则事后追查会看到「界面截断了、库里还在长」这种对不上的情况。
  dbRunFinish(recordId, {
    status,
    exitCode: outcome.code,
    endedAt,
    durationMs: endedAt - startedAt,
    stdout,
    stderr,
    truncated: stdoutSink.isTruncated || stderrSink.isTruncated ? 1 : 0,
    signal: outcome.signal ?? '',
  })
  dbRunPrune(RUN_HISTORY_LIMIT)

  return {
    status,
    exitCode: outcome.code,
    signal: outcome.signal ?? '',
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    stdout,
    stderr,
    truncated: stdoutSink.isTruncated || stderrSink.isTruncated,
    recordId,
  }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true })
  } catch (error) {
    // 删不掉（句柄没释放）**不能**让运行结果变成失败：脚本已经跑完了，
    // 结论就是脚本的结论。留一行日志，剩下交给下一次清理。
    console.error('[raven] 清理临时脚本目录失败：', dir, error)
  }
}

/** 临时脚本的文件名消毒：只留单个 basename，且强制 `.mjs`（见 runTempScript 注释）。 */
export function sanitizeScriptName(raw: unknown): string {
  const source = typeof raw === 'string' ? raw : ''
  const tail = source.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = tail
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[\s.]+/, '')
    .replace(/\s+$/, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'script.mjs'
  return cleaned
}

async function startRun(input: ExecuteInput, priority: boolean, prepare?: () => Promise<void>): Promise<RunResult> {
  return withSlot(priority, async () => {
    await fsp.mkdir(input.tempDir, { recursive: true })
    try {
      if (prepare) await prepare()
      return await executeScript(input)
    } finally {
      // 失败也不能泄漏：临时目录里可能有脚本下载了一半的东西。
      await cleanupTempDir(input.tempDir)
    }
  })
}

/**
 * 运行前的准入检查：执行开关 + 脚本名解析。
 *
 * 单独导出是为了让 route 能在**开事件流之前**验一次：脚本不存在或执行被关掉时，
 * 调用方（lib/api.ts 的 apiStream）期待的是一个普通信封错误（403/404 + JSON），
 * 而不是一个 HTTP 200 的事件流里塞一个 error 事件。
 */
export async function assertScriptRunnable(name: unknown): Promise<{ absolute: string; relative: string }> {
  const { config, sandbox } = getConfig()
  await sandbox.ensureRoots()
  if (!config.workspace.allowScriptExecution) {
    throw new SandboxError(
      'script_disabled',
      '配置里关掉了脚本执行（workspace.allowScriptExecution=false），现在只能跑临时上传的脚本。',
      403
    )
  }
  return sandbox.resolveScript(name)
}

export async function runWorkspaceScript(input: RunScriptInput): Promise<RunResult> {
  const { config, sandbox } = getConfig()
  // 解析放在排队之前：名字不合法/文件不存在立刻回 400/404，
  // 而不是让调用方在队列里等半天才拿到一个错误。
  const script = await assertScriptRunnable(input.name)
  const args = normalizeArgs(input.args)
  const commandArgs: ExecuteInput = {
    script: path.basename(script.relative),
    origin: input.origin ?? 'workspace',
    commandArgs: [script.absolute, ...args],
    cwd: sandbox.filesRoot, // 脚本的默认输出位置就是文件管理器那棵树
    tempDir: path.join(sandbox.tempRoot, runTempName()),
    args,
    timeoutMs: resolveTimeout(input.timeoutMs, config.scripts.execution.timeoutMs),
    triggeredBy: input.triggeredBy ?? 'api',
    onStdout: input.onStdout,
    onStderr: input.onStderr,
  }
  return startRun(commandArgs, input.priority === true)
}

export async function runTempScript(input: RunTempScriptInput): Promise<RunResult> {
  const { config, sandbox } = getConfig()
  await sandbox.ensureRoots()
  const content = typeof input.content === 'string' ? input.content : ''
  const size = Buffer.byteLength(content, 'utf8')
  if (size > MAX_TEMP_SCRIPT_BYTES) {
    throw new SandboxError('script_too_large', `临时脚本 ${humanBytes(size)} 超过 ${humanBytes(MAX_TEMP_SCRIPT_BYTES)} 上限。`, 413)
  }
  const args = normalizeArgs(input.args)
  const displayName = sanitizeScriptName(input.name)
  // ⚠️ 落盘的扩展名强制成 `.mjs`。上传的文件名常常是 `.js`，而 `.js` 是不是 ESM
  // 取决于最近的 package.json 的 `type` —— 那个文件不归这一层管，不能赌。
  // 契约里临时脚本的语义就是 ESM（原本走 `node --input-type=module -`）。
  const diskName = `${displayName.replace(/\.(mjs|js)$/i, '')}.mjs`
  const tempDir = path.join(sandbox.tempRoot, runTempName())
  const scriptPath = path.join(tempDir, diskName)
  if (!isInside(tempDir, scriptPath)) {
    throw new SandboxError('invalid_script', '临时脚本的文件名不合法。', 400)
  }

  const command: ExecuteInput = {
    script: displayName,
    origin: input.origin ?? 'temp',
    commandArgs: [scriptPath, ...args],
    cwd: tempDir,
    tempDir,
    args,
    timeoutMs: resolveTimeout(input.timeoutMs, config.scripts.execution.timeoutMs),
    triggeredBy: input.triggeredBy ?? 'api',
    onStdout: input.onStdout,
    onStderr: input.onStderr,
  }

  return startRun(command, input.priority === true, async () => {
    await fsp.writeFile(scriptPath, content, { flag: 'wx' })
  })
}

export function listRuns(limit: number, script?: string): RunRow[] {
  const cap = Number.isFinite(limit) ? Math.trunc(limit) : 50
  return dbRunList(Math.min(500, Math.max(1, cap)), script !== undefined && script !== '' ? script : undefined)
}

export function getRun(id: number): RunRow | undefined {
  return dbRunGet(id)
}
