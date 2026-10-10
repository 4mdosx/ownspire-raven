'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ErrorBar, StatusPill, useToast, type StatusTone } from '@/components/raven/feedback'
import { apiGet, apiPost, apiStream } from '@/lib/api'
import { formatDateTime, formatLatency, formatMetric, humanDuration, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
// 只引类型：`types/config.ts` 是纯类型文件（无运行时依赖、无 server-only），
// `import type` 保证它不会出现在客户端包里。
import type { PublicConfig } from '@/types/config'

/**
 * 总览（Dashboard）。
 *
 * 这个页面要回答的唯一问题是：**现在哪里不对劲，我要跑哪个动作。**
 * 所以每张卡片的注意力顺序是「状态 → 哪一项探测挂了 → 能按的按钮」，
 * 版本号、实体信息、端点链接排在后面。
 *
 * 数据形状**全部按可选字段处理**。契约里 `DashboardService` 有很多数组字段，
 * 但服务注册表允许用户少写几项（没有 probes、没有 metrics、没有 actions 都是
 * 合法配置），崩在一个 `undefined.map` 上等于整个面板白屏 —— 而这是运维最先
 * 打开的页面。
 */

// ---------------------------------------------------------------------------
// 契约 §6 的数据形状（客户端本地声明，字段全可选，防御性读取）
// ---------------------------------------------------------------------------

type DashboardProbe = {
  index?: number
  type?: string
  status?: string
  latencyMs?: number
  message?: string
  version?: string
}

type DashboardHealth = {
  status?: string
  latencyMs?: number | null
  message?: string
  version?: string
  checkedAt?: number
  okCount?: number
  totalCount?: number
  fromCache?: boolean
  probes?: DashboardProbe[]
}

type DashboardMetric = { metric?: string; value?: number; unit?: string; at?: number }
type DashboardHistoryEntry = { status?: string; latencyMs?: number | null; checkedAt?: number; message?: string }
type DashboardEndpoint = { label?: string; url?: string }
type DashboardEntity = {
  id?: string
  title?: string
  endpoint?: string
  port?: number
  source?: string
  commit?: string
  dataDir?: string
  notes?: string
  capabilities?: string[]
}
type DashboardAction = {
  id?: string
  title?: string
  description?: string
  readonly?: boolean
  needsConfirm?: boolean
  /** 服务端下发的确认词；缺省 `yes`。界面不再自己猜。 */
  confirmPhrase?: string
}
type DashboardMetricProbe = { id?: string; title?: string; script?: string; timeoutMs?: number }

type DashboardService = {
  id?: string
  title?: string
  kind?: string
  summary?: string
  enabled?: boolean
  origin?: string
  persistable?: boolean
  endpoints?: DashboardEndpoint[]
  entities?: DashboardEntity[]
  repo?: string
  baseUrl?: string
  tags?: string[]
  health?: DashboardHealth
  metrics?: DashboardMetric[]
  history?: DashboardHistoryEntry[]
  actions?: DashboardAction[]
  /**
   * ⚠️ 契约 §6 的 `DashboardService` **没有**声明指标探针列表，但界面上的
   * 「跑一次」按钮必须知道 probeId（`POST /api/services/[id]/metrics {probeId}`）。
   * 所以这里按可选读取：服务端给了就渲染按钮，没给就整段不显示 ——
   * 这正是「不猜接口、缺东西就降级」的做法，而不是编一个探针列表出来。
   */
  metricProbes?: DashboardMetricProbe[]
}

type DashboardTotals = { ok?: number; warn?: number; down?: number; unknown?: number; total?: number }

type DashboardPayload = {
  generatedAt?: number
  services?: DashboardService[]
  totals?: DashboardTotals
  config?: { collect?: boolean; sampleIntervalSeconds?: number }
}

type MetricProbeResult = {
  metrics?: Array<{ metric?: string; value?: number; unit?: string }>
  report?: { status?: string; exitCode?: number | null; durationMs?: number; stdout?: string; stderr?: string; truncated?: boolean }
}

/** 自动刷新间隔。与服务端 `sampleIntervalSeconds` 的默认值同量级：更密没意义，
    服务端会直接返回缓存（`fromCache: true`），那只是白打一轮 HTTP。 */
const REFRESH_MS = 30_000

/**
 * 确认词的兜底缺省值，与 `ActionDef.confirmPhrase` 的缺省一致。
 *
 * ⚠️ 服务端已经把每个动作的确认词下发在 `actions[].confirmPhrase` 里，
 * 这里只用于「字段缺失」的防御。**不要**改成硬编码使用 ——
 * 配置里写了自定义确认词的动作会因此稳定 400，而那个报错看起来像权限问题。
 */
const DEFAULT_CONFIRM_PHRASE = 'yes'

const STATUS_LABEL: Record<string, string> = {
  ok: '正常',
  warn: '告警',
  down: '故障',
  unknown: '未知',
  running: '运行中',
}

function statusTone(status: string | undefined): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'warn':
      return 'warn'
    case 'down':
      return 'down'
    case 'running':
      return 'busy'
    default:
      return 'unknown'
  }
}

