import { NextResponse } from 'next/server'
import { ApiError, handle, readJson } from '@/backstage/lib/http'
import {
  clientIp,
  sessionCookieOptions,
  SESSION_COOKIE,
  updatePin,
} from '@/backstage/services/auth.service'
import { PIN_LENGTH } from '@/backstage/services/auth.types'
import { ensureSchema } from '@/backstage/db/database'

/**
 * 修改 PIN。**需要登录**（不走 proxy 的公开白名单）。
 *
 * 必须验当前 PIN：拿到会话的人就能永久改掉 PIN 的话，
 * 那「改 PIN」这个补救手段（PIN 泄露时的唯一止血办法）就失效了。
 *
 * 成功时换发一枚新会话 —— `savePin` 已经把 `pinEpoch` 换掉了，
 * 旧会话此刻全部作废，不换发的话用户改完立刻被弹回登录页。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request)
  return handle(async () => {
    ensureSchema()
    const body = await readJson(request)

    const parsed = await updatePin(
      {
        currentPin: body['currentPin'],
        pin: body['pin'],
        confirmPin: body['confirmPin'],
      },
      ip
    )
    if (!parsed.ok) {
      const currentWrong = parsed.errors['currentPin']?.[0] === '当前 PIN 不正确'
      // 当前 PIN 错 = 认证失败（401）；两次不一致 = 输入问题（400）。
      throw new ApiError(
        currentWrong ? 'invalid_pin' : 'invalid_input',
        currentWrong ? '当前 PIN 不正确。' : (parsed.errors['confirmPin']?.[0] ?? 'PIN 不合法。'),
        currentWrong ? 401 : 400,
        { errors: parsed.errors }
      )
    }

    const response = NextResponse.json({
      ok: true,
      session: { expiresAt: parsed.expiresAt },
      pinLength: PIN_LENGTH,
    })
    response.cookies.set(SESSION_COOKIE, parsed.token, sessionCookieOptions(parsed.expiresAt))
    return response
  })
}
