import type { NextResponse } from 'next/server'
import { getConfig } from '@/backstage/lib/config'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { tokenMatches } from '@/backstage/services/auth.service'
import { registerService } from '@/backstage/services/dashboard.service'

/**
 * 服务自注册（契约 §8）—— 走 `x-ownspire-token`，未登录也可用
 * （proxy.ts 的公开前缀 `/api/ingest`）。
 *
 * body 收两种：`{ "def": { ...ServiceDef } }`（与 /api/services/registry 一致）
 * 或**裸的服务定义**。自注册方是别人的部署脚本，让它直接 POST 自己那份定义
 * 最省事，不必先包一层。
 *
 * 没配 `services.registrationToken` 时整个端点关闭（403 而不是 401）——
 * 「没开这个功能」和「令牌不对」是两件事，混在一起会让排障的人一直去翻令牌。
 * 注意令牌比较是常量时间的（`tokenMatches`），空串一律判否：
 * 「没配令牌」绝不能等价于「任何令牌都通」。
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { config } = getConfig()
    const expected = config.services.registrationToken
    if (expected === undefined || expected === '') {
      throw new ApiError('registration_disabled', '没有配置 services.registrationToken，自注册已关闭。', 403)
    }
    const provided = request.headers.get('x-ownspire-token')
    if (!tokenMatches(provided, expected)) {
      throw new ApiError('unauthorized', '注册令牌不正确。', 401)
    }

    const body = await readJson(request)
    const { snapshot, created } = await registerService({ def: body.def ?? body, token: provided, sessionAuthorized: false })
    return ok({ service: snapshot, created }, { status: created ? 201 : 200 })
  })
}
