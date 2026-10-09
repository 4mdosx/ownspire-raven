import { publicConfig } from '@/backstage/lib/config'
import { ModelConfig } from '@/components/raven/model-config'
import { RavenShell } from '@/components/raven/shell'

/**
 * 模型与厂商页（服务端组件）。
 *
 * 只做两件事：把配置取出来交给客户端组件、决定要不要显示「没配置」的提示。
 * **不在服务端读一次目录再传给客户端** —— 那是缓存，而配置页的全部意义是
 * 「改完立刻能看到」；多一份服务端缓存就多一个「界面上还是旧的」的来源。
 */
export const dynamic = 'force-dynamic'

export default function ModelsPage() {
  const config = publicConfig()
  const agentConfigured = (process.env.AGENT_RUNTIME_TOKEN ?? '').trim() !== ''
  return (
    <RavenShell version={config.version} username={config.username}>
      <ModelConfig agentConfigured={agentConfigured} />
    </RavenShell>
  )
}
