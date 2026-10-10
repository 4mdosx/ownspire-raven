'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/input'
import { apiPost, ApiClientError, fieldErrors, isUnauthorized } from '@/lib/api'
import { errorMessage } from '@/lib/utils'
import { PinInput } from './pin-input'

/**
 * 登录表单。对齐 navi 的两态模式：**首次设置 PIN / 之后输入 PIN 解锁**。
 *
 * 与 raven 旧版（用户名 + 密码）的差别，除了少一个字段之外，还有几处刻意的选择：
 *
 * 1. **失败时原样显示服务端那句 `error`**。限流的 429 会返回「登录失败次数过多，
 *    请 42 秒后再试。」—— 这句话包含**还要等多久**，客户端自己编一句「登录失败」
 *    就把唯一有用的信息丢了。所以这里不翻译、不加工。
 * 2. **解锁态填满就提交，不等点按钮**；**设置态保留按钮**。差别是有理由的：
 *    解锁时输完 4 位意图已经明确，再要求一次点击是这个界面能省掉的唯一一次点击；
 *    而设置态要判「两次是否一致」，在输完之前判不了 —— 而且自动提交会让
 *    「输错一位」立刻报「两次不一致」，用户还没来得及确认就吃了一个错误。
 * 3. **成功后用 `location.replace` 而不是 `router.replace`**：路由器的客户端缓存里
 *    可能还留着「未登录时被 proxy 重定向到 /login」的那次渲染结果，
 *    硬跳转能确保拿到带 cookie 的新会话。代价是一次整页加载，值得。
 *
 * ⚠️ 与 navi 的一个刻意差异：navi 用 server action + `redirect()`，raven 是
 * REST + fetch。这里不搬 navi 的代码形态，只搬凭据语义 —— 混进 server action
 * 会让 raven 的接口风格出现两套。
 */
export function PinLoginForm({
  mode,
  pinLength,
  version,
  next,
}: {
  mode: 'setup' | 'unlock'
  pinLength: number
  version: string
  next: string
}) {
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState('')
  const [pinError, setPinError] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [pending, setPending] = useState(false)

  function clearFieldErrors() {
    setError('')
    setPinError('')
    setConfirmError('')
  }

  function applyFieldErrors(cause: unknown) {
    const errors = fieldErrors(cause)
    setPinError(errors['pin']?.[0] ?? '')
    setConfirmError(errors['confirmPin']?.[0] ?? errors['currentPin']?.[0] ?? '')
    // 服务端给了字段级错误就用它，否则退回信封里那句人话。
    if (Object.keys(errors).length === 0 && cause instanceof ApiClientError) {
      setError(cause.message)
    }
  }

  function succeed() {
    // PIN 不留在 state 里。整页马上会被卸载，但清掉是为了不让它进过 React DevTools。
    setPin('')
    setConfirmPin('')
    window.location.replace(next)
  }

  async function submitUnlock(value: string) {
    if (pending) return
    clearFieldErrors()
    setPending(true)
    try {
      await apiPost<Record<string, unknown>>('/api/auth/login', { pin: value })
      succeed()
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        applyFieldErrors(cause)
        // 只在 401（PIN 错了）时清空：清掉之后用户要从头再输。
        // 429（限流）时**保留**已输的内容 —— 限流解除后可以直接重试，
        // 让人重新输 4 位是对一次限流的过度惩罚。
        if (isUnauthorized(cause)) {
          setPin('')
          setPinError('')
        }
      } else {
        setError(errorMessage(cause, '登录失败。'))
      }
      setPending(false)
    }
  }

  async function submitSetup() {
    if (pending) return
    clearFieldErrors()
    setPending(true)
    try {
      await apiPost<Record<string, unknown>>('/api/auth/setup', { pin, confirmPin })
      succeed()
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        applyFieldErrors(cause)
        // 只清「确认 PIN」这一栏：新 PIN 是用户刚想清楚的，
        // 让他重新输 4 位是最没必要的惩罚。
        setConfirmPin('')
      } else {
        setError(errorMessage(cause, '设置 PIN 失败。'))
      }
      setPending(false)
    }
  }

  const setupReady = pin.length === pinLength && confirmPin.length === pinLength

  return (
    <main className="grid min-h-svh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Ownspire Raven</h1>
          <p className="mt-1 text-xs text-muted-foreground">版本 {version}</p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (mode === 'setup' && setupReady) void submitSetup()
          }}
          className="space-y-5 rounded-lg border bg-card p-5"
          noValidate
        >
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            {mode === 'setup'
              ? `首次使用，请设置一个 ${pinLength} 位 PIN。它保存在本机数据库里，只用于解锁 raven。`
              : `输入 ${pinLength} 位 PIN 解锁。`}
          </p>

          <div className="space-y-2">
            <Label className="text-center">{mode === 'setup' ? '新 PIN' : 'PIN'}</Label>
            <PinInput
              length={pinLength}
              disabled={pending}
              invalid={pinError !== ''}
              label={mode === 'setup' ? '新 PIN' : 'PIN'}
              onChange={setPin}
              // 解锁态填满即提交；设置态不自动提交（要等确认 PIN 那一组）。
              onComplete={(value) => {
                if (mode === 'unlock') void submitUnlock(value)
              }}
            />
            {pinError && <p className="text-center text-[11px] text-destructive">{pinError}</p>}
          </div>

          {mode === 'setup' && (
            <div className="space-y-2">
              <Label className="text-center">确认 PIN</Label>
              <PinInput
                length={pinLength}
                autoFocus={false}
                disabled={pending}
                invalid={confirmError !== ''}
                label="确认 PIN"
                onChange={setConfirmPin}
              />
              {confirmError && (
                <p className="text-center text-[11px] text-destructive">{confirmError}</p>
              )}
            </div>
          )}

          {/* `role="alert"` 让读屏立刻念出错误；`break-words` 是因为限流文案
              可能很长，窄屏上不换行会把卡片撑破。 */}
          {error && (
            <p
              role="alert"
              className="break-words rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          {mode === 'setup' ? (
            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full"
              loading={pending}
              disabled={!setupReady}
            >
              {pending ? '保存中…' : '保存 PIN'}
            </Button>
          ) : (
            // 解锁态没有提交按钮（填满即提交）。留一个「重新载入」是因为
            // 用户中途在别处改了 PIN 的话，本页的 setup/unlock 判定已经过期，
            // 这是他唯一能重新读到当前状态的入口。
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={pending}
              onClick={() => window.location.reload()}
            >
              {pending ? '验证中…' : '重新载入'}
            </Button>
          )}
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          PIN 输错会触发临时限流，界面会显示服务端返回的剩余等待时间。
        </p>
      </div>
    </main>
  )
}
