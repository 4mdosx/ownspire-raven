import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { getConfig } from '@/backstage/lib/config'
import { MiB } from '@/backstage/lib/format'
import { ulid } from '@/backstage/lib/ids'
import { isInside, joinRelative, parseRelativePath, SandboxError, type PathSandbox } from '@/backstage/lib/sandbox'
import { QuotaMeter, quotaTransform } from '@/backstage/lib/quota'

/**
 * 文件管理器服务层。
 *
 * 这一层有两个**只在这里**成立的约定，别在别处重复实现：
 *
 * 1. **对外路径相对 filesRoot**（`workspace/`），而 `PathSandbox` 的一切
 *    判定相对 `rootPath`。所以每个入口都先套一层 `workspace/` 前缀，出口再
 *    把绝对路径转回相对 filesRoot 的 POSIX 串。绕开这层的 `path.join(root, 用户输入)`
 *    等于把 `scripts/`、`clipboard/` 也交给文件管理器。
 * 2. **沙箱只保证「在 root 内」**。文件管理器要的是「在 filesRoot 内」——
 *    `<root>/workspace/link -> <root>/scripts` 没有越出 root，但双击它会 403。
 *    所以每个 resolve 之后还要比一次 filesRoot，软链的 `linkInside` 也按 filesRoot 算。
 *
 * 错误一律用 `SandboxError`（带 code + status）。这里刻意不 import
 * `ApiError`：那会把 `next/server` 拖进服务层，而 `scripts/verify-storage.ts`
 * 要在纯 Node 里直接调这些函数。两者在 `handle()` 里的出口形状完全一致。
 */

export type FileKind = 'file' | 'dir' | 'symlink' | 'other'

export type FileEntry = {
  name: string
  /** 相对 filesRoot 的 POSIX 路径；根目录为 ''。 */
  path: string
  kind: FileKind
  /** 目录为 0；symlink 为链接自身长度。 */
  size: number
  mtimeMs: number
  /** symlink 才有：链接目标（原样），以及它是否仍在文件管理器可见树内。 */
  linkTarget?: string
  linkInside?: boolean
  /** 小写，不含点；目录为 ''。 */
  extension: string
  mime: string
  /** 文本类且 < 1MiB。 */
  editable: boolean
}

export type FileStats = {
  /** 沙箱内的绝对路径，仅用于展示。 */
  filesRoot: string
  bytes: number
  files: number
  dirs: number
  quotaBytes: number | null
  remainingBytes: number | null
  /** 0..1；未设配额为 null。 */
  usedRatio: number | null
}

/** 单次请求允许删除的文件数上限。超过就拒绝并告知数量（见 AGENTS.md 的删除门禁）。 */
export const MAX_DELETE_FILES = 1000

/** 超过这个大小就不给编辑器打开：整棵树塞进浏览器只会让标签页崩掉。 */
export const EDITABLE_MAX_BYTES = 1 * MiB

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 相对 filesRoot 的输入 → 相对 rootPath 的路径段。空输入 = filesRoot 本身。 */
function rootSegments(input: unknown, options: { allowEmpty?: boolean } = {}): string[] {
  const { config } = getConfig()
  return [config.workspace.name, ...parseRelativePath(input, options)]
}

/**
 * filesRoot 的 realpath（带缓存）。
 *
 * ⚠️ macOS 上 `os.tmpdir()` 给的 `/var/folders/...` 是指向 `/private/var/...`
 * 的软链，而 `resolveExisting/resolveTarget` 返回的一律是 **realpath**。
 * 拿 `path.relative('/var/...', '/private/var/...')` 去算相对路径会得到一串
 * `../../..` —— 于是列目录里每个条目的 `path` 都是一坨垃圾，而检测路径越界的
 * 代码看到的是「合法字符串」，谁都不会报错。所以两边必须先归一到 realpath。
 */
let filesRootCache: { root: string; real: string } | null = null

function filesRootRealPath(): string {
  const { sandbox } = getConfig()
  if (filesRootCache !== null && filesRootCache.root === sandbox.filesRoot) return filesRootCache.real
  let real = sandbox.filesRoot
  try {
    real = fs.realpathSync(sandbox.filesRoot)
  } catch {
    // 目录还没建：先用原值，下一次调用再纠正。
  }
  filesRootCache = { root: sandbox.filesRoot, real }
  return real
}

/** 沙箱内的绝对路径 → 相对 filesRoot 的 POSIX 串。 */
function filesRelative(absolute: string): string {
  const relative = path.relative(filesRootRealPath(), absolute)
  return relative === '' ? '' : relative.split(path.sep).join('/')
}

