import type { NextResponse } from 'next/server'
import { handle, ok, searchParam } from '@/backstage/lib/http'
import { getServiceDetail } from '@/backstage/services/dashboard.service'

/**
 * 单个服务详情（契约 §8）。
 *
 * 刻意**不复用** `/api/services` 的整体聚合：为了一个 id 去把每个服务的探针
 * 都跑一遍，是给上游白送一轮压测。这里只采一个服务。
 *
 * Next 16 的动态段参数是 Promise，必须 await（`params` 之前是同步对象，
 * 直接解构会拿到 undefined，报错还是「没有找到服务 undefined」）。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params
    const force = searchParam(request, 'force') === '1'
    return ok({ service: await getServiceDetail(id, { force }) })
  })
}
