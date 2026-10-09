import 'server-only'
import { ApiError } from '@/backstage/lib/http'

/**
 * raven → Agent Runtime 的服务端客户端。
 *
 *⚠️ **这个文件是 `server-only` 的**，因为 `AGENT_RUNTIME_TOKEN` 只能待在服务端：
 * 它是agent 的全部权限凭据，浏览器拿到它就等于拿到所有工具的调用权。
 * 契约 §二 的要求是「token 永远不下发到浏览器」，而这条纪律靠的就是这个
 * `server-only` 标记 —— 一旦有人从客户端组件 import 它，**打包会直接失败**，
 * 而不是悄悄把密钥打进 bundle。
 *
 *raven 的 `/api/agent/*` 是 BFF：浏览器只跟 raven 说话，raven 校验自己的登录态，
 * 再带 token 转发。所以 agent 侧完全不需要再实现一套用户鉴权。
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:5900'

export function agentBaseUrl(): string {
  const raw = process.env.AGENT_RUNTIME_URL?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

function agentToken(): string {
  const token = process.env.AGENT_RUNTIME_TOKEN?.trim()
  if (!token) {
    throw new ApiError(
      'agent_not_configured',
      '没有配置 AGENT_RUNTIME_TOKEN，Agent 功能不可用。在环境变量里填上与 agent 服务相同的值。',
      503
    )
  }
  return token
}

export type AgentFetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/**
 * 调agent 的 JSON 接口。
 *
 * **保留 agent 侧的原话**：agent 返回的 `code` 与 `error` 直接透传，
 * 不改写、不包装。理由与 raven 其他接口一致 —— 前端已经按那些 code 分支写了，
 * 这里再翻译一次就多一处会漂移的地方。
 */
export async function agentFetch<T>(path: string, options: AgentFetchOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options

  let response: Response
  try {
    response = await fetch(`${agentBaseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${agentToken()}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
      cache: 'no-store',
    })
  } catch (error) {
    // 连不上agent —— 这通常是「服务没起」而不是「请求错了」。
    // 消息里必须说清楚是**agent 侧**的问题，否则用户会去查自己的操作。
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError('agent_unreachable', `连不上 Agent Runtime（${agentBaseUrl()}）：${message}`, 503)
  }

  const text = await response.text()
  let payload: unknown = null
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new ApiError(
        'agent_bad_response',
        `Agent Runtime 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`,
        502
      )
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as { code?: unknown; error?: unknown }
    const code = typeof envelope.code === 'string' ? envelope.code : 'agent_error'
    const message =
      typeof envelope.error === 'string' ? envelope.error : `Agent Runtime 返回 HTTP ${response.status}。`
    throw new ApiError(code, message, response.status)
  }

  return payload as T
}

// ---------------------------------------------------------------------------
// 契约里的接口（ownspire-agent docs/01-contract.md §三）
// ---------------------------------------------------------------------------

export type AgentToolInfo = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  risk: 'read' | 'write' | 'destructive'
  confirmationPhrase: string | null
}

export type AgentSessionSummary = {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  runCount: number
  messageCount: number
}

export type AgentSessionDetail = AgentSessionSummary & {
  instructions: string | null
  tools: string[]
  messages: { id: number; role: 'user' | 'assistant'; content: string; runId: string | null; createdAt: number }[]
}

export function listAgentTools(signal?: AbortSignal): Promise<{ tools: AgentToolInfo[] }> {
  return agentFetch<{ tools: AgentToolInfo[] }>('/api/tools', { ...(signal ? { signal } : {}) })
}

export function listAgentSessions(signal?: AbortSignal): Promise<{ sessions: AgentSessionSummary[] }> {
  return agentFetch<{ sessions: AgentSessionSummary[] }>('/api/sessions', { ...(signal ? { signal } : {}) })
}

export function getAgentSession(sessionId: string, signal?: AbortSignal): Promise<AgentSessionDetail> {
  return agentFetch<AgentSessionDetail>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { ...(signal ? { signal } : {}) }
  )
}

export function createAgentSession(
  body: { title?: string; instructions?: string; tools?: string[] },
  signal?: AbortSignal
): Promise<{ sessionId: string; title: string; createdAt: number; tools: string[] }> {
  return agentFetch('/api/sessions', { method: 'POST', body, ...(signal ? { signal } : {}) })
}

export function deleteAgentSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<{ deleted: boolean; sessionId: string; messages: number; runs: number }> {
  return agentFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  })
}

/**
 * 转发一次流式请求。
 *
 * ⚠️ **原样转发 `content-type` 与状态码**，不包装成 raven 的信封 ——
 * 事件流不是信封（契约 §四），包一层会把 `data:` 里的 JSON 变成字符串，
 * 前端的 SSE 解析器会拿到一堆空帧。
 *
 * 与 `lib/api.ts` 里`runStream` 的约定一致：非事件流的响应走信封，
 * 所以**错误照原样交给 raven 的 `handle()` 处理**，
 * 前端拿到的仍是 `{ ok: false, code, error }`。
 */
export async function forwardAgentStream(
  sessionId: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(`${agentBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentToken()}`,
      },
      body: JSON.stringify(body),
      signal,
      cache: 'no-store',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError('agent_unreachable', `连不上 Agent Runtime（${agentBaseUrl()}）：${message}`, 503)
  }

  // 不是事件流 → 是流开始前的错误（404/400/409）。**转成 raven 信封**，
  // 这样前端的 readEnvelope 能给出「会话不存在」这类明确文案，
  // 而不是一句「响应不是事件流」。
  const contentType = upstream.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const text = await upstream.text()
    let code = 'agent_error'
    let message = `Agent Runtime 返回 HTTP ${upstream.status}。`
    try {
      const parsed = JSON.parse(text) as { code?: unknown; error?: unknown }
      if (typeof parsed.code === 'string') code = parsed.code
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      if (text.trim() !== '') message = text.slice(0, 300)
    }
    throw new ApiError(code, message, upstream.status)
  }

  return upstream
}