import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { remove, updateText } from '@/backstage/services/clipboard.service'

/**
 * PATCH /api/clipboard/[id] —— `{text}` 纠错
 * DELETE /api/clipboard/[id] —— 删一条（连附件目录）
 *
 * Next 16 的动态段 `params` 是 Promise，必须 await。`updateText` 不改
 * `createdAt`，所以纠错不会把这一条顶到队首 —— 那是刻意的队列语义。
 */

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await context.params
    const body = await readJson(request)
    if (typeof body.text !== 'string') {
      throw new ApiError('invalid_body', 'text 必须是字符串。', 400)
    }
    return ok({ entry: await updateText(id, body.text) })
  })
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await context.params
    return ok({ removed: (await remove(id)).removed })
  })
}
