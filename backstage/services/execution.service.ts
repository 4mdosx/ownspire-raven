import { executionId as newExecutionId } from '@/backstage/lib/ids'
import {
  EXECUTION_ID_PREFIX,
  toToolError,
  type ExecutionStatus,
  type ToolResult,
} from '@/backstage/lib/tool-protocol'

/**
 * 工具执行注册表 —— **每次执行都有 ID，所以每次执行都可指认、可取消。**
 *
 * ## 为什么不能「先跑起来再说」
 *
 * 协议里的 `cancelExecution(executionId)` 拿什么去指认一次执行？只有 ID。
 * 一个没有登记的执行是**无法取消**的，而取消是长命令唯一的刹车 ——
 * 一个跑飞的 `ffmpeg` 不会因为 runtime 不再关心它就停下来。
 *
 * ## 三条纪律
 *
 * 1. **abort 时立刻钉死状态。** 不是「标记请求取消，等执行体自己发现」——
 *    那样会有一段「已经取消但状态还是 running」的窗口，而取消接口在这个窗口里
 *    再来一次就会重复发信号，甚至和执行体的正常收尾抢着写结果。
 *    钉死之后执行体写什么都无效，终态只有一个。
 * 2. **终态要留一会儿。** 取消请求晚到（网络重试最常见）时必须能回答
 *    「它已经结束了，终态是 X」而不是 `execution_not_found` ——
 *    后者会让调用方以为取消失败了，然后一遍遍重试。
 * 3. **超时与取消是两种终态。** 都是 abort，但 `timeout` 说「时间到了」，
 *    `cancelled` 说「有人叫停」。混成一个的话，模型学到的是错的教训
 *    （它会以为自己调用得太慢，而不是被用户打断）。
 */

type ExecutionRecord = {
  executionId: string
  toolName: string
  workspaceId: string
  status: ExecutionStatus | 'running'
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  output: unknown
  error: ReturnType<typeof toToolError> | null
  controller: AbortController
}

/** 终态记录保留时长：够 cancel 的重试走完两轮，又不至于无限涨。 */
const RECENT_TTL_MS = 5 * 60_000

/** 终态记录上限。超过就丢最老的 —— 它是**可追踪性**不是审计日志。 */
const RECENT_LIMIT = 200

const inflight = new Map<string, ExecutionRecord>()
const recent = new Map<string, ExecutionRecord>()

let sweepTimer: NodeJS.Timeout | null = null

function ensureSweep(): void {
  if (sweepTimer !== null) return
  sweepTimer = setInterval(() => {
    const deadline = Date.now() - RECENT_TTL_MS
    for (const [id, record] of recent) {
      if ((record.endedAt ?? 0) < deadline) recent.delete(id)
    }
    while (recent.size > RECENT_LIMIT) {
      const oldest = recent.keys().next()
      if (oldest.done) break
      recent.delete(oldest.value)
    }
  }, 60_000)
  // ⚠️ 必须 unref：否则一个常驻定时器会把整个进程拖住不退出（测试脚本会挂）。
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

export function beginExecution(input: {
  executionId?: string
  toolName: string
  workspaceId: string
}): { executionId: string; signal: AbortSignal } {
  ensureSweep()
  const id = normalizeExecutionId(input.executionId) ?? newExecutionId()
  const controller = new AbortController()
  const record: ExecutionRecord = {
    executionId: id,
    toolName: input.toolName,
    workspaceId: input.workspaceId,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    output: null,
    error: null,
    controller,
  }
  inflight.set(id, record)
  return { executionId: id, signal: controller.signal }
}

/**
 * 调用方给的 ID 要不要认。
 *
 * ⚠️ 只做**形状**校验（必须是 `exe_` 开头的短字符串），不查重。
 * 查重意味着「同一个 ID 提交两次要返回第一次的结果」，那是幂等存储，
 * 而现在没有存储 —— 假装支持幂等比明说不支持危险得多。
 * 同名重复提交会被后一次覆盖，这是已知的、记在协议里的行为。
 */
function normalizeExecutionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith(EXECUTION_ID_PREFIX)) return null
  if (trimmed.length > 128) return null
  return trimmed
}

export function isExecutionCancelled(executionId: string): boolean {
  const record = inflight.get(executionId)
  if (record) return record.status !== 'running'
  return recent.get(executionId)?.status === 'cancelled'
}

