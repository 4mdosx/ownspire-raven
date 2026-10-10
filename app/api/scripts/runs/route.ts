import type { NextResponse } from 'next/server'
import { toInt } from '@/backstage/lib/format'
import { handle, ok, searchParam } from '@/backstage/lib/http'
import { listRuns } from '@/backstage/services/runner.service'

/**
 * GET /api/scripts/runs —— `?limit=&script=` 运行历史（契约 §8）。
 *
 * 列表不带完整 stdout/stderr 的裁剪逻辑：`run_records` 里的输出本来就已经
 * 按 `maxOutputBytes` 封顶过，单条最多几十 KB。真要把详情做轻，应当另开一个
 * 「摘要」视图，而不是在这里定第二条截断规则。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const script = searchParam(request, 'script')
    return ok({
      runs: await listRuns(toInt(searchParam(request, 'limit'), 50, 1, 500), script ?? undefined),
    })
  })
}
