import type { NextResponse } from 'next/server'
import { handle, ok, searchParam } from '@/backstage/lib/http'
import { getDashboard } from '@/backstage/services/dashboard.service'

/**
 * Dashboard 数据（契约 §8）。
 *
 * `force=1` 绕过采样缓存。**这个 GET 不执行任何脚本** —— 动作只是元数据，
 * 真要跑得走 `POST /api/services/[id]/actions`（SSE）。
 *
 * `force-dynamic` 不能省：这个 handler 不碰任何动态 API（cookie/header），
 * Next 会把它当成静态路由，于是「服务状态」被冻在构建那一刻 —— 一个看起来
 * 永远全绿的 dashboard 比一个报错的 dashboard 危险得多。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const force = searchParam(request, 'force') === '1'
    return ok({ ...(await getDashboard({ force })) })
  })
}
