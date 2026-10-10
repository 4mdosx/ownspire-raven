import { agentFetch } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'
import type { NextResponse } from 'next/server'
import { handle, ok } from '@/backstage/lib/http'

/**
 * 取消一轮（agent 契约 §三「取消一轮」，2026-10-09 加法）。
 *
 * 纯 BFF 转发：agent 的 404 `run_not_found` / 409 `run_not_running` 原样透传 ——
 * 前端按 code 分支（409 该刷新那一轮的状态，不是重试）。
 */

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> }
): Promise<NextResponse> {
  return handle(async () => {
    await requireSessionFrom(request)
    const { id, runId } = await context.params
    return ok(
      await agentFetch<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
      })
    )
  })
}
