'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { apiPost, ApiClientError, isUnauthorized } from '@/lib/api'
import { errorMessage } from '@/lib/utils'

/**
 * 登录表单。
 *
 * 三条硬性要求，各自的理由：
 *
 * 1. **失败时原样显示服务端那句 `error`**。限流的 429 会返回「登录失败次数过多，
 *    请 42 秒后再试。」—— 这句话包含**还要等多久**，客户端自己编一句
 *    「登录失败」就把唯一有用的信息丢了。所以这里不翻译、不加工。
 * 2. **用户名自动聚焦、回车提交**。登录是一个每天要做一次的动作，
 *    多一次点击就是每天多一次摩擦。回车走 `<form onSubmit>`，
 *    这样输入法（中文/日文）在组合状态下的回车不会被误当成提交。
 * 3. **成功后才跳转**。先 `router.replace` 再等接口返回，会在密码错误时
 *    闪过一丝仪表盘（而且 proxy 会立刻把人弹回 /login，看起来像随机跳页）。
 *    成功时用 `router.replace` 而不是 `push`：登录成功那一页不该留在历史里，
 *    否则点「后退」又会回到登录表单。
 */
export function LoginForm({ hintUsername, version, next }: { hintUsername: string; version: string; next: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const usernameRef = useRef<HTMLInputElement | null>(null)

  // 自动聚焦。放在 effect 里而不是 autoFocus 属性：SSR 出来的 HTML 上没有这个
  // 属性，React 的水合过程才能安全接管；而且这样能确保**每次进入页面**都聚焦，
  // 包括从别的页面 client-side 导航回来时。
  useEffect(() => {
    usernameRef.current?.focus()
  }, [])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError('')

    if (username.trim() === '' || password === '') {
      setError('请填写用户名和密码。')
      return
    }

    setPending(true)
    try {
      await apiPost<Record<string, unknown>>('/api/auth/login', { username, password })
      // 密码**不留**在任何 state 里，跳转前先清掉 —— 这一步失败也不影响，
      // 因为整页马上会被卸载。
      setPassword('')
      // ⚠️ 用 `location.replace` 而不是 `router.replace`：路由器的客户端缓存里
      // 可能还留着「未登录时被 proxy 重定向到 /login」的那次渲染结果，
      // 硬跳转能确保拿到带 cookie 的新会话。代价是一次整页加载，值得。
      window.location.replace(next)
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        // 401 与 429 都走这里，`cause.message` 就是服务端原文。
        setError(cause.message)
        if (isUnauthorized(cause)) {
          // 凭据错的时候把密码清掉、焦点留在密码框：这是要重输的那一栏。
          setPassword('')
        }
      } else {
        setError(errorMessage(cause, '登录失败。'))
      }
      setPending(false)
    }
  }

  return (
    <main className="grid min-h-svh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Ownspire Raven</h1>
          <p className="mt-1 text-xs text-muted-foreground">版本 {version}</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-5" noValidate>
          <Field
            label="用户名"
            htmlFor="raven-username"
            hint={hintUsername ? `配置里的账号是 ${hintUsername}。` : undefined}
          >
            <Input
              id="raven-username"
              ref={usernameRef}
              name="username"
              value={username}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              // 单账号自托管场景，浏览器密码管理器能省一步。保留原生行为。
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>

          <Field label="密码" htmlFor="raven-password">
            <Input
              id="raven-password"
              name="password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {/* `role="alert"` 让读屏立刻念出错误；`break-words` 是因为限流文案
              可能很长，窄屏上不换行会把卡片撑破。 */}
          {error && (
            <p role="alert" className="break-words rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" size="md" className="w-full" loading={pending}>
            {pending ? '登录中…' : '登录'}
          </Button>
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          登录失败次数过多会被临时限流，界面会直接显示服务端的提示与剩余等待时间。
        </p>
      </div>
    </main>
  )
}
