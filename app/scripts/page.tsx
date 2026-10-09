import { publicConfig } from '@/backstage/lib/config'
import { ScriptsRunner } from '@/components/raven/scripts-runner'
import { RavenShell } from '@/components/raven/shell'

/**
 * 脚本页（服务端组件）。
 *
 * `allowScriptExecution` 直接来自配置：关掉时界面要显示明确的禁用状态，
 * 而不是让用户选好脚本、按下去才在 SSE 里收到 403 —— 那是一次没必要的往返，
 * 而且「点了没反应」比「一开始就告诉我不能用」差得多。
 */
export const dynamic = 'force-dynamic'

export default function ScriptsPage() {
  const config = publicConfig()
  return (
    <RavenShell version={config.version} username={config.username} maxWidth="wide">
      <ScriptsRunner publicConfig={config} />
    </RavenShell>
  )
}
