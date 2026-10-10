import { NextResponse } from 'next/server'
import { ApiError, handle, readJson } from '@/backstage/lib/http'
import {
  clientIp,
  sessionCookieOptions,
  setupPin,
  SESSION_COOKIE,
} from '@/backstage/services/auth.service'
import { PIN_LENGTH } from '@/backstage/services/auth.types'
import { ensureSchema } from '@/backstage/db/database'

/**
 * 首次设置 PIN。**公开写接口**（`proxy.ts` 的 PUBLIC_PATHS 里）。
 *
 * ⚠️ 为什么它可以公开：service 层用 `isPinConfigured()` 把住了入口 ——
 * 已经设过 PIN 时这里一律拒绝。所以「公开」不等于「谁能改」，
 * 最坏情况是别人抢先占坑设一个 PIN（那意味着他本来就有你的文件系统写权限，
 * 或者数据库已经不在你手里了，这两种情况下再挡也没有意义）。
 *
 * 成功时**直接签发会话**：设置完 PIN 的人就是主人，让他再输一遍是纯粹的摩擦。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request)
  return handle(async () => {
    await ensureSchema()
    const body = await readJson(request)

    const parsed = await setupPin(
      { pin: body['pin'], confirmPin: body['confirmPin'] },
      ip
    )
    if (!parsed.ok) {
      // 「已设置过」是 409：状态冲突，重试没有意义，界面该引导去解锁。
      const alreadySetup = parsed.errors['pin']?.[0] === 'PIN 已设置，请直接解锁'
      if (alreadySetup) {
        throw new ApiError('pin_already_configured', 'PIN 已设置，请直接解锁。', 409, {
          errors: parsed.errors,
        })
      }
      throw new ApiError('invalid_input', parsed.errors['confirmPin']?.[0] ?? 'PIN 不合法。', 400, {
        errors: parsed.errors,
      })
    }

    const response = NextResponse.json({
      ok: true,
      configured: true,
      session: { expiresAt: parsed.expiresAt },
      pinLength: PIN_LENGTH,
    })
    response.cookies.set(SESSION_COOKIE, parsed.token, sessionCookieOptions(parsed.expiresAt))
    return response
  })
}
