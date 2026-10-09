import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 类名合并。
 *
 * ⚠️ 用 `twMerge` 而不是裸 `clsx`：组件默认样式与调用点覆盖样式会同时出现在
 * 一个 className 里（`rounded border` + `rounded-none`），裸 clsx 下谁生效取决于
 * 样式表里的顺序而不是书写顺序 —— 表现是「传了覆盖样式但没生效」，而且只在
 * 某些元素上不生效。twMerge 按 Tailwind 的语义做「后写的赢」。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** 从任意异常里取出可显示的中文说明。不认识的一律落到 fallback，绝不返回空串。 */
export function errorMessage(error: unknown, fallback = '操作失败。'): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  if (typeof error === 'string' && error.trim() !== '') return error
  return fallback
}

/** 拖拽/焦点类交互里常用的 sleep；只在 UI 侧做重试退避时用。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
