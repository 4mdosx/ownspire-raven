import type { NextResponse } from 'next/server'
import { handle, ok } from '@/backstage/lib/http'
import { deleteAgentSession, getAgentSession } from '@/backstage/services/agent.service'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await context.params
    return ok(await getAgentSession(id))
  })
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await context.params
    return ok(await deleteAgentSession(id))
  })
}