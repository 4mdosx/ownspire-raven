import 'server-only'
import { execFile } from 'node:child_process'
import type { Stats } from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { dbSampleInsert, dbSamplePrune, dbSnapshotAll, dbSnapshotPut } from '@/backstage/db/database'
import type { ServiceSnapshotRow } from '@/backstage/db/database'
import { getConfig } from '@/backstage/lib/config'
import { isInside, isSandboxError } from '@/backstage/lib/sandbox'
import { runWorkspaceScript } from '@/backstage/services/runner.service'
import type { ServiceSnapshot } from '@/backstage/services/registry.service'
import type { Probe, ProbeDocker, ProbeFile, ProbeHttp, ProbeScript, ProbeTcp } from '@/types/config'

/**
 * 健康采集。
 *
 * 三条贯穿全文件的纪律，改动前先看这三条：
 *
 * 1. **探针不许把 dashboard 拖死。** 每个探针都有自己的墙钟上限，超时是
 *    `down`（或者明确的一句话），不是「一直转圈」。探针之间并行但**并发上限 6**：
 *    上游是别人家的服务，不是 raven 的免费资源，一次刷新放 60 个连接会变成
 *    对上游的小型压测。
 * 2. **缓存优先于新鲜。** `services.sampleIntervalSeconds` 之内直接回放上一次采样
 *    （`fromCache: true`）。Dashboard 是轮询页面，用户按 F5 的频率和上游该承受的
 *    请求量完全无关。
 * 3. **拿不到答案就说拿不到。** docker 探针在既没有 socket 又没有 CLI 时报
 *    `warn` + 「无法访问 Docker」，而不是假装容器死了。含糊的 `down` 会让人去
 *    重启一个本来活得好好的服务。
 */

export type ProbeStatus = 'ok' | 'warn' | 'down'
export type ServiceStatus = 'ok' | 'warn' | 'down' | 'unknown'

export type ProbeResult = {
  index: number
  type: Probe['type']
  status: ProbeStatus
  latencyMs: number
  message: string
  version: string
}

export type HealthReport = {
  serviceId: string
  status: ServiceStatus
  latencyMs: number | null
  message: string
  version: string
  checkedAt: number
  okCount: number
  totalCount: number
  probes: ProbeResult[]
  fromCache: boolean
}

/** 一条探针的判定结果；`index`/`type`/`latencyMs` 由调度器统一补上。 */
type ProbeOutcome = { status: ProbeStatus; message: string; version: string }

const DEFAULT_HTTP_TIMEOUT_MS = 5000
const DEFAULT_TCP_TIMEOUT_MS = 5000
const DEFAULT_DOCKER_TIMEOUT_MS = 5000
/** 并行探针上限。见文件头第 1 条。 */
const MAX_PROBE_CONCURRENCY = 6
/** HTTP 响应体最多读这么多字节；健康响应应该很短，长到离谱的只留开头做诊断。 */
const MAX_BODY_BYTES = 64 * 1024
const DOCKER_UNAVAILABLE = '无法访问 Docker（既没有 socket 也没有 docker CLI）'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * JSON 值的深比较。
 *
 * 不用 `JSON.stringify` 比字符串：对象键顺序不同会判不等，而 `{a:1,b:2}` 与
 * `{b:2,a:1}` 对「期望字段是否满足」这件事是同一个答案。
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>
    const b = right as Record<string, unknown>
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * 按 `a.b.c` 取值。`expectJson` 与 `versionField` 都吃这一套：
 * 契约里的键是顶层字段，但写 `build.version` 是无害的超集 ——
 * 真有一个字段名里带点的 JSON 时，这里会先按整键取一次，取不到才拆点。
 */
