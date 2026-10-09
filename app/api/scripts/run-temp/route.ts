import type { NextResponse } from 'next/server'
import { humanBytes } from '@/backstage/lib/format'
import { ApiError, handle } from '@/backstage/lib/http'
import { createSseStream } from '@/backstage/lib/sse'
import { MAX_TEMP_SCRIPT_BYTES, runTempScript } from '@/backstage/services/runner.service'

/**
 * POST /api/scripts/run-temp —— multipart：`file` + `args` → SSE（契约 §8）。
 *
 * `args` 两种写法都收：重复字段（`args=a&args=b`）或一个 JSON 数组字符串
 * （lib/api.ts 的调用方多半直接 `form.append('args', JSON.stringify(args))`）。
 * 前者是表单的自然写法，后者是程序调用的自然写法，两个都认比让调用方去猜好。
 *
 * 临时脚本落盘后以 `.mjs` 执行（见 runner.service 的注释），跑完整个临时目录删掉。
 */

export const runtime = 'nodejs'

function formArgs(form: FormData): string[] {
  const values = form.getAll('args').filter((value): value is string => typeof value === 'string')
  if (values.length === 1) {
    const raw = values[0].trim()
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === 'string')
        }
      } catch {
        // 不是合法 JSON 就当成一个普通参数，别把整次上传毙掉。
      }
    }
  }
  return values
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    let form: FormData
    try {
      form = await request.formData()
    } catch (error) {
      throw new ApiError('invalid_body', `multipart 解析失败：${(error as Error).message}`, 400)
    }

    const file = form.get('file')
    if (file === null || typeof file === 'string') {
      throw new ApiError('missing_file', 'multipart 里缺少 file 字段。', 400)
    }
    if (file.size > MAX_TEMP_SCRIPT_BYTES) {
      // 先按 multipart 报的 size 拒一道：被拒的请求没必要整份读进内存。
      throw new ApiError('script_too_large', `临时脚本超过 ${humanBytes(MAX_TEMP_SCRIPT_BYTES)} 上限。`, 413)
    }
    const name = file.name === '' ? 'script.mjs' : file.name
    const content = await file.text()
    const args = formArgs(form)

    return createSseStream(async (emit) => {
      emit.start({ script: name, startedAt: Date.now(), origin: 'temp' })
      const result = await runTempScript({
        name,
        content,
        args,
        triggeredBy: 'ui',
        onStdout: (chunk) => emit.stdout(chunk),
        onStderr: (chunk) => emit.stderr(chunk),
      })
      emit.done(result)
    }) as unknown as NextResponse
  })
}
