import type { NextResponse } from 'next/server'
import { handle, ok } from '@/backstage/lib/http'
import { collectAll } from '@/backstage/services/dashboard.service'

/**
 * 立刻采一轮（契约 §8）。
 *
 * 一律 `force: true`：这个端点的语义就是「现在去问一遍上游」，点到它的人
 * 要的是最新状态而不是缓存。`services.collect === false` 时 `collectAll`
 * 会变成一个只回放缓存的空操作（连一个上游请求都不发），返回值里
 * `collected` 为空、`cached` 列出全部服务，前端据此说明「采集已关闭」。
 *
 * 不做 SSE：健康采集是「短请求 + 一串数据库写入」，用普通 JSON 返回
 * collected/cached 两串 id 就够了，为它开一条流只是多一层失败模式。
 */
export async function POST(): Promise<NextResponse> {
  return handle(async () => ok({ ...(await collectAll({ force: true })) }))
}