function readJsonPath(value: unknown, key: string): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const direct = (value as Record<string, unknown>)[key]
    if (direct !== undefined) return direct
  }
  let cursor: unknown = value
  for (const segment of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function oneLine(text: string, max = 200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function humanAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时`
  return `${Math.round(seconds / 86_400)} 天`
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `请求超时（>${timeoutMs}ms）`
    if (error.name === 'AbortError') return `请求被中止（>${timeoutMs}ms）`
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) {
      return `${error.message}（${cause.message}）`
    }
    return error.message
  }
  return String(error)
}

function describeSocketError(error: NodeJS.ErrnoException): string {
  const code = error.code ?? ''
  if (code === 'ECONNREFUSED') return '连接被拒绝（端口没有在监听）'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `域名解析失败（${code}）`
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `主机不可达（${code}）`
  if (code === 'ECONNRESET') return '连接被对端重置'
  if (code === 'ETIMEDOUT') return '连接超时'
  return code === '' ? error.message : `${code}：${error.message}`
}

/** 固定并发上限的 map，保持结果顺序（探针顺序就是配置里的顺序）。 */
async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function resolveProbeUrl(raw: string, baseUrl: string | undefined): string | null {
  if (/^https?:\/\//i.test(raw)) return raw
  if (baseUrl === undefined || baseUrl === '') return null
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}

/** 读响应体，带字节上限；读失败（超时/连接断）不抛，把原因带回给调用方。 */
async function readBodyCapped(response: Response): Promise<{ text: string; error: string | null }> {
  const body = response.body
  if (body === null) return { text: '', error: null }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const decode = (): string =>
    total === 0 ? '' : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, MAX_BODY_BYTES).toString('utf8')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      if (value === undefined) continue
      chunks.push(value)
      total += value.byteLength
      if (total >= MAX_BODY_BYTES) {
        // 够诊断了就别把整个响应拖下来 —— 探针是每分钟都要跑的东西。
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch (error) {
    return { text: decode(), error: describeFetchError(error, 0) }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 已经释放过了。
    }
  }
  return { text: decode(), error: null }
}

/**
 * 重定向：**不跟随，3xx 判为 warn**。
 *
 * 跟随重定向会把「配置里那个地址已经不对了」这件事藏起来：探针去请求运维从未
 * 授权的主机（可能是被劫持的 DNS、也可能是一个测试环境），而 dashboard 全绿。
 * 手动模式下 3xx 带上 `Location` 原样报出来，人一眼就知道该改配置。
 * 3xx 是「服务活着，但不在这个地址」，所以是 warn 而不是 down。
 */
async function probeHttp(probe: ProbeHttp, baseUrl: string | undefined): Promise<ProbeOutcome> {
  const timeoutMs = probe.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const url = resolveProbeUrl(probe.url, baseUrl)
  if (url === null) {
    return { status: 'down', message: `http 探针需要绝对 URL 或在服务上写 baseUrl（当前是 ${probe.url}）`, version: '' }
  }

  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: probe.headers,
      redirect: 'manual',
    })
  } catch (error) {
    return { status: 'down', message: describeFetchError(error, timeoutMs), version: '' }
  }

  const { text: body, error: bodyError } = await readBodyCapped(response)
  const status = response.status
  const snippet = oneLine(body)
  const location = response.headers.get('location')

  if (probe.expectStatus !== undefined) {
    if (status !== probe.expectStatus) {
      return {
        status: 'down',
        message: `HTTP ${status}（期望 ${probe.expectStatus}）${snippet === '' ? '' : `：${snippet}`}`,
        version: '',
      }
    }
  } else if (status < 200 || status >= 300) {
    if (status >= 300 && status < 400) {
      return {
        status: 'warn',
        message: `HTTP ${status}${location === null ? '' : ` → ${location}`}（探针不跟随重定向，请把配置里的地址改成最终地址）`,
        version: '',
      }
    }
    return { status: 'down', message: `HTTP ${status}${snippet === '' ? '' : `：${snippet}`}`, version: '' }
  }

  if (bodyError !== null) {
    return { status: 'down', message: `HTTP ${status} 的响应体没读完：${bodyError}`, version: '' }
  }

  const needsJson = probe.expectJson !== undefined || probe.versionField !== undefined
  let parsed: unknown = null
  if (needsJson) {
    try {
      parsed = JSON.parse(body)
    } catch {
      return { status: 'down', message: `HTTP ${status} 但响应体不是 JSON${snippet === '' ? '' : `：${snippet}`}`, version: '' }
    }
  }

  if (probe.expectJson !== undefined) {
    const mismatches: string[] = []
    for (const [key, expected] of Object.entries(probe.expectJson)) {
      const actual = readJsonPath(parsed, key)
      if (!deepEqual(actual, expected)) {
        mismatches.push(`${key} 期望 ${JSON.stringify(expected) ?? 'undefined'}，实际 ${JSON.stringify(actual) ?? 'undefined'}`)
      }
    }
    if (mismatches.length > 0) {
      return { status: 'down', message: `字段不符：${oneLine(mismatches.join('；'), 300)}`, version: '' }
    }
  }

  // versionField 取不到值**不算异常**：它只是展示用的元数据，不该把健康分拉低。
  let version = ''
  if (probe.versionField !== undefined) {
    const raw = readJsonPath(parsed, probe.versionField)
    if (typeof raw === 'string') version = raw
    else if (typeof raw === 'number') version = String(raw)
  }

  return { status: 'ok', message: `HTTP ${status}${version === '' ? '' : `（版本 ${version}）`}`, version }
}

// ---------------------------------------------------------------------------
// tcp
// ---------------------------------------------------------------------------

function probeTcp(probe: ProbeTcp): Promise<ProbeOutcome> {
  const timeoutMs = probe.timeoutMs ?? DEFAULT_TCP_TIMEOUT_MS
  const target = `${probe.host}:${probe.port}`
  return new Promise((resolve) => {
    let settled = false
    const socket = net.createConnection({ host: probe.host, port: probe.port })
    // 三条路径（connect/timeout/error）都必须 destroy：不 destroy 的话
    // 探针的 socket 会跟着 fd 一起留到进程结束，几分钟就是几十个句柄。
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ status: 'ok', message: `已连接 ${target}`, version: '' }))
    socket.once('timeout', () => finish({ status: 'down', message: `连接 ${target} 超时（>${timeoutMs}ms）`, version: '' }))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish({ status: 'down', message: `${target} 连不上：${describeSocketError(error)}`, version: '' })
    )
  })
}

// ---------------------------------------------------------------------------
// docker
// ---------------------------------------------------------------------------

type DockerState = { Status?: string; Running?: boolean; Health?: { Status?: string; FailingStreak?: number } }

type DockerAttempt =
  /** 拿到了容器状态。 */
  | { kind: 'state'; state: DockerState; via: 'socket' | 'cli' }
  /** socket 干脆不在（ENOENT/EACCES/连接被拒）：可以退到 CLI。 */
  | { kind: 'unreachable'; error: string }
  /** 明确答案：容器不存在。 */
  | { kind: 'not_found'; error: string }
  /** Docker 答了，但答的东西没法用（HTTP 500、坏 JSON、超时）。 */
  | { kind: 'failed'; error: string }
  | { kind: 'no_cli' }

function dockerSocketPath(): string {
  const configured = process.env.RAVEN_DOCKER_SOCK
  return configured !== undefined && configured.trim() !== '' ? configured : '/var/run/docker.sock'
}

/** Docker Engine API over unix socket。不引 dockerode：一个 GET 不值得一层依赖。 */
function dockerApiInspect(socketPath: string, container: string, timeoutMs: number): Promise<DockerAttempt> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (attempt: DockerAttempt): void => {
      if (settled) return
      settled = true
      resolve(attempt)
    }
    const request = http.request(
      {
        socketPath,
        path: `/containers/${encodeURIComponent(container)}/json`,
        method: 'GET',
        headers: { host: 'docker', accept: 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 4 * 1024 * 1024) {
            request.destroy()
            finish({ kind: 'failed', error: 'Docker 的响应大得离谱，已放弃' })
            return
          }
          chunks.push(chunk)
        })
        response.on('error', (error: Error) => finish({ kind: 'failed', error: `读 Docker 响应失败：${error.message}` }))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode ?? 0
          if (status === 404) return finish({ kind: 'not_found', error: `容器 ${container} 不存在` })
          if (status < 200 || status >= 300) {
            return finish({ kind: 'failed', error: `Docker API HTTP ${status}${text.trim() === '' ? '' : `：${oneLine(text)}`}` })
          }
          try {
            const parsed = JSON.parse(text) as { State?: DockerState }
            finish({ kind: 'state', state: parsed.State ?? {}, via: 'socket' })
          } catch {
            finish({ kind: 'failed', error: 'Docker API 返回的不是 JSON' })
          }
        })
      }
    )
    request.setTimeout(timeoutMs, () => {
      // 超时不退 CLI：CLI 也走同一个 daemon，只会把等待时间翻倍。
      timedOut = true
      request.destroy()
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (timedOut) return finish({ kind: 'failed', error: `Docker API 超时（>${timeoutMs}ms）` })
      const code = error.code ?? ''
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ECONNREFUSED' || code === 'ENOTDIR') {
        return finish({ kind: 'unreachable', error: `socket ${socketPath} 用不了（${code}）` })
      }
      finish({ kind: 'failed', error: `访问 ${socketPath} 失败：${describeSocketError(error)}` })
    })
    request.end()
  })
}

/** 回退路径。**必须 execFile**：容器名来自配置文件，拼 shell 字符串就是一条注入。 */
function dockerCliInspect(container: string, timeoutMs: number): Promise<DockerAttempt> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['inspect', '--format', '{{json .State}}', container],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          try {
            resolve({ kind: 'state', state: JSON.parse(stdout.trim()) as DockerState, via: 'cli' })
          } catch {
            resolve({ kind: 'failed', error: 'docker inspect 的输出不是 JSON' })
          }
          return
        }
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (code === 'ENOENT') return resolve({ kind: 'no_cli' })
        const failure = error as Error & { killed?: boolean; signal?: string }
        if (failure.killed === true || (failure.signal !== undefined && failure.signal !== '')) {
          return resolve({ kind: 'failed', error: `docker inspect 超时（>${timeoutMs}ms）` })
        }
        const detail = oneLine(stderr.trim() === '' ? (stdout.trim() === '' ? error.message : stdout) : stderr)
        if (/no such (container|object)/i.test(detail)) return resolve({ kind: 'not_found', error: `容器 ${container} 不存在` })
        resolve({ kind: 'failed', error: `docker inspect 失败：${detail}` })
      }
    )
  })
}

function interpretDockerState(container: string, state: DockerState, via: 'socket' | 'cli'): ProbeOutcome {
  const status = typeof state.Status === 'string' && state.Status !== '' ? state.Status : '未知'
  const health = state.Health?.Status
  const suffix = via === 'cli' ? '（经 docker CLI）' : ''
  // version 一律留空：镜像 tag 不是「服务版本」，硬塞进去只会误导 dashboard 上的版本列。
  if (state.Running !== true && status !== 'running') {
    return { status: 'down', message: `容器 ${container} 未运行（${status}）${suffix}`, version: '' }
  }
  if (health === 'unhealthy') return { status: 'down', message: `容器 ${container} 在跑，但 healthcheck 是 unhealthy${suffix}`, version: '' }
  if (health === 'starting') return { status: 'warn', message: `容器 ${container} 在跑，healthcheck 还在 starting${suffix}`, version: '' }
  if (health === 'healthy') return { status: 'ok', message: `容器 ${container} 运行中（healthy）${suffix}`, version: '' }
  return { status: 'ok', message: `容器 ${container} 运行中${suffix}`, version: '' }
}

async function probeDocker(probe: ProbeDocker): Promise<ProbeOutcome> {
  const container = probe.container.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) {
    // 不合法就直接判定，别把它塞进 URL 路径或 argv 里试运气。
    return { status: 'down', message: `容器名「${probe.container}」不合法（只接受字母数字点下划线短横）`, version: '' }
  }
  const timeoutMs = probe.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS
  const socketPath = dockerSocketPath()

  const viaApi = await dockerApiInspect(socketPath, container, timeoutMs)
  if (viaApi.kind === 'state') return interpretDockerState(container, viaApi.state, viaApi.via)
  if (viaApi.kind === 'not_found') return { status: 'down', message: viaApi.error, version: '' }

  const viaCli = await dockerCliInspect(container, timeoutMs)
  if (viaCli.kind === 'state') return interpretDockerState(container, viaCli.state, viaCli.via)
  if (viaCli.kind === 'not_found') return { status: 'down', message: viaCli.error, version: '' }

  if (viaApi.kind === 'unreachable' && viaCli.kind === 'no_cli') {
    return { status: 'warn', message: DOCKER_UNAVAILABLE, version: '' }
  }
  // 用 `'error' in …` 取字符串，而不是在联合类型上做属性访问：判别式收窄在
  // 「复合条件 + 提前 return」之后不可靠，这里不值得赌 TS 的控制流分析。
  const apiError = 'error' in viaApi ? viaApi.error : ''
  const cliError = 'error' in viaCli ? viaCli.error : ''
  if (viaApi.kind === 'unreachable') {
    // CLI 在、daemon 不在（或 CLI 自己出错）：依然不是「容器挂了」。
    return { status: 'warn', message: `无法访问 Docker（${apiError}；${cliError === '' ? '原因不明' : cliError}）`, version: '' }
  }
  const cliDetail = viaCli.kind === 'failed' && cliError !== '' ? `；docker CLI 也失败：${cliError}` : ''
  return { status: 'down', message: `Docker 查询失败：${apiError}${cliDetail}`, version: '' }
}

// ---------------------------------------------------------------------------
// file
// ---------------------------------------------------------------------------

async function probeFile(probe: ProbeFile): Promise<ProbeOutcome> {
  const { config, sandbox } = getConfig()
  const display = probe.path
  let absolute: string

  if (path.isAbsolute(probe.path)) {
    try {
      absolute = await fsp.realpath(probe.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { status: 'down', message: `文件不存在：${display}`, version: '' }
      return { status: 'down', message: `读不到 ${display}：${describeSocketError(error as NodeJS.ErrnoException)}`, version: '' }
    }
    // 绝对路径也必须落在受管根里：配置文件是人写的，写错一个字符就会让探针
    // 去统计 /etc 或家目录里的文件 —— 那是我们没有理由知道的东西。
    if (!isInside(config.rootPath, absolute)) {
      return { status: 'down', message: `${display} 的真身落在受管根目录之外，已拒绝检查`, version: '' }
    }
  } else {
    try {
      absolute = await sandbox.resolveExisting(probe.path)
    } catch (error) {
      if (isSandboxError(error)) {
        const label = error.code === 'not_found' ? '文件不存在' : error.message
        return { status: 'down', message: `${label}：${display}`, version: '' }
      }
      throw error
    }
  }

  let stat: Stats
  try {
    stat = await fsp.stat(absolute)
  } catch (error) {
    return { status: 'down', message: `读不到 ${display}：${describeSocketError(error as NodeJS.ErrnoException)}`, version: '' }
  }
  if (!stat.isFile()) return { status: 'down', message: `${display} 不是普通文件`, version: '' }
  if (probe.minBytes !== undefined && stat.size < probe.minBytes) {
    return { status: 'down', message: `${display} 只有 ${stat.size} 字节（要求 ≥ ${probe.minBytes}）`, version: '' }
  }
  if (probe.maxAgeSeconds !== undefined) {
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000
    if (ageSeconds > probe.maxAgeSeconds) {
      return {
        status: 'down',
        message: `${display} 已经 ${humanAge(ageSeconds)} 没更新（上限 ${probe.maxAgeSeconds}s）`,
        version: '',
      }
    }
  }
  const age = probe.maxAgeSeconds === undefined ? '' : `，${humanAge((Date.now() - stat.mtimeMs) / 1000)}前更新`
  return { status: 'ok', message: `${display} 正常（${stat.size} 字节${age}）`, version: '' }
}

// ---------------------------------------------------------------------------
// script
// ---------------------------------------------------------------------------

type ScriptNote = { status: ProbeStatus; message: string; version: string }

/** 脚本可以打一行 JSON `{status,message,version}` 来细化结论；从后往前找最后一行。 */
function readScriptNote(stdout: string): ScriptNote | null {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === '' || !line.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const candidate = parsed as { status?: unknown; message?: unknown; version?: unknown }
    if (candidate.status !== 'ok' && candidate.status !== 'warn' && candidate.status !== 'down') continue
    return {
      status: candidate.status,
      message: typeof candidate.message === 'string' ? candidate.message : '',
      version: typeof candidate.version === 'string' ? candidate.version : '',
    }
  }
  return null
}

async function probeScript(probe: ProbeScript): Promise<ProbeOutcome> {
  const { config } = getConfig()
  const timeoutMs = probe.timeoutMs ?? config.scripts.execution.timeoutMs
  // ⚠️ priority: true —— 健康探针必须跳过并发闸门。两个长任务占满槽位时，
  // 排队等 10 分钟的 dashboard 和坏了没有区别（docs/10 §5）。
  // origin/triggeredBy 分开记：事后要能一眼分出「健康探针」「指标探针」「动作」。
  const result = await runWorkspaceScript({
    name: probe.script,
    args: probe.args,
    origin: 'probe',
    timeoutMs: probe.timeoutMs,
    priority: true,
    triggeredBy: 'health',
  })
  const note = readScriptNote(result.stdout)

  if (result.status === 'timeout') {
    return { status: 'down', message: `脚本 ${probe.script} 超时（>${timeoutMs}ms），已按进程组杀掉`, version: note?.version ?? '' }
  }
  const failed = result.status !== 'ok' || (result.exitCode !== null && result.exitCode !== 0)
  if (failed) {
    const detail = oneLine(result.stderr.trim() === '' ? result.stdout : result.stderr)
    const code = result.exitCode === null ? result.status : `退出码 ${result.exitCode}`
    return {
      status: 'down',
      message: `脚本 ${probe.script} 失败（${code}）${detail === '' ? '' : `：${detail}`}`,
      version: note?.version ?? '',
    }
  }

  // 退出码是硬事实，JSON 只是细化：不让一个失败的脚本用一行 `{"status":"ok"}`
  // 把自己说成健康。
  if (note !== null) {
    return {
      status: note.status,
      message: note.message === '' ? `脚本 ${probe.script} 退出码 0` : note.message,
      version: note.version,
    }
  }
  const detail = oneLine(result.stdout, 120)
  return { status: 'ok', message: `脚本 ${probe.script} 退出码 0${detail === '' ? '' : `（${detail}）`}`, version: '' }
}

// ---------------------------------------------------------------------------
// 调度
// ---------------------------------------------------------------------------

async function runOneProbe(probe: Probe, index: number, snapshot: ServiceSnapshot): Promise<ProbeResult> {
  const startedAt = Date.now()
  let outcome: ProbeOutcome
  try {
    switch (probe.type) {
      case 'http':
        outcome = await probeHttp(probe, snapshot.def.baseUrl)
        break
      case 'tcp':
        outcome = await probeTcp(probe)
        break
      case 'docker':
        outcome = await probeDocker(probe)
        break
      case 'file':
        outcome = await probeFile(probe)
        break
      case 'script':
        outcome = await probeScript(probe)
        break
    }
  } catch (error) {
    // 单个探针内部炸掉不能带走整次采集：它是这一格的问题，不是这个服务的问题。
    outcome = { status: 'down', message: `探针内部错误：${error instanceof Error ? error.message : String(error)}`, version: '' }
  }
  return { index, type: probe.type, status: outcome.status, latencyMs: Date.now() - startedAt, message: outcome.message, version: outcome.version }
}

type RollUp = {
  status: ServiceStatus
  latencyMs: number | null
  message: string
  version: string
  okCount: number
  totalCount: number
}

/** 状态汇总规则见 docs/10 §6；`latencyMs` 取最慢的那条（它才是「dashboard 为什么慢」的答案）。 */
function rollUp(results: ProbeResult[]): RollUp {
  const totalCount = results.length
  if (totalCount === 0) {
    return { status: 'unknown', latencyMs: null, message: '没有配置探针', version: '', okCount: 0, totalCount: 0 }
  }
  const okCount = results.filter((result) => result.status === 'ok').length
  const downCount = results.filter((result) => result.status === 'down').length
  const latencyMs = results.reduce((slowest, result) => Math.max(slowest, result.latencyMs), 0)
  let status: ServiceStatus
  if (okCount === totalCount) status = 'ok'
  // 还有 ok、或者压根没有 down（全是 warn）都只是「部分不对」；一个 ok 都没有
  // 且有 down 才是真的挂了。
  else if (okCount > 0 || downCount === 0) status = 'warn'
  else status = 'down'

  const message =
    status === 'ok'
      ? `${okCount}/${totalCount} 探针正常`
      : oneLine(
          results
            .filter((result) => result.status !== 'ok')
            .map((result) => `#${result.index + 1} ${result.type}：${result.message}`)
            .join('；'),
          400
        )
  const version = results.find((result) => result.version !== '')?.version ?? ''
  return { status, latencyMs, message, version, okCount, totalCount }
}

