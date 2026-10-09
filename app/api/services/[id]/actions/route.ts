import type { NextResponse } from 'next/server'
import { createSseStream } from '@/backstage/lib/sse'
import { ApiError, handle, readJson } from '@/backstage/lib/http'
import { assertActionRunnable, runAction } from '@/backstage/services/dashboard.service'

/**
 * 治理动作（契约 §7 / §8）—— 唯一一条会真的改动线上状态的入口。
 *
 * ⚠️ **顺序是这个 handler 的全部要点**：
 *
 * 1. 先 await params / 读 body / 检查动作存在与确认词；
 * 2. 这些检查失败必须抛成 `ApiError` —— 此刻 `handle()` 还没发响应头，
 *    前端能拿到 404/400 的 JSON 信封（统一错误处理只认它）；
 * 3. 全部通过之后才 `createSseStream()`，进流之后的错误只剩 `error` 事件
 *    （HTTP 已是 200，见 docs/10 §7）。
 *
 * 反过来写（先开流再校验）的症状：动作 id 打错时前端收到一个 200 的空流，
 * 面板上永远是「运行中」，没有任何错误提示。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params
    const body = await readJson(request)
    const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : ''
    if (actionId === '') throw new ApiError('missing_param', '缺少 actionId。', 400)
    const confirm = typeof body.confirm === 'string' ? body.confirm : undefined

    const action = await assertActionRunnable(id, actionId, confirm)

    const stream = createSseStream(async (emit) => {
      emit.start({ script: action.script, startedAt: Date.now(), origin: `action:${id}/${actionId}` })
      const result = await runAction(id, actionId, {
        trigger: 'dashboard',
        confirm,
        onStdout: (chunk) => emit.stdout(chunk),
        onStderr: (chunk) => emit.stderr(chunk),
      })
      emit.done(result)
    })
    // handle() 的签名要的是 NextResponse；SSE 这条流是原生 Response
    // （NextResponse 是它的子类，这里只是把类型掰回来，对象本身没动）。
    return stream as NextResponse
  })
}
