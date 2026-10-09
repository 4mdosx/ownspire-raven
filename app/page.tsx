import { publicConfig } from '@/backstage/lib/config'
import { Dashboard } from '@/components/raven/dashboard'
import { RavenShell } from '@/components/raven/shell'

/**
 * 总览页（服务端组件）。
 *
 * ⚠️ 页面只做两件事：取 `publicConfig()`、把它交给客户端组件。
 * **不在这一层取 Dashboard 数据** —— 那样会变成「服务端渲染一次 + 客户端
 * 每 30 秒再拉一次」两套来源，两边的 `fromCache` 状态还不同步，界面会出现
 * 「刚进去显示的是旧的，一秒后跳成新的」。
 *
 * `force-dynamic`：这个页面依赖运行期配置（版本号、用户名），而且本身是
 * 一个仪表盘，静态化没有任何收益。
 */
export const dynamic = 'force-dynamic'

export default function DashboardPage() {
  const config = publicConfig()
  return (
    <RavenShell version={config.version} username={config.username} maxWidth="wide">
      <Dashboard publicConfig={config} />
    </RavenShell>
  )
}
