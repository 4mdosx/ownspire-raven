import type { NextResponse } from 'next/server'
import { ApiError, handle, ok } from '@/backstage/lib/http'
import { agentFetch } from '@/backstage/services/agent.service'

/**
 * 配置目录的转发（agent 契约 §三「配置目录」）。
 *
 * **一个 catch-all 处理全部动词与路径**，而不是为每条路径写一个 route。
 * 理由：这里要做的事只有一件 —— **把请求原样送到 agent 的 `/api/config/*`，
 * 把响应原样送回**。为每条路径写一个文件的话，N 条路径就有 N 处
 * 「忘了带 query string」「忘了转发 body」的机会，而它们的表现是
 * 「界面上某个按钮不管用」，极难定位到转发层。
 *
 * ⚠️ **绝不加工**：agent 侧的 `code` 与 `error` 直接透传
 * （理由与 `agentFetch` 相同：前端按 code 分支，这里再翻译一次就多一处会漂移）。
 * 尤其 `409 cascade_required` 必须原样到达 —— 前端靠它弹确认框，
 * 改写成 500 就变成「让人重试一个必然失败的请求」。
 */

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ path?: string[] }> }

/** `/api/config/providers/zhipu` → `/api/config/providers/zhipu`。path 为空时是 `/api/config`。 */
function agentPath(segments: string[] | undefined): string {
  if (!segments || segments.length === 0) return '/api/config'
  // ⚠️ 逐段 encodeURIComponent：id 来自 URL，不能直接拼进去。
  // 而 encode 整条路径会把 `/` 也编码掉，agent 那边就认不出层级了。
  return `/api/config/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`
}

async function proxy(request: Request, context: Context, method: 'GET' | 'PUT' | 'DELETE'): Promise<NextResponse> {
  return handle(async () => {
    const { path } = await context.params
    const incoming = new URL(request.url)
    // ⚠️ 解析失败给 `{}` 而不是让异常冒出去：agent 侧会对空 body 说
    // 「这个字段是必填的」，那是有用的报错；而这里抛出的 JSON 解析错误
    // 会变成 500，用户完全看不出是自己少传了东西。
    const body =
      method === 'GET' || method === 'DELETE'
        ? undefined
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>)

    // ⚠️ query string 要转发：`?cascade=1` 是「确认连带删除」的信号，
    // 漏掉它 agent 就会返回 409，而界面表现为「点了删除说不行」。
    const target = agentPath(path) + incoming.search

    // ⚠️ 显式给类型参数：`agentFetch` 的返回默认是 `unknown`，
// 而 `ok()` 要`Record<string, unknown>`。不写的话 TS 不知道该推断成什么，
// 于是这个错误会一路留到 build 时才炸。
return ok(await agentFetch<Record<string, unknown>>(target, { method, body }))
  })
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  return proxy(request, context, 'GET')
}

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  return proxy(request, context, 'PUT')
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  return proxy(request, context, 'DELETE')
}

// Next.js 会为未声明的动词返回 405，浏览器上的表现是「方法不允许」——
// 那个信息对排查毫无帮助，所以明确接住并说明。
async function unsupported(): Promise<NextResponse> {
  return handle(async () => {
    throw new ApiError('method_not_allowed', '配置目录只支持 GET / PUT / DELETE。', 405)
  })
}

export const POST = unsupported
export const PATCH = unsupported
