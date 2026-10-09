'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * 模态框。
 *
 * 设计取舍（都是为了「不要用错」）：
 *
 * - **自己实现而不是引 Radix**：raven 只需要「居中卡片 + Esc + 点遮罩关」这一种
 *   形态，Radix 的 focus-trap 在这里的价值不足以换来一个额外依赖与一层
 *   Portal 行为差异（Tailwind 4 的 `@theme` 变量在 Portal 里照样生效，
 *   但 Radix 的 `Dialog.Content` 会强制挂 `data-state` 属性，样式要跟着适配）。
 * - **`createPortal` 到 body**：放在页面 DOM 里会被 `overflow-hidden` 的祖先裁掉，
 *   也会被 `transform` 祖先改变定位基准（这条在带 drawer 的页面上踩过）。
 * - **打开时把焦点移进对话框，关闭时还给原来的元素**：键盘用户按 Esc 关掉弹窗后
 *   如果焦点掉回 `<body>`，Tab 会从头开始走 —— 在文件列表里这等于丢失位置。
 * - **`open` 为 false 时直接返回 null**：不做 CSS 隐藏动画。动画期间元素还在
 *   可访问性树里（读屏能 Tab 进去），比没有动画糟糕得多。
 */

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 'md',
  closeOnBackdrop = true,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  onClose: () => void
  children?: React.ReactNode
  footer?: React.ReactNode
  width?: 'sm' | 'md' | 'lg'
  closeOnBackdrop?: boolean
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  /**
   * ⚠️ `onClose` 存进 ref，effect 的依赖只留 `open`。
   *
   * 调用点几乎都写 `onClose={() => setX(null)}`（每次渲染都是新函数），
   * 把它放进依赖数组会让这个 effect **每渲染一次就重跑一遍**：键盘监听反复
   * 摘挂、焦点被反复「移进面板 + 还给原元素」。表现是弹窗里的输入框偶尔
   * 丢焦点 —— 而且只在父组件恰好重渲染时出现，极难复现。
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const [mounted, setMounted] = useState(false)

  // ⚠️ 放在 effect 里而不是模块顶层判断：SSR 期间 `document` 不存在，
  // 直接调用会在服务端渲染时报错。
  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // ⚠️ stopPropagation：嵌套弹窗（例如确认框盖在编辑器上）时，
        // 不拦住的话两个都会关掉。
        event.stopPropagation()
        onCloseRef.current()
      }
      if (event.key === 'Tab' && panelRef.current) {
        // 简易焦点环。只处理「Tab 到头了绕回开头」这一种情况 ——
        // 完整实现要考虑可聚焦元素的可见性，这里的对话框内容都很短。
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    // 焦点进面板本身，而不是第一个输入框：调用方可能想让某个特定输入框聚焦
    // （用 autoFocus），这里抢焦点会覆盖它。
    const timer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>('[data-autofocus="true"]')
      ;(target ?? panelRef.current)?.focus()
    }, 0)

    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.clearTimeout(timer)
      restoreRef.current?.focus?.()
    }
  }, [open])

  if (!open || !mounted) return null

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[10vh]"
      // ⚠️ 用 onMouseDown 而不是 onClick：从面板内部按下、拖到遮罩上松手
      // 也会触发 click，那会让「选中文字拖出去」这种操作把弹窗关掉。
      onMouseDown={(event) => {
        if (!closeOnBackdrop) return
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'w-full rounded-lg border bg-card text-card-foreground shadow-lg outline-none',
          widths[width]
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭" title="关闭（Esc）">
            <span aria-hidden="true" className="text-base leading-none">
              ×
            </span>
          </Button>
        </header>
        {children && <div className="px-4 py-3 text-sm">{children}</div>}
        {footer && <footer className="flex items-center justify-end gap-2 border-t px-4 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

/**
 * 需要输入确认词的危险操作对话框。
 *
 * 为什么是「输入原词」而不是「点两次确定」：双击确认在肌肉记忆下等于没有确认。
 * 契约里 `needsConfirm` 的动作语义就是「要你打一遍那个词」，而删除文件同理 ——
 * 打出来的那一下是需要读的。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel = '确认',
  danger = true,
  requirePhrase,
  onCancel,
  onConfirm,
  busy = false,
}: {
  open: boolean
  title: string
  message: React.ReactNode
  /** 逐条列出的细项（要删哪些文件、返回的统计数字）。 */
  detail?: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  /** 给了就要求原样输入才允许确认。 */
  requirePhrase?: string
  onCancel: () => void
  onConfirm: () => void
  busy?: boolean
}) {
  const [typed, setTyped] = useState('')

  // 每次打开都清空输入：上一次残留的确认词会让「打开就能点确认」，
  // 这正好抵消了二次确认的全部意义。
  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const ready = requirePhrase === undefined || typed === requirePhrase

  const submit = useCallback(() => {
    if (!ready) return
    onConfirm()
  }, [ready, onConfirm])

  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? () => undefined : onCancel}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} size="md" onClick={submit} disabled={!ready} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="text-sm">{message}</div>
        {detail && <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed">{detail}</div>}
        {requirePhrase !== undefined && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              这是不可撤销的操作。请输入 <code className="rounded bg-muted px-1 font-mono">{requirePhrase}</code> 以继续。
            </p>
            <Input
              value={typed}
              data-autofocus="true"
              autoComplete="off"
              spellCheck={false}
              placeholder={requirePhrase}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}
