import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { isSandboxError, SandboxError } from '@/backstage/lib/sandbox'
import { ConfigError } from '@/backstage/lib/config'

/**
 * API 的统一错误与响应形状。
 *
 * 成功：`{ ok: true, ...数据 }`
 * 失败：`{ ok: false, code: '...', error: '人话说明' }`
 *
 * ⚠️ 所有 route 都必须经过 `handle()` —— 它保证：
 * - 异常不会以 HTML/堆栈的形式漏给前端（Next 默认那条 `Application error` 页面
 *   在 fetch 里是解析不出来的，会让前端把「后端 500」显示成「网络错误」）；
 * - `SandboxError` 自带的 status 被正确使用（403 越界、404 不存在、507 配额满）。
 */

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export function ok<T extends Record<string, unknown>>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, ...data }, init)
}

export function fail(code: string, error: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, code, error }, { status })
}

export async function handle(work: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await work()
  } catch (error) {
    if (isSandboxError(error)) {
      const sandbox = error as SandboxError
      return fail(sandbox.code, sandbox.message, sandbox.status)
    }
    if (error instanceof ApiError) {
      return fail(error.code, error.message, error.status)
    }
    if (error instanceof ConfigError) {
      return fail('config_error', error.message, 500)
    }
    if (error instanceof ZodError) {
      const first = error.issues[0]
      return fail('invalid_input', `${first?.path.join('.') ?? '输入'}：${first?.message ?? '校验失败'}`, 400)
    }
    const message = error instanceof Error ? error.message : String(error)
    // 只在服务端日志里出现堆栈；响应体里只给人话。
    console.error('[raven] 未处理的 API 异常：', error)
    return fail('internal_error', message, 500)
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError('invalid_body', '请求体必须是 JSON 对象。', 400)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('invalid_body', `请求体不是合法 JSON：${(error as Error).message}`, 400)
  }
}

export function searchParam(request: Request, key: string): string | null {
  return new URL(request.url).searchParams.get(key)
}

export function requireParam(request: Request, key: string): string {
  const value = searchParam(request, key)
  if (value === null || value === '') {
    throw new ApiError('missing_param', `缺少查询参数 ${key}。`, 400)
  }
  return value
}
