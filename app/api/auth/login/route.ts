import { NextResponse } from 'next/server'
import { ApiError, handle, readJson } from '@/backstage/lib/http'
import {
  clientIp,
  loginWithPin,
  sessionCookieOptions,
  SESSION_COOKIE,
} from '@/backstage/services/auth.service'
import { PIN_LENGTH } from '@/backstage/services/auth.types'
import { ensureSchema } from '@/backstage/db/database'

/**
 * 用 PIN 解锁。**公开写接口之一**（`proxy.ts` 的 PUBLIC_PATHS 里）。
 *
 * 状态码的区分是给界面用的，语义不能糊：
 * - **400 `invalid_input`**：PIN 位数不对（`PIN 需为 4 位数字`）。这是「你填的东西
 *   格式不对」，提示应该留在输入框旁边。
 * - **401 `invalid_pin`**：位数对但值不对。属于认证失败，且**不透露是哪一位错** ——
 *   4 位数字总共 10000 种，多给一点信息都在缩小枚举空间。
 * - **429 `rate_limited`**：由 service 层抛，界面原样显示那句「请 N 秒后再试」。
 *
 * 两者都把 `errors` 挂在 `details` 上带回去，界面用它做字段级提示。
 *
 * ⚠️ 限流的「记账」在 `auth.service` 里与校验成对出现：只在失败时记一次、
 * 只在成功时清一次。漏掉任一半，限流要么不生效，要么把正常用户锁在外面 ——
 * 两种都很难从现象反推原因，所以这里不做任何额外的计数。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request)
  return handle(async () => {
    await ensureSchema()
    const body = await readJson(request)
    const pin = body['pin']

    if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
      throw new ApiError('invalid_input', `PIN 需为 ${PIN_LENGTH} 位数字。`, 400, {
        errors: { pin: [`PIN 需为 ${PIN_LENGTH} 位数字`] },
      })
    }

    const result = await loginWithPin({ pin }, ip)
    if (!result.ok) {
      // 「尚未设置 PIN」是服务端状态问题（409），不是用户填错 —— 界面该提示
      // 「去设置」而不是「重填」。
      const notConfigured = result.errors['pin']?.[0] === '尚未设置 PIN'
      if (notConfigured) {
        throw new ApiError('pin_not_configured', '尚未设置 PIN。', 409, { errors: result.errors })
      }
      throw new ApiError('invalid_pin', 'PIN 不正确。', 401, { errors: result.errors })
    }

    const response = NextResponse.json({
      ok: true,
      session: { expiresAt: result.expiresAt },
    })
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt))
    return response
  })
}
