'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner } from '@/components/ui/button'
import { ConfirmDialog, Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ErrorBar, useToast } from '@/components/ui/toast'
import { apiDelete, apiGet, apiPatch, apiPost, apiUploadForm } from '@/lib/api'
import { formatDateTime, humanBytes, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { PublicConfig } from '@/types/config'

/**
 * 剪切板队列。
 *
 * 这个页面的**主交互是粘贴，不是填表**。所以：
 *
 * - 进页面焦点就在粘贴框里；
 * - 窗口级 `paste` 监听：粘一段文字 = **立刻**入队一条（那个框只是显示最近
 *   一次粘了什么，不是「填完再点提交」的表单）；
 * - 剪贴板里有图片/文件时走 multipart 接口，把文件一起带上。
 *
 * ⚠️ 三个必须写对、否则会出现「有时记两条有时一条都没记」的地方：
 *
 * 1. **`preventDefault()`**。不拦住默认行为的话，粘进粘贴框的文字会留在
 *    textarea 里；下一次用户在那儿按 Ctrl+Enter 手动提交，就**又**入队了一条 ——
 *    同一段内容两条记录，而且看不出来哪条是自动的哪条是手动的。
 * 2. **编辑框 / 任何输入框里粘贴不拦截**。在编辑某一条的正文时粘贴一小段片段是
 *    「修改这一条」，不是「新建一条」。判断用 `closest('[role="dialog"]')`
 *    而不是看 `activeElement` 标签名：编辑框也是一个 textarea，靠标签名区分不了
 *    它和粘贴框。
 * 3. **一次粘一个文件**。契约里 `createWithAttachments` 是「一条记录带若干附件」，
 *    但界面上一次粘贴就是一次意图；把 `clipboardData.files` 全塞进同一条记录是
 *    对的（它们本来就是一组的），却**不能**同时再发一条纯文本的 —— 那会变成两条。
 */

// ---------------------------------------------------------------------------
// 契约 §4 的形状
// ---------------------------------------------------------------------------

type ClipboardAttachment = { name?: string; bytes?: number }
type ClipboardEntry = {
  id?: string
  text?: string
  bytes?: number
  source?: string
  createdAt?: number
  attachments?: ClipboardAttachment[]
  attachBytes?: number
  position?: number
}

type ListResponse = { entries?: ClipboardEntry[]; total?: number; maxItems?: number }

const PAGE_SIZE = 100

/** 行内预览的折叠阈值。太短的文本没必要折叠（多一次点击）。 */
const COLLAPSE_CHARS = 240
const COLLAPSE_LINES = 6

export function ClipboardBoard({ publicConfig }: { publicConfig: PublicConfig }) {
  const toast = useToast()

  const [entries, setEntries] = useState<ClipboardEntry[]>([])
  const [total, setTotal] = useState(0)
  const [maxItems, setMaxItems] = useState(publicConfig.clipboard.maxItems)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** 上一次粘贴附带的文件。它们在提交时走 multipart，和文本一起入队。 */
  const [pendingFiles, setPendingFiles] = useState<File[]>([])

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [focusIndex, setFocusIndex] = useState(-1)
  const [editing, setEditing] = useState<{ entry: ClipboardEntry; text: string; busy: boolean; error: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ClipboardEntry | null>(null)

  const pasteRef = useRef<HTMLTextAreaElement | null>(null)
  const rowRefs = useRef<Array<HTMLLIElement | null>>([])
  /**
   * 入队互斥锁。
   *
   * ⚠️ 必须是 ref 而不是 `submitting` 这个 state：`useState` 的写入要到下一次
   * 渲染才在闭包外可见，而「粘贴事件」与「Ctrl+Enter」可能在**同一次事件循环**
   * 里各触发一次 `submit()` —— 两次都读到 `submitting === false`，于是一条内容
   * 入队两条。ref 是同步的，能真正挡住这种重入。
   */
  const submittingRef = useRef(false)

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setLoading(true)
      try {
        const body = await apiGet<ListResponse>('/api/clipboard', { limit: PAGE_SIZE, offset: 0, q: query })
        setEntries(Array.isArray(body.entries) ? body.entries : [])
        setTotal(typeof body.total === 'number' ? body.total : 0)
        if (typeof body.maxItems === 'number' && body.maxItems > 0) setMaxItems(body.maxItems)
        setError('')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '读取剪切板失败。')
      } finally {
        setLoading(false)
      }
    },
    [query]
  )

  useEffect(() => {
    void load()
  }, [load])

  // 相对时间的驱动源。这个页面看的是「几分钟前粘的」，30 秒一跳足够。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // 进页面聚焦粘贴框。用 effect 而不是 autoFocus：从别的页面客户端跳过来时，
  // autoFocus 只在首次挂载生效（这里正好也够），但显式聚焦能保证**每次**进入
  // 这个页面都落在正确的位置 —— 这是这个页面的核心动作。
  useEffect(() => {
    pasteRef.current?.focus()
  }, [])

  // -------------------------------------------------------------------------
  // 入队
  // -------------------------------------------------------------------------

  const submit = useCallback(
    async (text: string, files: File[]) => {
      const trimmed = text
      if (trimmed.trim() === '' && files.length === 0) return
      // 重入锁，见 submittingRef 的注释。
      if (submittingRef.current) return
      submittingRef.current = true
      setSubmitting(true)
      try {
        if (files.length > 0) {
          const form = new FormData()
          form.set('text', trimmed)
          // ⚠️ 字段名 `files` 是契约里的 multipart 约定（`text` + 文件字段）。
          // 多个文件用同一个字段名重复 append —— 这是 multipart 的标准做法。
          for (const file of files) form.append('files', file, file.name)
          await new Promise<void>((resolve, reject) => {
            apiUploadForm<Record<string, unknown>>(
              '/api/clipboard/attachments',
              form,
              {},
              {
                onDone: () => resolve(),
                onError: (uploadError) => reject(uploadError),
              }
            )
          })
        } else {
          await apiPost('/api/clipboard', { text: trimmed, source: 'web' })
        }
        setDraft('')
        setPendingFiles([])
        // 静默刷新：不把列表打成 loading 态，否则每次粘贴整个清单会闪一下，
        // 而这正是用户盯着的地方。
        await load({ silent: true })
      } catch (cause) {
        // 超长（clipboard.maxTextBytes）会被**拒绝而不是截断**，服务端那句话
        // 必须原样显示 —— 它包含上限是多少字节。
        const message = cause instanceof Error ? cause.message : '写入剪切板失败。'
        setError(message)
        toast.error(message)
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [load, toast]
  )

  // -------------------------------------------------------------------------
  // 窗口级粘贴
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      // 条件 2：编辑框 / 弹窗里的任何输入框都不拦截。那不是「新建一条」。
      if (target.closest('[role="dialog"]') !== null) return
      const isTextField =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
      // 粘贴框自己的粘贴走这里的默认分支；其他输入框（搜索框）完全不接管。
      if (isTextField && target !== pasteRef.current) return

      const data = event.clipboardData
      if (data === null) return

      const files = [...data.files]
      const text = data.getData('text/plain')

      // 条件 1：拦住默认插入，见文件头注释。
      event.preventDefault()

      if (files.length > 0) {
        // 有文件时：文本与文件作为**一条**记录提交。同时把文件显示在待提交区，
        // 让「附件是什么」在提交完之前就可见。
        setPendingFiles(files)
        void submit(text, files)
        return
      }
      if (text !== '') void submit(text, [])
    }

    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [submit])

  // -------------------------------------------------------------------------
  // 键盘导航
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement) {
        // 输入状态下一律不抢键：`j`/`k` 是搜索框里合法的字符。
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) {
          // 例外：Cmd/Ctrl+Enter 是「把框里的内容手动入队」。
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && target === pasteRef.current) {
            event.preventDefault()
            void submit(draft, pendingFiles)
          }
          return
        }
        if (target.closest('[role="dialog"]') !== null) return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setFocusIndex((index) => {
          const next = Math.min(entries.length - 1, index + 1)
          // `block: 'nearest'` 是关键：默认的 scrollIntoView 会把整个列表
          // 滚到自己顶部（历史/清单类界面里表现是「跳一下」），
          // nearest 只在目标不可见时才滚动，而且是最小距离。
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' })
          return next
        })
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setFocusIndex((index) => {
          const next = Math.max(0, index - 1)
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' })
          return next
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft, entries.length, pendingFiles, submit])

  // -------------------------------------------------------------------------
  // 单条操作
  // -------------------------------------------------------------------------

  const copyToClipboard = useCallback(
    async (entry: ClipboardEntry) => {
      const text = entry.text ?? ''
      try {
        // ⚠️ `navigator.clipboard` 只在安全上下文（https / localhost）里存在。
        // 通过局域网 IP 用 http 访问时它是 undefined —— 那时必须明确告诉用户
        // 「复制不了，请手动选中」，而不是静默什么都不做。
        if (navigator.clipboard?.writeText === undefined) {
          toast.error('这个浏览器上下文不允许写剪贴板（http + 非 localhost），请手动选中文本复制。')
          return
        }
        await navigator.clipboard.writeText(text)
        toast.ok(`已复制这一条（${humanBytes(entry.bytes ?? text.length)}）。`)
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : '复制到剪贴板失败。')
      }
    },
    [toast]
  )

  const saveEdit = useCallback(async () => {
    if (editing === null || editing.busy) return
    const id = editing.entry.id ?? ''
    if (id === '') return
    setEditing({ ...editing, busy: true, error: '' })
    try {
      await apiPatch(`/api/clipboard/${encodeURIComponent(id)}`, { text: editing.text })
      setEditing(null)
      await load({ silent: true })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败。'
      setEditing((current) => (current === null ? null : { ...current, busy: false, error: message }))
    }
  }, [editing, load])

  const removeEntry = useCallback(
    async (entry: ClipboardEntry) => {
      const id = entry.id ?? ''
      if (id === '') return
      try {
        await apiDelete(`/api/clipboard/${encodeURIComponent(id)}`)
        toast.ok('已删除这一条（附件目录一并删除）。')
        await load({ silent: true })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '删除失败。'
        setError(message)
        toast.error(message)
      } finally {
        setDeleteTarget(null)
      }
    },
    [load, toast]
  )

  const clearAll = useCallback(async () => {
    setClearing(true)
    try {
      const body = await apiDelete<{ removed?: number }>('/api/clipboard')
      const removed = typeof body.removed === 'number' ? body.removed : 0
      toast.ok(`已清空 ${removed} 条。`, '附件目录也已一并删除。')
      setConfirmClear(false)
      await load({ silent: true })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '清空失败。'
      setError(message)
      toast.error(message)
    } finally {
      setClearing(false)
    }
  }, [load, toast])

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const usable = useMemo(() => {
    // 「已用 N / maxItems」里的 N 用 total（服务端给的队列长度），不是本页条数 ——
    // 本页只取了前 100 条。
    return { used: total, max: maxItems }
  }, [total, maxItems])

  const draftBytes = useMemo(() => new TextEncoder().encode(draft).length, [draft])
  const draftOverLimit = draftBytes > publicConfig.clipboard.maxTextBytes

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">剪切板</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            直接 Ctrl/Cmd+V 就入队，一次粘贴 = 一条记录。J/K 或 ↑/↓ 在队列里移动。
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            已用 <span className="font-mono">{usable.used}</span> / {usable.max}
          </span>
          <Button variant="danger" onClick={() => setConfirmClear(true)} disabled={entries.length === 0 && total === 0}>
            清空
          </Button>
        </div>
      </div>

      {error && <ErrorBar message={error} onRetry={() => void load()} busy={loading} onDismiss={() => setError('')} />}

      {/* 粘贴区 */}
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-1 flex items-center gap-2">
          <label htmlFor="raven-paste" className="text-xs font-medium">
            粘贴框
          </label>
          <span className="text-[11px] text-muted-foreground">
            {submitting ? '正在入队…' : '粘进来就入队；要手动提交按 Ctrl/Cmd+Enter'}
          </span>
          <span className={cn('ml-auto font-mono text-[11px]', draftOverLimit ? 'text-destructive' : 'text-muted-foreground')}>
            {humanBytes(draftBytes)} / {humanBytes(publicConfig.clipboard.maxTextBytes)}
          </span>
        </div>
        <textarea
          id="raven-paste"
          ref={pasteRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ctrl/Cmd+V 粘贴文字或图片…"
          spellCheck={false}
          className="raven-mono h-28 w-full resize-y rounded-md border border-input bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="粘贴内容"
        />
        {/*
          ⚠️ 这里**故意不给 textarea 挂 onKeyDown**：Ctrl/Cmd+Enter 由下面那个
          窗口级 keydown 监听统一处理。两处都挂的话，一次按键会调用两次 submit，
          而 state 更新是异步的 —— 两条一模一样的记录入队，并且队列里看不出
          哪条是「多余」的。手动提交路径只保留一个入口。
        */}
        {/* 手动提交按钮：粘贴是主路径，但键盘/触屏用户需要一个显式的出口。 */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void submit(draft, pendingFiles)}
            loading={submitting}
            disabled={draft.trim() === '' && pendingFiles.length === 0}
          >
            入队
          </Button>
          {(draft !== '' || pendingFiles.length > 0) && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft('')
                setPendingFiles([])
              }}
            >
              清掉输入
            </Button>
          )}
          {pendingFiles.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              待提交附件：{pendingFiles.map((file) => file.name).join('、')}
            </span>
          )}
          {draftOverLimit && (
            <span className="text-[11px] text-destructive">
              超过单条上限 {humanBytes(publicConfig.clipboard.maxTextBytes)}，服务端会拒绝（不会截断）。
            </span>
          )}
        </div>
      </div>

      {/* 队列 */}
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按内容搜索（服务端过滤）"
          aria-label="搜索剪切板"
          className="h-7 w-64 text-xs"
        />
        {query !== '' && (
          <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
            清除
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {loading && entries.length === 0 && (
          <li className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> 载入中…
          </li>
        )}
        {!loading && entries.length === 0 && (
          <li className="py-8 text-center text-xs text-muted-foreground">
            {query === '' ? '队列是空的。粘一段东西试试。' : `没有匹配「${query}」的记录。`}
          </li>
        )}
        {entries.map((entry, index) => {
          const id = entry.id ?? String(index)
          const text = entry.text ?? ''
          const attachments = Array.isArray(entry.attachments) ? entry.attachments : []
          const isOpen = expanded.has(id)
          const isLong = text.length > COLLAPSE_CHARS || text.split('\n').length > COLLAPSE_LINES
          return (
            <li
              key={id}
              ref={(node) => {
                rowRefs.current[index] = node
              }}
              /*
                ⚠️ **不**用「roving tabindex」（`tabIndex={focusIndex === index ? 0 : -1}`）。
                那样虽然让 j/k 看起来像在导航，却把行内那三个按钮从 Tab 顺序里
                整个摘掉了 —— 键盘用户能跳行、却按不到「复制 / 编辑 / 删除」。
                所以：行本身不进 Tab 顺序，按钮保持原生可达；j/k 只负责高亮与滚动。
              */
              className={cn(
                'rounded-md border bg-card p-2 transition-colors',
                focusIndex === index && 'border-primary/60 ring-1 ring-primary/40'
              )}
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                {/* position 是服务端给的队列位置，1 是最新。用它当序号比用数组下标准
                    （搜索/分页时下标会错位）。 */}
                <span className="font-mono">#{entry.position ?? index + 1}</span>
                <span title={formatDateTime(entry.createdAt)}>{relativeTime(entry.createdAt, now)}</span>
                <span className="font-mono">{humanBytes(entry.bytes ?? text.length)}</span>
                {entry.source && <span className="rounded bg-muted px-1.5 py-0.5">{entry.source}</span>}
                {attachments.length > 0 && (
                  <span>
                    {attachments.length} 个附件 · {humanBytes(entry.attachBytes ?? 0)}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void copyToClipboard(entry)} title="复制这条文本到剪贴板">
                    复制
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing({ entry, text, busy: false, error: '' })}
                    title="修改这条文本（不改变队列顺序）"
                  >
                    编辑
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(entry)} title="删除这条（含附件）">
                    删除
                  </Button>
                </span>
              </div>

              <div className="mt-1">
                {text === '' ? (
                  <p className="raven-mono text-muted-foreground">（没有文本，只有附件）</p>
                ) : (
                  <p className={cn('raven-mono', !isOpen && isLong && 'max-h-24 overflow-hidden')}>{text}</p>
                )}
                {isLong && (
                  <button
                    type="button"
                    className="mt-1 text-[11px] text-muted-foreground underline hover:text-foreground"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }
                    aria-expanded={isOpen}
                  >
                    {isOpen ? '收起' : '展开全文'}
                  </button>
                )}
              </div>

              {attachments.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {attachments.map((attachment, attachmentIndex) => {
                    const name = attachment.name ?? `附件 ${attachmentIndex + 1}`
                    // ⚠️ 契约里附件下载在 `/api/clipboard/[id]/attachment?name=`。
                    // 路径段与查询值都要 encode：附件名基本是中文。
                    const href = `/api/clipboard/${encodeURIComponent(id)}/attachment?name=${encodeURIComponent(name)}`
                    return (
                      <li key={`${name}-${attachmentIndex}`}>
                        <a
                          href={href}
                          className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                          title={`下载 ${name}`}
                        >
                          {name}
                          <span className="text-muted-foreground">{humanBytes(attachment.bytes)}</span>
                        </a>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      {/* 编辑弹窗 */}
      <Modal
        open={editing !== null}
        title="编辑这一条"
        description="纠错用。改文本不会改变它在队列里的位置。"
        width="lg"
        onClose={editing?.busy === true ? () => undefined : () => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setEditing(null)} disabled={editing?.busy === true}>
              取消
            </Button>
            <Button variant="primary" size="md" onClick={() => void saveEdit()} loading={editing?.busy === true}>
              保存
            </Button>
          </>
        }
      >
        {editing?.error && (
          <p role="alert" className="mb-2 break-words rounded-md border border-destructive/60 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
            {editing.error}
          </p>
        )}
        <textarea
          data-autofocus="true"
          value={editing?.text ?? ''}
          onChange={(event) => setEditing((current) => (current === null ? null : { ...current, text: event.target.value }))}
          spellCheck={false}
          aria-label="记录内容"
          className="raven-mono h-[50vh] w-full resize-y rounded-md border border-input bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          在这个框里粘贴不会新建记录（只有粘贴框和窗口空白处的粘贴才算入队）。
        </p>
      </Modal>

      <ConfirmDialog
        open={confirmClear}
        title="清空整个队列？"
        message={`这会删掉全部 ${usable.used} 条记录及其附件目录，不可撤销。`}
        detail={<p>服务端会返回真正删掉的条数。附件目录（clipboard/&lt;id&gt;/）一并删除。</p>}
        confirmLabel="清空"
        requirePhrase="clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearAll()}
        busy={clearing}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这一条？"
        message="这条记录与它的附件目录都会被删掉，不可撤销。"
        detail={
          deleteTarget === null ? undefined : (
            <>
              <p className="raven-mono max-h-24 overflow-hidden">{deleteTarget.text ?? ''}</p>
              <p className="mt-1 text-muted-foreground">
                {(deleteTarget.attachments ?? []).length} 个附件 · {humanBytes(deleteTarget.attachBytes ?? 0)}
              </p>
            </>
          )
        }
        confirmLabel="删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) void removeEntry(deleteTarget)
        }}
      />
    </div>
  )
}
