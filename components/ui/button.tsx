'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * 按钮。shadcn/ui new-york，**默认值与裁剪处按 raven 保留**。
 *
 * 相对上游 shadcn 改了五处，每处都有理由（不是随手改）：
 *
 * 1. **默认值仍是 `outline` / `sm`，不是 `default`。** 上游默认是实心主按钮，
 *    而 raven 的存量代码大量用 `<Button>文字</Button>` 这种不写 variant 的写法。
 *    改默认值等于**静默改变几百处按钮的视觉** —— 这是最坏的一类迁移事故：
 *    代码 diff 里看不出来，跑起来才发现。
 * 2. **`loading` 是追加 spinner，不是替换文字。** raven 原本就这样，而且这是对的：
 *    替换文字会让按钮宽度在点击后变化，用户的下一次点击就可能落到旁边那个
 *    「删除」上。`AGENTS.md` 明确要求「loading 时保持宽度」。
 * 3. **删掉上游的 `shadow`。** 那些 shadow 是给「立体按钮」用的，raven 是密集
 *    信息面板，shadow 在工具栏上只会显得脏。
 * 4. **同时提供 `primary` 与 `default`、`md` 与 `default`、`danger` 与
 *    `destructive`。** 存量代码写的是 raven 的叫法，上游 shadcn 叫法是另一套。
 *    两个名字都留着，迁移就只是「换实现」而不是「改所有调用点」。
 * 5. **`focus-visible:ring-2` 而非上游的 `ring-1`。** 1px 在 raven 的深色工具栏上
 *    几乎看不见，键盘用户需要能明确知道焦点在哪。
 *
 * ⚠️ `type` 默认 `"button"` 这个约定**不能改**：漏写 type 的按钮在 `<form>` 里
 * 会变成 submit，登录页上表现是「点了别处的按钮把半截表单提交了」。
 */
const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border bg-background hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      },
      size: {
        sm: 'h-7 px-2 text-xs',
        md: 'h-9 px-3 text-sm',
        default: 'h-9 px-3 text-sm',
        // ⚠️ 上游 icon 是 `h-9 w-9`，raven 原本是 `size-7`。
        // 沿用 7×7：raven 的工具栏按钮密度高，9×9 在一行里排不下。
        icon: 'size-7 p-0',
      },
    },
    defaultVariants: {
      // ⚠️ 见文件头第 1 点：默认值不是上游的 `default`/`default`。
      variant: 'outline',
      size: 'sm',
    },
  }
)

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** 渲染成子元素而不是 `<button>`（shadcn 的 `asChild`）。 */
    asChild?: boolean
    /** 加载中：禁用 + 转圈，**按钮宽度不变**。 */
    loading?: boolean
  }

/** raven 原本导出的具名类型，保留以免外部引用断裂。 */
export type ButtonVariant = NonNullable<ButtonProps['variant']>
export type ButtonSize = NonNullable<ButtonProps['size']>

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, disabled, type = 'button', children, ...props },
  ref
) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      {...props}
      ref={ref}
      // ⚠️ `asChild` 时不能给 type —— 那是 `<a>`，多一个 type 属性虽然无害但语义不对。
      type={asChild ? undefined : type}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {/*
        ⚠️ `asChild` 时**不能**在 children 旁边塞 spinner：Slot 要求恰好一个子元素，
        塞两个会让 Radix 抛错。那种场景下 loading 只能靠禁用表达。
      */}
      {loading && !asChild ? (
        <>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  )
})
Button.displayName = 'Button'

export { Button, buttonVariants }

/**
 * 转圈。
 *
 * 为什么不内联进 Button：raven 有些地方需要「没有按钮外壳的 spinner」——
 * 比如 InlineProgress（行内进度条）和 ErrorBar 的忙态。
 *
 * ⚠️ `role="status"` 而非 `aria-hidden`：作为**独立元素**出现时它需要被读屏
 * 念出来（按钮里的那个才是 aria-hidden，因为旁边的文字已经说明了在做什么）。
 */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 role="status" aria-label="加载中" className={cn('size-3.5 animate-spin text-muted-foreground', className)} />
}