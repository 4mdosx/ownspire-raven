import type { NextResponse } from 'next/server'
import { handle, ok } from '@/backstage/lib/http'
import { stats } from '@/backstage/services/file.service'

/**
 * GET /api/files/stats —— 配额与用量。
 *
 * 响应直接把 `FileStats` 摊在信封里（`{ok,bytes,files,dirs,quotaBytes,...}`），
 * 与 `GET /api/files` 的摊平风格一致：没有第二层 `stats` 包装，前端少拆一层。
 * `remainingBytes` 走沙箱口径，会把「正在上传但还没落盘」的预留量算进去。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return handle(async () => {
    const usage = await stats()
    return ok({ ...usage })
  })
}
