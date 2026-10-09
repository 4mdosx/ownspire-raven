import type { NextResponse } from 'next/server'
import { toInt } from '@/backstage/lib/format'
import { ApiError, handle, ok, readJson, searchParam } from '@/backstage/lib/http'
import { clear, createText, list } from '@/backstage/services/clipboard.service'

/**
 * GET /api/clipboard —— `?limit=&offset=&q=` 取队列
 * POST /api/clipboard —— `{text,source?,idemKey?}` 粘贴一条
 * DELETE /api/clipboard —— 清空
 *
 * `total` 是**队列总长**（不是过滤命中数），位置与分页都以队列为尺度；
 * 带 `q` 时条目数是 `entries.length`。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const result = await list({
      limit: toInt(searchParam(request, 'limit'), 50, 1, 200),
      offset: toInt(searchParam(request, 'offset'), 0, 0, 1_000_000),
      query: searchParam(request, 'q') ?? undefined,
    })
    return ok({ entries: result.entries, total: result.total, maxItems: result.maxItems })
  })
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    if (typeof body.text !== 'string') {
      throw new ApiError('invalid_body', 'text 必须是字符串。', 400)
    }
    const result = await createText({
      text: body.text,
      source: typeof body.source === 'string' ? body.source : undefined,
      idemKey: typeof body.idemKey === 'string' ? body.idemKey : undefined,
    })
    return ok({ entry: result.entry, evicted: result.evicted })
  })
}

export async function DELETE(): Promise<NextResponse> {
  return handle(async () => {
    const result = await clear()
    return ok({ removed: result.removed })
  })
}
