import {
  JSON_RPC,
  jsonRpcError,
  jsonRpcResult,
  MCP_PROTOCOL_VERSION,
  toCallToolResult,
  toMcpTools,
} from '@/backstage/lib/mcp'
import { toToolError, ToolProtocolError, type ToolProtocolRequest } from '@/backstage/lib/tool-protocol'
import { dispatchExecuteTool, dispatchListTools } from '@/backstage/services/tool-gateway'
import { buildToolNameMap } from '@/backstage/lib/mcp'

/**
 * MCP（streamable HTTP）端点 —— claude-cli 等原生 MCP 客户端的业务工具入口。
 *
 * ## 归属与边界
 *
 * 执行**不在这里**：全部经 `backstage/services/tool-gateway.ts` 的分发 ——
 * 与 `/api/agent/gateway`（runtime 用的）同一份实现。权限校验、sandbox 的
 * realpath 段比较、配额、超时钳制，一层不少。这里只做三件事：
 * **鉴权 → JSON-RPC 信封 → 分发**。
 *
 * ## 鉴权（与 gateway 同尺，刻意不与登录态混用）
 *
 * 调用方是 claude 进程（服务端），没有也不该有 raven 的 JWT cookie；
 * 它拿 `AGENT_RUNTIME_TOKEN` Bearer。浏览器**天然被挡在这条门外面**
 * （没有 token），这正是「UI 不能绕过 raven 直调」的结构性保证之一 ——
 * 业务工具的浏览器路径只有 raven 自己的 UI 接口。
 *
 * ## 会话
 *
 * initialize 时发 `Mcp-Session-Id`，之后的请求原样接受但**不存任何状态** ——
 * 分发层无会话语义（每次 executeTool 都带自己的 executionId）。
 * 无状态实现是规范允许的，且让多客户端并发不需要一张会话表。
 */

export const dynamic = 'force-dynamic'

const GATEWAY_TOKEN = process.env.AGENT_RUNTIME_TOKEN?.trim()

/** 与 gateway/route.ts 同一条纪律、同一个 token：见那份文件的头部注释。 */
function requireGatewayToken(request: Request): void {
  if (!GATEWAY_TOKEN) {
    throw new ToolProtocolError('unauthorized', '没有配置 AGENT_RUNTIME_TOKEN，MCP 端点关闭。')
  }
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) {
    throw new ToolProtocolError('unauthorized', '缺少 Bearer token。')
  }
  const provided = header.slice('Bearer '.length).trim()
  if (provided.length !== GATEWAY_TOKEN.length || provided !== GATEWAY_TOKEN) {
    throw new ToolProtocolError('unauthorized', 'token 不匹配。')
  }
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }

function parseMessages(body: unknown): JsonRpcMessage[] {
  if (Array.isArray(body)) return body as JsonRpcMessage[]
  if (body !== null && typeof body === 'object') return [body as JsonRpcMessage]
  throw new ToolProtocolError('invalid_request', '请求体必须是 JSON-RPC 消息。')
}

/** raven 协议错误 → JSON-RPC 错误码。code 原样进 data —— 客户端按 code 分支。 */
function errorCodeFor(error: unknown): { code: number; message: string; data?: unknown } {
  const toolError = toToolError(error)
  const kind = toolError.code
  const code =
    kind === 'invalid_request' || kind === 'invalid_input' || kind === 'unknown_tool' || kind === 'workspace_unknown'
      ? JSON_RPC.invalidParams
      : kind === 'protocol_mismatch'
        ? JSON_RPC.invalidRequest
        : JSON_RPC.serverError
  return { code, message: `${kind}: ${toolError.message}`, data: { code: kind, retryable: toolError.retryable } }
}

async function handleRpc(message: JsonRpcMessage): Promise<{
  body: Record<string, unknown> | null
  sessionHeaders?: Record<string, string>
}> {
  // 通知没有 id：不回错、只确认收到（规范语）。
  if (message.id === undefined || message.id === null) {
    return { body: null }
  }
  const id = message.id
  const method = message.method ?? ''

  try {
    switch (method) {
      case 'initialize': {
        const params = (message.params ?? {}) as { protocolVersion?: string; clientInfo?: unknown }
        // 版本协商：客户端带来的版本是日期形就回显（相容），否则回 server 最新。
        const negotiated =
          typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
            ? params.protocolVersion
            : MCP_PROTOCOL_VERSION
        return {
          body: jsonRpcResult(id, {
            protocolVersion: negotiated,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'ownspire-raven', version: '1.0.0' },
          }),
          // 无状态实现也发这个头：有的客户端（规范语）要求 initialize 响应必须带它。
          sessionHeaders: { 'Mcp-Session-Id': crypto.randomUUID() },
        }
      }

      case 'tools/list': {
        const data = await dispatchListTools({ op: 'listTools' })
        const { tools } = toMcpTools(data)
        return { body: jsonRpcResult(id, { tools }) }
      }

      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
        if (typeof params.name !== 'string' || params.name === '') {
          return { body: jsonRpcError(id, JSON_RPC.invalidParams, 'tools/call 缺少 name。') }
        }
        // ⚠️ 客户端拿到的是 sanitize 后的名字（clipboard_list），raven 注册表里
        // 是原名（clipboard.list）—— 必须还原，否则 findTool 找不到带点的工具。
        const data = await dispatchListTools({ op: 'listTools' })
        const originalName = buildToolNameMap(data.tools).get(params.name)?.name
        if (originalName === undefined) {
          return {
            body: jsonRpcError(
              id,
              JSON_RPC.invalidParams,
              `raven 没有这个工具：${params.name}`,
              { code: 'unknown_tool', retryable: false }
            ),
          }
        }
        const request: Extract<ToolProtocolRequest, { op: 'executeTool' }> = {
          op: 'executeTool',
          toolName: originalName,
          arguments:
            params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {},
        }
        const result = await dispatchExecuteTool(request)
        return { body: jsonRpcResult(id, toCallToolResult(result)) }
      }

      case 'ping':
        return { body: jsonRpcResult(id, {}) }

      default:
        return { body: jsonRpcError(id, JSON_RPC.methodNotFound, `未知方法：${method}`) }
    }
  } catch (error) {
    const mapped = errorCodeFor(error)
    return { body: jsonRpcError(id, mapped.code, mapped.message, mapped.data) }
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireGatewayToken(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes('没有配置 AGENT_RUNTIME_TOKEN') ? 503 : 401
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.invalidRequest, message } },
      { status }
    )
  }

  const parsed = await request.json().catch(() => undefined)
  if (parsed === undefined) {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.parseError, message: '请求体不是合法 JSON。' } },
      { status: 400 }
    )
  }

  const messages = parseMessages(parsed)
  const replies: Record<string, unknown>[] = []
  const sessionHeaders: Record<string, string> = {}

  for (const message of messages) {
    const { body, sessionHeaders: headers } = await handleRpc(message)
    if (body !== null) replies.push(body)
    if (headers) Object.assign(sessionHeaders, headers)
  }

  // 全是通知 → 202 无正文（规范语）。
  if (replies.length === 0) {
    return new Response(null, { status: 202, headers: sessionHeaders })
  }
  return Response.json(
    replies.length === 1 ? replies[0]! : replies,
    { status: 200, headers: sessionHeaders }
  )
}

/** 不提供 server→client 推送：405 是规范对无推送服务器的明确回答。 */
export async function GET(): Promise<Response> {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'POST, DELETE' },
  })
}

/** 客户端会话关闭。无状态实现没有东西可清 —— 按规范回 204。 */
export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 204 })
}

