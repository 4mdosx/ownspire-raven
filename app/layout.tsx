import type { Metadata, Viewport } from 'next'
import { ToastProvider } from '@/components/raven/feedback'
import './globals.css'

/**
 * 根布局（服务端组件）。
 *
 * ⚠️ **这里绝不能引入任何 `@/backstage/**`**。它是服务端组件，本身能 import，
 * 但 `ToastProvider` 是客户端组件，一旦它（或它的任何依赖）间接把服务端模块
 * 拖进客户端图，构建期就会报 `server-only` 违规。配置由各页面的
 * `publicConfig()` 取，再以 props 形式交给客户端组件。
 *
 * `lang="zh-CN"` 不是装饰：读屏的中文断句、浏览器「翻译此页」的提示、
 * 以及 CSS 的 `:lang()` 选择器都依赖它。
 */

export const metadata: Metadata = {
  title: 'Ownspire Raven',
  description: 'ownspire 的运维面板：文件、剪切板、脚本与服务健康。',
  // 内部工具，不进搜索引擎。robots 只是提示，真正的门是 proxy 的登录拦截。
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 不做 `maximumScale: 1`：那会禁掉用户的捏合缩放，对看日志的人不友好。
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-svh antialiased">
        {/* ToastProvider 包在最外层：任何一个页面的写操作失败都要能弹出来。 */}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
