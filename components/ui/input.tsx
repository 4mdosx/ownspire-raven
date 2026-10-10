'use client'

import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'

import { cn } from '@/lib/utils'

/**
 * 输入类原语（shadcn 裁剪版）+ raven 自有的 `Field`。
 *
 * ⚠️ **`Field` 是 raven 的东西，shadcn 上游没有，必须留在这个文件里。**
 * 它是「label + 控件 + hint + error」的四段组合，而 raven 的表单几乎每处都在用
 * （文件管理器、脚本运行台、模型配置、设置）。拆成三个独立原语拼的话，
 * 每个调用点都要重复一遍 `flex-col gap-1` 的容器 + 两段条件文字，几十处重复，
 * 而且极易漏掉「hint 与 error 应同时显示」这条规则（见 Field 的注释）。
 */

const FIELD_BASE =
  'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(FIELD_BASE, 'h-9', className)} {...props} />
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(FIELD_BASE, 'min-h-20 resize-y', className)} {...props} />
}

/**
 * `Select` 是原生 `<select>`，**没有**换成 Radix Select。
 *
 * 这是刻意的取舍：Radix Select 会渲染成 button + Portal 的自定义下拉，
 * 视觉与原生在 macOS / Windows 上都不同（原生走系统渲染的系统菜单）。
 * raven 的用法是「执行配置里挑一个脚本」这类低频选择，为它换掉原生控件不划算；
 * 而且原生 select 在移动端会自动弹出系统选择器，可用性反而更好。
 * 真需要更完整的 Select（多选、搜索、分组）时，navi 的
 * `components/ui/select.tsx` 可以整个搬过来。
 */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(FIELD_BASE, 'h-9', className)} {...props} />
}

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        // ⚠️ `peer-disabled:` 而不是上游的只有 `select-none`：
        // 表单里控件被禁用时标签也要看起来禁用，否则用户会一直往一个
        // 填不了的框里打字。
        'block text-xs font-medium text-muted-foreground select-none peer-disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

/**
 * label + 控件 + 说明/错误的组合。
 *
 * ⚠️ **raven 自有组件，shadcn 上游没有。** 保留它的三个理由：
 *
 * 1. `hint` 与 `error` **同时存在时都显示**。错误是「提交失败的原因」，hint 是
 *    「这一栏是什么」。把 hint 换掉会让用户失去上下文 —— 尤其服务器返回的
 *    长错误（配额、越界）会压掉「这里是目标路径」这种关键提示。
 * 2. label 是**真元素**（Radix `<label>` + `htmlFor`），不是写在 placeholder 里。
 *    placeholder 在聚焦后消失，读屏也不把它当标签 —— 长表单里键盘用户
 *    无法回头确认自己在填哪一栏。
 * 3. `useId` 自动关联 id，调用方不必手写 `htmlFor`/`id` 配对（写错一对是常事）。
 */
function Field({
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
  const generated = React.useId()
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
function Checkbox({ className, label, ...props }: React.ComponentProps<'input'> & { label?: React.ReactNode }) {
  const box = (
    <input
      data-slot="checkbox"
      {...props}
      type="checkbox"
      className={cn('size-4 shrink-0 cursor-pointer accent-primary', className)}
    />
  )
  if (label === undefined) return box
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
      {box}
      <span className="select-none">{label}</span>
    </label>
  )
}

export { Input, Textarea, Select, Label, Field, Checkbox }