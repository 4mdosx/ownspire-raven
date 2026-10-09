import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { createDirectory } from '@/backstage/services/file.service'

/** POST /api/files/mkdir —— `{path}` 建目录（缺的父目录一并建）。 */

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    const path = body.path
    if (typeof path !== 'string' || path === '') {
      throw new ApiError('missing_param', '缺少 path。', 400)
    }
    return ok({ entry: await createDirectory({ path }) })
  })
}
