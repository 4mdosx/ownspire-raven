import { NextResponse } from 'next/server'
import { publicConfig } from '@/backstage/lib/config'
import { currentSession } from '@/backstage/services/auth.service'
import { handle } from '@/backstage/lib/http'

/**
 * 当前会话 + 可公开的配置。
 *
 * 前端用它在首屏决定「显示登录页还是工作区」，以及拿配额、剪切板长度、
 * 脚本超时这些展示需要但不必写死的数字。
 * **不返回密码、散列、配置路径、注册令牌。**
 */
export async function GET(): Promise<NextResponse> {
  return handle(async () => {
    const session = await currentSession()
    return NextResponse.json({
      ok: true,
      session: session ? { username: session.sub } : null,
      config: publicConfig(),
    })
  })
}
