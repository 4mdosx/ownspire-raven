import {
  dispatchCancelExecution,
  dispatchExecuteTool,
  dispatchListTools,
} from '@/backstage/services/tool-gateway'
import {
  RAVEN_TOOL_PROTOCOL_VERSION,
  toToolError,
  ToolProtocolError,
  TOOL_ERROR_CODES,
  type ToolProtocolRequest,
  type ToolProtocolResponse,
} from '@/backstage/lib/tool-protocol'

/**
 * Raven Tool Protocol v1 的传输端点。
 *
 * **一个入口、三个操作**（`op` 分发）：`listTools` / `executeTool` / `cancelExecution`。
 * 不用三个 URL，是因为这让鉴权只有一处 —— 鉴权点越多，漏掉一个的机会越多。
 *
 * ## 为什么 gateway 在 raven 而不在 runtime
 *
 * **路径边界判定必须留在 raven。** `backstage/lib/sandbox.ts` 的 realpath 段比较是
 * 唯一一份判定，依据是 raven 自己的 `rootPath`。runtime 里复制一份意味着两套会漂移的
 * 判定 —— 而漂移的那一次就是越界。
 *
 * ## 鉴权
 *
 * 用**独立于 raven 登录态的共享 token**（`AGENT_RUNTIME_TOKEN`）：runtime 不是浏览器，
 * 它没有 cookie，也拿不到 raven 的 JWT。
 *
 * ⚠️ 与 `backstage/lib/http.ts` 的 `requireAuth` 同一条纪律但**刻意不复用**：
 * 那个读 JWT cookie，这个读 Bearer。共用一个函数会在里面塞「两种 token 都试试」的
 * 分支 —— 而那正是认证绕过最常见的形状。
 */

const GATEWAY_TOKEN = process.env.AGENT_RUNTIME_TOKEN?.trim()

function requireGatewayToken(request: Request): void {
  if (!GATEWAY_TOKEN) {
    throw new ToolProtocolError('unauthorized', '没有配置 AGENT_RUNTIME_TOKEN，gateway 关闭。')
  }
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) {
    throw new ToolProtocolError('unauthorized', '缺少 Bearer token。')
  }
  const provided = header.slice('Bearer '.length).trim()
  // 定长比较：长度不同直接判否，避免比较耗时泄露前缀信息。
  if (provided.length !== GATEWAY_TOKEN.length || provided !== GATEWAY_TOKEN) {
    throw new ToolProtocolError('unauthorized', 'token 不匹配。')
  }
}

function ok<T>(data: T): Response {
  const body: ToolProtocolResponse<T> = { ok: true, v: RAVEN_TOOL_PROTOCOL_VERSION, data }
  return Response.json(body)
}

function fail(error: unknown, httpOverride?: number): Response {
  const toolError = toToolError(error)
  const body: ToolProtocolResponse<never> = {
    ok: false,
    v: RAVEN_TOOL_PROTOCOL_VERSION,
    error: toolError,
  }
  return Response.json(body, { status: httpOverride ?? TOOL_ERROR_CODES[toolError.code].http })
}

/**
 * 解析请求体。**只做形状校验，不做业务校验** —— 业务校验在工具自己的
 * `execute` 里（它们靠 `requireString` 这类助手报 `invalid_input`）。
 */
function parseRequest(body: unknown): ToolProtocolRequest {
  if (body === null || typeof body !== 'object') {
    throw new ToolProtocolError('invalid_request', '请求体必须是 JSON 对象。')
  }
  const value = body as Record<string, unknown>

  if (value.v !== undefined && value.v !== RAVEN_TOOL_PROTOCOL_VERSION) {
    throw new ToolProtocolError(
      'protocol_mismatch',
      `不支持的协议版本 ${String(value.v)}，这里是 v${RAVEN_TOOL_PROTOCOL_VERSION}。`
    )
  }

  switch (value.op) {
    case 'listTools':
      return { op: 'listTools', workspaceId: asOptionalString(value.workspaceId, 'workspaceId') }

    case 'executeTool': {
      if (typeof value.toolName !== 'string' || value.toolName === '') {
        throw new ToolProtocolError('invalid_request', '缺少 toolName。')
      }
      const rawArgs = value.arguments
      const args =
        rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {}
      return {
        op: 'executeTool',
        workspaceId: asOptionalString(value.workspaceId, 'workspaceId'),
        toolName: value.toolName,
        arguments: args,
        ...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {}),
        ...(typeof value.timeoutMs === 'number' ? { timeoutMs: value.timeoutMs } : {}),
      }
    }

    case 'cancelExecution': {
      if (typeof value.executionId !== 'string' || value.executionId === '') {
        throw new ToolProtocolError('invalid_request', '缺少 executionId。')
      }
      return { op: 'cancelExecution', executionId: value.executionId }
    }

    default:
      throw new ToolProtocolError(
        'invalid_request',
        `未知的 op：${String(value.op)}（只认 listTools / executeTool / cancelExecution）`
      )
  }
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw new ToolProtocolError('invalid_request', `字段 ${field} 必须是字符串。`)
  }
  return value
}

/**
 * 分发实现在 `backstage/services/tool-gateway.ts`（gateway 与 MCP 端点共享）。
 * 这一层只剩：鉴权 → 形状校验 → 信封组装。
 */
async function dispatch(request: ToolProtocolRequest): Promise<Response> {
  switch (request.op) {
    case 'listTools':
      return ok(await dispatchListTools(request))
    case 'executeTool':
      return ok(await dispatchExecuteTool(request))
    case 'cancelExecution':
      return ok(await dispatchCancelExecution(request))
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireGatewayToken(request)
    const body = await request.json().catch(() => null)
    return await dispatch(parseRequest(body))
  } catch (error) {
    // 没配 token 是运维状态不是内部错误，给它正确的 503。
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('没有配置 AGENT_RUNTIME_TOKEN')) {
      return fail(error, 503)
    }
    if (error instanceof ToolProtocolError || isKnownProtocolCode(error)) {
      return fail(error)
    }
    console.error('[raven] tool protocol 未处理的异常：', error)
    return fail(error)
  }
}

function isKnownProtocolCode(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code in TOOL_ERROR_CODES
}

/**
 * GET —— `listTools` 的等价物，方便 `curl` 核对。
 *
 * ⚠️ 它**不是**另一套协议：只是把 `listTools` 的默认参数挂在 GET 上。
 * 一旦它和 POST 的返回出现分叉，「curl 看到的是对的、runtime 拿到的是错的」
 * 就会变成一类极难排查的问题 —— 所以这里直接复用同一个函数。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    requireGatewayToken(request)
    return ok(await dispatchListTools({ op: 'listTools' }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('没有配置 AGENT_RUNTIME_TOKEN')) return fail(error, 503)
    return fail(error)
  }
}
