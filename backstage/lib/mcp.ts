import type { ListToolsData, ToolDefinition, ToolResult } from '@/backstage/lib/tool-protocol'

/**
 * MCP(Model Context Protocol)streamable HTTP 适配 —— raven 侧。
 *
 * ## 为什么给 raven 加一个 MCP 门
 *
 * claude-cli 原生说 MCP。业务工具经这条门直达 raven 的执行层（治理不旁路：
 * 执行仍走 tool-gateway 的分发，权限校验、sandbox、配额一层不少）。
 * 这是「模型伸手的那只手长在 raven 上」的最后一块：
 * - little-one 引擎 → 走 Raven Tool Protocol（`/api/agent/gateway`）；
 * - claude 引擎   → 原生 MCP（`/api/agent/mcp`）。
 * 两种传输，一个分发层（`backstage/services/tool-gateway.ts`）。
 *
 * ## 实现范围（刻意的小）
 *
 * 只实现 claude-cli 作为 MCP **客户端**会用到的部分：
 * `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`。
 * 响应用 `application/json`（协议允许，客户端必收）；不提供 server→client 推送
 * （GET 返回 405 是规范明确允许的）；执行取消不在 MCP 的 tools 语义里
 * （`$/cancelRequest` 管的是请求本身），raven 的 `cancelExecution` 仍走 gateway 暴露。
 *
 * ## 工具名的约定
 *
 * MCP 工具名只允许 `[a-zA-Z0-9_-]`，而 raven 工具名带点（`clipboard.list`）。
 * 对外做替换、对内建反向表；**替换后撞名在 list 时直接报错** —— 静默合并会让
 * 「调 A 执行了 B」成为可能，那是治理事故不是兼容性问题。
 *
 * ## 鉴权
 *
 * 与 gateway 同一把尺：`AGENT_RUNTIME_TOKEN` Bearer。**刻意不接受 raven 登录态**
 * —— 调用方是 claude 进程不是浏览器，两套凭据混在一个函数里正是认证绕过最常见的形状
 * （gateway 路由头注释同款纪律）。
 */

/** MCP 协议版本（server 侧支持的最新）。客户端带来的版本相容时回显它的。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * 工具名映射：对外（MCP）→ 对内（raven）。撞名是**注册表口径的事故**，
 * 不在传输层静默消解。
 */
export function buildToolNameMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    const sdkName = sanitizeToolName(tool.name)
    const existing = map.get(sdkName)
    if (existing !== undefined && existing.name !== tool.name) {
      throw new Error(
        `MCP 工具名撞车：${existing.name} 与 ${tool.name} 都映射为 ${sdkName}。` +
          '改其中一个工具的名字 —— 这不能靠传输层静默处理。'
      )
    }
    map.set(sdkName, tool)
  }
  return map
}

/** raven ToolDefinition → MCP Tool。risk 翻进 annotations（审批 UI 的事实源）。 */
export function toMcpTool(tool: ToolDefinition): {
  name: string
  title: string
  description: string
  inputSchema: ToolDefinition['inputSchema']
  annotations: {
    title: string
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
  }
} {
  return {
    name: sanitizeToolName(tool.name),
    title: tool.title,
    description: tool.description,
    // JSON Schema 原样透出 —— raven 的 inputSchema 本来就是 JSON Schema（跨进程只有 JSON 能过线）。
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: tool.risk === 'read',
      destructiveHint: tool.risk === 'destructive',
      idempotentHint: tool.risk === 'read',
    },
  }
}

export function toMcpTools(data: ListToolsData): {
  tools: ReturnType<typeof toMcpTool>[]
  /** 未开放的工具不进 tools/list，但保留映射，tools/call 撞上来时给准确报错。 */
  nameMap: Map<string, ToolDefinition>
} {
  const nameMap = buildToolNameMap([...data.tools, ...disabledDefinitions(data)])
  return { tools: data.tools.map(toMcpTool), nameMap }
}

/** disabled 工具的定义不在 data.tools 里，但名字映射需要它们（为了准确报错）。 */
function disabledDefinitions(data: ListToolsData): ToolDefinition[] {
  // listToolsData 没带 disabled 的定义本体（只有名字）—— 这里就不建映射了，
  // tools/call 落到 findTool 时由 tool-gateway 报 tool_disabled。
  // 留这个函数是为了把「为什么 disabled 不在映射里」写在明处。
  void data
  return []
}

/** ToolResult → MCP CallToolResult。错误进 isError 通道，不抛 JSON-RPC 错 ——
 *  工具执行失败是**工具的结果**，不是协议故障（MCP 规范语）。 */
export function toCallToolResult(result: ToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError: boolean
} {
  const payload = result.status === 'ok' ? result.output : (result.error ?? result.output)
  return {
    content: [{ type: 'text', text: JSON.stringify(payload ?? null) }],
    isError: result.status !== 'ok',
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 信封
// ---------------------------------------------------------------------------

export type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown }

export function jsonRpcResult(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

export function jsonRpcError(
  id: string | number,
  code: number,
  message: string,
  data?: unknown
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/** 标准 JSON-RPC 错误码 + MCP 惯例。 */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** raven 的协议错误（unknown_tool / tool_disabled / …）挂在这里,code 原样放 data。 */
  serverError: -32000,
} as const
