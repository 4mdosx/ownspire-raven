import { redirect } from 'next/navigation'
import { publicConfig } from '@/backstage/lib/config'
import { currentSession } from '@/backstage/services/auth.service'
import { isPinConfigured } from '@/backstage/services/pin.service'
import { PIN_LENGTH } from '@/backstage/services/auth.types'
import { ensureSchema } from '@/backstage/db/database'
import { PinLoginForm } from './login-form'

/**
 * 登录页（服务端组件）。
 *
 * **两态由服务端决定**，不由客户端猜：`isPinConfigured()` 为假 → 首次设置，
 * 为真 → 解锁。放在服务端是因为这个判断要读 SQLite，而客户端拿不到这个信息 ——
 * 让客户端先渲染再纠正会闪一下错误的表单，而且首次设置时用户会先看到
 * 一个「输入 PIN」的框，再被告知「尚未设置 PIN」。
 *
 * ⚠️ 这是唯一一个**不套 `RavenShell`** 的页面：shell 里有「退出登录」和六个页面的
 * 导航，而未登录时点任何一个都会被 proxy 弹回来，那等于给用户六个必然失败的按钮。
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

  // PIN 存在 settings 表里，读它之前得确保结构在（首次部署时表还不存在）。
  ensureSchema()
  const configured = isPinConfigured()
  const next = safeNext(params.next)

  // 已经解锁就别再给一次登录框。proxy 本该拦住，但直接访问 /login 时这里兜住。
  if (configured && (await currentSession())) {
    redirect(next)
  }

  const config = publicConfig()
  return (
    <PinLoginForm
      mode={configured ? 'unlock' : 'setup'}
      pinLength={PIN_LENGTH}
      version={config.version}
      next={next}
    />
  )
}