function emptyReport(serviceId: string, status: ServiceStatus, message: string): HealthReport {
  return {
    serviceId,
    status,
    latencyMs: null,
    message,
    version: '',
    checkedAt: Date.now(),
    okCount: 0,
    totalCount: 0,
    probes: [],
    fromCache: false,
  }
}

function isProbeResult(value: unknown): value is ProbeResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.index === 'number' &&
    typeof candidate.type === 'string' &&
    (candidate.status === 'ok' || candidate.status === 'warn' || candidate.status === 'down') &&
    typeof candidate.latencyMs === 'number' &&
    typeof candidate.message === 'string' &&
    typeof candidate.version === 'string'
  )
}

function normalizeServiceStatus(value: string): ServiceStatus {
  return value === 'ok' || value === 'warn' || value === 'down' ? value : 'unknown'
}

function reportFromRow(row: ServiceSnapshotRow): HealthReport {
  let probes: ProbeResult[] = []
  try {
    const parsed: unknown = JSON.parse(row.details)
    if (Array.isArray(parsed)) probes = parsed.filter(isProbeResult)
  } catch {
    // details 是历史遗留或别的工具写的：探针明细丢了不影响总体结论。
  }
  return {
    serviceId: row.serviceId,
    status: normalizeServiceStatus(row.status),
    latencyMs: row.latencyMs,
    message: row.message,
    version: row.version,
    checkedAt: row.checkedAt,
    okCount: row.okCount,
    totalCount: row.totalCount,
    probes,
    fromCache: true,
  }
}

