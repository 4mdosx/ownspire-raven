import type { RunResult } from '@/backstage/services/runner.service'

/**
 * SSE 流（脚本运行、指标探针、治理动作共用一套）。
 *
 * 前端只写一份解析逻辑，所以事件名与 data 形状是契约的一部分（docs/10 §7）：
 * `start` / `stdout` / `stderr` / `metrics` / `done` / `error`。
 *
 * 三个容易踩的点：
 *
 * 1. **失败之后 HTTP 状态码改不了了**。`work` 抛错时响应头早已发出，
 *    所以错误只能作为 `error` 事件送出去，HTTP 仍是 200 —— 前端必须
 *    先看事件再判断成败，不能只看 response.ok。
 * 2. **`data:` 里不能出现裸换行**。JSON.stringify 会把字符串里的换行转义成
 *    `\n`，所以只要不自己拼多行字符串就是安全的；这里一律先 stringify。
 * 3. **keepalive 必须是注释行**（`: xxx`）。写 `event: ping` 会让前端的
 *    事件回调被无意义地唤醒，而注释行按规范会被解析器直接丢弃。
 */

export type SseMetricItem = { metric: string; value: number; unit: string }

export type SseStartData = {
  script: string
  /** 运行记录 id；排队等待时还不知道，所以是可选的。 */
  runId?: number
  startedAt: number
  origin: string
}

export type SseEmit = {
  start(data: SseStartData): void
  stdout(chunk: string): void
  stderr(chunk: string): void
  /** 仅指标探针用。 */
  metrics(items: SseMetricItem[]): void
  done(result: RunResult): void
  error(code: string, message: string): void
  /** 契约之外的通用出口，给后续新增事件留一条不改签名的路。 */
  event(name: string, data: unknown): void
}

const encoder = new TextEncoder()

/** 15 秒一次注释行：nginx/Cloudflare 的默认空闲超时多在 60s，留足余量。 */
const KEEPALIVE_MS = 15_000

function encodeFrame(name: string, data: unknown): Uint8Array {
  const payload = typeof data === 'string' ? data : JSON.stringify(data) ?? 'null'
  return encoder.encode(`event: ${name}\ndata: ${payload}\n\n`)
}

/**
 * 取出错误的对外形状。这里刻意**不 import** `ApiError` / `SandboxError`：
 * 只要对象上带着字符串 `code` 就照搬。这样 sse.ts 不依赖 `next/server`，
 * 验证脚本可以单独把它拉起来；两个错误类本来也只有 code/status 有意义。
 */
function describeError(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown }
    if (typeof candidate.code === 'string' && candidate.code !== '') {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : '流中断。',
      }
    }
  }
  if (error instanceof Error) return { code: 'internal_error', message: error.message }
  return { code: 'internal_error', message: String(error) }
}

/**
 * 把一段会产生事件的异步工作包成 `text/event-stream` 响应。
 *
 * `work` 立即开始执行，但**不会**阻塞返回：route 拿到 Response 就可以交出去，
 * 事件边产生边推。`work` 结束后流被关闭，客户端据此判断「完了」。
 */
export function createSseStream(work: (emit: SseEmit) => Promise<void>): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const write = (chunk: Uint8Array): void => {
    if (closed || controller === null) return
    try {
      controller.enqueue(chunk)
    } catch {
      // 客户端断开会 cancel 掉流（或 enqueue 已关闭的流会抛 TypeError）。
      // SSE 是尽力而为的展示通道，最终结论以数据库里的 run_records 为准，
      // 所以这里吞掉即可，不要让它变成一次「运行失败」。
      closed = true
      stopTimer()
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    stopTimer()
    try {
      controller?.close()
    } catch {
      // 已经关了（重复 close 会抛 TypeError）。
    }
  }

  const emit: SseEmit = {
    event: (name, data) => write(encodeFrame(name, data)),
    start: (data) => write(encodeFrame('start', data)),
    stdout: (chunk) => write(encodeFrame('stdout', { chunk })),
    stderr: (chunk) => write(encodeFrame('stderr', { chunk })),
    metrics: (items) => write(encodeFrame('metrics', { items })),
    done: (result) => write(encodeFrame('done', result)),
    error: (code, message) => write(encodeFrame('error', { code, error: message })),
  }

  const stream = new ReadableStream<Uint8Array>({
    start(startController) {
      controller = startController
      timer = setInterval(() => write(encoder.encode(': keepalive\n\n')), KEEPALIVE_MS)
      // 工作异步跑：start() 不能 await 它，否则流要等脚本跑完才「开始」。
      void (async () => {
        try {
          await work(emit)
        } catch (error) {
          const described = describeError(error)
          emit.error(described.code, described.message)
        } finally {
          close()
        }
      })()
    },
    cancel() {
      // 客户端走了：不再写，但**不中断** work —— 脚本和 run_records 的写入
      // 必须跑完，否则「关掉页面」会让数据库里留下一条永远 running 的记录。
      closed = true
      stopTimer()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx 默认会把响应缓冲起来，SSE 就变成「跑完一次性吐出」。
      'X-Accel-Buffering': 'no',
    },
  })
}
