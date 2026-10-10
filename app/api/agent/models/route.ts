import { agentFetch } from '@/backstage/services/agent.service'
import { requireSessionFrom } from '@/backstage/services/auth.service'
import { handle, ok } from '@/backstage/lib/http'

/**
 * 模型清单（agent 契约 §三 `GET /api/models`）。
 *
 * 给聊天界面的「会话选模型」用：agent 侧返回 `models[]` 与 `default`，
 * 前端把 default 设为下拉的初值。**纯转发不加工** —— 聊天 UI 与模型管理页
 * 读的是同一份目录，两处各写一遍解析就会漂移。
 */

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<ReturnType<typeof handle>> {
  return handle(async () => {
    await requireSessionFrom(request)
    return ok(await agentFetch<Record<string, unknown>>('/api/models'))
  })
}
