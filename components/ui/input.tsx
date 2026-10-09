'use client'

import { forwardRef, useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * 输入类原语。
 *
 * ⚠️ 三个都不接受「把 label 写在 placeholder 里」。placeholder 在聚焦后消失，
 * 而且读屏软件不把它当标签 —— 文件管理器/脚本页都是长表单，失去标签会让
 * 键盘用户无法回头确认自己在填哪一栏。所以 `Field` 是独立组件，label 是真元素。
 */

const FIELD_BASE =
  'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref
) {
  return <input {...rest} ref={ref} className={cn(FIELD_BASE, 'h-9', className)} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea {...rest} ref={ref} className={cn(FIELD_BASE, 'min-h-20 resize-y', className)} />
  }
)

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...rest },
  ref
) {
  return <select {...rest} ref={ref} className={cn(FIELD_BASE, 'h-9', className)} />
})

export function Label({ className, ...rest }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...rest} className={cn('block text-xs font-medium text-muted-foreground', className)} />
}

/**
 * label + 控件 + 说明/错误的组合。
 *
 * `hint` 与 `error` **同时存在时都显示**：错误是「提交失败的原因」，hint 是
 * 「这一栏是什么」。把 hint 换掉会让用户失去上下文，尤其是服务器返回的
 * 长错误（配额、越界）压掉了「这里是目标路径」这种关键提示。
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: string
  hint?: React.ReactNode
  error?: string
  htmlFor?: string
  className?: string
  children: React.ReactNode
}) {
  const generated = useId()
  const id = htmlFor ?? generated
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      {/* 控件由调用方渲染，把 id 传下去；这里不再包一层，避免嵌套 label。 */}
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      {error && <p className="text-[11px] leading-snug text-destructive">{error}</p>}
    </div>
  )
}

/**
 * 复选框 + 文字说明的整行可点区域。
 *
 * ⚠️ 原生 checkbox 的默认尺寸（13px）在文件列表里太小，点不中。用 `size-4`
 * 放大，但**不能**只靠 `accent-color` 改样式 —— 那在 Safari 上会被忽略，
 * 所以底色变化只是锦上添花，勾选状态本身始终由原生控件表达。
 */
export function Checkbox({
  className,
  label,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode }) {
  const box = <input {...rest} type="checkbox" className={cn('size-4 shrink-0 cursor-pointer accent-primary', className)} />
  if (label === undefined) return box
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
      {box}
      <span className="select-none">{label}</span>
    </label>
  )
}
