'use client'

import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * 最小的按钮原语。
 *
 * ⚠️ 不用 `cva`：raven 的按钮变体只有 4 个，为它多引一个依赖不值得，
 * 而 `cva` 的 `compoundVariants` 在这里也用不上。变体表就是两个普通对象，
 * 读起来比链式 API 更直接。
 *
 * 约定（全站一致）：
 * - `type` 默认 `"button"`。**默认值必须是 button**：漏写 type 的按钮在
 *   `<form>` 里会变成 submit，登录页上表现是「点了别处的按钮把半截表单提交了」。
 * - `loading` 时禁用并保持宽度（用 `opacity` 而不是卸载文字），避免点击后
 *   按钮宽度跳变导致误点到旁边那个「删除」。
 */

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'icon'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs gap-1',
  md: 'h-9 px-3 text-sm gap-1.5',
  // 图标按钮：视觉上必须是正方形，否则一排图标按钮会左对齐出参差的边缘。
  icon: 'size-7 p-0',
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'outline', size = 'sm', loading = false, disabled, type = 'button', children, ...rest },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  )
})

/** 转圈。`aria-hidden` 是有意的：旁边的文字已经说明了正在做什么，读屏不需要再念一遍。 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn('animate-spin', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  )
}
