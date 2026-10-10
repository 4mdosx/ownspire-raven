'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Button, Spinner } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * raven 的业务反馈层。**这些不是 shadcn 原语** —— shadcn 没有对应物，
 * 也不该有：它们承载的是 raven 自己的产品约定。
 *
 * （shadcn 版的通用 toast 在 `components/ui/toast.tsx`，基于 Radix。
 * 这一层刻意没有改用它 —— 见下方 `ToastProvider` 的注释。）
 *
 * ⚠️ 为什么从 `components/ui/toast.tsx` 挪出来：那个目录的语义是
 * 「通用、无业务含义、可以整个删掉不影响产品」的原语。把 `ErrorBar`、
 * `StatusPill` 这种带 raven 业务判断的东西放进去，会让「这个文件能不能动」
 * 变得没有答案。
 */

export type ToastTone = 'ok' | 'error' | 'info'

export type ToastInput = {
  tone: ToastTone
  text: string
  /** 可选的补充说明（例如被淘汰的剪切板条数）。 */
  detail?: string
  /** 给用户一个出口，比如「去登录」。 */
  action?: { label: string; onClick: () => void }
}

type ToastItem = ToastInput & { id: number }

type ToastContextValue = {
  push: (toast: ToastInput) => void
  ok: (text: string, detail?: string) => void
  error: (text: string, detail?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (context === null) {
    // 用错 Provider 是编码错误，不该在运行期静默吞掉 —— 那会让「提示没出现」
    // 变成一个查不出来的 bug。
    throw new Error('useToast() 必须在 <ToastProvider> 内部使用。')
  }
  return context
}

/**
 * 全局提示。
 *
 * 为什么要有这一层：raven 的每个写操作都可能被服务端拒绝（配额 507、越界 403、
 * 名字非法 400），而拒绝发生在**用户已经切换到别处**之后（上传在后台跑、脚本
 * 还在流式输出）。把错误只画在触发它的那个组件里，用户看不到 —— 那就是静默失败。
 * 所以：错误走 toast，**必须带服务端原文**；表单内的校验错误仍然留在表单旁边。
 *
 * ⚠️ 有意不做「自动重试」和「静默去重」。前者会把 507 配额错误变成一串重复请求，
 * 后者会让「同一个错误发生了 5 次」看起来像 1 次。
 *
 * ⚠️ **这里没有换成 Radix 的 Toast。** 三个理由，按重要性排：
 * 1. Radix Toast 有「自动关闭计时由它接管」的行为，而 raven 的错误要停 9 秒
 *    （是要读的句子，而且常常是唯一一次展示机会）—— 能配，但 Raven 还需要
 *    「点击别处不关闭、只能点 ×」，Radix 的 `duration` 模型要配合更多 hack。
 * 2. raven 的 toast 有一个**动作按钮**（`action`），用在「会话失效 → 去登录」这类
 *    需要用户跳转的场合。
 * 3. 手写版一共 40 行，行为完全可控，且 raven 目前只有一个 toast 消费点
 *    （`app/layout.tsx`）。换成 Radix 带来的收益不足以抵掉上面两条的复杂度。
 * 真要统一到 Radix Toast 时，把「错误停 9 秒 + action 按钮」两条搬过去即可，
 * 调用侧的 `toast.ok/error/push` API 不变。
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current
      nextId.current += 1
      setItems((current) => [...current, { ...toast, id }])
      // 错误停久一点：那是要读的句子，而且常常是唯一一次展示机会。
      const ttl = toast.tone === 'error' ? 9000 : 4000
      window.setTimeout(() => remove(id), ttl)
    },
    [remove]
  )

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      ok: (text, detail) => push({ tone: 'ok', text, detail }),
      // ⚠️ 空字符串**必须**换掉：服务端偶尔会给出空 message（例如内部异常但
      // 没有文案），显示一个空白的红框等于「什么都没说」，那正是这个界面最不
      // 该有的行为。
      error: (text, detail) =>
        push({ tone: 'error', text: text.trim() === '' ? '操作失败，服务端没有给出说明。' : text, detail }),
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* `aria-live="polite"`：读屏会把新提示念出来，但不打断当前朗读。
          错误用的是 assertive 的容器语义更合适，但那会打断用户正在输入的
          内容；raven 的场景里错误也会同时留在页面上，所以 polite 够了。 */}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto rounded-md border bg-card px-3 py-2 shadow-lg',
              item.tone === 'error' && 'border-destructive/60',
              item.tone === 'ok' && 'border-emerald-500/50'
            )}
          >
            <div className="flex items-start gap-2">
              <p className={cn('min-w-0 flex-1 text-xs leading-snug', item.tone === 'error' && 'text-destructive')}>
                {item.text}
              </p>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭提示"
                title="关闭提示"
                className="size-5 shrink-0"
                onClick={() => remove(item.id)}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </div>
            {item.detail && <p className="mt-1 text-[11px] text-muted-foreground">{item.detail}</p>}
            {item.action && (
              <Button variant="outline" className="mt-2" onClick={() => { item.action?.onClick(); remove(item.id) }}>
                {item.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/**
 * 页面内联的错误条。
 *
 * 与 toast 的分工：**渲染失败的加载错误**用这个（它需要一直挂在那里，直到用户
 * 重试成功），**动作失败**用 toast（用户可能已经看不到触发点了）。
 * `onRetry` 是可选但强烈建议给的 —— 一个没有重试按钮的错误条会逼用户刷新整页。
 */
export function ErrorBar({
  message,
  detail,
  onRetry,
  onDismiss,
  busy,
}: {
  message: string
  detail?: string
  onRetry?: () => void
  onDismiss?: () => void
  busy?: boolean
}) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-destructive">{message}</p>
        {detail && <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>}
      </div>
      {busy && <Spinner className="mt-0.5 size-3.5 text-muted-foreground" />}
      {onRetry && (
        <Button variant="outline" onClick={onRetry} disabled={busy}>
          重试
        </Button>
      )}
      {onDismiss && (
        <Button variant="ghost" size="icon" aria-label="关闭这条错误" title="关闭" onClick={onDismiss}>
          <span aria-hidden="true">×</span>
        </Button>
      )}
    </div>
  )
}

export type StatusTone = 'ok' | 'warn' | 'down' | 'unknown' | 'busy'

/**
 * 状态药丸。
 *
 * ⚠️ 颜色**不是唯一**的信息载体：每个 pill 都带文字。色盲用户、以及
 * 「warn 的黄和 ok 的绿在低亮度屏上分不开」这两种情况都靠文字兜住。
 */
export function StatusPill({ tone, children, title }: { tone: StatusTone; children: React.ReactNode; title?: string }) {
  const tones: Record<StatusTone, string> = {
    ok: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    warn: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    down: 'border-destructive/60 bg-destructive/10 text-destructive',
    unknown: 'border-border bg-muted text-muted-foreground',
    busy: 'border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  }
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[tone])}
    >
      {children}
    </span>
  )
}