async function sandboxReady(): Promise<PathSandbox> {
  const { sandbox } = getConfig()
  // 首次启动（或数据卷刚挂上）时目录可能还不存在。每次都 ensure 一次很便宜，
  // 而「空目录列不出来 → 前端以为坏了」是更难查的那种问题。
  await sandbox.ensureRoots()
  return sandbox
}

/** 解析一个必须已存在的路径，并复核它没有借软链跑出 filesRoot。 */
async function resolveReadPath(input: unknown, options: { allowEmpty?: boolean } = {}): Promise<string> {
  const sandbox = await sandboxReady()
  const absolute = await sandbox.resolveExisting(rootSegments(input, options))
  if (!isInside(sandbox.filesRoot, absolute)) {
    throw new SandboxError('outside_root', '这个路径不在文件管理器的可见树里。', 403)
  }
  return absolute
}

/** 解析一个将要创建的路径（父目录可以是软链，但 realpath 后必须仍在 filesRoot 内）。 */
async function resolveWritePath(input: unknown): Promise<string> {
  const sandbox = await sandboxReady()
  const absolute = await sandbox.resolveWrite(rootSegments(input))
  if (!isInside(sandbox.filesRoot, absolute)) {
    throw new SandboxError('outside_root', '这个路径不在文件管理器的可见树里。', 403)
  }
  return absolute
}

async function statOrNull(absolute: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function kindOf(stats: fs.Stats): FileKind {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'other'
}

// ---------------------------------------------------------------------------
// 类型判定（mime / 可编辑）
// ---------------------------------------------------------------------------

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json',
  jsonc: 'application/json',
  json5: 'application/json',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  env: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'md', 'markdown', 'json', 'jsonc', 'json5', 'csv', 'tsv', 'yml', 'yaml',
  'toml', 'ini', 'conf', 'env', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'jsx', 'py', 'sh', 'sql', 'xml', 'svg', 'srt', 'vtt', 'gitignore', 'editorconfig',
])

/** 小写扩展名，不含点。`.bashrc` 与 `README` 都算没有扩展名。 */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function guessMime(name: string): string {
  return MIME_BY_EXTENSION[fileExtension(name)] ?? 'application/octet-stream'
}

function looksTextual(name: string, mime: string): boolean {
  if (TEXT_EXTENSIONS.has(fileExtension(name))) return true
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml'
}

/**
 * RFC 5987 的 `Content-Disposition`。
 *
 * 工作目录里中文文件名是常态，只给 `filename="..."` 会让浏览器存成乱码，
 * 所以必须带 `filename*=UTF-8''...`；同时保留一个 ASCII 回退给老客户端。
 *
 * ⚠️ CR/LF 先删掉：文件名来自 HTTP 查询串，带换行就是一个响应头注入。
 */
export function contentDisposition(name: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const safe = name.replace(/[\r\n]/g, '')
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ---------------------------------------------------------------------------
// FileEntry
// ---------------------------------------------------------------------------

async function buildEntry(absolute: string, display?: { name: string; path: string }): Promise<FileEntry> {
  const stats = await fsp.lstat(absolute)
  const kind = kindOf(stats)
  const name = display?.name ?? path.basename(absolute)
  const extension = kind === 'dir' || kind === 'other' ? '' : fileExtension(name)
  const mime = kind === 'dir' || kind === 'other' ? '' : guessMime(name)
  const entry: FileEntry = {
    name,
    path: display?.path ?? filesRelative(absolute),
    kind,
    // 目录的大小没有意义（不同文件系统上还不一样），symlink 的 size 是链接自身长度。
    size: kind === 'dir' ? 0 : stats.size,
    mtimeMs: stats.mtimeMs,
    extension,
    mime,
    editable: kind === 'file' && stats.size < EDITABLE_MAX_BYTES && looksTextual(name, mime),
  }
  if (kind === 'symlink') {
    try {
      entry.linkTarget = await fsp.readlink(absolute)
    } catch {
      entry.linkTarget = ''
    }
    entry.linkInside = await symlinkInside(absolute)
  }
  return entry
}

async function symlinkInside(absolute: string): Promise<boolean> {
  const { sandbox } = getConfig()
  try {
    const real = await fsp.realpath(absolute)
    // 按 filesRoot 判，不按 root：指向 <root>/scripts 的软链没出沙箱，
    // 但文件管理器点进去必然 403 —— 显示成「可点」是误导。
    return isInside(sandbox.filesRoot, real)
  } catch {
    // 断链或成环：都不是「在树内」。
    return false
  }
}

// ---------------------------------------------------------------------------
// 目录列表
// ---------------------------------------------------------------------------

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'variant' })

