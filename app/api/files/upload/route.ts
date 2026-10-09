import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, requireParam, searchParam } from '@/backstage/lib/http'
import { upload } from '@/backstage/services/file.service'

/**
 * PUT /api/files/upload —— 裸流上传（契约 §8）。
 *
 * body 就是文件字节，**没有** multipart 包装（浏览器端用 XHR 直传，见 lib/api.ts）。
 * `path` 是相对 filesRoot 的完整目标路径（含文件名）；`overwrite=1` 才允许覆盖。
 *
 * 这里只做参数提取：存在性、配额、原子落盘全在服务层。路由层自己拼路径
 * 是 raven 三令五申禁止的事。
 */

export const runtime = 'nodejs'

export async function PUT(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const path = requireParam(request, 'path')
    const overwriteParam = searchParam(request, 'overwrite')
    const body = request.body
    if (body === null) {
      throw new ApiError('empty_body', '上传请求没有请求体。', 400)
    }
    // content-length 只用于「开始前快速拒绝」和进度提示；真实字节数由服务层
    // 边写边数 —— 代理会改写这个头，拿它记账迟早对不上。
    const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10)
    const result = await upload({
      path,
      stream: body,
      expectedBytes: Number.isFinite(declared) && declared > 0 ? declared : undefined,
      overwrite: overwriteParam === '1' || overwriteParam === 'true',
    })
    return ok({ entry: result.entry, bytes: result.bytes })
  })
}
