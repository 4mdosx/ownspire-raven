import type { NextResponse } from 'next/server'
import { handle, ok, readJson } from '@/backstage/lib/http'
import { createAgentSession, deleteAgentSession, getAgentSession, listAgentSessions } from '@/backstage/services/agent.service'

/**
 * Agent 会话。**纯 BFF** —— 每一个动作都对应 agent 契约 §三 的一条。
 *
 * ⚠️ 这里不做任何本地状态：raven 不存会话、不缓存消息、不做分页。
 * 加一层缓存就意味着「界面看到的会话」与「agent 记录的会话」会分叉，
 * 而这种分叉要等到真出问题时才发现。
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return handle(async () => ok(await listAgentSessions()))
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    return ok(
      await createAgentSession({
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
        ...(Array.isArray(body.tools) ? { tools: body.tools.filter((t): t is string => typeof t === 'string') } : {}),
      })
    )
  })
}