function compareEntries(a: FileEntry, b: FileEntry, sort: 'name' | 'size' | 'mtime'): number {
  // 大小/时间相同的条目按名字收尾：否则每次列目录的顺序都可能不同，
  // 前端的分页和「我刚上传的文件在哪」会变得不可预测。
  if (sort === 'size') return a.size - b.size || collator.compare(a.name, b.name)
  if (sort === 'mtime') return a.mtimeMs - b.mtimeMs || collator.compare(a.name, b.name)
  return collator.compare(a.name, b.name)
}

export async function listDirectory(input: {
  path?: string
  search?: string
  sort?: 'name' | 'size' | 'mtime'
  order?: 'asc' | 'desc'
}): Promise<{ path: string; parent: string | null; entries: FileEntry[] }> {
  const absolute = await resolveReadPath(input.path ?? '', { allowEmpty: true })
  const stats = await fsp.stat(absolute)
  if (!stats.isDirectory()) {
    throw new SandboxError('not_a_directory', '这个路径不是目录。', 400)
  }

  const entries: FileEntry[] = []
  for (const dirent of await fsp.readdir(absolute, { withFileTypes: true })) {
    try {
      entries.push(await buildEntry(path.join(absolute, dirent.name)))
    } catch (error) {
      // 列目录期间文件被删掉（脚本正在写同一棵树是常态）：跳过这一条，
      // 不能让整个目录变成打不开。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }

  const search = (input.search ?? '').trim().toLowerCase()
  const matched = search === '' ? entries : entries.filter((entry) => entry.name.toLowerCase().includes(search))

  const sort = input.sort === 'size' || input.sort === 'mtime' ? input.sort : 'name'
  const direction = input.order === 'desc' ? -1 : 1
  // 目录不单独提前：混排才能让「按大小/时间排序」的结果可预期。
  matched.sort((a, b) => direction * compareEntries(a, b, sort))

  const relative = filesRelative(absolute)
  const parent = relative === '' ? null : filesRelative(path.dirname(absolute))
  return { path: relative, parent, entries: matched }
}

// ---------------------------------------------------------------------------
// 读写文本
// ---------------------------------------------------------------------------

export async function readTextFile(input: {
  path: string
  maxBytes?: number
}): Promise<{ path: string; text: string; size: number; encoding: 'utf8'; truncated: boolean }> {
  const absolute = await resolveReadPath(input.path)
  const stats = await fsp.stat(absolute)
  if (!stats.isFile()) {
    throw new SandboxError('not_a_file', '只能读取普通文件。', 400)
  }
  const maxBytes = Math.max(1, Math.trunc(input.maxBytes ?? EDITABLE_MAX_BYTES))
  const length = Math.min(stats.size, maxBytes)
  const buffer = Buffer.alloc(length)
  const handle = await fsp.open(absolute, 'r')
  try {
    if (length > 0) await handle.read(buffer, 0, length, 0)
  } finally {
    await handle.close()
  }
  // 截断点可能正好落在一个 UTF-8 汉字中间，末尾会出现 U+FFFD。
  // 这比「按字符截断」多一步猜测，但 readTextFile 的承诺本来就是「给你前 N 字节」。
  return {
    path: filesRelative(absolute),
    text: buffer.toString('utf8'),
    size: stats.size,
    encoding: 'utf8',
    truncated: stats.size > maxBytes,
  }
}

/** 同目录 `.part` + rename。半成品绝不能以最终文件名被看见（上传与保存都走它）。 */
async function writeAtomic(absolute: string, data: Buffer | string): Promise<void> {
  const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${ulid()}.part`)
  try {
    await fsp.writeFile(temp, data, { flag: 'wx' })
    await fsp.rename(temp, absolute)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function writeTextFile(input: {
  path: string
  text: string
  createOnly?: boolean
}): Promise<FileEntry> {
  const sandbox = await sandboxReady()
  const absolute = await resolveWritePath(input.path)
  const buffer = Buffer.from(input.text, 'utf8')
  const existing = await statOrNull(absolute)
  if (existing?.isDirectory()) {
    throw new SandboxError('is_directory', '目标是目录，不能当文件写。', 400)
  }
  if (existing && input.createOnly) {
    throw new SandboxError('exists', '目标已存在，本次是「仅新建」。', 409)
  }
  // 只有净增量吃配额：把一个 3MiB 的日志改成 3MiB 的另一份不该因为
  // 「总量看起来变两倍」而被拒。`credit` 交给 QuotaMeter 处理这件事。
  const meter = new QuotaMeter(sandbox, existing?.size ?? 0)
  try {
    await meter.acceptTotal(buffer.length)
    await fsp.mkdir(path.dirname(absolute), { recursive: true })
    await writeAtomic(absolute, buffer)
    meter.commit()
    return await buildEntry(absolute)
  } finally {
    meter.abort()
  }
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

function toNodeReadable(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): Readable {
  if (typeof (stream as { getReader?: unknown }).getReader === 'function') {
    return Readable.fromWeb(stream as unknown as WebReadableStream<Uint8Array>)
  }
  return stream as Readable
}

/**
 * 裸流上传。
 *
 * 纪律（踩过的坑都在这里）：
 *
 * - 先写同目录的 `.<name>.<ulid>.part`，再 `rename` 就位。中途失败留下的
 *   半截文件如果不叫最终名字，用户最多看到一个可以删的碎片，而不是一个
 *   看起来正常、实际上截断的文件。
 * - **配额按实际写入量收口**，不信任 `content-length`：浏览器给的是估算，
 *   代理还会改写。`expectedBytes` 只用于「开始前快速拒绝」。
 * - 覆盖写时旧文件会在 rename 那一刻消失，所以计入配额的是净增量；
 *   否则「配额快满时覆盖同体积文件」会被误拒。净增量的算法收在 `QuotaMeter` 的
 *   `credit` 里 —— 这里和剪切板附件共用同一份实现，别再各写一遍。
 * - 预留量一律在 `finally` 里 `meter.abort()` 归还：任何异常路径漏掉它，
 *   配额就会被永久吃掉一块，症状是「磁盘明明有空间，上传却一直报配额满」。
 */
export async function upload(input: {
  path: string
  stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream
  expectedBytes?: number
  overwrite?: boolean
}): Promise<{ entry: FileEntry; bytes: number }> {
  const sandbox = await sandboxReady()
  const absolute = await resolveWritePath(input.path)
  const name = path.basename(absolute)
  const existing = await statOrNull(absolute)
  if (existing?.isDirectory()) {
    throw new SandboxError('is_directory', '目标是目录，不能被文件覆盖。', 400)
  }
  if (existing && !input.overwrite) {
    throw new SandboxError('exists', `目标已存在：${filesRelative(absolute)}。要覆盖请显式声明。`, 409)
  }
  await sandbox.assertRoomFor(Math.max(0, Math.trunc(input.expectedBytes ?? 0)))
  await fsp.mkdir(path.dirname(absolute), { recursive: true })

  const temp = path.join(path.dirname(absolute), `.${name}.${ulid()}.part`)
  // 覆盖上传时旧文件那部分空间本来就已经计入用量，不能重复算 —— `credit` 就是它。
  const meter = new QuotaMeter(sandbox, existing?.size ?? 0)
  let committed = false

  try {
    // 边写边预留：两个并发上传「各自看到还有空间」的竞态由 reserve 兜住。
    // 计量与判定顺序都收在 QuotaMeter 里，避免这里和剪切板附件各错一遍。
    // ⚠️ `quotaTransform()` 返回的是 transform **函数**，要放进 options，
    // 不能当 Transform 的构造参数传（那会报一个完全指不到重点的类型错误）。
    const counter = new Transform({ transform: quotaTransform(meter) })
    await pipeline(toNodeReadable(input.stream), counter, fs.createWriteStream(temp, { flags: 'wx' }))
    await fsp.rename(temp, absolute)
    committed = true
    meter.commit()
    return { entry: await buildEntry(absolute), bytes: meter.bytes }
  } finally {
    meter.abort()
    if (!committed) await fsp.rm(temp, { force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/**
 * 把一个沙箱内的文件包成流式 HTTP 响应。
 *
 * 三个头缺一不可：
 * - `Content-Length` 用 `stat` 的真实大小，不是 `Content-Length` 请求头那套估算；
 * - `Content-Disposition` 走 RFC 5987（中文文件名）；
 * - `X-Content-Type-Options: nosniff`：工作目录里的内容是用户自己的，但仍不该
 *   让浏览器「猜」类型 —— 猜成 text/html 的 .log 会以同源身份执行脚本。
 */
export function streamFileResponse(input: {
  absolutePath: string
  size: number
  name: string
  contentType: string
  disposition?: 'attachment' | 'inline'
}): Response {
  const disposition = input.disposition ?? 'attachment'
  const stream = fs.createReadStream(input.absolutePath)
  const headers = new Headers({
    'Content-Type': input.contentType,
    'Content-Length': String(input.size),
    'Content-Disposition': contentDisposition(input.name, disposition),
    'X-Content-Type-Options': 'nosniff',
  })
  if (disposition === 'inline') {
    // 内联预览只给图片/文本/PDF。CSP 收到「什么都别执行」：上传来的 SVG
    // 是能以同源身份跑脚本的，而预览请求带着会话 cookie。
    headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox")
  }
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers })
}

export async function readStream(input: { path: string }): Promise<{ absolutePath: string; entry: FileEntry }> {
  const absolute = await resolveReadPath(input.path)
  const stats = await fsp.stat(absolute)
  if (stats.isDirectory()) {
    throw new SandboxError('is_directory', '目录不能直接下载，请先打包。', 400)
  }
  // 名字用请求时那一段：`link.txt -> real.txt` 下载下来应该还叫 link.txt。
  // 字节仍然来自 realpath 的结果（沙箱已经确认它没跑出去）。
  const requested = parseRelativePath(input.path)
  const displayName = requested[requested.length - 1]
  return {
    absolutePath: absolute,
    entry: await buildEntry(absolute, { name: displayName, path: joinRelative(requested) }),
  }
}

// ---------------------------------------------------------------------------
// 目录 / 改名 / 移动 / 复制 / 删除
// ---------------------------------------------------------------------------

export async function createDirectory(input: { path: string }): Promise<FileEntry> {
  const absolute = await resolveWritePath(input.path)
  if (await statOrNull(absolute)) {
    throw new SandboxError('exists', '目标已存在。', 409)
  }
  // 递归建：`a/b/c` 一次建出来，比让前端连点三次强。
  await fsp.mkdir(absolute, { recursive: true })
  const sandbox = await sandboxReady()
  sandbox.invalidateMeasurement()
  return buildEntry(absolute)
}

export async function rename(input: { from: string; to: string }): Promise<FileEntry> {
  const source = await resolveReadPath(input.from)
  const target = await resolveWritePath(input.to)
  if (source === target) return buildEntry(source)
  if (await statOrNull(target)) {
    // 改名不覆盖：`fs.rename` 会静默把目标文件吃掉，而这个操作在 UI 上
    // 就叫「重命名」，用户没打算删东西。要覆盖请走 move + overwrite。
    throw new SandboxError('exists', '目标已存在，重命名不会覆盖已有文件。', 409)
  }
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.rename(source, target)
  const sandbox = await sandboxReady()
  sandbox.invalidateMeasurement()
  return buildEntry(target)
}

export async function move(input: { from: string; to: string; overwrite?: boolean }): Promise<FileEntry> {
  const sandbox = await sandboxReady()
  const source = await resolveReadPath(input.from)
  const target = await resolveWritePath(input.to)
  if (source === target) return buildEntry(source)
  if (isInside(source, target)) {
    throw new SandboxError('invalid_path', '不能把目录移动到它自己里面。', 400)
  }
  const existing = await statOrNull(target)
  if (existing) {
    if (!input.overwrite) {
      throw new SandboxError('exists', '目标已存在；要覆盖请显式声明 overwrite。', 409)
    }
    await deleteForOverwrite(target)
  }
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.rename(source, target)
  sandbox.invalidateMeasurement()
  return buildEntry(target)
}

export async function copy(input: { from: string; to: string; overwrite?: boolean }): Promise<FileEntry> {
  const sandbox = await sandboxReady()
  const source = await resolveReadPath(input.from)
  const target = await resolveWritePath(input.to)
  if (source === target) {
    throw new SandboxError('invalid_path', '源与目标是同一个路径。', 400)
  }
  if (isInside(source, target)) {
    throw new SandboxError('invalid_path', '不能把目录复制到它自己里面。', 400)
  }
  const sourceStats = await fsp.lstat(source)
  const existing = await statOrNull(target)
  if (existing && !input.overwrite) {
    throw new SandboxError('exists', '目标已存在；要覆盖请显式声明 overwrite。', 409)
  }
  if (existing) await deleteForOverwrite(target)

  const incoming = sourceStats.isDirectory()
    ? (await measureTree(source)).bytes
    : sourceStats.size
  const meter = new QuotaMeter(sandbox)
  try {
    await meter.acceptTotal(incoming)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.cp(source, target, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      verbatimSymlinks: true,
    })
    meter.commit()
    return await buildEntry(target)
  } finally {
    meter.abort()
  }
}

export async function remove(input: {
  paths: string[]
}): Promise<{ removed: Array<{ path: string; kind: FileKind; bytes: number }>; count: number }> {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new SandboxError('invalid_path', 'paths 不能是空数组。', 400)
  }
  const sandbox = await sandboxReady()

  // 第一遍：全部解析 + 递归统计。任何一条不合法都在**动刀之前**失败 ——
  // 「接口报错但文件已经少了一半」是最糟的结果。
  const plans: Array<{ absolute: string; path: string; kind: FileKind; files: number; bytes: number }> = []
  for (const raw of input.paths) {
    if (parseRelativePath(raw, { allowEmpty: true }).length === 0) {
      throw new SandboxError('invalid_path', '不能删除工作目录本身。请删它里面的条目。', 400)
    }
    const absolute = await resolveReadPath(raw)
    const stats = await fsp.lstat(absolute)
    const kind = kindOf(stats)
    if (kind === 'dir') {
      const measured = await measureTree(absolute)
      plans.push({ absolute, path: filesRelative(absolute), kind, files: measured.files, bytes: measured.bytes })
      continue
    }
    plans.push({ absolute, path: filesRelative(absolute), kind, files: 1, bytes: stats.size })
  }

  const count = plans.reduce((sum, plan) => sum + plan.files, 0)
  assertUnderDeleteLimit(count, '本次请求')
  for (const plan of plans) await deleteTree(plan.absolute)
  sandbox.invalidateMeasurement()
  return { removed: plans.map((plan) => ({ path: plan.path, kind: plan.kind, bytes: plan.bytes })), count }
}

export async function stats(): Promise<FileStats> {
  const sandbox = await sandboxReady()
  const measured = await sandbox.measure()
  const quotaBytes = sandbox.quotaBytes
  return {
    filesRoot: sandbox.filesRoot,
    bytes: measured.bytes,
    files: measured.files,
    dirs: measured.dirs,
    quotaBytes,
    // 用沙箱自己的口径：它会把并发上传已预留但还没落盘的字节算进去。
    remainingBytes: await sandbox.remainingBytes(),
    usedRatio: quotaBytes === null || quotaBytes <= 0 ? null : Math.min(1, measured.bytes / quotaBytes),
  }
}

// ---------------------------------------------------------------------------
// 删除门禁
// ---------------------------------------------------------------------------

function assertUnderDeleteLimit(files: number, label: string): void {
  if (files > MAX_DELETE_FILES) {
    throw new SandboxError(
      'too_many_files',
      `${label}要删除 ${files} 个文件，超过单次上限 ${MAX_DELETE_FILES}。请分批删除。`,
      400
    )
  }
}

/** 递归统计（软链只计一条，不跟随 —— 跟随会把树外体积算进配额，还会成环）。 */
async function measureTree(absolute: string): Promise<{ files: number; dirs: number; bytes: number }> {
  const measured = { files: 0, dirs: 0, bytes: 0 }
  const stack: string[] = [absolute]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const entryStats = await fsp.lstat(current)
    if (entryStats.isDirectory()) {
      measured.dirs += 1
      for (const dirent of await fsp.readdir(current, { withFileTypes: true })) {
        stack.push(path.join(current, dirent.name))
      }
      continue
    }
    measured.files += 1
    measured.bytes += entryStats.size
  }
  return measured
}

async function deleteTree(absolute: string): Promise<void> {
  const entryStats = await fsp.lstat(absolute)
  if (entryStats.isDirectory()) {
    await fsp.rm(absolute, { recursive: true, force: true })
    return
  }
  // force 让「统计之后被别的请求删掉了」不算失败。
  await fsp.rm(absolute, { force: true })
}

/**
 * 覆盖式移动/复制的第一步：清掉目标。
 *
 * 这里**照样过删除门禁**：一次「复制并覆盖」如果顺手抹掉三千个文件，
 * 和直接点删除没有区别，而用户并没有看到任何回执。
 */
async function deleteForOverwrite(target: string): Promise<void> {
  const targetStats = await fsp.lstat(target)
  if (targetStats.isDirectory()) {
    const measured = await measureTree(target)
    assertUnderDeleteLimit(measured.files, '覆盖目标')
  }
  await deleteTree(target)
}
