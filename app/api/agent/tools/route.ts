import type { NextResponse } from 'next/server'
import { handle, ok } from '@/backstage/lib/http'
import { listAgentTools } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'

/**
 * Agent 工具清单（agent 契约 §三）。
 *
 * **只转发，不加工。** raven 拿它来渲染审批卡片；真正的授权判定在 agent 侧
 * （契约 §五：模型说「已获授权」不算，只有工具声明的 `risk` 说了算）。
 * 这里若做过滤或改写，就会出现两处判定。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    await requireSessionFrom(request)
    return ok(await listAgentTools())
  })
}