function statusLabel(status: string | undefined): string {
  if (status === undefined || status === '') return '未知'
  return STATUS_LABEL[status] ?? status
}

// ---------------------------------------------------------------------------
// SSE → 可显示的行
// ---------------------------------------------------------------------------

type RunLine = { kind: 'stdout' | 'stderr' | 'note' | 'metrics' | 'done' | 'error'; text: string }
type StreamState = { status: 'idle' | 'running' | 'done' | 'error'; lines: RunLine[] }

const LINE_CLASS: Record<RunLine['kind'], string> = {
  stdout: 'text-foreground',
  // ⚠️ stderr 一律红色，但**不**当成错误处理：yt-dlp / ffmpeg 的进度条也走 stderr，
  // 把它当错误会让「一切正常」的运行看起来像失败了。颜色只是「这不是 stdout」。
  stderr: 'text-destructive',
  note: 'text-muted-foreground',
  metrics: 'text-sky-600 dark:text-sky-400',
  done: 'font-medium text-foreground',
  error: 'font-medium text-destructive',
}

function reduceStreamLine(event: string, data: unknown): RunLine | null {
  const payload = (data ?? {}) as Record<string, unknown>
  switch (event) {
    case 'start': {
      const runId = payload.runId === undefined || payload.runId === null ? '—' : String(payload.runId)
      return { kind: 'note', text: `▶ 开始 ${String(payload.script ?? '')}（runId=${runId}）` }
    }
    case 'stdout':
      return { kind: 'stdout', text: typeof payload.chunk === 'string' ? payload.chunk : '' }
    case 'stderr':
      return { kind: 'stderr', text: typeof payload.chunk === 'string' ? payload.chunk : '' }
    case 'metrics': {
      const items = Array.isArray(payload.items) ? payload.items : []
      const text = items
        .map((item) => {
          const row = (item ?? {}) as Record<string, unknown>
          const value = typeof row.value === 'number' ? row.value : Number(row.value)
          return `${String(row.metric ?? '?')}=${formatMetric(value, String(row.unit ?? ''))}`
        })
        .join('   ')
      return { kind: 'metrics', text: text === '' ? '（本次没有指标）' : text }
    }
    case 'done': {
      const exitCode = payload.exitCode === null || payload.exitCode === undefined ? '—' : String(payload.exitCode)
      const duration = typeof payload.durationMs === 'number' ? humanDuration(payload.durationMs) : '—'
      // ⚠️ 截断必须显眼：输出被截断时日志**不是全部**，不说明就会有人把
      // 「日志里没看到报错」当作「运行没问题」。
      const truncated = payload.truncated === true ? ' · ⚠️ 输出已截断，日志不是全部' : ''
      const signal = typeof payload.signal === 'string' && payload.signal !== '' ? ` · signal=${payload.signal}` : ''
      return { kind: 'done', text: `■ 结束：${statusLabel(String(payload.status ?? ''))} · 退出码 ${exitCode} · 耗时 ${duration}${signal}${truncated}` }
    }
    case 'error': {
      const code = payload.code === undefined ? '' : `（${String(payload.code)}）`
      return { kind: 'error', text: `✖ ${String(payload.error ?? '运行失败，服务端没有给出说明。')}${code}` }
    }
    default:
      return { kind: 'note', text: `（未知事件 ${event}）` }
  }
}

/**
 * 流式输出面板。
 *
 * `onAbort` 一定要有：一个跑飞的动作（比如误触了一个耗时的重建）如果不能取消，
 * 用户唯一的出路是刷新页面，而刷新会连带丢掉别的卡片上正在跑的输出。
 */
