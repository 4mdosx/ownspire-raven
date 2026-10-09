import { publicConfig } from '@/backstage/lib/config'
import { LoginForm } from './login-form'

/**
 * 登录页（服务端组件）。
 *
 * ⚠️ 这是唯一一个**不套 `RavenShell`** 的页面：shell 里有「退出登录」和四个页面的
 * 导航，而未登录时点任何一个都会被 proxy 弹回来，那等于给用户四个必然失败的按钮。
 *
 * `next` 参数来自 proxy 的重定向（`?next=/files`）。⚠️ 只接受**站内相对路径**：
 * 直接把查询参数塞进 `location.replace()` 就是一个开放重定向。
 * 这里强制它必须以单个 `/` 开头、且不含协议与反斜杠。
 */
function safeNext(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '/'
  if (!raw.startsWith('/')) return '/'
  // `//evil.com` 与 `/\evil.com` 都会被浏览器当成协议相对地址，必须挡掉。
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  // ⚠️ Next 15+ 的 searchParams 是 Promise，必须 await。忘了 await 会拿到一个
  // 永远为空的普通对象，表现为「重定向回来永远跳首页」。
  const params = await searchParams
  const config = publicConfig()
  return <LoginForm hintUsername={config.username} version={config.version} next={safeNext(params.next)} />
}
