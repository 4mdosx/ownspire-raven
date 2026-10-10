'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * 模态框（shadcn/ui，**包装成 raven 原本的 `Modal` API**）。
 *
 * ============================ 为什么保留 `Modal` 这个壳 ============================
 *
 * shadcn 上游是 `Dialog` + `DialogContent` + `DialogHeader` + `DialogTitle`… 一组
 * 复合件。raven 的存量代码是 `<Modal open title onClose footer width>` 这一个整块，
 * 4 个文件、十几处调用。改成上游那套要动每一处的 JSX 结构 —— 而**那一处 `width`、
 * `description`、以及「children 与 footer 之间那两条分隔线」都是 raven 自己定的**
 * （上游 `DialogContent` 是一个 `grid gap-4` 的整块，没有 header/footer 分隔）。
 *
 * 所以这里**只把底下的实现换成 Radix**（拿到真正的 focus-trap、Esc、
 * `aria-labelledby` 关联、`scroll-lock`、`inert` 背景），**API 与视觉保持不变**。
 * 这是「换实现」而不是「重写调用点」，diff 小且可审查。
 *
 * ============================ 顺带修掉的三个真实问题 ============================
 *
 * 迁移前 raven 的手写版（243 行）自己实现了焦点环，而它是：
 *
 * 1. **没有 `aria-labelledby`。** 它写了 `role="dialog"` + `aria-modal="true"` +
 *    `aria-label={title}`，看起来齐全 —— 但 `aria-modal` 的正确用法是同时把背景
 *    标记为 `inert`，而那个只能靠 Radix 做。手写版里背景**没有**被 inert，
 *    读屏用户可以 Tab 到弹窗后面那些看不见但可聚焦的元素上。
 * 2. **焦点环是手写的简易版**，只处理「Tab 到头绕回开头」，不处理
 *    元素可见性、不处理 shadow DOM、不处理禁用态。Radix 的 focus-trap 是完整的。
 * 3. **背景不锁滚动。** 手写版给遮罩加了 `overflow-y-auto`，但 body 本身还能滚。
 *
 * 另外原手写版有一处**刻意的正确取舍**：`open === false` 时直接返回 `null`，
 * 注释写着「不做 CSS 隐藏动画，动画期间元素还在可访问性树里（读屏能 Tab 进去）」。
 * Radix 的 `Presence` 已经处理了这件事（只在 `open` 时挂载），所以这个取舍
 * 由 Radix 承担，不需要额外代码。
 *
 * ⚠️ **动画类刻意不用 shadcn 上游那一套**（`data-[state=open]:animate-in`
 * `fade-in-0` `zoom-in-95`…）：那些类来自 `tailwindcss-animate` 插件，
 * 而 **raven 的 `globals.css` 里没有 `@plugin` 引入它**，照抄过来就是一批
 * 不存在的类 —— 表现是「类名写了但什么都不会发生」，而且 review 时看不出来。
 * （顺带发现：navi 自己的 dialog 也是这么写的，它的动画同样没生效。）
 * 这里用 Tailwind 4 原生的 `transition-opacity` / `transition-transform`。
 * 真要上动画基础设施，应引 `tw-animate-css` 并在 globals.css 里 `@plugin` 引入。
 */

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        // `bg-black/50` 而不是 navi 的 `bg-black/80`：raven 的弹窗叠在文件列表上，
        // 80% 会让人完全失去对背景的参照（要对照文件名确认自己在删哪个文件）。
        'fixed inset-0 z-50 bg-black/50 transition-opacity data-[state=closed]:opacity-0',
        className
      )}
      {...props}
    />
  )
})

/** 与 raven 原版一致的宽度档位。 */
const MODAL_WIDTHS = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** raven 的定位：顶部对齐而不是垂直居中（原版是 `pt-[10vh]` 的居中偏上）。 */
    width?: keyof typeof MODAL_WIDTHS
  }
>(function DialogContent({ className, children, width = 'md', ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // ⚠️ 原来的位置是 `flex items-start justify-center ... pt-[10vh]`（在遮罩层里排版）。
          // Radix 要求 Content 自己定位，所以改成 fixed + 居中，顶部留 10vh ——
          // 视觉位置与原版一致。
          'fixed left-1/2 top-[10vh] z-50 w-[calc(100%-2rem)] -translate-x-1/2 transition-all data-[state=closed]:opacity-0 data-[state=closed]:scale-[0.98]',
          'max-h-[80vh] overflow-y-auto',
          MODAL_WIDTHS[width],
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})

const DialogHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    className={cn(
      // ⚠️ 原版是 `flex items-start justify-between gap-4 border-b px-4 py-3` ——
      // 「标题与关闭按钮同一行 + 下方一条分隔线」。上游是 `text-center sm:text-left`
      // 且**没有**分隔线，视觉会明显变样，所以这里按 raven 的原样来。
      'flex items-start justify-between gap-4 border-b px-4 py-3',
      className
    )}
    {...props}
  />
)

const DialogFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div className={cn('flex items-center justify-end gap-2 border-t px-4 py-3', className)} {...props} />
)

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('min-w-0 text-sm font-semibold', className)}
      {...props}
    />
  )
})

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('mt-0.5 text-xs text-muted-foreground', className)}
      {...props}
    />
  )
})

// ---------------------------------------------------------------------------
// raven 的 `Modal` —— 保持原有 API，内部换成 Radix
// ---------------------------------------------------------------------------

/**
 * raven 原本的模态框 API。**存量调用点全部不改。**
 *
 * 行为与原版的差异（都是 Radix 带来的改进，不是退化）：
 * - 背景变成 `inert`：读屏与 Tab 都进不去弹窗后面的内容了。
 * - 焦点真正被 trap 住，边界处理是完整的（不再是「只算绕回开头」）。
 * - body 锁滚动。
 * - `aria-labelledby` / `aria-describedby` 由 Radix 自动关联到 Title/Description。
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
  width?: keyof typeof MODAL_WIDTHS
  /** `false` 用于「必须显式点取消」的场合（比如有未保存的编辑）。 */
  closeOnBackdrop?: boolean
}) {
  return (
    <Dialog
      open={open}
      // Radix 在 Esc / 点遮罩 / 关按钮 / 外部点击时都会调 onOpenChange，
      // 全部转成 onClose —— 这是 raven 原版的语义（它只有一个 onClose）。
      // `closeOnBackdrop === false` 的场景交给下面的 onPointerDownOutside 单独挡，
      // 因为那需要区分「点击来源」：挡在这里会连 Esc 和关闭按钮一起挡掉。
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        width={width}
        // 遮罩点击不走 Radix 的 onOpenChange，而是完全由我们决定，
        // 这样 `closeOnBackdrop` 的语义才准确。
        onPointerDownOutside={(event) => {
          if (!closeOnBackdrop) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (!closeOnBackdrop) event.preventDefault()
        }}
        className="rounded-lg border bg-card text-card-foreground shadow-lg"
      >
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </div>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="关闭"
              title="关闭（Esc）"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-base leading-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <X aria-hidden className="size-4" />
            </button>
          </DialogClose>
        </DialogHeader>
        {children && <div className="px-4 py-3 text-sm">{children}</div>}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 需要输入确认词的危险操作对话框。
 *
 * ⚠️ **raven 独有的组件，shadcn 上游没有。** 而它背后是一条硬要求
 * （见 `AGENTS.md` 的删除操作段）：破坏性操作必须给出「将删 N 个文件」这类回执，
 * 且不可撤销的操作要**输入原词**确认。
 *
 * 为什么是「输入原词」而不是「点两次确定」：双击确认在肌肉记忆下等于没有确认。
 * 契约里 `needsConfirm` 的动作语义就是「要你打一遍那个词」，删除文件同理 ——
 * 打出来的那一下是需要读的。
 *
 * （原来的实现与 `Modal` 在同一个文件里，现在 `Modal` 换成了 Radix 版，
 * 而这个组件的逻辑一个字没改 —— 它上面那两条设计理由依然成立。）
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
  const [typed, setTyped] = React.useState('')

  // 每次打开都清空输入：上一次残留的确认词会让「打开就能点确认」，
  // 这正好抵消了二次确认的全部意义。
  React.useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const ready = requirePhrase === undefined || typed === requirePhrase

  const submit = React.useCallback(() => {
    if (!ready) return
    onConfirm()
  }, [ready, onConfirm])

  return (
    <Modal
      open={open}
      title={title}
      // ⚠️ busy 时不给关闭：操作正在跑，关掉弹窗不会停止它，
      // 用户会以为取消了却看到数据继续变。
      onClose={busy ? () => undefined : onCancel}
      width="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!ready}
            aria-busy={busy || undefined}
            className={cn(
              'inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
              danger ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="text-sm">{message}</div>
        {detail && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed">{detail}</div>
        )}
        {requirePhrase !== undefined && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              这是不可撤销的操作。请输入 <code className="rounded bg-muted px-1 font-mono">{requirePhrase}</code> 以继续。
            </p>
            {/* ⚠️ 用原生 input 而不是 ui/input：Radix Dialog 会把焦点锁在
                `Content` 里，但**不会**自动聚焦第一个可聚焦元素，
                所以这里必须显式 autoFocus。 */}
            <input
              value={typed}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={requirePhrase}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        )}
      </div>
    </Modal>
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}