/**
 * 进程内快照。落库那份是给重启后用的，这份是给「同一个 tick 里十几个服务各查一次」
 * 用的：只靠 DB 的话每次 `checkService` 都要全表扫一遍 service_snapshots。
 * 只信 checkedAt：内容过不过期由调用方判定。
 */
const memorySnapshots = new Map<string, HealthReport>()

async function readCachedReport(serviceId: string): Promise<HealthReport | null> {
  const inMemory = memorySnapshots.get(serviceId)
  if (inMemory !== undefined) return inMemory
  let rows: ServiceSnapshotRow[]
  try {
    rows = await dbSnapshotAll()
  } catch (error) {
    console.error('[raven] 读服务快照失败：', error)
    return null
  }
  for (const row of rows) {
    if (!memorySnapshots.has(row.serviceId)) memorySnapshots.set(row.serviceId, reportFromRow(row))
  }
  return memorySnapshots.get(serviceId) ?? null
}

async function persist(report: HealthReport, historyLimit: number): Promise<void> {
  await dbSampleInsert({
    serviceId: report.serviceId,
    status: report.status,
    latencyMs: report.latencyMs,
    message: report.message,
    checkedAt: report.checkedAt,
  })
  await dbSnapshotPut({
    serviceId: report.serviceId,
    status: report.status,
    latencyMs: report.latencyMs,
    message: report.message,
    version: report.version,
    source: 'collector',
    details: JSON.stringify(report.probes),
    checkedAt: report.checkedAt,
    okCount: report.okCount,
    totalCount: report.totalCount,
  })
  // 每次采样后修剪，而不是只在 collectAll 里修：dashboard 用 force 轮询时
  // 一样在写历史，只靠手动采集那条路径修剪的话表会一直长。
  await dbSamplePrune(historyLimit)
}

