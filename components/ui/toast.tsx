'use client'

import * as React from 'react'
import * as ToastPrimitives from '@radix-ui/react-toast'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Toast（shadcn/ui，基于 `@radix-ui/react-toast`）。
 *
 * ⚠️ 这个文件是**新建**的。raven 原先没有 Radix 版 toast ——
 * `components/raven/feedback.tsx` 里那个是手写的、只服务于 raven 业务语义
 * （错误必须带服务端原文、错误停 9 秒、不做自动重试与静默去重）。
 * 那些设计决定**全部保留在那边**，这里只提供 shadcn 的通用原语。
 */

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
  React.ComponentRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(function ToastViewport({ className, ...props }, ref) {
  return (
    <ToastPrimitives.Viewport
      ref={ref}
      className={cn(
        // ⚠️ `z-[60]` 是 raven 的既有约定：dialog 遮罩是 z-50，toast 必须在它上面 ——
        // 否则「删除失败」这种提示会被自己触发的确认框盖住。
        'pointer-events-none fixed bottom-4 right-4 z-[60] flex max-h-screen w-96 flex-col-reverse gap-2',
        className
      )}
      {...props}
    />
  )
})

const toastVariants = cva(
  'pointer-events-auto relative flex w-full items-start gap-2 overflow-hidden rounded-md border p-3 pr-8 text-xs shadow-lg transition-all data-[state=closed]:animate-out data-[state=open]:animate-in',
  {
    variants: {
      variant: {
        default: 'border bg-card text-card-foreground',
        destructive: 'border-destructive/60 bg-card text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

const Toast = React.forwardRef<
  React.ComponentRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> & VariantProps<typeof toastVariants>
>(function Toast({ className, variant, ...props }, ref) {
  return <ToastPrimitives.Root ref={ref} className={cn(toastVariants({ variant }), className)} {...props} />
})

const ToastAction = React.forwardRef<
  React.ComponentRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(function ToastAction({ className, ...props }, ref) {
  return (
    <ToastPrimitives.Action
      ref={ref}
      className={cn(
        'inline-flex h-6 shrink-0 items-center justify-center rounded border px-1.5 text-[11px] font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      {...props}
    />
  )
})

const ToastClose = React.forwardRef<
  React.ComponentRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(function ToastClose({ className, ...props }, ref) {
  return (
    <ToastPrimitives.Close
      ref={ref}
      toast-close=""
      aria-label="关闭提示"
      className={cn(
        'absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      {...props}
    >
      <X aria-hidden className="size-3.5" />
    </ToastPrimitives.Close>
  )
})

const ToastTitle = React.forwardRef<
  React.ComponentRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(function ToastTitle({ className, ...props }, ref) {
  return <ToastPrimitives.Title ref={ref} className={cn('text-xs font-medium', className)} {...props} />
})

const ToastDescription = React.forwardRef<
  React.ComponentRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(function ToastDescription({ className, ...props }, ref) {
  return <ToastPrimitives.Description ref={ref} className={cn('text-[11px] text-muted-foreground', className)} {...props} />
})

export {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
}