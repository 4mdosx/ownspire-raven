import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { rename } from '@/backstage/services/file.service'

/**
 * POST /api/files/rename —— `{from,to}` 改名（`to` 是含新名字的完整路径）。
 *
 * 与 move 的分工：rename 只换名字，目标存在就拒绝；要覆盖请用 move + overwrite。
 */

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    const from = body.from
    const to = body.to
    if (typeof from !== 'string' || from === '') throw new ApiError('missing_param', '缺少 from。', 400)
    if (typeof to !== 'string' || to === '') throw new ApiError('missing_param', '缺少 to。', 400)
    return ok({ entry: await rename({ from, to }) })
  })
}
