'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { useToast } from '@/components/raven/feedback'
import { apiDelete, apiGet, apiPost, apiPut, apiStream, apiStreamGet, ApiClientError, isUnauthorized } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Agent 对话界面。**只按 agent 契约 §四 的事件渲染**，不理解任何内部机制。
 *
 * 三条从契约推出来的界面纪律：
 *
 * 1. **终止事件驱动指示器**：收到 `run.completed` 或 `run.failed` 才把「运行中」
 *    收回去。流结束但没收到终止事件 → 显示「异常中断」而不是永远转圈。
 * 2. **`code` 分支，不匹配文案**：契约明说 code 稳定、error 不稳定。
 *    所以下面的错误文案按 code 选，不 `includes(error)`。
 * 3. **未知事件丢弃，未知字段忽略**：agent 与 raven 各自独立部署、版本不同步，
 *    所以前端必须能handle 一个更新的后端。
 */

type ToolInfo = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  risk: 'read' | 'write' | 'destructive'
  confirmationPhrase: string | null
}

type SessionSummary = {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  runCount: number
  messageCount: number
  /** 2026-10-09 加法：引擎标识。老 agent 不发 → little-one。 */
  engine?: 'little-one' | 'claude'
  /** 2026-10-09 加法：在途 run。断线重连的依据。 */
  runningRunId?: string | null
}

type SessionDetail = {
  title: string
  messages: Message[]
  engine?: 'little-one' | 'claude'
  sandboxApproval?: boolean
  businessApproval?: boolean
  runningRunId?: string | null
}

