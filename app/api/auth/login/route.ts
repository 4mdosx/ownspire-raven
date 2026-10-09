import { NextResponse } from 'next/server'
import { getConfig } from '@/backstage/lib/config'
import { clientIp, login, sessionCookieOptions, SESSION_COOKIE } from '@/backstage/services/auth.service'
import { ApiError, handle, readJson } from '@/backstage/lib/http'
import { ensureSchema } from '@/backstage/db/database'

/**
 * 登录。**唯一的公开写接口**（proxy.ts 里放行的路径之一）。
 *
 * ⚠️ 限流的「记账」必须在 auth.service 里与校验成对出现：只在失败时记一次、
 * 只在成功时清一次。漏掉任一半，限流要么不生效，要么把正常用户锁在外面 ——
 * 两种都很难从现象反推原因，所以这里不做任何额外的计数。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request)
  return handle(async () => {
    ensureSchema()
    const body = await readJson(request)
    const username = body['username']
    const password = body['password']
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new ApiError('invalid_input', '需要 username 与 password。', 400)
    }
    const result = await login(username, password, ip)
    const { config } = getConfig()
    const response = NextResponse.json({
      ok: true,
      session: { username: config.auth.username, expiresAt: result.expiresAt },
    })
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt))
    return response
  })
}
