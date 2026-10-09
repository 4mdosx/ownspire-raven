import fsp from 'node:fs/promises'
import type { NextResponse } from 'next/server'
import { ApiError, handle, requireParam } from '@/backstage/lib/http'
import { clipboardAttachmentPath, MAX_ATTACHMENT_BYTES } from '@/backstage/services/clipboard.service'
import { guessMime, streamFileResponse } from '@/backstage/services/file.service'

/**
 * GET /api/clipboard/[id]/attachment?name= —— 取附件。
 *
 * 路径来自 `clipboardAttachmentPath()`：它会校验 id、附件名必须在库里的清单里，
 * 并且 realpath 之后仍在 clipboardRoot 内。路由层不做任何拼接。
 *
 * 附件一律按下载给（`attachment`）：剪贴板里的东西（截图、压缩包、脚本）
 * 内联预览没有收益，内联一个 .html 反而多一个同源执行面。类型按扩展名猜，
 * 文件名走 RFC 5987（中文名很常见）。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await context.params
    const name = requireParam(request, 'name')
    const absolutePath = await clipboardAttachmentPath(id, name)
    const stats = await fsp.stat(absolutePath)
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      // 写入口是边写边数的，正常写不出超限的附件；库被手工改过时这里兜一道。
      throw new ApiError('attachments_too_large', '这个附件超过 32MiB 上限，已拒绝发送。', 413)
    }
    return streamFileResponse({
      absolutePath,
      size: stats.size,
      name,
      contentType: guessMime(name),
      disposition: 'attachment',
    }) as unknown as NextResponse
  })
}
