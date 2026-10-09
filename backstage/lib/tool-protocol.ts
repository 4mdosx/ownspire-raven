/**
 * Raven Tool Protocol v1 —— raven 侧的镜像。
 *
 * ⚠️ **这份类型是两份里的另一份。** Runtime 那边是
 * `ownspire-little-one/src/protocol/raven-tool-protocol.ts`。**改那边必须改这边。**
 * 不抽共享包是刻意的：现在只有两个项目，抽包换来的只是「不用改两遍」，
 * 代价是版本号与发布流程 —— 等真出现第三个客户端再说。
 *
 * ## raven 在这条边界上的三条纪律
 *
 * 1. **权限校验自己做。** runtime 传来的 `workspaceId` 是**意图**，不是凭证。
 *    调用方身份由 `AGENT_RUNTIME_TOKEN` 决定，能不能碰某个 workspace 由 raven 判。
 * 2. **执行必须可指认。** 每次执行都有 `executionId`，取消接口才有东西可指。
 *    「先跑起来再说」的执行是无法取消的，而取消是长命令唯一的刹车。
 * 3. **错误说人话但要给 code。** `message` 会改，`code` 不会 ——
 *    runtime 按 code 决定要不要重试、要不要换参数再问一遍。
 */

export const RAVEN_TOOL_PROTOCOL_VERSION = 1

export type JsonSchemaNode = boolean | JsonSchemaObject

export type JsonSchemaObject = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: (string | number | boolean)[]
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean
  [key: string]: unknown
}

export type ToolRisk = 'read' | 'write' | 'destructive'

export type ToolDefinition = {
  name: string
  title: string
  description: string
  inputSchema: JsonSchemaObject
  risk: ToolRisk
  timeoutMs?: number
  confirmationPhrase?: string | null
}

export type ExecutionStatus = 'ok' | 'error' | 'cancelled' | 'timeout'

export type ToolError = {
  code: ToolErrorCode
  message: string
  retryable: boolean
}

export type ToolResult = {
  executionId: string
  toolName: string
  workspaceId: string
  status: ExecutionStatus
  output: unknown
  error: ToolError | null
  startedAt: number
  endedAt: number
  durationMs: number
}

export type ListToolsRequest = {
  op: 'listTools'
  workspaceId?: string
}

export type ExecuteToolRequest = {
  op: 'executeTool'
  workspaceId?: string
  toolName: string
  arguments: Record<string, unknown>
  executionId?: string
  timeoutMs?: number
}

export type CancelExecutionRequest = {
  op: 'cancelExecution'
  executionId: string
}

export type ToolProtocolRequest = ListToolsRequest | ExecuteToolRequest | CancelExecutionRequest

export type ListToolsData = {
  protocolVersion: number
  workspaceId: string
  tools: ToolDefinition[]
  disabled: string[]
}

export type CancelExecutionData = {
  executionId: string
  status: ExecutionStatus | 'running'
  cancelled: boolean
}

export type ToolProtocolResponse<T> =
  | { ok: true; v: number; data: T }
  | { ok: false; v: number; error: ToolError }

export const TOOL_ERROR_CODES = {
  unauthorized: { http: 401, retryable: false },
  protocol_mismatch: { http: 400, retryable: false },
  invalid_request: { http: 400, retryable: false },
  unknown_tool: { http: 404, retryable: false },
  tool_disabled: { http: 501, retryable: false },
  invalid_input: { http: 400, retryable: false },
  not_found: { http: 404, retryable: false },
  outside_root: { http: 403, retryable: false },
  permission_denied: { http: 403, retryable: false },
  workspace_unknown: { http: 404, retryable: false },
  quota_exceeded: { http: 507, retryable: false },
  timeout: { http: 504, retryable: false },
  cancelled: { http: 409, retryable: false },
  execution_not_found: { http: 404, retryable: false },
  internal_error: { http: 500, retryable: true },
} as const

export type ToolErrorCode = keyof typeof TOOL_ERROR_CODES

export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000
export const MAX_EXECUTION_TIMEOUT_MS = 600_000
export const EXECUTION_ID_PREFIX = 'exe_'

// ---------------------------------------------------------------------------
// raven 侧特有：workspace 与错误构造
// ---------------------------------------------------------------------------

/**
 * 当前实现的默认 workspace。
 *
 * ⚠️ raven 现在只有一个受管根 —— `workspaceId` 这个字段是为「以后有多个」预留的，
 * **不是现在就支持多 workspace**。所以这里做的是**校验**而不是查找：
 * 传来的不是它 → `workspace_unknown`，绝不静默忽略当成默认。
 * 静默忽略会让「我以为在 A 里写，实际写进了 B」变成一类查不出来的事故。
 */
export const DEFAULT_WORKSPACE_ID = 'workspace'

export function resolveWorkspaceId(requested: unknown): string | null {
  if (requested === undefined || requested === null || requested === '') return DEFAULT_WORKSPACE_ID
  if (typeof requested !== 'string') return null
  return requested === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE_ID : null
}

/**
 * 把任意异常归一成协议错误。
 *
 * 沙箱错误（`SandboxError`）的 code 与协议码同名，所以直接认；
 * 其余一律 `internal_error` —— 但 **message 原样保留**，因为运维要看。
 */
export function toToolError(error: unknown): ToolError {
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code in TOOL_ERROR_CODES) {
      const known = code as ToolErrorCode
      return { code: known, message: error.message, retryable: TOOL_ERROR_CODES[known].retryable }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'internal_error', message, retryable: true }
}

/**
 * 协议层主动抛出的错误。
 *
 * 用一个类而不是「随手 `throw new Error()` 再挂个 code」，是因为 `toToolError()`
 * 认的是 `code` 字段：随手挂出来的形状各不相同，而**认不出来的错误一律降级成
 * `internal_error`** —— 那会把「没这个工具」说成「raven 崩了」，
 * 而前者是调用方的错、后者是运维的锅，两者的处理方式完全不同。
 */
export class ToolProtocolError extends Error {
  readonly code: ToolErrorCode
  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'ToolProtocolError'
    this.code = code
  }
}

/** 超时封顶：调用方可以要更短，不能要更长。 */
export function clampTimeout(requested: unknown, toolDefault: number): number {
  const fallback = toolDefault > 0 ? toolDefault : DEFAULT_EXECUTION_TIMEOUT_MS
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(Math.floor(requested), MAX_EXECUTION_TIMEOUT_MS)
}
