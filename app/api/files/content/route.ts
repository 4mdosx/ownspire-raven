import type { NextResponse } from 'next/server'
import { toInt } from '@/backstage/lib/format'
import { ApiError, handle, ok, readJson, requireParam, searchParam } from '@/backstage/lib/http'
import { EDITABLE_MAX_BYTES, readTextFile, writeTextFile } from '@/backstage/services/file.service'

/**
 * GET /api/files/content —— 读文本（编辑器用）
 * PUT /api/files/content —— 存文本
 *
 * `maxBytes` 默认与 `editable` 的门槛一致（1MiB），上限 8MiB：编辑器不是
 * 日志查看器，把一个大文件整个塞进 JSON 只会让标签页崩掉。截断与否在响应里
 * 明说（`truncated`），前端据此提示「只显示了前 N 字节」。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_READ_BYTES = 8 * 1024 * 1024

export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const result = await readTextFile({
      path: requireParam(request, 'path'),
      maxBytes: toInt(searchParam(request, 'maxBytes'), EDITABLE_MAX_BYTES, 1, MAX_READ_BYTES),
    })
    return ok({
      path: result.path,
      text: result.text,
      size: result.size,
      encoding: result.encoding,
      truncated: result.truncated,
    })
  })
}

export async function PUT(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    const path = body.path
    const text = body.text
    if (typeof path !== 'string' || path === '') {
      throw new ApiError('missing_param', '缺少 path。', 400)
    }
    if (typeof text !== 'string') {
      throw new ApiError('invalid_body', 'text 必须是字符串。', 400)
    }
    const entry = await writeTextFile({ path, text, createOnly: body.createOnly === true })
    return ok({ entry })
  })
}
