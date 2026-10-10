import { publicConfig } from '@/backstage/lib/config'
import { FilesManager } from '@/components/raven/files-manager'
import { RavenShell } from '@/components/raven/shell'

/**
 * 文件页（服务端组件）。
 *
 * 只把 `publicConfig` 里的工作区信息交给客户端 —— 配额与用量是**运行期数据**，
 * 由客户端自己打 `/api/files/stats`：那样上传完能立刻刷新配额条，
 * 而不需要整页重新渲染。
 */
export const dynamic = 'force-dynamic'

export default function FilesPage() {
  const config = publicConfig()
  return (
    <RavenShell version={config.version} maxWidth="wide">
      <FilesManager publicConfig={config} />
    </RavenShell>
  )
}
