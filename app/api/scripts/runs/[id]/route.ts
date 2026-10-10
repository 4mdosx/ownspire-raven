import type { NextResponse } from 'next/server'
import { ApiError, handle, ok } from '@/backstage/lib/http'
import { getRun } from '@/backstage/services/runner.service'

/**
 * GET /api/scripts/runs/[id] —— 单条运行详情（含完整输出）。
 *
 * `id` 是 SQLite 的自增整数。`Number.parseInt('12abc')` 会得到 12，所以这里
 * 用正则钉死纯数字：一个拼错的 id 应该 400，而不是静默指向另一条记录。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await context.params
    if (!/^\d+$/.test(id)) {
      throw new ApiError('invalid_param', '运行记录 id 必须是整数。', 400)
    }
    const run = await getRun(Number.parseInt(id, 10))
    if (!run) {
      throw new ApiError('not_found', `没有 id 为 ${id} 的运行记录。`, 404)
    }
    return ok({ run })
  })
}
