import { ApiError, fail, readJson } from '@/backstage/lib/http'
import { forwardAgentStream } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'

/**
 * 发消息（**唯一的流式接口**）。
 *
 * 这一层**不能包装成 raven 的信封** —— 事件流不是 `{ok:true,...}`，
 * 包一层会把 `data:` 里的 JSON 变成字符串，前端解析出一堆空帧。
 * 所以成功时直接把 agent 的响应原样透出去（含 content-type 与 SSE 帧）。
 *
 * 失败时走 `handle()`：agent 在**开流之前**的拒绝（404 会话不存在 / 400 空内容 /
 * 409 上一轮还在跑）会被转成 raven 的标准信封，前端 `readEnvelope` 就能给出
 * 明确文案。流开始之后的失败是 `run.failed` 事件、HTTP 仍 200 —— 那由前端按
 * agent 契约 §四 处理。
 *
 * ⚠️ 返回类型是 `Response` 而不是 `NextResponse`：**流式响应不能经过
 * `NextResponse.json` 那套**，而 `handle()` 的签名要求 `NextResponse`。
 * 所以这里**不套 `handle()`** —— 自己 try/catch 并调用 `fail()`：
 * SSE 这条路要的正是「不包装」，套上信封就把它毁了。
 */
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params

  try {
    // ⚠️ 必须在开流之前 —— 流开始后状态码改不了（agent 契约 §四 规则一）。
    await requireSessionFrom(request)
    const body = await readJson(request)
    const upstream = await forwardAgentStream(id, body)

    const headers = new Headers()
    headers.set('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8')
    headers.set('Cache-Control', 'no-cache, no-transform')
    headers.set('Connection', 'keep-alive')
    // nginx 默认会缓冲响应，SSE 就变成「跑完一次性吐出」。
    headers.set('X-Accel-Buffering', 'no')

    return new Response(upstream.body, { status: 200, headers })
  } catch (error) {
    return fail(...describeFailure(error))
  }
}

/**
 * 错误 → raven 信封。
 *
 * `ApiError` 用它自带的 code 与 status —— agent 侧的 code（`session_not_found`、
 * `run_in_progress`…）直接透传，前端已经按那些分支写了。
 */
function describeFailure(error: unknown): [code: string, error: string, status: number] {
  if (error instanceof ApiError) return [error.code, error.message, error.status]
  const message = error instanceof Error ? error.message : String(error)
  // ⚠️ 只在服务端日志里出现堆栈；响应体里只给人话。
  console.error('[raven] agent 流式接口未处理的异常：', error)
  return ['internal_error', message, 500]
}