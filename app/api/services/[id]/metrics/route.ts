import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { runMetricProbe } from '@/backstage/services/dashboard.service'

/**
 * 跑一个指标探针（契约 §8）。
 *
 * 返回 **JSON 而不是 SSE**：一次指标采集的产出是一小串数字 + 一条运行记录，
 * 前端拿到后一次性渲染就行；run_records 里已经有完整 stdout/stderr 可供追查。
 * 返回体形状 `{ metrics, report }` 与 components/raven/dashboard.tsx 的
 * MetricProbeResult 一致。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params
    const body = await readJson(request)
    const probeId = typeof body.probeId === 'string' ? body.probeId.trim() : ''
    if (probeId === '') throw new ApiError('missing_param', '缺少 probeId。', 400)
    const { metrics, report } = await runMetricProbe(id, probeId)
    return ok({ metrics, report })
  })
}
