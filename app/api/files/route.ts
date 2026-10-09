import type { NextResponse } from 'next/server'
import { handle, ok, searchParam } from '@/backstage/lib/http'
import { listDirectory } from '@/backstage/services/file.service'

/**
 * GET /api/files —— 列目录（契约 §8）。
 *
 * 路径一律相对 `workspace/`，`path` 省略即根目录。排序默认按名字升序，
 * 未知的 `sort` / `order` 值退回默认值而不是报错：排序方式不该让一次
 * 「刷新列表」失败。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const sortParam = searchParam(request, 'sort')
    const result = await listDirectory({
      path: searchParam(request, 'path') ?? '',
      search: searchParam(request, 'search') ?? undefined,
      sort: sortParam === 'size' || sortParam === 'mtime' ? sortParam : 'name',
      order: searchParam(request, 'order') === 'desc' ? 'desc' : 'asc',
    })
    return ok({ path: result.path, parent: result.parent, entries: result.entries })
  })
}
