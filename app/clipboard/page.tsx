import { publicConfig } from '@/backstage/lib/config'
import { ClipboardBoard } from '@/components/raven/clipboard-board'
import { RavenShell } from '@/components/raven/shell'

/**
 * 剪切板页（服务端组件）。
 *
 * `maxItems` / `maxTextBytes` 来自配置，所以能在**第一次渲染**就把「已用 N / max」
 * 和超长提示画出来。真正的队列数据由客户端拉 —— 这个页面的写入频率最高
 * （每次粘贴一次 POST），服务端渲染一次没有意义。
 */
export const dynamic = 'force-dynamic'

export default function ClipboardPage() {
  const config = publicConfig()
  return (
    <RavenShell version={config.version} maxWidth="normal">
      <ClipboardBoard publicConfig={config} />
    </RavenShell>
  )
}