type Message = {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

/** 一次工具调用在本页的渲染状态。key 是 callId。 */
type ToolActivity = {
  callId: string
  tool: string
  risk: ToolInfo['risk']
  state: 'running' | 'done' | 'failed'
  output?: unknown
  durationMs?: number
}

type Approval = {
  callId: string
  /** 签名凭证（契约 §五,2026-10-09 加法）。决策原样回传；缺省退回 callId。 */
  approvalId?: string
  tool: string
  input: unknown
  risk: ToolInfo['risk']
  reason?: string
  confirmationPhrase: string | null
}

/** 流式过程中正在拼接的助手消息（还没落库，所以和历史消息分开存）。 */
type Streaming = { text: string } | null

export function AgentChat() {
  const toast = useToast()

  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [toolError, setToolError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState<Streaming>(null)
  const [activity, setActivity] = useState<Record<string, ToolActivity>>({})
  const [approval, setApproval] = useState<Approval | null>(null)
  const [running, setRunning] = useState(false)
  const [input, setInput] = useState('')
  /** 终止事件之外流就断了 —— 契约 §四 规则二，那必须说出来而不是装作还在跑。 */
  const [aborted, setAborted] = useState<string | null>(null)
  // ---- 2026-10-09 契约新增面：引擎、双审批开关、取消、断线重连 ----
  const [newEngine, setNewEngine] = useState<'little-one' | 'claude'>('little-one')
  /** 可选模型（来自 agent 的配置目录）。null = 还没拉到（发消息时走 agent 默认）。 */
  const [models, setModels] = useState<{ id: string; label: string }[] | null>(null)
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [newSandboxApproval, setNewSandboxApproval] = useState(false)
  const [newBusinessApproval, setNewBusinessApproval] = useState(true)
  /** 当前会话在途的 run（断线重连与取消都指向它）。 */
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const body = await apiGet<{ tools: ToolInfo[] }>('/api/agent/tools', {}, { signal: controller.signal })
        setTools(body.tools)
      } catch (error) {
        if (controller.signal.aborted) return
        setTools([])
        setToolError(describeClient(error))
      }
    })()
    return () => controller.abort()
  }, [])

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const body = await apiGet<{ sessions: SessionSummary[] }>('/api/agent/sessions')
      setSessions(body.sessions)
    } catch (error) {
      // 会话列表拿不到不该阻断主流程 —— 用户仍然可以发一条消息，
      // raven 会自动建一个会话。
      if (!isUnauthorized(error)) console.warn('会话列表拉取失败：', describeClient(error))
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  // 模型清单:给会话挑模型用（agent 契约 §三 /api/models + 配置目录的 default）。
  // 拉不到不阻断 —— 发消息仍走 agent 的默认模型（可用优先）。
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const body = await apiGet<{ models: { id: string; label: string }[]; default: string | null }>(
          '/api/agent/models',
          {},
          { signal: controller.signal }
        )
        setModels(body.models)
        setSelectedModel(body.default ?? body.models[0]?.id ?? '')
      } catch {
        if (!controller.signal.aborted) setModels(null)
      }
    })()
    return () => controller.abort()
  }, [])

  const openSession = useCallback(async (id: string): Promise<void> => {
    try {
      const body = await apiGet<SessionDetail>(`/api/agent/sessions/${id}`)
      setSessionId(id)
      setMessages(body.messages)
      setActivity({})
      setAborted(null)
      setStreaming(null)
      // 契约 §六：详情带 runningRunId。非空 = 有一轮还在跑（页面可能刚重开）。
      // 挂上重连流看直播；agent 不发这个字段（老版本）时退回安静态。
      setActiveRunId(body.runningRunId ?? null)
      if (body.runningRunId) {
        void attachStream(id, body.runningRunId, 0)
      }
    } catch (error) {
      toast.error('打开会话失败。', describeClient(error))
    }
    // attachStream 的依赖见它自身的 useCallback 声明。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast])

  const createSession = useCallback(async (): Promise<string | null> => {
    try {
      const body = await apiPost<{ sessionId: string }>('/api/agent/sessions', {
        title: `对话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        engine: newEngine,
        sandboxApproval: newSandboxApproval,
        businessApproval: newBusinessApproval,
        // 会话固定模型:不传 = agent 的默认（可用优先）。空模型清单时也不传。
        ...(selectedModel !== '' ? { modelId: selectedModel } : {}),
      })
      setSessionId(body.sessionId)
      setMessages([])
      setActivity({})
      setAborted(null)
      void refreshSessions()
      return body.sessionId
    } catch (error) {
      toast.error('新建会话失败。', describeClient(error))
      return null
    }
  }, [newBusinessApproval, newEngine, newSandboxApproval, refreshSessions, selectedModel, toast])

  const removeSession = useCallback(
    async (id: string): Promise<void> => {
      // 回执里带条数 ——  raven 的删除纪律：别让一次误点变成没有回执的抹除。
      const target = sessions.find((s) => s.sessionId === id)
      const label = target?.title ?? id
      if (!window.confirm(`删除会话「${label}」？其中的消息与运行记录会一起删掉。`)) return
      try {
        const body = await apiDelete<{ messages: number; runs: number }>(`/api/agent/sessions/${id}`)
        toast.ok(`已删除会话，${body.messages} 条消息、${body.runs} 次运行。`)
        if (id === sessionId) {
          setSessionId(null)
          setMessages([])
        }
        void refreshSessions()
      } catch (error) {
        toast.error('删除失败。', describeClient(error))
      }
    },
    [refreshSessions, sessionId, sessions, toast]
  )

  /**
   * SSE 事件的**唯一**处理器 —— 发消息与断线重连共用（契约 §六）。
   * 两处各给一个 onTerminated 钩子翻各自的本地标志,其余状态更新完全一致。
   */
  const handleAgentEvent = useCallback(
    (event: string, data: unknown, ctx: { onTerminated: () => void }) => {
      const payload = (data ?? {}) as Record<string, unknown>

      switch (event) {
        case 'run.started':
          setActivity({})
          setActiveRunId(typeof payload.runId === 'string' ? payload.runId : null)
          break

        case 'message.delta': {
          const delta = typeof payload.text === 'string' ? payload.text : ''
          setStreaming((prev) => ({ text: (prev?.text ?? '') + delta }))
          break
        }

        case 'tool.called': {
          const callId = String(payload.callId ?? '')
          const name = String(payload.tool ?? '')
          const info = tools?.find((t) => t.name === name)
          setActivity((prev) => ({
            ...prev,
            [callId]: {
              callId,
              tool: name,
              risk: info?.risk ?? 'write',
              state: 'running',
            },
          }))
          break
        }

        case 'tool.completed': {
          const callId = String(payload.callId ?? '')
          setActivity((prev) => {
            const existing = prev[callId]
            if (!existing) return prev
            return {
              ...prev,
              [callId]: {
                ...existing,
                state: payload.ok === true ? 'done' : 'failed',
                output: payload.output,
                durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
              },
            }
          })
          break
        }

        case 'approval.requested': {
          const name = String(payload.tool ?? '')
          const info = tools?.find((t) => t.name === name)
          setApproval({
            callId: String(payload.callId ?? ''),
            approvalId: typeof payload.approvalId === 'string' ? payload.approvalId : undefined,
            tool: name,
            input: payload.input,
            risk: (payload.risk as ToolInfo['risk']) ?? info?.risk ?? 'write',
            reason: typeof payload.reason === 'string' ? payload.reason : undefined,
            confirmationPhrase: info?.confirmationPhrase ?? null,
          })
          break
        }

        case 'approval.resolved':
          setApproval(null)
          break

        case 'run.completed': {
          ctx.onTerminated()
          setStreaming((prev) => {
            if (prev?.text.trim()) {
              // 这一轮的正文在库里了，落到消息列表里。
              setMessages((msgs) => [
                ...msgs,
                { id: -Date.now() - 1, role: 'assistant', content: prev.text, createdAt: Date.now() },
              ])
            }
            return null
          })
          const status = payload.status
          if (status === 'stopped') {
            toast.error('达到步数上限，这一轮提前停了。', '这是保护机制，不是失败。换个说法或拆小一点再试。')
          } else if (status === 'denied') {
            toast.error('有工具调用被拒绝，这一轮提前结束。')
          } else if (status === 'cancelled') {
            // 2026-10-09 加值：用户取消。与 stopped 一样如实说,不说成失败。
            toast.ok('这一轮已取消。')
          }
          break
        }

        case 'run.failed': {
          ctx.onTerminated()
          const code = String(payload.code ?? 'internal_error')
          const message = String(payload.error ?? '未知错误')
          setStreaming(null)
          setActivity((prev) => {
            const next: Record<string, ToolActivity> = { ...prev }
            for (const [key, item] of Object.entries(next)) {
              if (item.state === 'running') next[key] = { ...item, state: 'failed' }
            }
            return next
          })
          // code 是稳定标识，error 是不稳定文案 —— 所以按 code 选文案。
          toast.error(failureTitle(code), message)
          break
        }

        default:
          // 未知事件：丢弃。raven 与 agent 版本不同步是常态，
          // 后端多发一个事件不该让整条消息渲染失败。
          break
      }
    },
    [toast, tools]
  )

  /**
   * 断线重连（契约 §六）：打开还在跑的会话时挂到回放+续流上。
   * after=0 全量回放 —— 已落库的消息在 detail 里,重复的 message.delta 只会
   * 重复拼接 streaming 文本,而回放的终止事件会把 streaming 正确落位,
   * 所以不额外去重（去重的复杂度换不来越过的那几条 delta）。
   */
  const attachStream = useCallback(
    async (id: string, runId: string, after: number): Promise<void> => {
      setReconnecting(true)
      setRunning(true)
      setStreaming({ text: '' })
      let terminated = false

      await apiStreamGet(`/api/agent/sessions/${id}/runs/${runId}/stream?after=${after}`, {
        label: 'agent-reconnect',
        onEvent: (event: string, data: unknown) =>
          handleAgentEvent(event, data, {
            onTerminated: () => {
              terminated = true
              setActiveRunId(null)
            },
          }),
        onTransportError: (error) => {
          setStreaming(null)
          toast.error('重连流中断。', error.message)
        },
      })

      // 回放里没有终止事件且流关闭 → 那一轮死在了半途（interrupted）。
      if (!terminated) {
        setStreaming(null)
        setAborted('那一轮没有收到结束事件 —— 它多半死在了服务重启的半途。可以重新问一遍。')
      }
      setRunning(false)
      setReconnecting(false)
      void refreshSessions()
    },
    [handleAgentEvent, refreshSessions, toast]
  )

  /**
   * 发一轮。
   */
  const send = useCallback(
    async (content: string, approvalResponses?: { approvalId: string; approved: boolean }[]): Promise<void> => {
      const text = content.trim()
      if (text === '' && !approvalResponses) return

      const controller = new AbortController()
      abortRef.current = controller

      setRunning(true)
      setAborted(null)
      setApproval(null)
      setStreaming({ text: '' })
      if (text !== '') {
        // 乐观追加：用户消息已发出去，不要等一次往返才让它出现。
        setMessages((prev) => [
          ...prev,
          { id: -Date.now(), role: 'user', content: text, createdAt: Date.now() },
        ])
        setInput('')
      }

      let target = sessionId
      if (!target) {
        target = await createSession()
        if (!target) {
          setRunning(false)
          setStreaming(null)
          return
        }
      }

      let terminated = false

      await apiStream(`/api/agent/sessions/${target}/messages`, {
        body: { content: text, ...(approvalResponses ? { approvalResponses } : {}) },
        signal: controller.signal,
        label: 'agent',
        onEvent: (event, data) =>
          handleAgentEvent(event, data, {
            onTerminated: () => {
              terminated = true
              setActiveRunId(null)
            },
          }),
        onTransportError: (error) => {
          if (controller.signal.aborted) return
          setStreaming(null)
          toast.error('事件流中断。', error.message)
        },
      })

      // 契约 §四 规则三的兜底：流结束但没收到终止事件，说明连接被掐了。
      // 不说的话界面会永远停在「运行中」。
      if (!terminated && !controller.signal.aborted) {
        setStreaming(null)
        setAborted('连接在收到结束事件之前就断了。可以重新问一遍。')
      }

      setRunning(false)
      abortRef.current = null
      void refreshSessions()
    },
    [createSession, handleAgentEvent, refreshSessions, sessionId, toast, tools]
  )

  // 流式文本或工具活动变化时滚到底。写进 ref 避免每帧都重建回调。
  const scrollRefState = useRef(0)
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const now = Date.now()
    if (now - scrollRefState.current < 80) return
    scrollRefState.current = now
    node.scrollTop = node.scrollHeight
  }, [messages, streaming, activity])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    // 本地断流只关自己的阅读器,server 侧的 run 照契约继续跑到落库 ——
    // 要真停下来必须显式取消（契约 §三「取消一轮」）。
    if (activeRunId && sessionId) {
      void apiPost(`/api/agent/sessions/${sessionId}/runs/${activeRunId}/cancel`).catch((error) =>
        console.warn('取消请求失败（本地已停止）：', describeClient(error))
      )
    }
    setRunning(false)
    setStreaming(null)
  }, [activeRunId, sessionId])

  const disabled = toolError !== null || (tools !== null && tools.length === 0)
  const list = Object.values(activity)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* ---- 左：会话 ---- */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-64">
          <div className="flex flex-col gap-1.5 rounded-md border p-2">
            <label className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">引擎</span>
              <select
                value={newEngine}
                onChange={(event) => setNewEngine(event.target.value as 'little-one' | 'claude')}
                className="h-7 rounded border bg-background px-1.5 text-xs"
              >
                <option value="little-one">little-one（轻量调度）</option>
                <option value="claude">claude（脱手长任务）</option>
              </select>
            </label>
            <label className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">模型</span>
              <select
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                className="h-7 max-w-[9.5rem] rounded border bg-background px-1.5 text-xs"
              >
                {models === null ? (
                  <option value="">（用默认）</option>
                ) : models.length === 0 ? (
                  <option value="">（agent 没配模型）</option>
                ) : (
                  models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={newSandboxApproval}
                onChange={(event) => setNewSandboxApproval(event.target.checked)}
              />
              沙箱内工具需审批
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={newBusinessApproval}
                onChange={(event) => setNewBusinessApproval(event.target.checked)}
              />
              业务工具需审批
            </label>
            <Button size="sm" onClick={() => void createSession()} disabled={disabled}>
              新建会话
            </Button>
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto lg:max-h-none lg:flex-1">
            {sessions.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">还没有会话。</p>
            ) : (
              sessions.map((item) => (
                <div
                  key={item.sessionId}
                  className={cn(
                    'group flex items-center gap-1 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors',
                    item.sessionId === sessionId ? 'bg-secondary' : 'hover:bg-accent'
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void openSession(item.sessionId)}
                  >
                    <span className="block truncate text-xs font-medium">
                      {item.title}
                      {item.engine === 'claude' && (
                        <span className="ml-1 rounded bg-primary/10 px-1 text-[10px] text-primary">claude</span>
                      )}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {item.messageCount} 条 · {item.runCount} 次运行
                      {item.runningRunId && <span className="ml-1 text-primary">● 进行中</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`删除会话 ${item.title}`}
                    className="shrink-0 rounded p-1 text-[11px] text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    onClick={() => void removeSession(item.sessionId)}
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ---- 右：对话 ---- */}
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {toolError !== null ? (
            <Notice tone="error" title="Agent Runtime 不可用">
              {toolError}
            </Notice>
          ) : tools !== null && tools.length === 0 ? (
            <Notice tone="warn" title="还没有可用工具">
              Agent Runtime 已连接，但它没有注册任何工具。发消息不会有结果。
            </Notice>
          ) : (
            <>
              <div ref={scrollRef} className="min-h-64 flex-1 overflow-y-auto rounded-lg border p-3">
                {messages.length === 0 && streaming === null ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    发一句话开始。可用工具：
                    {tools?.map((t) => t.name).join('、') ?? '加载中…'}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {messages.map((message, index) => (
                      <Bubble key={`${message.id}-${index}`} message={message} />
                    ))}
                    {streaming !== null && <Bubble message={{ id: -1, role: 'assistant', content: streaming.text, createdAt: Date.now() }} live />}
                  </div>
                )}
              </div>

              {/* ---- 工具活动 ---- */}
              {list.length > 0 && (
                <div className="flex flex-col gap-1">
                  {list.map((item) => (
                    <div
                      key={item.callId}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs',
                        item.state === 'failed' && 'border-destructive/40 bg-destructive/5',
                        item.state === 'running' && 'border-border'
                      )}
                    >
                      <RiskDot risk={item.risk} />
                      <span className="font-mono">{item.tool}</span>
                      <span className="text-muted-foreground">
                        {item.state === 'running'
                          ? '执行中…'
                          : item.state === 'done'
                            ? `完成${item.durationMs !== undefined ? ` · ${item.durationMs}ms` : ''}`
                            : '失败'}
                      </span>
                      {item.state === 'failed' && item.output !== undefined && (
                        <span className="truncate font-mono text-destructive">
                          {errorText(item.output)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ---- 审批 ---- */}
              {approval !== null && (
                <ApprovalCard
                  approval={approval}
                  onDecide={(approved) => {
                    const next = approval
                    // 契约 §五：决策走**下一条消息**，不在原流上等。
                    // approvalId 是签名凭证（claude 引擎由 Driver 签发）——缺省退回 callId。
                    void send('', [{ approvalId: next.approvalId ?? next.callId, approved }])
                  }}
                />
              )}

              {reconnecting && (
                <Notice tone="warn" title="这一轮还在跑">
                  页面重开时发现它没跑完，已经接上事件流 —— 结果会实时出现在这里，
                  关掉页面它也会继续跑。
                </Notice>
              )}

              {aborted !== null && <Notice tone="warn" title="这一轮没有正常结束">{aborted}</Notice>}

              {/* ---- 输入 ---- */}
              <div className="flex flex-col gap-2">
                <Textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="说点什么。Enter 发送，Shift+Enter 换行。"
                  rows={3}
                  disabled={running || disabled}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send(input)
                    }
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => void send(input)} loading={running} disabled={disabled}>
                    发送
                  </Button>
                  {running && (
                    <Button size="sm" variant="outline" onClick={stop}>
                      中止
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Bubble({ message, live = false }: { message: Message; live?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-1', message.role === 'user' && 'items-end')}>
      <span className="text-[11px] text-muted-foreground">{message.role === 'user' ? '你' : 'Agent'}</span>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
          message.role === 'user' ? 'bg-secondary' : 'border'
        )}
      >
        {message.content || (live ? <span className="text-muted-foreground">…</span> : null)}
      </div>
    </div>
  )
}

function RiskDot({ risk }: { risk: ToolInfo['risk'] }) {
  return (
    <span
      aria-label={risk}
      title={risk === 'destructive' ? '不可逆' : risk === 'write' ? '写' : '只读'}
      className={cn(
        'size-2 shrink-0 rounded-full',
        risk === 'destructive' ? 'bg-destructive' : risk === 'write' ? 'bg-amber-500' : 'bg-muted-foreground'
      )}
    />
  )
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Approval
  onDecide: (approved: boolean) => void
}) {
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)

  // 确认词是**体验**，不是授权 —— agent 侧不依赖它（契约 §五）。
  // 但要求用户敲一遍能让误点变难，所以这里只拦 UI。
  const needsPhrase = approval.confirmationPhrase !== null && approval.confirmationPhrase !== ''
  const canApprove = !needsPhrase || phrase.trim() === approval.confirmationPhrase

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2">
        <RiskDot risk={approval.risk} />
        <span className="text-sm font-medium">需要你确认</span>
        <span className="font-mono text-xs text-muted-foreground">{approval.tool}</span>
      </div>
      {approval.reason && <p className="mt-1 text-xs text-muted-foreground">{approval.reason}</p>}
      <pre className="mt-2 max-h-32 overflow-auto rounded bg-background p-2 text-[11px]">
        {JSON.stringify(approval.input, null, 2)}
      </pre>
      {needsPhrase && (
        <div className="mt-2 flex items-center gap-2">
          <input
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            placeholder={`输入 ${approval.confirmationPhrase} 以确认`}
            className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
          />
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={!canApprove || busy}
          onClick={() => {
            setBusy(true)
            onDecide(true)
          }}
        >
          批准
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            onDecide(false)
          }}
        >
          拒绝
        </Button>
      </div>
    </div>
  )
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'error'
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-xs',
        tone === 'error' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'
      )}
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-muted-foreground">{children}</div>
    </div>
  )
}

/** 按契约 §四 的 code 选文案。**不匹配 error 文本** —— 那是不稳定的。 */
function failureTitle(code: string): string {
  // 与 agent 契约 §四 的 code 表一一对应 —— 每个码给「现在该做什么」的标题。
  switch (code) {
    case 'model_auth_failed':
      return '模型 key 无效或缺失'
    case 'model_quota_exhausted':
      return '模型余额不足'
    case 'model_rate_limited':
      return '被厂商限流了'
    case 'model_content_filtered':
      return '内容被模型的安全策略拦下'
    case 'model_not_found':
      return '模型或端点不存在'
    case 'model_upstream_error':
      return '厂商侧出错'
    case 'model_not_configured':
      return 'Runtime 没配模型'
    case 'model_error':
      return '模型调用失败'
    case 'tool_error':
      return '工具出错'
    case 'invalid_tool_input':
      return '模型给的参数不合法'
    case 'budget_exhausted':
      return 'token 预算已用尽'
    case 'engine_not_available':
      return 'claude 引擎未就绪'
    case 'aborted':
      return '已中止'
    default:
      return 'Agent Runtime 出错'
  }
}

function errorText(output: unknown): string {
  if (output !== null && typeof output === 'object' && 'error' in output) {
    return String((output as { error: unknown }).error)
  }
  return ''
}

function describeClient(error: unknown): string {
  if (error instanceof ApiClientError) return error.message
  return error instanceof Error ? error.message : String(error)
}