'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { apiDelete, apiGet, apiPost, apiStream, ApiClientError, isUnauthorized } from '@/lib/api'
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

  const openSession = useCallback(async (id: string): Promise<void> => {
    try {
      const body = await apiGet<{ title: string; messages: Message[] }>(`/api/agent/sessions/${id}`)
      setSessionId(id)
      setMessages(body.messages)
      setActivity({})
      setAborted(null)
      setStreaming(null)
    } catch (error) {
      toast.error('打开会话失败。', describeClient(error))
    }
  }, [toast])

  const createSession = useCallback(async (): Promise<string | null> => {
    try {
      const body = await apiPost<{ sessionId: string }>('/api/agent/sessions', {
        title: `对话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
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
  }, [refreshSessions, toast])

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
   * 发一轮。这是整个组件里唯一一处处理 SSE 事件的地方。
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
        onEvent: (event, data) => {
          const payload = (data ?? {}) as Record<string, unknown>

          switch (event) {
            case 'run.started':
              setActivity({})
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
              terminated = true
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
              }
              break
            }

            case 'run.failed': {
              terminated = true
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
    [createSession, refreshSessions, sessionId, toast, tools]
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
    setRunning(false)
    setStreaming(null)
  }, [])

  const disabled = toolError !== null || (tools !== null && tools.length === 0)
  const list = Object.values(activity)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* ---- 左：会话 ---- */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-64">
          <Button size="sm" onClick={() => void createSession()} disabled={disabled}>
            新建会话
          </Button>
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
                    <span className="block truncate text-xs font-medium">{item.title}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {item.messageCount} 条 · {item.runCount} 次运行
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
                    void send('', [{ approvalId: next.callId, approved }])
                  }}
                />
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
  switch (code) {
    case 'model_error':
      return '模型调用失败'
    case 'tool_error':
      return '工具出错'
    case 'invalid_tool_input':
      return '模型给的参数不合法'
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