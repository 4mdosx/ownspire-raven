import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { move } from '@/backstage/services/file.service'

/**
 * POST /api/files/move —— `{from,to,overwrite?}` 移动/改名。
 *
 * `overwrite` 不传时目标已存在一律 409：删除是不可逆的，把它藏在一个
 * 布尔默认值后面（大多数「移动」实现其实是静默覆盖）会让用户第一次误删
 * 就发生在自己没意识到的时候。
 */

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    const from = body.from
    const to = body.to
    if (typeof from !== 'string' || from === '') throw new ApiError('missing_param', '缺少 from。', 400)
    if (typeof to !== 'string' || to === '') throw new ApiError('missing_param', '缺少 to。', 400)
    return ok({ entry: await move({ from, to, overwrite: body.overwrite === true }) })
  })
}
