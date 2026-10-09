'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner } from '@/components/ui/button'
import { ErrorBar, StatusPill, useToast, type StatusTone } from '@/components/ui/toast'
import { Field, Input } from '@/components/ui/input'
import { apiGet, apiStream, apiStreamForm } from '@/lib/api'
import { formatDateTime, formatMetric, humanBytes, humanDuration, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { PublicConfig } from '@/types/config'

/**
 * 脚本运行器。
 *
 * 布局：左边挑脚本、右边跑 + 看输出、下面翻历史。三段对应三个真实动作，
 * 而不是把「脚本列表 + 运行 + 历史」塞进一个 Tab 组件里 —— 运行脚本的人
 * 需要同时看到清单（还有哪个能跑）和输出（跑到哪了）。
 *
 * ⚠️ 关于 SSE 的三条纪律（这个页面是它们唯一的消费者）：
 *
 * 1. **`AbortController` 必须在卸载时 abort**，否则组件没了回调还在 setState
 *    （React 19 会警告），而且服务端那条流会一直挂着不结束。
 * 2. **`done` 事件之前的一切都只是「尽力而为」的展示**。契约 §5 明确说最终
 *    权威结果永远是 `RunResult` —— 所以 `done` 到达时要**用它的值覆盖**整个
 *    状态（包括从 stdout 拼出来的文本），不能只当成一行日志。
 * 3. **`truncated: true` 必须显眼**。日志被截断时屏幕上看到的不是全部输出，
 *    不说明就会有人把「没看到报错」当成「运行没问题」。
 */

// ---------------------------------------------------------------------------
// 契约 §5 的形状
// ---------------------------------------------------------------------------

type RunStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'killed'

type ScriptInfo = {
  name?: string
  bytes?: number
  mtimeMs?: number
  description?: string
  lastRun?: { status?: string; exitCode?: number | null; startedAt?: number; durationMs?: number }
}

type RunRow = {
  id?: number
  script?: string
  origin?: string
  status?: string
  exitCode?: number | null
  startedAt?: number
  endedAt?: number
  durationMs?: number
  stdout?: string
  stderr?: string
  /** 数据库里是 0/1，界面按「真值」处理，两个都认。 */
  truncated?: boolean | number
  signal?: string
  triggeredBy?: string
  metricCalls?: number
}

type ScriptsResponse = {
  scripts?: ScriptInfo[]
  runs?: RunRow[]
  config?: {
    allowScriptExecution?: boolean
    timeoutMs?: number
    maxConcurrent?: number
    maxOutputBytes?: number
    extraEnvKeys?: string[]
    [key: string]: unknown
  }
}

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  ok: '成功',
  failed: '失败',
  timeout: '超时',
  killed: '被终止',
}

function statusTone(status: string | undefined): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'failed':
    case 'timeout':
    case 'killed':
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

