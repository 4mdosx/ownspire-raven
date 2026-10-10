import { NextResponse } from 'next/server'
import { publicConfig } from '@/backstage/lib/config'
import { currentSession } from '@/backstage/services/auth.service'
import { isPinConfigured } from '@/backstage/services/pin.service'
import { PIN_LENGTH } from '@/backstage/services/auth.types'
import { handle } from '@/backstage/lib/http'
import { ensureSchema } from '@/backstage/db/database'

/**
 * 当前会话 + 可公开的配置。
 *
 * 前端用它在首屏决定「显示登录页还是工作区」，以及拿配额、剪切板长度、
 * 脚本超时这些展示需要但不必写死的数字。
 *
 * `pin.configured` 是登录页两态的唯一依据（首次设置 / 解锁）。
 * **不返回 PIN 散列、配置路径、注册令牌** —— `configured` 只是个布尔值，
 * 它泄露的信息量是「这台机器设过 PIN」，仅此而已。
 */
export async function GET(): Promise<NextResponse> {
  return handle(async () => {
    ensureSchema()
    const session = await currentSession()
    return NextResponse.json({
      ok: true,
      // 没有用户名概念了，只回一个「已登录」的布尔。
      session: session ? { authenticated: true } : null,
      pin: { configured: isPinConfigured(), length: PIN_LENGTH },
      config: publicConfig(),
    })
  })
}
