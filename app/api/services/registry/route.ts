import type { NextResponse } from 'next/server'
import { handle, ok, readJson } from '@/backstage/lib/http'
import { currentSession } from '@/backstage/services/auth.service'
import { registerService } from '@/backstage/services/dashboard.service'

/**
 * 注册 / 更新服务定义（契约 §8）。
 *
 * 两道凭据满足其一即可：`{def, token}` 里的注册令牌，或一个已登录的会话。
 * 「有没有登录」由这里判并作为一个布尔传给 service 层 —— `registerService`
 * 不 import `next/headers`，这样它能在验证脚本里被直接调用
 * （cookies() 在 Next 运行期之外会抛错）。
 *
 * ⚠️ 现状提示：proxy.ts 的公开路径只有 `/login` `/healthz` `/api/auth/login`
 * 与 `/api/ingest/*`，所以**令牌路径今天到不了这里**（未登录请求在 proxy 就被
 * 401 掉了）。保留它是因为「API 自己也要能独立鉴权」，而且这条判断题写在
 * service 层比写在中间件里更容易测；纯令牌注册请走 `/api/ingest/register`。
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    const bodyToken = typeof body.token === 'string' && body.token !== '' ? body.token : null
    const headerToken = request.headers.get('x-ownspire-token')
    const sessionAuthorized = (await currentSession()) !== null
    const { snapshot, created } = await registerService({
      def: body.def,
      token: bodyToken ?? headerToken,
      sessionAuthorized,
    })
    // 新建 201、更新 200：让调用方（CI/脚本）不用再查一次就能区分这两种结果。
    return ok({ service: snapshot, created }, { status: created ? 201 : 200 })
  })
}