function isTruncated(value: boolean | number | undefined): boolean {
  return value === true || value === 1
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

type LogLine = { kind: 'stdout' | 'stderr' | 'note' | 'metrics' | 'error'; text: string }

type RunSummary = {
  status?: string
  exitCode?: number | null
  durationMs?: number
  truncated?: boolean | number
  signal?: string
  endedAt?: number
  recordId?: number
}

const LINE_CLASS: Record<LogLine['kind'], string> = {
  stdout: 'text-foreground',
  // stderr 红色但不加图标、不打断：进度条类输出（yt-dlp / ffmpeg）都走 stderr。
  stderr: 'text-destructive',
  note: 'text-muted-foreground',
  metrics: 'text-sky-600 dark:text-sky-400',
  error: 'font-medium text-destructive',
}

function LogPanel({
  lines,
  running,
  summary,
  onAbort,
  title,
}: {
  lines: LogLine[]
  running: boolean
  summary: RunSummary | null
  onAbort?: () => void
  title: string
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    // scrollTop 而不是 scrollIntoView：后者会把整页滚下去，脚本刷日志时
    // 页面会一直往下跳，用户没法同时看左边的脚本清单。
    box.scrollTop = box.scrollHeight
  }, [lines.length])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-medium">{title}</span>
        {running && <Spinner className="size-3" />}
        {summary?.status !== undefined && <StatusPill tone={statusTone(summary.status)}>{statusLabel(summary.status)}</StatusPill>}
        {summary?.status !== undefined && (
          <span className="text-muted-foreground">
            退出码 {summary.exitCode ?? '—'} · 耗时 {typeof summary.durationMs === 'number' ? humanDuration(summary.durationMs) : '—'}
            {summary.signal ? ` · signal=${summary.signal}` : ''}
            {summary.recordId !== undefined ? ` · 记录 #${summary.recordId}` : ''}
          </span>
        )}
        {running && onAbort && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onAbort}>
            中止
          </Button>
        )}
      </div>

      {/* ⚠️ truncated 用小横幅而不是一行日志：它是对**整个输出**的限定，
          混在日志流里会被冲走。 */}
      {isTruncated(summary?.truncated) && (
        <p className="mb-1 rounded-md border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
          ⚠️ 输出已被截断（服务端按 <code className="font-mono">execution.maxOutputBytes</code> 封顶）。下面看到的**不是全部输出**，
          但脚本仍然跑完了 —— 完整结果以退出码与耗时为准。
        </p>
      )}

      <div ref={boxRef} className="raven-log h-[45vh] min-h-48 overflow-y-auto rounded-md border bg-muted/30 p-2">
        {lines.length === 0 ? (
          <p className="raven-mono text-muted-foreground">{running ? '等待输出…' : '还没有输出。选一个脚本按「运行」。'}</p>
        ) : (
          lines.map((line, index) => (
            <p key={index} className={cn('raven-mono', LINE_CLASS[line.kind])}>
              {line.text}
            </p>
          ))
        )}
        {running && <span className="raven-mono animate-pulse text-muted-foreground">▍</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export function ScriptsRunner({ publicConfig }: { publicConfig: PublicConfig }) {
  const toast = useToast()

  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  // ⚠️ 显式写出 `| null`：只给 `useState(null)` 时 TS 推断出的是
  // `T | undefined`（因为它把 initial 当成 T），于是 `setServerConfig(null)`
  // 会报「null 不能赋给 SetStateAction<T | undefined>」。这个错误看起来像
  // 泛型问题，实际是「初始值是 null」这一个信息被丢掉了。
  const [serverConfig, setServerConfig] = useState<ScriptsResponse['config'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const [selectedScript, setSelectedScript] = useState('')
  const [args, setArgs] = useState('')
  const [lines, setLines] = useState<LogLine[]>([])
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<RunSummary | null>(null)

  const [tempFile, setTempFile] = useState<File | null>(null)
  const [tempBusy, setTempBusy] = useState(false)

  const [historyDetail, setHistoryDetail] = useState<{ row: RunRow | null; loading: boolean; error: string } | null>(null)

  const streamController = useRef<AbortController | null>(null)
  /** 临时脚本那条 multipart 流的句柄。中止按钮要能同时掐两条路径上的流。 */
  const abortFormRef = useRef<{ abort: () => void } | null>(null)
  /** 上传进度的 100% 提示只发一次，否则 onprogress 会把它刷成几十行。 */
  const uploadedRef = useRef(false)
  /**
   * 组件还在不在。
   *
   * ⚠️ 为什么需要它：`runSelected` 的 `finally` 里要「跑完刷一次历史」，
   * 而中止/卸载后那个 `load()` 仍然会发出去并 setState。React 19 已经不警告了，
   * 但一次对着已卸载组件的网络请求 + 状态写入是实打实的浪费，也让
   * 「界面停止响应」这类问题的现场变得更难读。JSON 请求不值得配一套
   * AbortController（还有 WebKit 上 abort 后 server 端刚发的响应被丢弃的
   * 老问题），一个标记就够。
   */
  const aliveRef = useRef(true)

  // -------------------------------------------------------------------------
  // 读取脚本清单 + 历史
  // -------------------------------------------------------------------------

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setLoading(true)
      try {
        const body = await apiGet<ScriptsResponse>('/api/scripts')
        setScripts(Array.isArray(body.scripts) ? body.scripts : [])
        setRuns(Array.isArray(body.runs) ? body.runs : [])
        setServerConfig(body.config ?? null)
        setError('')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '读取脚本列表失败。')
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // ⚠️ 卸载时中止正在跑的流 —— **两条路径都要掐**：工作区脚本走 fetch，临时脚本
  // 走 XHR。只 abort 其中一个的话，临时脚本跑着的时候切走页面，XHR 会继续读到
  // 结束，而回调里的 setState 已经指向一个卸载了的组件。
  useEffect(() => {
    return () => {
      aliveRef.current = false
      streamController.current?.abort()
      abortFormRef.current?.abort()
    }
  }, [])

  /** 把参数串切成数组。空串 → 空数组（不是 `['']`，那会往脚本里传一个空参数）。 */
  const parsedArgs = useMemo(() => {
    const text = args.trim()
    if (text === '') return [] as string[]
    // 用空白切分：契约里 args 是 `string[]`，界面上给一个输入框时这是唯一
    // 不引入「引号解析器」的做法。需要带空格的参数时请直接改脚本或跑命令行 ——
    // 这里不假装支持 shell 引号（半吊子的引号解析比不支持更容易出错）。
    return text.split(/\s+/)
  }, [args])

  const pushLine = useCallback((line: LogLine) => {
    setLines((current) => [...current, line])
  }, [])

  /**
   * 处理一个 SSE 事件。
   *
   * ⚠️ `done` 是**权威**结果：它到达时用它的值重置整个面板状态（含 summary），
   * 而不是「再追加一行」。契约 §5 说回调是尽力而为的流式展示，
   * 一次回调都没收到也要能跑完 —— 反过来，回调收到了但 `done` 没到，
   * 界面上就不能宣布结果。
   */
  const handleEvent = useCallback(
    (event: string, data: unknown) => {
      const payload = (data ?? {}) as Record<string, unknown>
      switch (event) {
        case 'start': {
          const runId = payload.runId === undefined || payload.runId === null ? '—' : String(payload.runId)
          pushLine({ kind: 'note', text: `▶ 开始 ${String(payload.script ?? '')}（runId=${runId}，origin=${String(payload.origin ?? '—')}）` })
          return
        }
        case 'stdout':
          pushLine({ kind: 'stdout', text: typeof payload.chunk === 'string' ? payload.chunk : '' })
          return
        case 'stderr':
          pushLine({ kind: 'stderr', text: typeof payload.chunk === 'string' ? payload.chunk : '' })
          return
        case 'metrics': {
          const items = Array.isArray(payload.items) ? payload.items : []
          const text = items
            .map((item) => {
              const row = (item ?? {}) as Record<string, unknown>
              const value = typeof row.value === 'number' ? row.value : Number(row.value)
              return `${String(row.metric ?? '?')}=${formatMetric(value, String(row.unit ?? ''))}`
            })
            .join('   ')
          pushLine({ kind: 'metrics', text: text === '' ? '（本次没有指标）' : text })
          return
        }
        case 'done': {
          setSummary({
            status: typeof payload.status === 'string' ? payload.status : undefined,
            exitCode: typeof payload.exitCode === 'number' || payload.exitCode === null ? (payload.exitCode as number | null) : undefined,
            durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
            truncated: payload.truncated === true || payload.truncated === 1,
            signal: typeof payload.signal === 'string' ? payload.signal : undefined,
            endedAt: typeof payload.endedAt === 'number' ? payload.endedAt : undefined,
            recordId: typeof payload.recordId === 'number' ? payload.recordId : undefined,
          })
          pushLine({
            kind: 'note',
            text: `■ 结束：${statusLabel(typeof payload.status === 'string' ? payload.status : undefined)} · 退出码 ${payload.exitCode ?? '—'} · 耗时 ${
              typeof payload.durationMs === 'number' ? humanDuration(payload.durationMs) : '—'
            }`,
          })
          return
        }
        case 'error': {
          const code = payload.code === undefined ? '' : `（${String(payload.code)}）`
          pushLine({ kind: 'error', text: `✖ ${String(payload.error ?? '运行失败，服务端没有给出说明。')}${code}` })
          setSummary({ status: 'failed' })
          return
        }
        default:
          pushLine({ kind: 'note', text: `（未知事件 ${event}）` })
      }
    },
    [pushLine]
  )

  /** 跑工作区脚本。 */
  const runSelected = useCallback(async () => {
    if (running) return
    if (selectedScript === '') {
      toast.error('先在左边选一个脚本。')
      return
    }
    const controller = new AbortController()
    streamController.current = controller
    setRunning(true)
    setSummary(null)
    setLines([{ kind: 'note', text: `$ raven run ${selectedScript} ${parsedArgs.join(' ')}`.trimEnd() }])

    try {
      await apiStream('/api/scripts/run', {
        body: { name: selectedScript, args: parsedArgs },
        signal: controller.signal,
        label: `运行 ${selectedScript}`,
        onEvent: handleEvent,
        onTransportError: (transportError) => {
          pushLine({ kind: 'error', text: `✖ ${transportError.message}` })
          setSummary({ status: 'failed' })
        },
      })
    } finally {
      // 卸载后这些 setState 与刷新都没有意义，先看 aliveRef 再动手。
      if (aliveRef.current) {
        setRunning(false)
        streamController.current = null
        // 跑完刷历史：`runs` 里会出现这一条。静默刷新，不把清单打成 loading。
        void load({ silent: true })
      }
    }
  }, [handleEvent, load, parsedArgs, pushLine, running, selectedScript, toast])

  /** 上传并运行临时脚本（multipart：`file` + `args`）。 */
  const runTemp = useCallback(async () => {
    if (running || tempBusy) return
    if (tempFile === null) {
      toast.error('先选一个本地脚本文件（.mjs / .js）。')
      return
    }
    const controller = new AbortController()
    streamController.current = controller
    setTempBusy(true)
    setRunning(true)
    setSummary(null)
    setLines([{ kind: 'note', text: `$ raven run-temp ${tempFile.name} ${parsedArgs.join(' ')}`.trimEnd() }])

    const form = new FormData()
    form.set('file', tempFile, tempFile.name)
    // 契约里 args 是同一个 multipart 请求里的一个字段。用 JSON 数组形式传，
    // 服务端两种解析都认（`args` 也可能是重复字段）。
    if (parsedArgs.length > 0) form.set('args', JSON.stringify(parsedArgs))

    try {
      // ⚠️ 用 apiStreamForm 而不是 apiStream：这个接口的请求体是 multipart，
      // 而 apiStream 只会发 JSON。事件解析仍然是同一套 SSE 语义。
      const handle = apiStreamForm('/api/scripts/run-temp', form, {}, {
        signal: controller.signal,
        label: `运行临时脚本 ${tempFile.name}`,
        onEvent: handleEvent,
        onProgress: (sent, total) => {
          // 上传进度只提示一次（到达 100% 时），不刷屏：脚本输出才是这条流的主体。
          if (total > 0 && sent >= total && uploadedRef.current === false) {
            uploadedRef.current = true
            pushLine({ kind: 'note', text: `（已上传 ${humanBytes(total)}，等待脚本输出…）` })
          }
        },
        onTransportError: (transportError) => {
          pushLine({ kind: 'error', text: `✖ ${transportError.message}` })
          setSummary({ status: 'failed' })
        },
      })
      abortFormRef.current = handle
      // `done` 在流结束（含出错与被中止）时一定会 resolve，见 lib/api.ts 的注释。
      await handle.done
    } finally {
      abortFormRef.current = null
      uploadedRef.current = false
      if (aliveRef.current) {
        setTempBusy(false)
        setRunning(false)
        streamController.current = null
        void load({ silent: true })
      }
    }
  }, [handleEvent, load, parsedArgs, pushLine, running, tempBusy, tempFile, toast])

  /** 打开一条历史运行的完整输出。 */
  const openHistory = useCallback(async (row: RunRow) => {
    const id = row.id
    if (id === undefined) return
    setHistoryDetail({ row: null, loading: true, error: '' })
    try {
      // 契约里详情接口是 `{ ok, ... }` + RunRow。字段可能包在 `run` 里，
      // 也可能平铺 —— 两种都认，认不出来就把整包当 RunRow 用（行的 id 一定在）。
      const body = await apiGet<Record<string, unknown>>(`/api/scripts/runs/${encodeURIComponent(String(id))}`)
      const candidate = (body.run ?? body) as RunRow
      setHistoryDetail({ row: candidate, loading: false, error: '' })
    } catch (cause) {
      setHistoryDetail({ row: null, loading: false, error: cause instanceof Error ? cause.message : '读取运行详情失败。' })
    }
  }, [])

  const selectedInfo = scripts.find((script) => script.name === selectedScript) ?? null
  const allowExecution = serverConfig?.allowScriptExecution ?? publicConfig.workspace.allowScriptExecution
  const timeoutMs = serverConfig?.timeoutMs ?? publicConfig.scripts.timeoutMs

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">脚本</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            运行前注入的环境变量：RAVEN_WORKSPACE / RAVEN_FILES / RAVEN_UPLOADS / RAVEN_TMPDIR / RAVEN_CLIPBOARD / RAVEN_SCRIPTS / RAVEN_ROOT / RAVEN_API / RAVEN_TOKEN / RAVEN_RUN_ID / RAVEN_VERSION，cwd 是工作目录。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            并发上限 {serverConfig?.maxConcurrent ?? publicConfig.scripts.maxConcurrent} · 超时 {humanDuration(timeoutMs)} · 输出封顶{' '}
            {humanBytes(serverConfig?.maxOutputBytes ?? publicConfig.scripts.maxOutputBytes)}
          </span>
          <Button variant="outline" onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      {error && <ErrorBar message={error} onRetry={() => void load()} busy={loading} onDismiss={() => setError('')} />}

      {!allowExecution && (
        <div className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          配置里 <code className="font-mono">workspace.allowScriptExecution = false</code>：工作区脚本被禁用，只能跑临时上传的脚本。
        </div>
      )}

      <div className="grid min-h-0 gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* 左：脚本清单 + 临时脚本 */}
        <div className="flex min-h-0 flex-col gap-3">
          <section className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
            <header className="flex items-center gap-2 border-b px-2 py-1.5">
              <h2 className="text-xs font-semibold">工作区脚本（{scripts.length}）</h2>
              {loading && <Spinner className="size-3" />}
            </header>
            <ul className="min-h-0 flex-1 overflow-y-auto p-1">
              {!loading && scripts.length === 0 && (
                <li className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                  脚本目录是空的。把 .mjs / .js 放进配置里的 scripts 目录，或在下面上传并运行。
                </li>
              )}
              {scripts.map((script, index) => {
                const name = script.name ?? `脚本 ${index + 1}`
                const active = name === selectedScript
                return (
                  <li key={name}>
                    <button
                      type="button"
                      onClick={() => setSelectedScript(name)}
                      aria-pressed={active}
                      disabled={allowExecution === false}
                      className={cn(
                        'w-full rounded-md px-2 py-1.5 text-left transition-colors',
                        active ? 'bg-secondary' : 'hover:bg-accent',
                        allowExecution === false && 'cursor-not-allowed opacity-50'
                      )}
                      title={allowExecution === false ? '工作区脚本执行已关闭' : `选中 ${name}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
                        {script.lastRun?.status !== undefined && (
                          <StatusPill tone={statusTone(script.lastRun.status)}>{statusLabel(script.lastRun.status)}</StatusPill>
                        )}
                      </div>
                      {script.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{script.description}</p>}
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {humanBytes(script.bytes)} · 改于 {relativeTime(script.mtimeMs, now)}
                        {script.lastRun?.startedAt !== undefined &&
                          ` · 上次 ${relativeTime(script.lastRun.startedAt, now)}${
                            typeof script.lastRun.durationMs === 'number' ? `（${humanDuration(script.lastRun.durationMs)}）` : ''
                          }`}
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="rounded-lg border bg-card p-2">
            <h2 className="text-xs font-semibold">上传并运行（临时脚本）</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              文件走 stdin 执行，工作目录是一次性的临时目录，跑完即删。参数取右边那个输入框。
            </p>
            <div className="mt-2 space-y-2">
              <input
                type="file"
                accept=".mjs,.js,application/javascript,text/javascript"
                onChange={(event) => setTempFile(event.target.files?.[0] ?? null)}
                aria-label="选择临时脚本文件"
                className="block w-full text-[11px] file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-[11px] file:text-foreground hover:file:bg-accent"
              />
              {tempFile !== null && (
                <p className="text-[11px] text-muted-foreground">
                  {tempFile.name} · {humanBytes(tempFile.size)}
                </p>
              )}
              <Button variant="secondary" size="md" className="w-full" onClick={() => void runTemp()} loading={tempBusy} disabled={tempFile === null || running}>
                上传并运行
              </Button>
            </div>
          </section>
        </div>

        {/* 右：参数 + 运行 + 输出 */}
        <div className="flex min-h-0 flex-col gap-3">
          <section className="rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="参数（空白分隔）"
                className="min-w-56 flex-1"
                hint={parsedArgs.length === 0 ? '留空表示不带参数；这里不做 shell 引号解析，需要带空格的参数请改脚本。' : `将作为 JSON 数组传给脚本：${JSON.stringify(parsedArgs)}`}
              >
                <Input
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="例如 --limit 20"
                  spellCheck={false}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void runSelected()
                  }}
                />
              </Field>
              <Button variant="primary" size="md" onClick={() => void runSelected()} loading={running} disabled={selectedScript === '' || running}>
                运行{selectedScript === '' ? '' : ` ${selectedScript}`}
              </Button>
              {selectedInfo?.description && <span className="text-[11px] text-muted-foreground">{selectedInfo.description}</span>}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-3">
            <LogPanel
              title={selectedScript === '' ? '输出' : `输出 · ${selectedScript}`}
              lines={lines}
              running={running}
              summary={summary}
              onAbort={() => {
                // 中止只是不再读这个流 + 关掉连接。服务端会看到客户端断开，
                // 从而按 `execution.timeoutMs` 之外的路径收尾；界面不宣布结果。
                streamController.current?.abort()
                pushLine({ kind: 'note', text: '（已中止读取；服务端会自行收尾，历史里仍会留下这次运行）' })
              }}
            />
          </section>
        </div>
      </div>

      {/* 历史 */}
      <section className="rounded-lg border bg-card">
        <header className="flex items-center gap-2 border-b px-3 py-1.5">
          <h2 className="text-xs font-semibold">运行历史（{runs.length}）</h2>
          <span className="text-[11px] text-muted-foreground">点一行看完整输出</span>
        </header>
        <div className="max-h-72 overflow-auto">
          <table className="w-full border-collapse text-left text-[11px]">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="border-b">
                <th className="px-2 py-1 font-medium">#</th>
                <th className="px-2 py-1 font-medium">脚本</th>
                <th className="px-2 py-1 font-medium">来源</th>
                <th className="px-2 py-1 font-medium">状态</th>
                <th className="px-2 py-1 font-medium">退出码</th>
                <th className="px-2 py-1 font-medium">耗时</th>
                <th className="px-2 py-1 font-medium">开始于</th>
                <th className="px-2 py-1 font-medium">触发</th>
                <th className="px-2 py-1 font-medium">输出</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-2 py-6 text-center text-muted-foreground">
                    还没有运行记录。
                  </td>
                </tr>
              )}
              {runs.map((row, index) => (
                <tr key={row.id ?? index} className="border-b last:border-b-0 hover:bg-accent/40">
                  <td className="px-2 py-1 font-mono">{row.id ?? '—'}</td>
                  <td className="px-2 py-1 font-mono">{row.script ?? '—'}</td>
                  <td className="px-2 py-1 text-muted-foreground">{row.origin ?? '—'}</td>
                  <td className="px-2 py-1">
                    <StatusPill tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusPill>
                  </td>
                  <td className="px-2 py-1 font-mono">{row.exitCode ?? '—'}</td>
                  <td className="px-2 py-1 font-mono">{typeof row.durationMs === 'number' ? humanDuration(row.durationMs) : '—'}</td>
                  <td className="px-2 py-1" title={formatDateTime(row.startedAt)}>
                    {relativeTime(row.startedAt, now)}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{row.triggeredBy ?? '—'}</td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => void openHistory(row)}
                      className="rounded border px-1.5 py-0.5 hover:bg-accent"
                      title="查看完整输出"
                    >
                      查看
                    </button>
                    {isTruncated(row.truncated) && <span className="ml-1 text-amber-600 dark:text-amber-400">截断</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 历史详情 */}
      {historyDetail !== null && (
        <section className="rounded-lg border bg-card p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-semibold">
              运行 #{historyDetail.row?.id ?? '—'} · {historyDetail.row?.script ?? ''}
            </h2>
            {historyDetail.row?.status !== undefined && (
              <StatusPill tone={statusTone(historyDetail.row.status)}>{statusLabel(historyDetail.row.status)}</StatusPill>
            )}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setHistoryDetail(null)} aria-label="关闭运行详情" title="关闭">
              关闭
            </Button>
          </div>

          {historyDetail.loading && (
            <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> 读取中…
            </p>
          )}
          {historyDetail.error !== '' && <ErrorBar message={historyDetail.error} />}
          {!historyDetail.loading && historyDetail.row !== null && (
            <div className="space-y-2">
              {isTruncated(historyDetail.row.truncated) && (
                <p className="rounded-md border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                  ⚠️ 这条记录的输出在写入时就被截断了（truncated）。以下内容不是脚本的全部输出。
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                退出码 {historyDetail.row.exitCode ?? '—'} · 耗时{' '}
                {typeof historyDetail.row.durationMs === 'number' ? humanDuration(historyDetail.row.durationMs) : '—'} · 开始{' '}
                {formatDateTime(historyDetail.row.startedAt)} · 结束 {formatDateTime(historyDetail.row.endedAt)}
                {historyDetail.row.signal ? ` · signal=${historyDetail.row.signal}` : ''}
                {typeof historyDetail.row.metricCalls === 'number' ? ` · 指标回调 ${historyDetail.row.metricCalls}` : ''}
              </p>
              <div>
                <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">stdout</p>
                <pre className="raven-mono max-h-64 overflow-auto rounded-md border bg-muted/30 p-2">
                  {historyDetail.row.stdout || '（空）'}
                </pre>
              </div>
              <div>
                <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">stderr</p>
                {/* stderr 为空时不显示红色 —— 空内容配红字会让人以为出错了。 */}
                <pre className={cn('raven-mono max-h-64 overflow-auto rounded-md border bg-muted/30 p-2', historyDetail.row.stderr ? 'text-destructive' : 'text-muted-foreground')}>
                  {historyDetail.row.stderr || '（空）'}
                </pre>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
