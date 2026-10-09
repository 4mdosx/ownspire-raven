import { publicConfig } from '@/backstage/lib/config'
import { AgentChat } from '@/components/raven/agent-chat'
import { RavenShell } from '@/components/raven/shell'

/**
 * Agent 页（服务端组件）。
 *
 * **刻意不在服务端探测 agent 是否可用** —— 那样每次进页面都要等一次上游
 * 超时，而且「连不上」和「没配置」是两种完全不同的界面。
 * 两种状态都交给客户端去问 `/api/agent/tools`，各自显示各自的提示。
 */
export const dynamic = 'force-dynamic'

export default function AgentPage() {
  const config = publicConfig()
  return (
    <RavenShell version={config.version} username={config.username} maxWidth="wide">
      <AgentChat />
    </RavenShell>
  )
}