/** 登记终态。**先到先写，后到的写不进去** —— 见文件头纪律 1。 */
export function finishExecution(
  executionId: string,
  status: ExecutionStatus,
  payload: { output?: unknown; error?: unknown } = {}
): ToolResult {
  ensureSweep()
  // ⚠️ 终态记录会被搬到 recent，所以两边都要查：只看 inflight 的话，
  // 「执行体晚一步收尾」会落到下面的「找不到记录」分支，凭空造出一个
  // 空壳结果盖掉真实终态 —— 而它是我们刚写进去的。
  const record = inflight.get(executionId) ?? recent.get(executionId)
  if (!record) {
    // 执行体拿了 signal 却用了别的 ID 收尾 —— 构造一个最小可返回的形状，
    // 总比抛异常让整个请求 500 好。
    const now = Date.now()
    return {
      executionId,
      toolName: '',
      workspaceId: '',
      status,
      output: payload.output ?? null,
      error: payload.error === undefined ? null : toToolError(payload.error),
      startedAt: now,
      endedAt: now,
      durationMs: 0,
    }
  }

  // 「状态」与「产出」分开判定：
  // - 状态先到先钉（超时/取消先动的手就钉成它们）；
  // - 产出只在**第一次收尾**时写，之后谁都改不动。
  // 不分开的话，超时那条路径会因为「状态已被钉死」而写不进 error，
  // 于是终态是 timeout 而 error 是 null —— runtime 拿到一个没有原因的失败。
  if (record.endedAt === null) {
    if (record.status === 'running') record.status = status
    if (payload.output !== undefined) record.output = payload.output
    if (payload.error !== undefined) record.error = toToolError(payload.error)
  }

  const endedAt = Date.now()
  record.endedAt = endedAt
  record.durationMs = endedAt - record.startedAt
  inflight.delete(record.executionId)
  recent.set(record.executionId, record)

  return snapshot(record)
}

function snapshot(record: ExecutionRecord): ToolResult {
  return {
    executionId: record.executionId,
    toolName: record.toolName,
    workspaceId: record.workspaceId,
    status: record.status === 'running' ? 'error' : record.status,
    output: record.output,
    error: record.error,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? Date.now(),
    durationMs: record.durationMs ?? 0,
  }
}

/** 取消。**来晚了不是错误** —— 见文件头纪律 2。 */
export function cancelExecution(executionId: string): {
  executionId: string
  status: ExecutionStatus | 'running'
  cancelled: boolean
} | null {
  const record = inflight.get(executionId) ?? recent.get(executionId)
  if (!record) return null

  if (record.status !== 'running') {
    return { executionId, status: record.status, cancelled: false }
  }

  record.status = 'cancelled'
  record.controller.abort(new ExecutionCancelledError(executionId))
  // ⚠️ 这里**不**立刻 finish：执行体（比如 shell）还要收一下输出、杀进程组。
  // 但状态已经钉死，它后面写什么都改不了终态。
  return { executionId, status: 'cancelled', cancelled: true }
}

/** 超时终止。与取消同一个机制，不同的终态。 */
function timeoutExecution(executionId: string): void {
  const record = inflight.get(executionId)
  if (!record || record.status !== 'running') return
  record.status = 'timeout'
  record.controller.abort(new ExecutionTimeoutError(executionId))
}

export class ExecutionCancelledError extends Error {
  readonly code = 'cancelled'
  constructor(executionId: string) {
    super(`执行 ${executionId} 已被取消。`)
    this.name = 'ExecutionCancelledError'
  }
}

export class ExecutionTimeoutError extends Error {
  readonly code = 'timeout'
  constructor(executionId: string) {
    super(`执行 ${executionId} 超过时限。`)
    this.name = 'ExecutionTimeoutError'
  }
}

export type RunExecutionInput<T> = {
  executionId?: string
  toolName: string
  workspaceId: string
  timeoutMs: number
  work: (context: { executionId: string; signal: AbortSignal }) => Promise<T>
}

/**
 * 跑一次执行：登记 → 起超时 → 等 → 收尾。
 *
 * 终态判定顺序是**先看注册表状态**，再看异常：
 * 超时与取消是把状态钉在注册表里的，而执行体抛出的可能是它自己捕获的
 * AbortError —— 那种异常的形状随 SDK 变，注册表里的状态是我们自己写的，更可信。
 */
export async function runExecution<T>(input: RunExecutionInput<T>): Promise<ToolResult> {
  const { executionId: id, signal } = beginExecution({
    ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
    toolName: input.toolName,
    workspaceId: input.workspaceId,
  })

  const timer = setTimeout(() => timeoutExecution(id), input.timeoutMs)
  try {
    const output = await input.work({ executionId: id, signal })
    return finishExecution(id, 'ok', { output })
  } catch (error) {
    if (isExecutionCancelled(id)) {
      const record = inflight.get(id)
      // 被钉成 cancelled 还是 timeout，取决于是谁先动的手。
      const finalStatus = record?.status === 'timeout' ? 'timeout' : 'cancelled'
      const reason =
        finalStatus === 'timeout' ? new ExecutionTimeoutError(id) : new ExecutionCancelledError(id)
      // ⚠️ error 必须带上：否则终态是 timeout 而 error 是 null，
      // runtime 拿到一个「失败了但没说为什么」的结果，只能原样念给模型。
      return finishExecution(id, finalStatus, { error: reason })
    }
    return finishExecution(id, 'error', { error })
  } finally {
    clearTimeout(timer)
    // 极端情况：work 抛出后 finish 没跑到（不该发生，但兜住泄漏）。
    if (inflight.has(id)) finishExecution(id, 'error', { error: new Error('执行未正常收尾。') })
  }
}

/** 验证脚本用：清空全部记录。 */
export function clearExecutions(): void {
  inflight.clear()
  recent.clear()
}

/** 验证脚本用：当前在飞数量。 */
export function inflightCount(): number {
  return inflight.size
}
