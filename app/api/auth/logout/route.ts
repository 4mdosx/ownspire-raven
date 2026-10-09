import { NextResponse } from 'next/server'
import { handle } from '@/backstage/lib/http'
import { SESSION_COOKIE } from '@/backstage/services/auth.service'

/**
 * 退出登录。
 *
 * ⚠️ cookie 的属性必须与写入时**完全一致**（path / sameSite / secure），
 * 否则 `delete` 只会发一个不匹配的 Set-Cookie，浏览器保留原 cookie ——
 * 症状是「点了退出但还登录着」。所以这里显式写出同样的属性再置空。
 */
export async function POST(request: Request): Promise<NextResponse> {
  void request
  return handle(async () => {
    const response = NextResponse.json({ ok: true })
    response.cookies.set(SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    })
    return response
  })
}
