import type { NextResponse } from 'next/server'
import { ApiError, handle, ok } from '@/backstage/lib/http'
import { createWithAttachments, MAX_ATTACHMENT_BYTES } from '@/backstage/services/clipboard.service'

/**
 * POST /api/clipboard/attachments —— multipart：`text` + 若干文件。
 *
 * 字段名的规矩：**所有** File 都当附件收，不看字段名（浏览器的 input name
 * 千奇百怪，要求调用方统一命名没有意义），顺序就是 FormData 的插入顺序，
 * 它决定附件在条目里的先后。`text` 可以空，但那样至少要有一个文件。
 *
 * 这里先按 `content-length` 拦一道超过 32MiB + 1MiB 的请求：`formData()` 会
 * 把整个 body 缓冲进内存，等服务层再拒就已经白读了。真实上限仍由服务层
 * 边写边数（代理会改写这个头）。
 */

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES + 1024 * 1024) {
      throw new ApiError('attachments_too_large', '这次粘贴的附件总量超过 32MiB 上限。', 413)
    }

    let form: FormData
    try {
      form = await request.formData()
    } catch (error) {
      throw new ApiError('invalid_body', `multipart 解析失败：${(error as Error).message}`, 400)
    }

    const textValue = form.get('text')
    const text = typeof textValue === 'string' ? textValue : ''
    const attachments: Array<{ name: string; stream: ReadableStream<Uint8Array> }> = []
    for (const value of form.values()) {
      if (typeof value === 'string') continue
      attachments.push({ name: value.name, stream: value.stream() as ReadableStream<Uint8Array> })
    }
    if (attachments.length === 0 && text === '') {
      throw new ApiError('empty_entry', 'multipart 里既没有 text 也没有文件。', 400)
    }

    const result = await createWithAttachments({ text, source: 'web', attachments })
    return ok({ entry: result.entry, evicted: result.evicted })
  })
}
