import { agentFetch } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'
import type { NextResponse } from 'next/server'
import { handle, ok } from '@/backstage/lib/http'

/**
 * token 用量统计（agent 契约 §六「token 预算」，2026-10-09 加法）。
 *
 * 纯 BFF 转发。**全程不出现钱** —— 那是 agent 侧就定死的口径，
 * 这里也不做任何换算。
 */

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    await requireSessionFrom(request)
    return ok(await agentFetch<Record<string, unknown>>('/api/usage'))
  })
}
