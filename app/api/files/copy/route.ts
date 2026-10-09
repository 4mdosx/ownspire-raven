import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { copy } from '@/backstage/services/file.service'

/**
 * POST /api/files/copy —— `{from,to,overwrite?}` 复制（目录递归）。
 *
 * 复制同样吃配额（服务层 reserve/release），因为「复制一份大目录」和上传
 * 一样会让工作目录长大；不判定的话配额会从复制这条路被绕过去。
 */

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    const from = body.from
    const to = body.to
    if (typeof from !== 'string' || from === '') throw new ApiError('missing_param', '缺少 from。', 400)
    if (typeof to !== 'string' || to === '') throw new ApiError('missing_param', '缺少 to。', 400)
    return ok({ entry: await copy({ from, to, overwrite: body.overwrite === true }) })
  })
}
