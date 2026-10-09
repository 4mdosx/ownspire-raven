import type { NextResponse } from 'next/server'
import { handle, requireParam } from '@/backstage/lib/http'
import { readStream, streamFileResponse } from '@/backstage/services/file.service'

/**
 * GET /api/files/raw —— 内联返回（契约 §8）。
 *
 * 给 `<img src>` / 文本预览用：类型按扩展名猜，猜不出来一律 octet-stream
 * （宁可让浏览器下载，也不要按错误类型渲染）。响应头里的 CSP 与
 * `nosniff` 由 `streamFileResponse` 统一加，别在这里另起一套。
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
      contentType: entry.mime === '' ? 'application/octet-stream' : entry.mime,
      disposition: 'inline',
    }) as unknown as NextResponse
  })
}
