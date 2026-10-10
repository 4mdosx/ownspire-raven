'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/raven/feedback'
import { apiGet, apiPost, isUnauthorized } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 全站顶栏。
 *
 * 这一层只做三件事：导航、显示当前会话状态、退出登录。**不放任何数据获取**——
 * 六个页面的数据结构完全不同，一个「公共数据层」最后会变成六个页面各自的
 * 特例堆在一个组件里。会话只在这里读一次（为了显示「已解锁」），失败时不做
 * 跳转：proxy 已经保证了页面可达，客户端再跳一次会在网络抖动时把用户
 * 甩到登录页 —— 那是比「状态显示成占位符」严重得多的体验事故。
 *
 * ⚠️ 这里**不再显示用户名**：PIN 登录没有「账号」这个概念，显示一个假的名字
 * 只会让人以为自己记错了什么。现在显示的是「已解锁」这个状态本身。
 */

const NAV = [
  { href: '/', label: '总览' },
  { href: '/agent', label: 'Agent' },
  { href: '/files', label: '文件' },
  { href: '/clipboard', label: '剪切板' },
  { href: '/scripts', label: '脚本' },
  // 厂商/端点/模型的增删改。与 Agent 页分开是因为职责不同：
  // 那页是「用模型」，这页是「配模型」。
  { href: '/models', label: '模型' },
] as const

export function RavenShell({
  children,
  version,
  maxWidth = 'wide',
}: {
  children: React.ReactNode
  version: string
  /** `wide` 给文件管理器/日志（要吃满宽度），`normal` 给卡片型页面。 */
  maxWidth?: 'normal' | 'wide' | 'none'
}) {
  const pathname = usePathname()
  const toast = useToast()
  const [unlocked, setUnlocked] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const body = await apiGet<{ session: { authenticated?: boolean } | null }>(
          '/api/auth/session',
          {},
          { signal: controller.signal }
        )
        setUnlocked(body.session?.authenticated === true)
      } catch (error) {
        // 401 说明 cookie 已经失效（改了 PIN / 会话过期）。这时提示一下并
        // 由用户决定何时重新登录，**不**自动跳转：正在跑的脚本日志会被整页
        // 刷新清掉，而那是他此刻唯一在意的信息。其他错误（网络抖动）忽略，
        // 顶栏状态退化成「已解锁」，不影响使用。
        if (isUnauthorized(error)) {
          setUnlocked(false)
          toast.error('登录状态已失效，写操作会被拒绝。', '重新登录后再操作；当前页面的数据仍可查看。')
        }
      }
    })()
    return () => controller.abort()
    // ⚠️ 依赖数组故意不包含 `toast`：ToastProvider 的 value 是 useMemo 出来的，
    // 在实现上是稳定的，但把对象塞进依赖会让这条「只跑一次」的 effect 依赖
    // 一个外部实现细节。这里用空数组 + 注释锁死意图。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function logout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await apiPost<Record<string, unknown>>('/api/auth/logout')
    } catch (error) {
      // 退出失败**不能**静默：cookie 还在，用户以为退出了但其实没有。
      toast.error(error instanceof Error ? error.message : '退出登录失败。')
      setLoggingOut(false)
      return
    }
    // 硬跳转，理由同登录页：清掉客户端路由缓存里的已登录渲染结果。
    window.location.replace('/login')
  }

  const widths = { normal: 'max-w-5xl', wide: 'max-w-[1600px]', none: '' } as const

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className={cn('mx-auto flex h-12 items-center gap-3 px-4', widths[maxWidth])}>
          <Link href="/" className="flex items-baseline gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="text-sm font-semibold tracking-tight">Ownspire Raven</span>
            <span className="text-[11px] text-muted-foreground">{version}</span>
          </Link>

          <nav aria-label="主导航" className="ml-2 flex items-center gap-1">
            {NAV.map((item) => {
              // ⚠️ 首页要**精确**匹配：`pathname.startsWith('/')` 对每个路径都成立，
              // 用前缀判断会让「总览」在所有页面上都显示为选中。
              const active = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    active ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span
              className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:inline"
              title={unlocked ? 'PIN 已解锁' : '会话已失效，写操作会被拒绝'}
            >
              <span
                aria-hidden
                className={unlocked ? 'size-1.5 rounded-full bg-status-ok' : 'size-1.5 rounded-full bg-status-warn'}
              />
              {unlocked ? '已解锁' : '未解锁'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void logout()} loading={loggingOut} title="退出登录">
              退出登录
            </Button>
          </div>
        </div>
      </header>

      <div className={cn('mx-auto flex w-full min-h-0 flex-1 flex-col px-4 py-4', widths[maxWidth])}>{children}</div>

      <footer className="mx-auto w-full px-4 pb-4 pt-2 text-[11px] text-muted-foreground">
        {/* 只写界面层的来源，不写任何路径 —— 服务端目录结构不该出现在浏览器里。 */}
        数据直接来自 REST API；写操作失败会把服务端返回的原因原样显示出来。
      </footer>
    </div>
  )
}
