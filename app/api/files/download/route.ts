import type { NextResponse } from 'next/server'
import { handle, requireParam } from '@/backstage/lib/http'
import { readStream, streamFileResponse } from '@/backstage/services/file.service'

/**
 * GET /api/files/download —— 流式下载（契约 §8）。
 *
 * 一律 `application/octet-stream` + `attachment`：下载的动作就是「存到本地」，
 * 让浏览器按真实 mime 决定「是打开还是存」会把用户带到一个空白标签页。
 * 内联预览走 `/api/files/raw`。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { absolutePath, entry } = await readStream({ path: requireParam(request, 'path') })
    return streamFileResponse({
      absolutePath,
      size: entry.size,
      name: entry.name,
      contentType: 'application/octet-stream',
    }) as unknown as NextResponse
  })
}