function StreamLog({
  state,
  label,
  onAbort,
}: {
  state: StreamState
  label: string
  onAbort?: () => void
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    // ⚠️ 用 scrollTop 而不是 scrollIntoView：后者会把**整页**一起滚下去，
    // 表现是「日志每来一行页面就跳一下」。
    box.scrollTop = box.scrollHeight
  }, [state.lines])

  if (state.status === 'idle') return null

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {state.status === 'running' && <Spinner className="size-3" />}
        <span>{label}</span>
        {state.status === 'running' && onAbort && (
          <button type="button" className="underline hover:text-foreground" onClick={onAbort}>
            中止
          </button>
        )}
      </div>
      <div ref={boxRef} className="raven-log max-h-56 overflow-y-auto rounded-md border bg-muted/30 px-2 py-1.5">
        {state.lines.length === 0 && <p className="raven-mono text-muted-foreground">等待输出…</p>}
        {state.lines.map((line, index) => (
          <p key={index} className={cn('raven-mono', LINE_CLASS[line.kind])}>
            {line.text}
          </p>
        ))}
        {state.status === 'running' && <span className="raven-mono animate-pulse text-muted-foreground">▍</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 延迟历史（纯 CSS 柱状）
// ---------------------------------------------------------------------------

/**
 * ⚠️ **不引图表库**：40 个 div 的需求换成 recharts 是 ~100KB 依赖加一次布局抖动，
 * 而这里要看的只是「最近有没有变慢/变红」。
 * 柱高按**本服务自己**的最大值归一：跨服务比高度没有意义（本机 tcp 探针 2ms
 * 与外部 API 800ms 会被互相压平）。
 */
function HistoryBars({ history, now }: { history: DashboardHistoryEntry[]; now: number }) {
  // 契约里 history 是最新在前（数据库 `ORDER BY checkedAt DESC`），
  // 而柱状图要从左到右表示时间流逝，所以反转。
  const points = useMemo(() => [...history].reverse(), [history])
  const max = useMemo(() => {
    let value = 0
    for (const point of points) {
      if (typeof point.latencyMs === 'number' && Number.isFinite(point.latencyMs)) value = Math.max(value, point.latencyMs)
    }
    return value === 0 ? 1 : value
  }, [points])

  if (points.length === 0) {
    return <p className="text-[11px] text-muted-foreground">还没有健康样本（第一次采样之后才会出现）。</p>
  }

  const colors: Record<string, string> = {
    ok: 'bg-status-ok',
    warn: 'bg-status-warn',
    down: 'bg-status-down',
    unknown: 'bg-status-unknown',
  }

  return (
    <div className="flex items-end gap-0.5" role="img" aria-label={`最近 ${points.length} 次采样，最新在右`}>
      {points.map((point, index) => {
        const latency = typeof point.latencyMs === 'number' && Number.isFinite(point.latencyMs) ? point.latencyMs : 0
        // 最低 8%：延迟为 0 或 null 时也要有一条可见的线，否则空柱子会被
        // 误读成「这里没有数据」。
        const height = Math.max(8, Math.round((latency / max) * 100))
        return (
          <div
            key={`${point.checkedAt ?? index}-${index}`}
            title={`${formatDateTime(point.checkedAt)} · ${statusLabel(point.status)} · ${formatLatency(point.latencyMs)}${
              point.message ? `\n${point.message}` : ''
            }`}
            className={cn('w-1.5 shrink-0 rounded-sm', colors[point.status ?? ''] ?? 'bg-status-unknown')}
            style={{ height: `${height}%`, minHeight: 3 }}
          />
        )
      })}
      <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">最早 {relativeTime(points[0]?.checkedAt, now)}</span>
    </div>
  )
}

function ProbeTable({ probes }: { probes: DashboardProbe[] }) {
  if (probes.length === 0) return <p className="text-[11px] text-muted-foreground">这个服务没有配置探针。</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1 pr-2 font-medium">#</th>
            <th className="py-1 pr-2 font-medium">类型</th>
            <th className="py-1 pr-2 font-medium">状态</th>
            <th className="py-1 pr-2 font-medium">耗时</th>
            <th className="py-1 pr-2 font-medium">版本</th>
            <th className="py-1 font-medium">说明</th>
          </tr>
        </thead>
        <tbody>
          {probes.map((probe, index) => (
            <tr key={`${probe.index ?? index}-${index}`} className="border-t align-top">
              <td className="py-1 pr-2 text-muted-foreground">{probe.index ?? index + 1}</td>
              <td className="py-1 pr-2 font-mono">{probe.type ?? '—'}</td>
              <td className="py-1 pr-2">
                <StatusPill tone={statusTone(probe.status)}>{statusLabel(probe.status)}</StatusPill>
              </td>
              <td className="py-1 pr-2 font-mono">{formatLatency(probe.latencyMs)}</td>
              <td className="py-1 pr-2 font-mono">{probe.version || '—'}</td>
              <td className="max-w-[420px] break-words py-1">{probe.message || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 服务卡片
// ---------------------------------------------------------------------------

function ServiceCard({
  service,
  now,
  busy,
  onCollect,
  onMetricProbe,
  onProbeStart,
  onProbeEnd,
}: {
  service: DashboardService
  now: number
  busy: boolean
  onCollect: () => void
  onMetricProbe: (probeId: string) => void
  /** 指标探针开始/结束。父级靠它暂停自动刷新 —— 探针会真的跑一个脚本，
      跑的时候刷新会把卡片重渲染成服务端的旧快照，用户看不到这次的结果。 */
  onProbeStart?: () => void
  onProbeEnd?: () => void
}) {
  const toast = useToast()
  const [expanded, setExpanded] = useState(false)
  /** 正在等确认的**那一个**动作 id。只存 boolean 的话，展开区里多个动作按钮
      会全都打开同一个确认框，确认时无从知道该跑哪个 —— 那等于跑错脚本。 */
  const [confirmTarget, setConfirmTarget] = useState<DashboardAction | null>(null)
  const [pendingAction, setPendingAction] = useState<{ id: string; controller: AbortController } | null>(null)
  const [stream, setStream] = useState<StreamState>({ status: 'idle', lines: [] })
  const [metricStream, setMetricStream] = useState<Record<string, StreamState>>({})

  const id = service.id ?? ''
  const health = service.health
  const probes = Array.isArray(health?.probes) ? health.probes : []
  const history = Array.isArray(service.history) ? service.history : []
  const metrics = Array.isArray(service.metrics) ? service.metrics : []
  const actions = Array.isArray(service.actions) ? service.actions : []
  const entities = Array.isArray(service.entities) ? service.entities : []
  const endpoints = Array.isArray(service.endpoints) ? service.endpoints : []
  const metricProbes = Array.isArray(service.metricProbes) ? service.metricProbes : []

  // 卸载时中止还在跑的流。
  //
  // ⚠️ 用 ref 存 controller，而不是把 `pendingAction` 放进依赖数组：
  // 那样每次「开始运行 / 运行结束」都会触发一次清理，而清理里的 abort 会把
  // 刚启动的这次运行自己掐掉。依赖数组写成空，意图就是「只在卸载时执行」。
  const actionControllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    return () => actionControllerRef.current?.abort()
  }, [])

  const pushLine = useCallback((line: RunLine | null) => {
    if (line === null) return
    setStream((state) => ({ ...state, lines: [...state.lines, line] }))
  }, [])

  const runAction = useCallback(
    (actionId: string, confirm: string) => {
      if (id === '' || actionId === '') return
      const controller = new AbortController()
      actionControllerRef.current = controller
      setPendingAction({ id: actionId, controller })
      setStream({ status: 'running', lines: [{ kind: 'note', text: `▶ 动作 ${actionId}` }] })
      void (async () => {
        try {
          await apiStream(`/api/services/${encodeURIComponent(id)}/actions`, {
            // ⚠️ `confirm` 必须一起发：服务端对非只读动作要求它等于
            // 该动作的 confirmPhrase，只发 actionId 会稳定拿到 400
            // `confirm_required` —— 而那看起来像权限问题，不像漏了字段。
            body: { actionId, confirm },
            signal: controller.signal,
            label: `动作 ${actionId}`,
            onEvent: (event, data) => pushLine(reduceStreamLine(event, data)),
            onTransportError: (error) => {
              // 传输层失败也要进面板：这个面板是用户此刻看的地方。
              pushLine({ kind: 'error', text: error.message })
            },
          })
        } finally {
          setStream((state) => ({ ...state, status: state.lines.some((line) => line.kind === 'error') ? 'error' : 'done' }))
          setPendingAction(null)
        }
      })()
    },
    [id, pushLine]
  )

  const runMetric = useCallback(
    (probeId: string) => {
      if (id === '' || probeId === '') return
      setMetricStream((current) => ({ ...current, [probeId]: { status: 'running', lines: [] } }))
      onProbeStart?.()
      void (async () => {
        try {
          // ⚠️ 这个接口返回 **JSON**（不是 SSE），所以不要用 apiStream。
          const body = await apiPost<MetricProbeResult>(`/api/services/${encodeURIComponent(id)}/metrics`, { probeId })
          const report = body.report
          const lines: RunLine[] = []
          for (const item of body.metrics ?? []) {
            lines.push({
              kind: 'metrics',
              text: `${String(item.metric ?? '?')}=${formatMetric(
                typeof item.value === 'number' ? item.value : Number(item.value),
                String(item.unit ?? '')
              )}`,
            })
          }
          if (lines.length === 0) lines.push({ kind: 'note', text: '这次没有采到指标。' })
          if (report?.stdout) lines.push({ kind: 'stdout', text: report.stdout })
          if (report?.stderr) lines.push({ kind: 'stderr', text: report.stderr })
          lines.push({
            kind: 'done',
            text: `■ ${statusLabel(report?.status)} · 退出码 ${report?.exitCode ?? '—'} · 耗时 ${
              typeof report?.durationMs === 'number' ? humanDuration(report.durationMs) : '—'
            }${report?.truncated ? ' · ⚠️ 输出已截断' : ''}`,
          })
          setMetricStream((current) => ({ ...current, [probeId]: { status: 'done', lines } }))
        } catch (error) {
          const message = error instanceof Error ? error.message : '指标探针运行失败。'
          setMetricStream((current) => ({
            ...current,
            [probeId]: { status: 'error', lines: [{ kind: 'error', text: `✖ ${message}` }] },
          }))
          toast.error(message)
        } finally {
          // ⚠️ 结束标记放在 finally 里：探针抛错时如果不解除，自动刷新会被
          // 永久暂停 —— 表现是「跑了一次失败的探针之后面板再也不更新了」。
          onProbeEnd?.()
        }
      })()
    },
    [id, toast, onProbeStart, onProbeEnd]
  )

  return (
    <section className="rounded-lg border bg-card p-3" aria-label={`服务 ${service.title ?? id}`}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{service.title ?? id}</h2>
            <StatusPill tone={statusTone(health?.status)} title={health?.message}>
              {statusLabel(health?.status)}
            </StatusPill>
            {health?.fromCache && <span className="text-[10px] text-muted-foreground">（缓存样本）</span>}
            {service.enabled === false && <span className="text-[10px] text-muted-foreground">已停用</span>}
            {service.kind && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{service.kind}</span>}
            {(service.tags ?? []).map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {/* 探测计数的措辞很重要：(2/3) 比「warn」更能说明问题在哪 */}
            <span>
              {health?.okCount ?? 0}/{health?.totalCount ?? probes.length} 项探测通过 · 延迟 {formatLatency(health?.latencyMs)} ·
              检查于 {relativeTime(health?.checkedAt, now)}
            </span>
            {health?.version ? <span className="ml-2 font-mono">v{health.version}</span> : null}
          </p>
          {health?.message && <p className="mt-1 break-words text-[11px] text-destructive">{health.message}</p>}
          {service.summary && <p className="mt-1 break-words text-[11px]">{service.summary}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="rounded-md border px-2 py-1 text-[11px] hover:bg-accent"
          >
            {expanded ? '收起明细' : `明细（${probes.length} 项探测）`}
          </button>
          <button
            type="button"
            onClick={onCollect}
            disabled={busy}
            title="强制采一轮（force=1，绕过服务端采样缓存）"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
          >
            {busy && <Spinner className="size-3" />}
            立即采集
          </button>
        </div>
      </header>

      {/* 延迟历史 + 指标 */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">延迟历史</p>
          <div className="h-12">
            <HistoryBars history={history} now={now} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">最新指标</p>
          {metrics.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">还没有指标样本（需要配置指标探针并跑一次）。</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {metrics.map((item, index) => (
                <span
                  key={`${item.metric ?? index}`}
                  title={`采样于 ${formatDateTime(item.at)}`}
                  className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                >
                  <span className="text-muted-foreground">{item.metric ?? '?'}</span>
                  <span className="font-mono">{formatMetric(typeof item.value === 'number' ? item.value : Number(item.value), String(item.unit ?? ''))}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 展开区：探针明细 + 端点 + 实体 + 指标探针 + 动作 */}
      {expanded && (
        <div className="mt-3 space-y-3 border-t pt-3">
          <ProbeTable probes={probes} />

          {endpoints.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">端点</p>
              <ul className="flex flex-wrap gap-2">
                {endpoints.map((endpoint, index) =>
                  endpoint.url ? (
                    <li key={`${endpoint.url}-${index}`}>
                      {/* target=_blank 必须带 rel="noreferrer"：新窗口能通过
                          window.opener 改本页地址，那对面板是实打实的钓鱼面。 */}
                      <a
                        href={endpoint.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[11px] text-sky-700 underline hover:no-underline dark:text-sky-400"
                      >
                        {endpoint.label ?? endpoint.url}
                      </a>
                    </li>
                  ) : null
                )}
              </ul>
            </div>
          )}

          {entities.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">实体</p>
              <ul className="space-y-1">
                {entities.map((entity, index) => (
                  <li key={`${entity.id ?? index}-${index}`} className="text-[11px]">
                    <span className="font-mono">{entity.id ?? '—'}</span>
                    {entity.title && <span className="ml-2">{entity.title}</span>}
                    <span className="ml-2 text-muted-foreground">
                      {[
                        entity.port === undefined ? '' : `端口 ${entity.port}`,
                        entity.commit ? `commit ${entity.commit}` : '',
                        entity.source ? `来源 ${entity.source}` : '',
                        entity.endpoint ? `地址 ${entity.endpoint}` : '',
                        entity.dataDir ? `数据 ${entity.dataDir}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {(entity.capabilities ?? []).length > 0 && (
                      <span className="ml-2 text-muted-foreground">能力：{(entity.capabilities ?? []).join('、')}</span>
                    )}
                    {entity.notes && <span className="ml-2 text-muted-foreground">{entity.notes}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {service.repo && (
            <p className="text-[11px] text-muted-foreground">
              仓库：
              <a href={service.repo} target="_blank" rel="noreferrer noopener" className="ml-1 underline">
                {service.repo}
              </a>
            </p>
          )}

          <div>
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">指标探针</p>
            {metricProbes.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                服务端没有下发指标探针列表，无法定位 probeId（契约里 DashboardService 不含该字段）。
              </p>
            ) : (
              <ul className="space-y-2">
                {metricProbes.map((probe) => {
                  const probeId = probe.id ?? ''
                  const state = metricStream[probeId]
                  return (
                    <li key={probeId || probe.title}>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onMetricProbe(probeId)}
                          disabled={probeId === '' || state?.status === 'running'}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                          title={probe.script === undefined ? '跑一次这个指标探针' : `脚本：${probe.script}`}
                        >
                          {state?.status === 'running' && <Spinner className="size-3" />}
                          跑一次
                        </button>
                        <span className="text-[11px]">{probe.title ?? probeId}</span>
                        {probe.script && <span className="font-mono text-[10px] text-muted-foreground">{probe.script}</span>}
                      </div>
                      {state && <StreamLog state={state} label={`指标输出 · ${probe.title ?? probeId}`} />}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">动作</p>
            {actions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">这个服务没有配置动作。</p>
            ) : (
              <ul className="space-y-3">
                {actions.map((action) => {
                  const actionId = action.id ?? ''
                  const running = pendingAction?.id === actionId
                  return (
                    <li key={actionId || action.title}>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (actionId === '') return
                            // 只有「显式 readonly 且没被标成需要确认」的动作才直接跑。
                            // 其余一律先弹确认框 —— 契约里 `readonly` 缺省是
                            // 「要确认」，把缺省当宽松解释会让人一不小心就重建了服务。
                            if (action.readonly === true && action.needsConfirm !== true) runAction(actionId, '')
                            else setConfirmTarget(action)
                          }}
                          disabled={actionId === '' || running}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50',
                            action.readonly !== true && 'border-amber-500/60'
                          )}
                          title={action.description ?? action.title ?? actionId}
                        >
                          {running && <Spinner className="size-3" />}
                          {running ? '运行中…' : (action.title ?? actionId)}
                        </button>
                        {action.readonly !== true && <span className="text-[10px] text-muted-foreground">需要确认</span>}
                      </div>
                      {action.description && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{action.description}</p>}
                    </li>
                  )
                })}
              </ul>
            )}
            {stream.status !== 'idle' && (
              <StreamLog
                state={stream}
                label={`动作输出${pendingAction ? ` · ${pendingAction.id}` : ''}`}
                onAbort={() => pendingAction?.controller.abort()}
              />
            )}
          </div>
        </div>
      )}

      {/*
        ⚠️ 这张确认框用 `confirmTarget` 里的动作对象，而不是「第一个需要确认的动作」：
        展开区里每个动作按钮都会把它自己塞进来，确认时才不会跑错脚本。
      */}
      <ConfirmDialog
        open={confirmTarget !== null}
        title={`确认运行动作：${confirmTarget?.title ?? confirmTarget?.id ?? ''}`}
        message="这个动作会改动服务状态，且通常不可撤销。"
        detail={
          <>
            <p>服务：{service.title ?? id}</p>
            <p>动作：{confirmTarget?.id ?? ''}</p>
            {confirmTarget?.description && <p className="mt-1">{confirmTarget.description}</p>}
            <p className="mt-1 text-muted-foreground">
              确认词：<span className="raven-mono text-foreground">{confirmTarget?.confirmPhrase ?? DEFAULT_CONFIRM_PHRASE}</span>
              —— 由服务端按动作定义下发，界面不作猜测。
            </p>
          </>
        }
        confirmLabel="运行"
        requirePhrase={confirmTarget?.confirmPhrase ?? DEFAULT_CONFIRM_PHRASE}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          const target = confirmTarget
          setConfirmTarget(null)
          if (target?.id) runAction(target.id, target.confirmPhrase ?? DEFAULT_CONFIRM_PHRASE)
        }}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

function TotalsBar({ totals, config, generatedAt, now }: {
  totals: DashboardTotals
  config: DashboardPayload['config']
  generatedAt: number | undefined
  now: number
}) {
  const items: Array<{ key: string; label: string; value: number | undefined; tone: StatusTone }> = [
    { key: 'ok', label: '正常', value: totals.ok, tone: 'ok' },
    { key: 'warn', label: '告警', value: totals.warn, tone: 'warn' },
    { key: 'down', label: '故障', value: totals.down, tone: 'down' },
    { key: 'unknown', label: '未知', value: totals.unknown, tone: 'unknown' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      {items.map((item) => (
        // 计数为 0 的仍然显示：**「0 个故障」本身是重要信息**，
        // 隐藏它会让「故障那一格消失了」和「没查出来」分不清。
        <span key={item.key} className="inline-flex items-center gap-1">
          <StatusPill tone={item.tone}>{item.label}</StatusPill>
          <span className="font-mono">{item.value ?? 0}</span>
        </span>
      ))}
      <span>共 {totals.total ?? '—'} 个服务</span>
      {config?.collect === false && <span className="text-amber-600 dark:text-amber-400">采集已关闭（只显示历史数据）</span>}
      {typeof config?.sampleIntervalSeconds === 'number' && <span>采样间隔 {config.sampleIntervalSeconds}s</span>}
      <span>数据生成于 {relativeTime(generatedAt, now)}</span>
    </div>
  )
}

export function Dashboard({ publicConfig }: { publicConfig: PublicConfig }) {
  const toast = useToast()
  const [payload, setPayload] = useState<DashboardPayload | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  /**
   * 有没有写操作在飞（采集 / 指标探针 / 动作）。有的话自动刷新要停：
   * 一次自动刷新会把整页的 `payload` 换掉，而动作的输出面板虽然不在 payload 里，
   * 但服务卡片会重新挂载（key 没变，但 props 变了）—— 更实际的原因是
   * **服务端采样与动作本身就是同一条脚本执行队列**，自动刷新会让刚点下按钮的
   * 那张卡片在「采集中」和「采集完」之间反复重渲染，用户看不到自己那一次的结果。
   */
  const [busyCount, setBusyCount] = useState(0)
  const [manualBusy, setManualBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [lastRefreshedAt, setLastRefreshedAt] = useState(0)
  /**
   * 「强制刷新」开关。开了之后**只有手动刷新**会带 `?force=1`，
   * 定时轮询永远不带 —— 详见下面 load() 里的说明。
   */
  const [forceNext, setForceNext] = useState(false)
  const [hidden, setHidden] = useState(false)

  const inFlight = useRef(0)
  const busy = manualBusy || busyCount > 0

  /**
   * 读一次 Dashboard。
   *
   * ⚠️ 关于 `force` 的策略（这一条直接影响别的服务，值得写清楚）：
   * 契约 §6 明确说「Dashboard 的轮询不能每次都打上游 —— 上游是别的服务，
   * 不是 raven 的免费资源」，采样缓存就是这个约束的实现。所以：
   * - 定时轮询：**永远**不带 force，让服务端按 sampleIntervalSeconds 返回缓存；
   * - 手动「刷新」/「立即采集」/「全部采集」：才允许带 force。
   * 把 force 接到 30 秒的轮询上，等于让 raven 每 30 秒对所有上游做一次真实探测，
   * 那不是这个界面该做的决定。
   *
   * ⚠️ 返回 `true` 表示**真的发起了**请求。跳过时返回 `false` —— 调用方
   * （手动采集的 busy 标记）靠这个区分「已经采完了」和「这次被跳过了」，
   * 否则被跳过的那次会立刻把按钮恢复成可点，看起来像采集瞬间完成。
   */
  const load = useCallback(
    async (options: { force?: boolean } = {}): Promise<boolean> => {
      // 页面被切到后台时**不刷新**：一是没人看，二是浏览器会把后台标签页的
      // 定时器节流到几分钟一次，一个「30 秒轮询」在后台账面上其实是不定时
      // 触发，数据反而更容易出现诡异的时间跳变。可见性恢复时会有一次补刷。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
      if (inFlight.current > 0) return false

      inFlight.current += 1
      setRefreshing(true)
      try {
        const body = await apiGet<DashboardPayload>('/api/services', options.force === true ? { force: 1 } : {})
        setPayload(body)
        setError('')
        setLastRefreshedAt(Date.now())
        return true
      } catch (cause) {
        // ⚠️ 刷新失败**不清空已有数据**：仪表盘上「上一次的读数 + 一条错误」
        // 比一片空白有用得多。
        setError(cause instanceof Error ? cause.message : '加载服务列表失败。')
        return false
      } finally {
        inFlight.current -= 1
        setRefreshing(false)
      }
    },
    []
  )

  // 首次加载。空依赖数组是刻意的：load 是 useCallback([])，
  // 加进去没有任何变化，反而让人以为它会随参数变化。
  useEffect(() => {
    void (async () => {
      await load()
      setLoading(false)
    })()
  }, [load])

  /**
   * 30 秒自动刷新。
   *
   * ⚠️ 两个「暂停」条件，都是必须的：
   * 1. **页面隐藏**（document.visibilityState === 'hidden'）：后台标签页不该
   *    继续打服务端。浏览器本来就会把定时器节流，结果是「你以为在每 30 秒刷新，
   *    实际是不定时」，数据反而不可预期。
   * 2. **有写操作在飞**：动作/指标探针正在跑的时候刷新，会把卡片重渲染成
   *    服务端的最新快照 —— 用户看不到他刚按下那次操作的中间态，也会让
   *    「这个输出面板是这次的还是上次的」变得无法判断。
   */
  useEffect(() => {
    if (hidden || busy) return
    const timer = window.setInterval(() => {
      void load()
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [hidden, busy, load])

  // 可见性跟踪 + 切回前台立刻补一次刷新（否则最长要等 30 秒才看到变化）。
  useEffect(() => {
    const onVisibility = () => {
      const isHidden = document.visibilityState === 'hidden'
      setHidden(isHidden)
      if (!isHidden) void load()
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load])

  // 相对时间的驱动源。1 秒一跳就够，而且只在**可见**时走 —— 后台标签页
  // 每秒 setState 是纯浪费（也是 React DevTools 里最常见的噪声来源）。
  useEffect(() => {
    if (hidden) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hidden])

  /** 手动刷新。`forceNext` 打开时带 force=1，见 load() 顶部的说明。 */
  const refresh = useCallback(async () => {
    if (manualBusy || busyCount > 0) return
    setManualBusy(true)
    try {
      await load({ force: forceNext })
      setForceNext(false)
    } finally {
      setManualBusy(false)
    }
  }, [load, forceNext, manualBusy, busyCount])

  // 「全部采集」与「立即采集」都打 `POST /api/services/collect`（契约里没有
  // 单服务的采集端点），区别只在范围：这里先标记所有服务为忙，采完统一刷新。
  const collectAll = useCallback(async () => {
    if (manualBusy) return
    setManualBusy(true)
    try {
      const body = await apiPost<{ collected?: string[]; cached?: string[] }>('/api/services/collect')
      const collected = Array.isArray(body.collected) ? body.collected : []
      const cached = Array.isArray(body.cached) ? body.cached : []
      toast.ok(`采集完成：真实采样 ${collected.length} 个，命中缓存 ${cached.length} 个。`)
      // ⚠️ 这里的刷新**不能**带 force：刚刚才采过，再强采一遍等于把每个上游
      // 立刻再打一次，而缓存刚被这些采样填满，不带 force 会直接读缓存。
      await load()
      setError('')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '采集失败。'
      // 服务端的说明同时进 toast 和页面错误条：toast 会消失，错误条不会。
      toast.error(message)
      setError(message)
    } finally {
      setManualBusy(false)
    }
  }, [load, manualBusy, toast])

  const services = useMemo(() => {
    const list = Array.isArray(payload?.services) ? payload.services : []
    // 排序：先按「坏的程度」，再按标题。这是运维扫一眼时的实际顺序 ——
    // down 在最上面，正常的沉到底下。相等时按标题保证顺序稳定（不会每次
    // 刷新都换位置，那会让「刚才那个红色的卡片去哪了」变成一个真问题）。
    const rank: Record<string, number> = { down: 0, warn: 1, unknown: 2, ok: 3 }
    return [...list].sort((left, right) => {
      const leftRank = rank[left.health?.status ?? 'unknown'] ?? 2
      const rightRank = rank[right.health?.status ?? 'unknown'] ?? 2
      if (leftRank !== rightRank) return leftRank - rightRank
      return (left.title ?? left.id ?? '').localeCompare(right.title ?? right.id ?? '', 'zh-CN')
    })
  }, [payload])

  const totals = payload?.totals ?? {}

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">服务总览</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            每 30 秒自动刷新；页面切到后台、或有动作正在运行时自动暂停（后台刷新既没人看，也会把正在跑的输出现场重渲染掉）。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 手动刷新默认不带 force：那是「看看现在什么样」，不是「去骚扰上游」。 */}
          <Button variant="outline" onClick={() => void refresh()} loading={manualBusy} title="刷新（可选强制绕过采样缓存）">
            刷新
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground" title="勾上之后，手动刷新会带 force=1 绕过服务端采样缓存；定时轮询永远不带">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={forceNext}
              onChange={(event) => setForceNext(event.target.checked)}
            />
            强制刷新
          </label>
          <Button variant="primary" onClick={() => void collectAll()} loading={manualBusy} title="对所有服务强制采一轮">
            全部采集
          </Button>
        </div>
      </div>

      {error && <ErrorBar message={error} detail={`上次成功刷新：${lastRefreshedAt === 0 ? '从未' : formatDateTime(lastRefreshedAt)}`} onRetry={() => void refresh()} busy={refreshing} onDismiss={() => setError('')} />}

      <TotalsBar totals={totals} config={payload?.config} generatedAt={payload?.generatedAt} now={now} />

      {loading && payload === null ? (
        <p className="py-8 text-center text-xs text-muted-foreground">载入中…</p>
      ) : services.length === 0 ? (
        // 明确区分「配置里一个服务都没有」和「加载失败」。前者要点用户去写配置。
        <div className="rounded-lg border bg-card p-6 text-center text-xs text-muted-foreground">
          注册表里没有服务。在配置的 <code className="rounded bg-muted px-1">services.defs</code> 里加一条，或往注册表文件写一条。
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {services.map((service) => (
            <ServiceCard
              key={service.id ?? service.title ?? Math.random().toString(36)}
              service={service}
              now={now}
              busy={manualBusy || busyCount > 0}
              onCollect={() => {
                // 契约里没有「只采一个服务」的端点：`POST /api/services/collect`
                // 是全局的。所以按钮打到同一个端点上，只是文案区分。
                // 这里明确按「全部采集」的语义执行，而不是假装只采了一个。
                setBusyCount((count) => count + 1)
                void (async () => {
                  try {
                    await collectAll()
                  } finally {
                    setBusyCount((count) => Math.max(0, count - 1))
                  }
                })()
              }}
              onMetricProbe={(probeId) => {
                // 探针跑完刷新一次，让新指标出现在「最新指标」里。
                // ⚠️ 这里**不能** await 探针本身：真正执行它的是 ServiceCard 内部的
                // runMetric，父级看不到那个 promise。所以用 onProbeStart /
                // onProbeEnd 一对回调驱动忙标记，刷新只在结束时发生。
                void probeId
              }}
              onProbeStart={() => setBusyCount((count) => count + 1)}
              onProbeEnd={() => {
                setBusyCount((count) => Math.max(0, count - 1))
                // 延后一拍再刷新：让 `busy` 先落到 false，否则 load() 会被自己
                // 的「有写操作在飞就跳过」判定拦下来（那个判定是给轮询用的，
                // 手动刷新才该被它拦住）。
                window.setTimeout(() => void load(), 0)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
