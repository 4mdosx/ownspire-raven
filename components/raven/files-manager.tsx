'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner } from '@/components/ui/button'
import { ConfirmDialog, Modal } from '@/components/ui/dialog'
import { Checkbox, Field, Input } from '@/components/ui/input'
import { ErrorBar, useToast } from '@/components/raven/feedback'
import { apiDelete, apiGet, apiPost, apiUpload } from '@/lib/api'
import { basename, formatDateTime, humanBytes, joinPath, parentPath, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { PublicConfig } from '@/types/config'

/**
 * 文件管理器。
 *
 * 这是 raven 里唯一一个「随时可能毁掉东西」的页面，所以纪律比功能重要：
 *
 * - **删除必须带确认，并且把服务端真正删了多少条说出来**。
 *   契约 §3 的删除纪律要求服务端先递归统计再删，并把 `count` 返回给调用方 ——
 *   界面上如果只显示「已删除」，用户永远不知道那一下删掉的是 1 个文件还是整棵树。
 * - **上传一律先写 `.part` 再 rename** 是服务端的事（AGENTS.md 第一条边界），
 *   客户端要保证的只有：一个文件一次 PUT、失败要说清楚哪个文件失败了、
 *   并且允许取消。半成品如果以最终文件名出现，用户会把它当成一个完好的文件。
 * - **不猜接口**。移动/复制需要目标路径，契约给的就是「完整目标路径」，
 *   所以这里弹一个路径输入框，而不是做一个只能同目录的假移动。
 *
 * ⚠️ 所有路径/查询值都交给 `lib/api.ts` 里的 `queryString` 做 `encodeURIComponent`。
 * 中文文件名在这里是常态（上传的资料基本都是中文名），漏编码会表现为
 * 「有些文件点进去 404，有些正常」—— 因为 `fetch` 会容忍一部分字符自己转义。
 */

// ---------------------------------------------------------------------------
// 契约 §3 的形状（字段全可选，服务端多给字段不影响渲染）
// ---------------------------------------------------------------------------

type FileKind = 'file' | 'dir' | 'symlink' | 'other'

type FileEntry = {
  name?: string
  path?: string
  kind?: FileKind
  size?: number
  mtimeMs?: number
  linkTarget?: string
  linkInside?: boolean
  extension?: string
  mime?: string
  editable?: boolean
}

type ListResponse = { path?: string; parent?: string | null; entries?: FileEntry[] }

type FileStats = {
  filesRoot?: string
  bytes?: number
  files?: number
  dirs?: number
  quotaBytes?: number | null
  remainingBytes?: number | null
  usedRatio?: number | null
}

type SortKey = 'name' | 'size' | 'mtime'
type SortOrder = 'asc' | 'desc'

/** 表头点一下的行为：同一列则翻转方向，换列则用该列的默认方向。 */
const DEFAULT_ORDER: Record<SortKey, SortOrder> = { name: 'asc', size: 'desc', mtime: 'desc' }

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'])

function kindLabel(entry: FileEntry): string {
  switch (entry.kind) {
    case 'dir':
      return '目录'
    case 'symlink':
      return entry.linkInside === false ? '符号链接（越界）' : '符号链接'
    case 'file':
      return entry.extension ? entry.extension.toUpperCase() : '文件'
    default:
      return '其他'
  }
}

function isImage(entry: FileEntry): boolean {
  if (entry.kind !== 'file') return false
  const extension = (entry.extension ?? '').toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return true
  return (entry.mime ?? '').startsWith('image/')
}

function kindTone(entry: FileEntry): string {
  if (entry.kind === 'dir') return 'text-sky-700 dark:text-sky-400'
  if (entry.kind === 'symlink') return entry.linkInside === false ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'
  return ''
}

// ---------------------------------------------------------------------------
// 上传任务
// ---------------------------------------------------------------------------

type UploadTask = {
  id: string
  name: string
  /** 目标相对路径（含文件名），上传进度条上要显示，出错了也要说清楚是哪一个。 */
  target: string
  sent: number
  total: number
  status: 'running' | 'done' | 'error' | 'aborted'
  message?: string
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function FilesManager({ publicConfig }: { publicConfig: PublicConfig }) {
  const toast = useToast()

  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [serverParent, setServerParent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')

  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [order, setOrder] = useState<SortOrder>('asc')
  const [now, setNow] = useState(() => Date.now())

  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([])

  const [dialog, setDialog] = useState<
    | { kind: 'mkdir' }
    | { kind: 'rename'; entry: FileEntry }
    | { kind: 'move'; entries: FileEntry[]; copy: boolean }
    | { kind: 'delete'; entries: FileEntry[] }
    | null
  >(null)

  const [editor, setEditor] = useState<{ path: string; text: string; original: string; loading: boolean; saving: boolean; error: string } | null>(null)
  const [confirmCloseEditor, setConfirmCloseEditor] = useState(false)

  const [stats, setStats] = useState<FileStats | null>(null)
  const [statsError, setStatsError] = useState('')

  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)

  const uploadControllers = useRef(new Map<string, { abort: () => void }>())

  const selectedEntries = useMemo(
    () => entries.filter((entry) => entry.path !== undefined && selected.has(entry.path)),
    [entries, selected]
  )

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setLoading(true)
      try {
        const body = await apiGet<ListResponse>('/api/files', {
          path,
          search,
          sort,
          order,
        })
        // 服务端会把**规范化后**的路径回显出来（去掉多余斜杠、拒绝 `..`），
        // 用它覆盖本地状态 —— 否则面包屑会和真实目录不一致。
        if (typeof body.path === 'string' && body.path !== path) setPath(body.path)
        setEntries(Array.isArray(body.entries) ? body.entries : [])
        setServerParent(body.parent === undefined ? parentPath(path) : body.parent)
        setListError('')
        setSelected(new Set())
      } catch (cause) {
        // ⚠️ 失败时**保留旧的 entries**：一个打不开的目录不该让整个列表空白，
        // 而且用户可能只是想确认另一个目录里有什么。
        setListError(cause instanceof Error ? cause.message : '列目录失败。')
      } finally {
        setLoading(false)
      }
    },
    [path, search, sort, order]
  )

  useEffect(() => {
    void load()
  }, [load])

  const loadStats = useCallback(async () => {
    try {
      const body = await apiGet<FileStats>('/api/files/stats')
      setStats(body)
      setStatsError('')
    } catch (cause) {
      setStatsError(cause instanceof Error ? cause.message : '读取配额失败。')
    }
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  // 相对时间的驱动源。只有可见时跳，理由同 Dashboard。
  useEffect(() => {
    const onVisibility = () => setNow(Date.now())
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }, 30_000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // 卸载时取消所有还在跑的上传。不做这一步，用户切走页面后 XHR 还在往磁盘写，
  // 而服务端的配额预留（reserve/release）要等连接断开才归还。
  useEffect(() => {
    const controllers = uploadControllers.current
    return () => {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
    }
  }, [])

  // -------------------------------------------------------------------------
  // 上传
  // -------------------------------------------------------------------------

  const uploadOne = useCallback(
    (file: File, targetDir: string, overwrite: boolean) => {
      const target = joinPath(targetDir, file.name)
      const id = `${target}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setUploadTasks((current) => [...current, { id, name: file.name, target, sent: 0, total: file.size, status: 'running' }])

      const handle = apiUpload('/api/files/upload', file, { path: target, overwrite: overwrite ? 1 : undefined }, {
        onProgress: (sent, total) => {
          setUploadTasks((current) => current.map((task) => (task.id === id ? { ...task, sent, total } : task)))
        },
        onDone: () => {
          setUploadTasks((current) => current.map((task) => (task.id === id ? { ...task, status: 'done', sent: file.size, total: file.size } : task)))
          uploadControllers.current.delete(id)
          // 每个文件上传完都刷一次统计：配额条是「我还要传多少」的唯一依据，
          // 等全部传完才更新会让用户以为空间没变。
          void loadStats()
        },
        onError: (error) => {
          setUploadTasks((current) =>
            current.map((task) => (task.id === id ? { ...task, status: error.code === 'aborted' ? 'aborted' : 'error', message: error.message } : task))
          )
          uploadControllers.current.delete(id)
          // 「不能吞错」：配额满（507）、越界（403）、名字非法（400）都在这里，
          // 而且必须带文件名一起说，否则一次拖 20 个文件时不知道是谁失败的。
          toast.error(`${file.name}：${error.message}`)
        },
      })
      uploadControllers.current.set(id, handle)
    },
    [loadStats, toast]
  )

  const uploadMany = useCallback(
    (files: File[], overwrite: boolean) => {
      if (files.length === 0) return
      for (const file of files) uploadOne(file, path, overwrite)
      // 拖进来的东西里可能有目录：浏览器的 DataTransferItem 能区分，但契约里的
      // 上传接口只有「一个裸流 → 一个文件路径」，没有建目录的语义。所以明确说清楚，
      // 而不是静默丢掉 —— 用户以为传上去了、实际没有，是最糟的一种失败。
      toast.ok(`已开始上传 ${files.length} 个文件到 ${path === '' ? '根目录' : path}。`, '拖入的文件夹不会被上传（上传接口按文件接收），请先新建目录再逐个拖入。')
    },
    [path, toast, uploadOne]
  )

  // -------------------------------------------------------------------------
  // 拖放：整个窗口都是投放区
  // -------------------------------------------------------------------------

  useEffect(() => {
    // ⚠️ dragenter/dragleave 在穿过每个子元素时都会成对触发，直接 setState(boolean)
    // 会疯狂闪烁。必须用深度计数（这个坑在 creative-atlas 的 workspace 里踩过）。
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      // ⚠️ 不 preventDefault 的话浏览器会用自己的默认行为处理这个文件
      // （直接打开它 / 下载它），整个应用被换掉。
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      // ⚠️ 覆盖策略是**不覆盖**：带 `overwrite=1` 会让「拖错目录」变成
      // 一次静默的数据替换。同名时服务端报错，界面把错误显示出来，让用户自己决定。
      uploadMany([...event.dataTransfer.files], false)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [uploadMany])

  // -------------------------------------------------------------------------
  // 编辑
  // -------------------------------------------------------------------------

  const openEditor = useCallback(
    async (entry: FileEntry) => {
      const target = entry.path ?? ''
      if (target === '') return
      setEditor({ path: target, text: '', original: '', loading: true, saving: false, error: '' })
      try {
        const body = await apiGet<{ text?: string; size?: number; truncated?: boolean }>('/api/files/content', { path: target })
        const text = typeof body.text === 'string' ? body.text : ''
        setEditor({
          path: target,
          text,
          original: text,
          loading: false,
          saving: false,
          // `truncated` 必须说出来：在截断的内容上按保存会把整个文件改写成一截。
          error: body.truncated === true ? '⚠️ 服务端只返回了文件的前一段（truncated=true），保存会覆盖掉后面的内容。' : '',
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '读取文件失败。'
        setEditor({ path: target, text: '', original: '', loading: false, saving: false, error: message })
      }
    },
    []
  )

  const saveEditor = useCallback(async () => {
    if (editor === null || editor.loading) return
    setEditor({ ...editor, saving: true, error: '' })
    try {
      await apiPost('/api/files/content', { path: editor.path, text: editor.text })
      // 保存成功后把 original 更新成当前文本 —— 否则关掉时还会提示「有未保存改动」。
      setEditor((current) => (current === null ? null : { ...current, original: current.text, saving: false, error: '' }))
      toast.ok(`已保存 ${basename(editor.path)}。`)
      void load({ silent: true })
      void loadStats()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败。'
      // 错误留在编辑器里（那是用户此刻看的地方），不弹 toast 就走。
      setEditor((current) => (current === null ? null : { ...current, saving: false, error: message }))
      toast.error(message)
    }
  }, [editor, load, loadStats, toast])

  const requestCloseEditor = useCallback(() => {
    if (editor === null) return
    if (editor.text !== editor.original) {
      setConfirmCloseEditor(true)
      return
    }
    setEditor(null)
  }, [editor])

  // -------------------------------------------------------------------------
  // 表格交互
  // -------------------------------------------------------------------------

  function toggleSort(key: SortKey) {
    if (sort === key) {
      setOrder(order === 'asc' ? 'desc' : 'asc')
      return
    }
    setSort(key)
    setOrder(DEFAULT_ORDER[key])
  }

  function toggleSelected(target: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((current) => {
      if (current.size === entries.length && entries.length > 0) return new Set()
      return new Set(entries.map((entry) => entry.path ?? '').filter((value) => value !== ''))
    })
  }

  const sortIndicator = (key: SortKey) => (sort === key ? (order === 'asc' ? ' ↑' : ' ↓') : '')

  const usedRatio = stats?.usedRatio ?? (stats?.quotaBytes && stats.bytes !== undefined ? stats.bytes / stats.quotaBytes : null)
  const overQuota = typeof usedRatio === 'number' && usedRatio > 0.9

  const activeUploads = uploadTasks.filter((task) => task.status === 'running')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">文件</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {publicConfig.workspace.name}/ 这一棵树；把文件拖到窗口任意位置即可上传。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setDialog({ kind: 'mkdir' })}>
            新建目录
          </Button>
          <Button variant="outline" onClick={() => void load()} loading={loading} title="重新读当前目录">
            刷新
          </Button>
        </div>
      </div>

      {/* 配额条 */}
      <QuotaBar stats={stats} error={statsError} usedRatio={usedRatio} overQuota={overQuota} onRetry={() => void loadStats()} />

      {listError && <ErrorBar message={listError} detail={path === '' ? '根目录' : path} onRetry={() => void load()} busy={loading} />}

      {/* 工具条：面包屑 + 搜索 + 批量动作 */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-2 py-1.5">
        <nav aria-label="面包屑" className="flex min-w-0 flex-wrap items-center gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => setPath('')}
            className={cn('rounded px-1 py-0.5 hover:bg-accent', path === '' && 'font-medium')}
            title="回到根目录"
          >
            根目录
          </button>
          {path
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment, index, all) => {
              const target = all.slice(0, index + 1).join('/')
              return (
                <span key={target} className="flex items-center gap-1">
                  <span className="text-muted-foreground">/</span>
                  <button
                    type="button"
                    onClick={() => setPath(target)}
                    className={cn('max-w-[180px] truncate rounded px-1 py-0.5 hover:bg-accent', index === all.length - 1 && 'font-medium')}
                    title={target}
                  >
                    {segment}
                  </button>
                </span>
              )
            })}
        </nav>

        <Button
          variant="ghost"
          size="sm"
          disabled={serverParent === null}
          onClick={() => {
            if (serverParent !== null) setPath(serverParent)
          }}
          title="上一层"
        >
          ↑ 上一层
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索当前目录（服务端过滤）"
            aria-label="搜索文件"
            className="h-7 w-56 text-xs"
          />
          {search !== '' && (
            <Button variant="ghost" size="sm" onClick={() => setSearch('')}>
              清除
            </Button>
          )}
        </div>
      </div>

      {/* 批量动作条。只在有选中时出现，避免一排永远禁用的按钮占位。 */}
      {selectedEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-xs">
          <span>已选 {selectedEntries.length} 项</span>
          <Button variant="outline" onClick={() => setDialog({ kind: 'move', entries: selectedEntries, copy: true })}>
            复制到…
          </Button>
          <Button variant="outline" onClick={() => setDialog({ kind: 'move', entries: selectedEntries, copy: false })}>
            移动到…
          </Button>
          <Button variant="danger" onClick={() => setDialog({ kind: 'delete', entries: selectedEntries })}>
            删除
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
        </div>
      )}

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b text-muted-foreground">
              <th className="w-8 px-2 py-1.5">
                <Checkbox
                  aria-label="全选"
                  title="全选/取消全选"
                  checked={entries.length > 0 && selected.size === entries.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-2 py-1.5 font-medium">
                <button type="button" className="hover:underline" onClick={() => toggleSort('name')} title="按名称排序">
                  名称{sortIndicator('name')}
                </button>
              </th>
              <th className="w-24 px-2 py-1.5 font-medium">
                <button type="button" className="hover:underline" onClick={() => toggleSort('size')} title="按大小排序">
                  大小{sortIndicator('size')}
                </button>
              </th>
              <th className="w-40 px-2 py-1.5 font-medium">
                <button type="button" className="hover:underline" onClick={() => toggleSort('mtime')} title="按修改时间排序">
                  修改时间{sortIndicator('mtime')}
                </button>
              </th>
              <th className="w-24 px-2 py-1.5 font-medium">类型</th>
              <th className="w-64 px-2 py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-8 text-center text-muted-foreground">
                  载入中…
                </td>
              </tr>
            )}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-8 text-center text-muted-foreground">
                  {search === '' ? '这个目录是空的。' : `没有匹配「${search}」的条目。`}
                </td>
              </tr>
            )}
            {entries.map((entry) => {
              const target = entry.path ?? ''
              const name = entry.name ?? basename(target)
              const checked = selected.has(target)
              return (
                <tr
                  key={target || name}
                  className={cn('group border-b last:border-b-0 hover:bg-accent/40', checked && 'bg-primary/5')}
                >
                  <td className="px-2 py-1">
                    <Checkbox
                      aria-label={`选择 ${name}`}
                      checked={checked}
                      onChange={() => toggleSelected(target)}
                      disabled={target === ''}
                    />
                  </td>
                  <td className="max-w-0 px-2 py-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {isImage(entry) && (
                        // 缩略图走 `/api/files/raw`（内联返回）。用原生 img + loading=lazy：
                        // 引入 next/image 会多一层优化服务与一次配置，而这里只是
                        // 「这是不是我要找的那张图」。
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/files/raw?path=${encodeURIComponent(target)}`}
                          alt=""
                          loading="lazy"
                          className="size-6 shrink-0 rounded border object-cover"
                        />
                      )}
                      {entry.kind === 'dir' ? (
                        <button
                          type="button"
                          onClick={() => setPath(target)}
                          className={cn('truncate font-medium hover:underline', kindTone(entry))}
                          title={`进入 ${name}`}
                        >
                          {name}/
                        </button>
                      ) : (
                        <span className="truncate" title={target}>
                          {name}
                        </span>
                      )}
                      {entry.kind === 'symlink' && (
                        <span className="shrink-0 text-[10px] text-muted-foreground" title={entry.linkTarget ?? ''}>
                          → {entry.linkTarget ?? '?'}
                          {entry.linkInside === false ? '（越界）' : ''}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {entry.kind === 'dir' ? '—' : humanBytes(entry.size)}
                  </td>
                  <td className="px-2 py-1 text-[11px] text-muted-foreground" title={formatDateTime(entry.mtimeMs)}>
                    {relativeTime(entry.mtimeMs, now)}
                  </td>
                  <td className="px-2 py-1 text-[11px] text-muted-foreground">{kindLabel(entry)}</td>
                  <td className="px-2 py-1">
                    <div className="flex flex-wrap items-center gap-1">
                      {entry.kind === 'file' && (
                        <a
                          href={`/api/files/download?path=${encodeURIComponent(target)}`}
                          className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                          title="下载"
                        >
                          下载
                        </a>
                      )}
                      {entry.editable === true && (
                        <button
                          type="button"
                          onClick={() => void openEditor(entry)}
                          className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                          title="用内置编辑器打开"
                        >
                          编辑
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: 'rename', entry })}
                        className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                        title="重命名"
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: 'move', entries: [entry], copy: true })}
                        className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                        title="复制到另一个路径"
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: 'move', entries: [entry], copy: false })}
                        className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                        title="移动到另一个路径"
                      >
                        移动
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: 'delete', entries: [entry] })}
                        className="rounded border border-destructive/60 px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                        title="删除"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 上传进度 */}
      {uploadTasks.length > 0 && (
        <div className="rounded-md border bg-card p-2">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>上传（{activeUploads.length} 个进行中 / 共 {uploadTasks.length} 个）</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setUploadTasks((current) => current.filter((task) => task.status === 'running'))}>
              清掉已完成
            </Button>
          </div>
          <ul className="space-y-1">
            {uploadTasks.map((task) => {
              const percent = task.total === 0 ? 0 : Math.min(100, Math.round((task.sent / task.total) * 100))
              return (
                <li key={task.id} className="text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={task.target}>
                      {task.name}
                    </span>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {humanBytes(task.sent)} / {humanBytes(task.total)}
                      {task.status === 'running' && ` · ${percent}%`}
                    </span>
                    {task.status === 'running' ? (
                      <button
                        type="button"
                        className="shrink-0 underline hover:text-foreground"
                        onClick={() => uploadControllers.current.get(task.id)?.abort()}
                      >
                        取消
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="shrink-0 underline hover:text-foreground"
                        onClick={() => setUploadTasks((current) => current.filter((item) => item.id !== task.id))}
                      >
                        移除
                      </button>
                    )}
                  </div>
                  {/* 进度条：width 用百分比而不是 flex-grow，这样 0% 和 100% 都看得见 */}
                  <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        'h-full transition-[width] duration-150',
                        task.status === 'error' ? 'bg-destructive' : task.status === 'done' ? 'bg-status-ok' : 'bg-primary'
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  {task.message && <p className={cn('break-words', task.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{task.message}</p>}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* 拖放高亮 */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center border-4 border-dashed border-primary bg-background/80">
          <div className="text-center">
            <p className="text-sm font-medium">松手即上传到 {path === '' ? '根目录' : path}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">同名文件不会被覆盖，服务端会报错并显示在这里</p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 弹窗                                                               */}
      {/* ------------------------------------------------------------------ */}

      <MkdirDialog
        open={dialog?.kind === 'mkdir'}
        parent={path}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null)
          void load()
          void loadStats()
        }}
      />

      <RenameDialog
        open={dialog?.kind === 'rename'}
        entry={dialog?.kind === 'rename' ? dialog.entry : null}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null)
          void load()
        }}
      />

      <MoveCopyDialog
        open={dialog?.kind === 'move'}
        entries={dialog?.kind === 'move' ? dialog.entries : []}
        copy={dialog?.kind === 'move' ? dialog.copy : true}
        currentPath={path}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null)
          void load()
          void loadStats()
        }}
      />

      <DeleteDialog
        open={dialog?.kind === 'delete'}
        entries={dialog?.kind === 'delete' ? dialog.entries : []}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null)
          void load()
          void loadStats()
        }}
      />

      {/* 编辑器 */}
      <Modal
        open={editor !== null}
        title={editor === null ? '' : `编辑 ${basename(editor.path)}`}
        description={editor === null ? undefined : <span className="raven-mono">{editor.path}</span>}
        width="lg"
        onClose={requestCloseEditor}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={requestCloseEditor} disabled={editor?.saving === true}>
              关闭
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => void saveEditor()}
              loading={editor?.saving === true}
              disabled={editor === null || editor.loading || editor.text === editor.original}
            >
              保存
            </Button>
          </>
        }
      >
        {editor?.error && (
          <p role="alert" className="mb-2 break-words rounded-md border border-destructive/60 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
            {editor.error}
          </p>
        )}
        {editor?.loading ? (
          <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> 读取中…
          </p>
        ) : (
          <textarea
            value={editor?.text ?? ''}
            onChange={(event) => setEditor((current) => (current === null ? null : { ...current, text: event.target.value }))}
            spellCheck={false}
            // 高度给足：这是要真的改内容的编辑器，不是预览框。
            className="raven-mono h-[55vh] w-full resize-y rounded-md border border-input bg-background p-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="文件内容"
          />
        )}
        {editor !== null && !editor.loading && editor.text !== editor.original && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">有未保存的改动。</p>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmCloseEditor}
        title="放弃未保存的改动？"
        message="这个文件有改动还没保存，关掉编辑器会丢掉它们。"
        confirmLabel="放弃并关闭"
        onCancel={() => setConfirmCloseEditor(false)}
        onConfirm={() => {
          setConfirmCloseEditor(false)
          setEditor(null)
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 配额条
// ---------------------------------------------------------------------------

function QuotaBar({
  stats,
  error,
  usedRatio,
  overQuota,
  onRetry,
}: {
  stats: FileStats | null
  error: string
  usedRatio: number | null
  overQuota: boolean
  onRetry: () => void
}) {
  if (error !== '') {
    return (
      <ErrorBar message={error} detail="配额读不出来时上传仍可进行，但服务端会在写入越界时拒绝（507）。" onRetry={onRetry} />
    )
  }

  const unlimited = stats !== null && (stats.quotaBytes === null || stats.quotaBytes === undefined)
  const percent = usedRatio === null ? 0 : Math.min(100, Math.round(usedRatio * 100))

  return (
    <div className="rounded-md border bg-card px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span>
          已用 <span className="font-mono">{humanBytes(stats?.bytes)}</span>
        </span>
        {unlimited ? (
          <span className="text-muted-foreground">未设置配额（不限量）</span>
        ) : (
          <>
            <span className="text-muted-foreground">
              上限 <span className="font-mono">{humanBytes(stats?.quotaBytes)}</span>
            </span>
            <span className="text-muted-foreground">
              剩余 <span className="font-mono">{humanBytes(stats?.remainingBytes)}</span>
            </span>
            <span className={cn('font-mono', overQuota && 'text-destructive')}>{percent}%</span>
          </>
        )}
        <span className="text-muted-foreground">
          {stats?.files ?? 0} 个文件 · {stats?.dirs ?? 0} 个目录
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className={cn('h-full transition-[width]', overQuota ? 'bg-destructive' : 'bg-primary')} style={{ width: `${percent}%` }} />
        </div>
      )}
      {overQuota && (
        <p className="mt-1 text-[11px] text-destructive">
          ⚠️ 已用超过 90%：再多传几个大文件就会撞上 507 配额上限，服务端会拒绝写入。
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 新建目录
// ---------------------------------------------------------------------------

function MkdirDialog({ open, parent, onClose, onDone }: { open: boolean; parent: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setName('')
      setError('')
      setBusy(false)
    }
  }, [open])

  const target = joinPath(parent, name.trim())

  async function submit() {
    if (busy) return
    if (name.trim() === '') {
      setError('目录名不能为空。')
      return
    }
    // ⚠️ 先在客户端挡掉 `/` 和 `..`：服务端 `parseRelativePath()` 也会拒（那才是
    // 真正的门），但让用户先看到一个明确的本地提示，比等一次往返更好。
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      setError('目录名不能包含斜杠或 `..`；要建多层就一层一层建，或直接用 `a/b` 形式的多级路径。')
      return
    }
    setBusy(true)
    try {
      await apiPost('/api/files/mkdir', { path: target })
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建目录失败。')
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="新建目录"
      description={<>在 <span className="raven-mono">{parent === '' ? '根目录' : parent}</span> 下创建</>}
      width="sm"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="md" onClick={() => void submit()} loading={busy}>
            创建
          </Button>
        </>
      }
    >
      <Field label="目录名" hint={target === '' ? undefined : `将创建：${target}`} error={error}>
        <Input
          data-autofocus="true"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder="例如 参考资料"
        />
      </Field>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// 重命名
// ---------------------------------------------------------------------------

function RenameDialog({ open, entry, onClose, onDone }: { open: boolean; entry: FileEntry | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && entry !== null) {
      setName(entry.name ?? basename(entry.path ?? ''))
      setError('')
      setBusy(false)
    }
  }, [open, entry])

  const from = entry?.path ?? ''
  const dir = parentPath(from)
  const to = dir === null ? name : joinPath(dir, name)

  async function submit() {
    if (busy || entry === null) return
    if (name.trim() === '' || name.includes('/') || name.includes('\\')) {
      setError('新名字不能为空，也不能包含斜杠（要换目录请用「移动」）。')
      return
    }
    setBusy(true)
    try {
      await apiPost('/api/files/rename', { from, to })
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名失败。')
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="重命名"
      description={<span className="raven-mono">{from}</span>}
      width="sm"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="md" onClick={() => void submit()} loading={busy}>
            重命名
          </Button>
        </>
      }
    >
      <Field label="新名称" hint={`将变成：${to}`} error={error}>
        <Input
          data-autofocus="true"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
      </Field>
      <p className="mt-2 text-[11px] text-muted-foreground">
        重命名只能改同一目录下的名字。跨目录请用「移动」，它的目标是完整路径。
      </p>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// 移动 / 复制
// ---------------------------------------------------------------------------

/**
 * 移动与复制合用一个对话框。
 *
 * ⚠️ 契约里 `to` 是**完整目标路径**（含新名字），所以这里给一个可编辑的路径框，
 * 默认填「目标目录 + 原文件名」。做成「只能选一个目录」的假 UI 会让人以为
 * 可以把 A 改名成 B 一起移动 —— 那个能力接口是有的，界面不该藏起来。
 */
function MoveCopyDialog({
  open,
  entries,
  copy,
  currentPath,
  onClose,
  onDone,
}: {
  open: boolean
  entries: FileEntry[]
  copy: boolean
  currentPath: string
  onClose: () => void
  onDone: () => void
}) {
  const [dest, setDest] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  useEffect(() => {
    if (!open) return
    setDest(currentPath)
    setOverwrite(false)
    setError('')
    setBusy(false)
    setProgress('')
  }, [open, currentPath])

  const single = entries.length === 1 ? entries[0] : null

  async function submit() {
    if (busy) return
    if (dest.trim() === '' && single === null) {
      setError('多项移动/复制时必须给出目标目录路径。')
      return
    }
    setBusy(true)
    setError('')
    const failures: string[] = []
    try {
      for (const entry of entries) {
        const from = entry.path ?? ''
        // 单项且目标看起来是个文件名（不是目录）时，用它当完整目标路径；
        // 否则按「目标目录 + 原名」拼。这个判断只能靠末尾有没有斜杠/是否等于
        // 已有目录，所以宁可保守：多项一律按目录处理。
        const to = single !== null && dest.trim() !== '' && dest.trim() !== currentPath ? dest.trim() : joinPath(dest.trim(), entry.name ?? basename(from))
        setProgress(`${from} → ${to}`)
        try {
          if (copy) await apiPost('/api/files/copy', { from, to, overwrite })
          else await apiPost('/api/files/move', { from, to, overwrite })
        } catch (cause) {
          failures.push(`${entry.name ?? from}：${cause instanceof Error ? cause.message : '失败'}`)
        }
      }
      if (failures.length > 0) {
        // ⚠️ 部分成功必须逐条说出来。一次「失败」的批量移动里可能有 9 个成功
        // 1 个失败，用户需要知道是哪一个。
        setError(`有 ${failures.length} 项没有成功：\n${failures.join('\n')}`)
        setBusy(false)
        return
      }
      onDone()
    } finally {
      setProgress('')
    }
  }

  return (
    <Modal
      open={open}
      title={copy ? '复制到…' : '移动到…'}
      description={`${entries.length} 项 · ${copy ? '复制' : '移动'}`}
      width="md"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="md" onClick={() => void submit()} loading={busy}>
            {copy ? '复制' : '移动'}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <ul className="max-h-32 overflow-y-auto rounded-md border bg-muted/30 px-2 py-1">
          {entries.map((entry) => (
            <li key={entry.path} className="raven-mono truncate" title={entry.path}>
              {entry.path}
            </li>
          ))}
        </ul>

        <Field
          label={single !== null ? '目标路径' : '目标目录'}
          hint={
            single !== null
              ? '可以只给目录（自动沿用原名），也可以给完整路径来顺便改名。'
              : '多项操作时这里是目录路径，每项沿用原文件名。'
          }
          error={error}
        >
          <Input
            data-autofocus="true"
            value={dest}
            onChange={(event) => setDest(event.target.value)}
            placeholder="例如 uploads"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
        </Field>

        <Checkbox
          label="目标已存在时覆盖（overwrite）"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        <p className="text-[11px] text-muted-foreground">
          ⚠️ 覆盖是不可撤销的：目标位置的同名文件会被直接替换。不确定就不要勾。
        </p>
        {progress !== '' && <p className="raven-mono text-muted-foreground">正在处理：{progress}</p>}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

function DeleteDialog({
  open,
  entries,
  onClose,
  onDone,
}: {
  open: boolean
  entries: FileEntry[]
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setError('')
      setBusy(false)
    }
  }, [open])

  const dirCount = entries.filter((entry) => entry.kind === 'dir').length
  const fileBytes = entries.reduce((total, entry) => (entry.kind === 'file' ? total + (entry.size ?? 0) : total), 0)

  async function submit() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const body = await apiDelete<{ removed?: Array<{ path?: string; kind?: string; bytes?: number }>; count?: number }>('/api/files/delete', {
        paths: entries.map((entry) => entry.path ?? '').filter((value) => value !== ''),
      })
      const removed = Array.isArray(body.removed) ? body.removed : []
      const count = typeof body.count === 'number' ? body.count : removed.length
      const bytes = removed.reduce((total, item) => total + (typeof item.bytes === 'number' ? item.bytes : 0), 0)
      // ⭐ 这里就是「把服务端真正删了多少条说出来」：`count` 是**递归统计后**
      // 的真实数量（删一个目录可能是 300 个文件），显示的估算值（选了几项）
      // 完全不是一回事。
      toast.ok(`已删除 ${count} 个条目（${humanBytes(bytes)}）。`, `选中的是 ${entries.length} 项；目录按递归统计，所以数字通常更大。`)
      onDone()
    } catch (cause) {
      // 超过 MAX_DELETE_FILES（1000）时服务端会拒绝并告知数量 —— 那句话
      // 必须原样显示，因为它是「你差点删掉整棵树」的唯一回执。
      setError(cause instanceof Error ? cause.message : '删除失败。')
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title={`删除 ${entries.length} 项`}
      message="删除不可撤销。目录会被递归删除，包括里面的全部内容。"
      detail={
        <>
          <ul className="max-h-32 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.path} className="raven-mono truncate" title={entry.path}>
                {entry.path}
                {entry.kind === 'dir' ? '（目录）' : ''}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            选中的 {entries.length} 项里有 <span className="font-mono">{dirCount}</span> 个目录；
            文件部分合计 <span className="font-mono">{humanBytes(fileBytes)}</span>。
          </p>
          <p className="mt-1 text-muted-foreground">
            ⚠️ 目录自身的字节数在这里是 0（列表接口对目录返回 size=0），真正的删除数量由服务端递归统计后返回，
            删完会显示出来。单次请求超过 1000 个文件时服务端会直接拒绝。
          </p>
          {error !== '' && <p className="mt-2 break-words text-destructive">{error}</p>}
        </>
      }
      confirmLabel="删除"
      onCancel={onClose}
      onConfirm={() => void submit()}
      busy={busy}
    />
  )
}