/**
 * 采一次（或回放缓存）。
 *
 * `services.collect === false` 是硬开关：**连 force 都不越过它**。关掉采集之后
 * 一个上游请求都不该发出去 —— 这是运维在出事时按的刹车，不是建议。
 */
export async function checkService(snapshot: ServiceSnapshot, options: { force?: boolean } = {}): Promise<HealthReport> {
  const { config } = getConfig()
  const serviceId = snapshot.def.id
  const cached = await readCachedReport(serviceId)

  if (!config.services.collect) {
    return cached !== null
      ? { ...cached, fromCache: true }
      : emptyReport(serviceId, 'unknown', '采集已关闭（services.collect=false），且没有历史样本。')
  }
  if (!snapshot.enabled) return emptyReport(serviceId, 'unknown', '服务已停用。')

  const intervalMs = config.services.sampleIntervalSeconds * 1000
  if (options.force !== true && cached !== null && Date.now() - cached.checkedAt < intervalMs) {
    return { ...cached, fromCache: true }
  }

  const probes = snapshot.def.probes ?? []
  if (probes.length === 0) {
    // 没有探针就没有采样，不写库：写一条 unknown 的快照只会让缓存永远「新鲜」，
    // 把这个服务冻在 unknown 上。
    return emptyReport(serviceId, 'unknown', '没有配置探针')
  }

  const results = await mapLimited(probes, MAX_PROBE_CONCURRENCY, (probe, index) => runOneProbe(probe, index, snapshot))
  const summary = rollUp(results)
  const report: HealthReport = {
    serviceId,
    status: summary.status,
    latencyMs: summary.latencyMs,
    message: summary.message,
    version: summary.version,
    checkedAt: Date.now(),
    okCount: summary.okCount,
    totalCount: summary.totalCount,
    probes: results,
    fromCache: false,
  }

  try {
    await persist(report, config.services.historyLimit)
  } catch (error) {
    // 写库失败不能把一次成功的采集变成 500：结果照常返回，历史少一条。
    console.error(`[raven] 服务 ${serviceId} 的采样落库失败：`, error)
  }
  memorySnapshots.set(serviceId, report)
  return report
}
