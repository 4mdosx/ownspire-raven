import type { NextResponse } from 'next/server'
import { ApiError, handle, ok } from '@/backstage/lib/http'
import { agentFetch } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'

/**
 * 配置转发。现在只剩预算：`GET /api/config` 与 `PUT /api/config/budget`。
 * 模型目录已经不在 little-one 里，打到旧路径会原样得到 404。
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

async function proxy(request: Request, context: Context, method: 'GET' | 'POST' | 'PUT' | 'DELETE'): Promise<NextResponse> {
  return handle(async () => {
    // 全权代理同理：先登录态,再转发（预算接口在这里一并覆盖 —— catch-all 天然带上）。
    await requireSessionFrom(request)
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

/** 预算用 PUT。POST 一律 405。 */
export async function POST(): Promise<NextResponse> {
  return unsupported()
}

export const PATCH = unsupported
