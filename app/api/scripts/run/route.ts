import type { NextResponse } from 'next/server'
import { ApiError, handle, readJson } from '@/backstage/lib/http'
import { createSseStream } from '@/backstage/lib/sse'
import { assertScriptRunnable, runWorkspaceScript } from '@/backstage/services/runner.service'

/**
 * POST /api/scripts/run —— `{name,args?}` → SSE（契约 §8）。
 *
 * 准入检查在**开流之前**做：这样「脚本不存在」「执行被关掉」会以普通信封
 * 错误返回（403/404 + JSON），前端的 apiStream 正是按这个假设写的 —— 它先看
 * content-type，不是事件流就按信封解析。等到开了流再报错，就只能塞一个
 * `error` 事件在 200 里，前端得多写一条分支。
 *
 * 事件流一样要经过 `handle()`：张罗响应头之前抛的异常仍然要走统一信封。
 */

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    if (typeof body.name !== 'string' || body.name === '') {
      throw new ApiError('missing_param', '缺少脚本名 name。', 400)
    }
    const name = body.name
    const args = Array.isArray(body.args)
      ? body.args.filter((item): item is string => typeof item === 'string')
      : []
    const triggeredBy = typeof body.triggeredBy === 'string' && body.triggeredBy !== '' ? body.triggeredBy : 'ui'
    await assertScriptRunnable(name)

    return createSseStream(async (emit) => {
      // runId 排队时还不知道，RunResult 会在 done 事件里带上真正的 recordId。
      emit.start({ script: name, startedAt: Date.now(), origin: 'workspace' })
      const result = await runWorkspaceScript({
        name,
        args,
        triggeredBy,
        onStdout: (chunk) => emit.stdout(chunk),
        onStderr: (chunk) => emit.stderr(chunk),
      })
      emit.done(result)
    }) as unknown as NextResponse
  })
}
