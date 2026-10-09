import type { NextResponse } from 'next/server'
import { handle, ok } from '@/backstage/lib/http'
import { requireSession } from '@/backstage/services/auth.service'
import { removeService } from '@/backstage/services/registry.service'

/**
 * 注销一个服务（契约 §8）—— 只删注册表文件里的条目。
 *
 * 内联定义（`config.services.defs`）删不掉：那份内容属于配置文件，
 * API 把它摘掉只会让「配置里明明写着、dashboard 上却没有」变成一个幽灵。
 * 这种情况 `removeService` 抛 `not_persistable`，前端把原因显示出来。
 *
 * 这里再调一次 `requireSession()`：proxy 只验签、不查配置指纹，改完密码之后
 * 旧 cookie 能过 proxy 但过不了 service 层 —— 它就是为这一层存在的。
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params
    await requireSession()
    const { removed } = await removeService(id)
    return ok({ removed, id })
  })
}
