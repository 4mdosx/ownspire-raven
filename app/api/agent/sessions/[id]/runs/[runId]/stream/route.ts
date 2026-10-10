import { agentBaseUrl, agentToken } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'
import { fail } from '@/backstage/lib/http'

/**
 * 断线重连（agent 契约 §六「断线重连」，2026-10-09 加法）。
 *
 * 与 messages 路由同一条纪律：**SSE 不包装** —— 这里是回放+续流的透传管道，
 * 套 raven 信封会把 `data:` 里的 JSON 变成字符串。登录态在开流之前校验。
 *
 * agent 侧的 404（run 不属于这个会话）在开流之前返回 —— 状态码是真的。
 * 开流之后的一切由事件本身表达（回放终止事件 / 流关闭兜底）。
 */

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> }
): Promise<Response> {
  const { id, runId } = await context.params

  try {
    await requireSessionFrom(request)

    const incoming = new URL(request.url)
    const after = incoming.searchParams.get('after')
    const upstream = await fetch(
      `${agentBaseUrl()}/api/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/stream` +
        (after !== null ? `?after=${encodeURIComponent(after)}` : ''),
      {
        headers: { Authorization: `Bearer ${agentToken()}` },
        cache: 'no-store',
      }
    )

    const headers = new Headers()
    headers.set('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8')
    headers.set('Cache-Control', 'no-cache, no-transform')
    headers.set('Connection', 'keep-alive')
    headers.set('X-Accel-Buffering', 'no')

    if (upstream.status !== 200) {
      // 开流前的错误（404 run_not_found 等）—— 原样透传状态码与信封。
      const text = await upstream.text()
      return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
    }

    return new Response(upstream.body, { status: 200, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[raven] agent 重连流未处理的异常：', error)
    return fail('internal_error', message, 500)
  }
}
