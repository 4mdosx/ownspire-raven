import type { NextResponse } from 'next/server'
import { handle, ok, readJson } from '@/backstage/lib/http'
import { createAgentSession, deleteAgentSession, getAgentSession, listAgentSessions } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'

/**
 * Agent 会话。**纯 BFF** —— 每一个动作都对应 agent 契约 §三 的一条。
 *
 * ⚠️ 这里不做任何本地状态：raven 不存会话、不缓存消息、不做分页。
 * 加一层缓存就意味着「界面看到的会话」与「agent 记录的会话」会分叉，
 * 而这种分叉要等到真出问题时才发现。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    // ⚠️ BFF 是全权代理（服务端 token 直达 little-one），不校验登录态就等于
    // 把 agent 的全部能力挂在无鉴权的端口上。每条 BFF 路由的第一行都是它。
    await requireSessionFrom(request)
    return ok(await listAgentSessions())
  })
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    await requireSessionFrom(request)
    const body = await readJson(request)
    return ok(
      await createAgentSession({
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
        ...(Array.isArray(body.tools) ? { tools: body.tools.filter((t): t is string => typeof t === 'string') } : {}),
        // 2026-10-09 契约加法（§三）:逐字段类型检查后透传,不整包转发 ——
        // 未知字段由 agent 侧的「缺失用默认」纪律兜底。
        ...(body.engine === 'little-one' || body.engine === 'claude' ? { engine: body.engine } : {}),
        ...(typeof body.endpointId === 'string' && body.endpointId !== '' ? { endpointId: body.endpointId } : {}),
        ...(typeof body.modelId === 'string' && body.modelId !== '' ? { modelId: body.modelId } : {}),
        ...(typeof body.sandboxApproval === 'boolean' ? { sandboxApproval: body.sandboxApproval } : {}),
        ...(typeof body.businessApproval === 'boolean' ? { businessApproval: body.businessApproval } : {}),
      })
    )
  })
}