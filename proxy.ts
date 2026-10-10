import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

/**
 * 未登录一律挡在门外（与 navi 的 proxy.ts 同一套路数）。
 *
 * ⚠️ 这里**只验签，不查 PIN epoch**。epoch 校验要读 SQLite，而 proxy 跑在
 * Edge/中间件运行时里，`node:sqlite` 不可用。真正的 epoch 校验在
 * `verifySessionToken()`（Node 运行时）。所以 proxy 是「挡外面的」，
 * service 层是「挡里面的」—— 换过 PIN 之后旧 cookie 能过 proxy，
 * 但过不了 route 里的 requireSession。
 *
 * 公开路径：
 * - `/login` 登录页本身
 * - `/api/auth/login` 用 PIN 解锁
 * - `/api/auth/setup` **首次设置 PIN**。必须公开 —— 否则新部署没有 PIN、
 *   也没有会话，永远走不到设置这一步，整个实例进不去。
 *   ⚠️ 它安全是因为 service 层用 `isPinConfigured()` 把住了：已设过就一律拒绝。
 * - `/healthz` 部署健康检查（ownspire-infra 的 deploy 靠它取版本号）
 * - `/api/ingest/*` 服务自注册与指标上报（这些 route 自己校验 token）
 * - `/api/agent/gateway` **Agent Runtime 的反向 gateway**（自己校验 Bearer token）
 *
 * ⚠️ `/api/auth/pin`（改 PIN）**不在公开列表里** —— 它必须已有会话，
 * 否则任何人都能改掉 PIN。
 *
 * ⚠️ `/api/agent/**` 里**只有 gateway 是公开的**。`/api/agent/tools`、
 * `/api/agent/sessions/*`、发消息那些是浏览器用的，必须继续要 raven 的登录态 ——
 * 把整个 `/api/agent` 放行等于让任何进程拿着 token 就能读全部会话。
 * 放行一个前缀下的**单个 route** 而不是整个前缀，是这里唯一正确的做法。
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/healthz',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/agent/gateway',
])
const PUBLIC_PREFIXES = ['/api/ingest']

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function deny(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, code: 'unauthorized', error: '需要登录。' }, { status: 401 })
  }
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  return NextResponse.redirect(url)
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (isPublic(request.nextUrl.pathname)) return NextResponse.next()

  const secret = process.env.SESSION_SECRET
  const token = request.cookies.get('raven_session')?.value
  if (!secret || !token) return deny(request)

  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] })
    return NextResponse.next()
  } catch {
    return deny(request)
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|ttf|woff2?)$).*)',
  ],
}
