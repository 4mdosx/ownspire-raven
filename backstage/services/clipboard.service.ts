import fsp from 'node:fs/promises'
import path from 'node:path'
import fs from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { QuotaMeter } from '@/backstage/lib/quota'
import {
  dbClipboardByIdem,
  dbClipboardClear,
  dbClipboardCount,
  dbClipboardDelete,
  dbClipboardGet,
  dbClipboardInsert,
  dbClipboardList,
  dbClipboardPrune,
  type ClipboardRow,
} from '@/backstage/db/database'
import { getConfig } from '@/backstage/lib/config'
import { humanBytes } from '@/backstage/lib/format'
import { ulid } from '@/backstage/lib/ids'
import { isInside, SandboxError, type PathSandbox } from '@/backstage/lib/sandbox'

/**
 * 剪切板服务。
 *
 * 队列语义只有一条：**插入即入队**，队序是 `createdAt DESC, id DESC`（ULID 字典序 = 时间序）。
 * 所以：
 * - `updateText` 是纠错，**不动** `createdAt`，位置不变；
 * - 只有 `createText` / `createWithAttachments` 入队；
 * - 超长淘汰在插入成功之后做，被淘汰的 id 连同附件目录一起删，并且返回给调用方
 *   —— UI 要能说清「顺手清了 2 条」，否则用户只会发现东西少了。
 *
 * 落库顺序是刻意的：**先写附件文件，再插数据库**。反过来的话，进程在写文件时崩掉
 * 会留下一条「有记录但没有附件」的条目，前端点下载只能 404；而先写文件再插入，
 * 最坏结果是磁盘上多一个目录 —— 那个可以在插入失败时回滚，也至少不会骗人。
 */

export type ClipboardAttachment = { name: string; bytes: number }

export type ClipboardEntry = {
  id: string
  text: string
  bytes: number
  source: string
  createdAt: number
  attachments: ClipboardAttachment[]
  attachBytes: number
  /** 本条的队列位置，1 是最新的。 */
  position: number
}

/** 单条附件的总大小上限。 */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

/**
 * 被淘汰的记录 id 列表。
 *
 * ⚠️ 契约 §4 把这个字段写成 `number[]`，但 `clipboard_entries.id` 是 TEXT
 * （ULID，字典序 = 时间序），库里根本没有数字 id 可返回。所以这里是 `string[]`：
 * UI 要的是「清掉哪几条」，回到数字 id 只能靠再来一次查询反查，反而更容易错。
 */
export type EvictedIds = string[]

const MAX_ATTACHMENT_NAME_BYTES = 180

/**
 * 位置扫描上限。
 *
 * `position` 是派生值（队序里的下标），database.ts 没有「数一数比它新的有几条」
 * 这种助手，而在这里写裸 SQL 违反 db 层的约定。队列本身被 maxItems 限长
 * （默认 200），扫一页足够；真的超出时退化成扫描上限，位置只是个展示数字。
 */
const POSITION_SCAN_LIMIT = 500

const ENTRY_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * 单调递增的入队时间。
 *
 * 队序是 `createdAt DESC, id DESC`，而 id 是 ULID：**同一毫秒**内的两条，
 * 随机段的大小关系是随机的 —— 于是「连点两次粘贴」有 50% 概率显示成反序。
 * 这里保证后插入的 createdAt 严格更大（同一毫秒就 +1ms），代价是时间戳最多
 * 领先真实时钟几毫秒，对「第几条」的展示完全没有影响。
 */
let lastCreatedAt = 0

function nextCreatedAt(): number {
  const now = Date.now()
  lastCreatedAt = Math.max(now, lastCreatedAt + 1)
  return lastCreatedAt
}

// ---------------------------------------------------------------------------
// 行 ↔ 对外形状
// ---------------------------------------------------------------------------

function parseAttachments(raw: string): ClipboardAttachment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 手工改坏了库也不该让整页打不开。
    return []
  }
  if (!Array.isArray(parsed)) return []
  const attachments: ClipboardAttachment[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { name?: unknown; bytes?: unknown }
    if (typeof record.name !== 'string' || record.name === '') continue
    attachments.push({ name: record.name, bytes: typeof record.bytes === 'number' ? record.bytes : 0 })
  }
  return attachments
}

function rowToEntry(row: ClipboardRow, position: number): ClipboardEntry {
  return {
    id: row.id,
    text: row.text,
    bytes: row.bytes,
    source: row.source,
    createdAt: row.createdAt,
    attachments: parseAttachments(row.attachments),
    // ⚠️ 列名必须是 `attachBytes`（schema 与 ClipboardRow 同名）。db 层是
    // `SELECT *`，一旦两边名字不同（曾经的 `attach_bytes`），类型检查完全
    // 看不见，只有真跑一次插入/读取才会暴露 —— 那时剪切板是 100% 不可用。
    attachBytes: row.attachBytes,
    position,
  }
}

async function entryWithPosition(row: ClipboardRow): Promise<ClipboardEntry> {
  const scan = Math.min(POSITION_SCAN_LIMIT, Math.max(1, await dbClipboardCount()))
  const rows = await dbClipboardList(scan, 0)
  const index = rows.findIndex((item) => item.id === row.id)
  return rowToEntry(row, index === -1 ? scan : index + 1)
}

// ---------------------------------------------------------------------------
// 附件名与目录
// ---------------------------------------------------------------------------

function truncateToBytes(name: string, maxBytes: number): string {
  const extension = path.extname(name)
  const keepExtension = Buffer.byteLength(extension) <= 32 ? extension : ''
  const stem = keepExtension === '' ? name : name.slice(0, name.length - keepExtension.length)
  const budget = Math.max(1, maxBytes - Buffer.byteLength(keepExtension))
  let out = ''
  // 按码点遍历：`for..of` 会把代理对当一个字符，不会把一个 emoji 劈成两半。
  for (const char of stem) {
    if (Buffer.byteLength(out) + Buffer.byteLength(char) > budget) break
    out += char
  }
  return `${out}${keepExtension}`
}

/**
 * 附件名消毒：只留一个安全的 basename。
 *
 * HTTP 过来的名字可能是 `../../etc/passwd`、`C:\x\y.txt`、`a\nb` —— 这些既不能
 * 当路径用，也不能直接写进响应头。消毒规则：取最后一段 → 去控制字符 → 去 `..`
 * → 去首尾空白与点 → 空则用 `attachment-N`。
 */
export function sanitizeAttachmentName(raw: unknown, index = 0): string {
  const source = typeof raw === 'string' ? raw : ''
  const tail = source.replace(/\\/g, '/').split('/').pop() ?? ''
  let name = tail
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.\./g, '')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
  if (name === '') name = `attachment-${index + 1}`
  if (Buffer.byteLength(name) > MAX_ATTACHMENT_NAME_BYTES) name = truncateToBytes(name, MAX_ATTACHMENT_NAME_BYTES)
  return name === '' ? `attachment-${index + 1}` : name
}

/** 同一批附件重名时补 `-2` / `-3`，否则后一个会静默覆盖前一个。 */
function uniqueAttachmentNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((name) => {
    let candidate = name
    let counter = 2
    while (seen.has(candidate)) {
      const extension = path.extname(name)
      const stem = extension === '' ? name : name.slice(0, name.length - extension.length)
      candidate = `${stem}-${counter}${extension}`
      counter += 1
    }
    seen.add(candidate)
    return candidate
  })
}

function assertEntryId(id: unknown): string {
  if (typeof id !== 'string' || !ENTRY_ID_PATTERN.test(id)) {
    throw new SandboxError('invalid_path', '剪切板记录 id 不合法。', 400)
  }
  return id
}

function entryDir(sandbox: PathSandbox, id: string): string {
  const dir = path.join(sandbox.clipboardRoot, assertEntryId(id))
  if (!isInside(sandbox.clipboardRoot, dir)) {
    throw new SandboxError('outside_root', '附件目录越过了剪切板根目录。', 403)
  }
  return dir
}

async function deleteAttachmentDirs(sandbox: PathSandbox, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await fsp.rm(entryDir(sandbox, id), { recursive: true, force: true })
    } catch (error) {
      // 淘汰是「顺手清理」，删不掉目录不该让这次粘贴失败。
      console.error('[raven] 清理剪切板附件目录失败：', id, error)
    }
  }
}

function toNodeReadable(stream: ReadableStream<Uint8Array>): Readable {
  // 与 file.service 同款实现。两处都只有几行，不值得为它造一个共享模块。
  return Readable.fromWeb(stream as unknown as WebReadableStream<Uint8Array>)
}

/**
 * 落一条附件。
 *
 * ⚠️ 两个上限是**两件事**，都要判：
 * - `budgetLeft`：单条粘贴的附件总量上限（`MAX_ATTACHMENT_BYTES`），是产品约束；
 * - `meter`：受管根的总配额，是磁盘约束。
 * 只判前者会让配额被附件绕过；只判后者会在配额无限时允许一条吃掉整个磁盘。
 *
 * 判定顺序也有意义：先判单条上限（同步、便宜），再向沙箱要配额（异步、要量目录）。
 */
async function writeAttachment(
  filePath: string,
  stream: ReadableStream<Uint8Array>,
  budgetLeft: number,
  meter: QuotaMeter
): Promise<number> {
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length
      if (written > budgetLeft) {
        callback(
          new SandboxError(
            'attachments_too_large',
            `附件总大小超过 ${humanBytes(MAX_ATTACHMENT_BYTES)} 上限，已拒绝本次粘贴。`,
            413
          )
        )
        return
      }
      // 按块要配额：`acceptChunk` 是异步的，必须 await 之后再放行这一块。
      meter.acceptChunk(chunk.length).then(
        () => callback(null, chunk),
        (error: Error) => callback(error)
      )
    },
  })
  await pipeline(toNodeReadable(stream), counter, fs.createWriteStream(filePath, { flags: 'wx' }))
  return written
}

// ---------------------------------------------------------------------------
// 入队
// ---------------------------------------------------------------------------

function validateText(text: string, maxTextBytes: number): number {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxTextBytes) {
    // 拒绝而不是截断：截断是静默数据损坏，用户拿到的会是半句话。
    throw new SandboxError(
      'text_too_large',
      `文本 ${humanBytes(bytes)} 超过上限 ${humanBytes(maxTextBytes)}，已拒绝（不做截断）。`,
      413
    )
  }
  return bytes
}

export async function createText(input: {
  text: string
  source?: string
  idemKey?: string
}): Promise<{ entry: ClipboardEntry; evicted: EvictedIds }> {
  const { config, sandbox } = getConfig()
  await sandbox.ensureRoots()
  const text = typeof input.text === 'string' ? input.text : ''
  if (text === '') {
    throw new SandboxError('empty_text', '文本是空的，没有可粘贴的内容。', 400)
  }
  const bytes = validateText(text, config.clipboard.maxTextBytes)

  const idemKey = typeof input.idemKey === 'string' && input.idemKey !== '' ? input.idemKey : null
  if (idemKey !== null) {
    const existing = await dbClipboardByIdem(idemKey)
    // 网络抖动导致的重发不该产生第二条；顺序也不该动（位置保持原样）。
    if (existing) return { entry: await entryWithPosition(existing), evicted: [] }
  }

  const row: ClipboardRow = {
    id: ulid(),
    text,
    bytes,
    source: typeof input.source === 'string' && input.source !== '' ? input.source : 'web',
    attachments: '[]',
    attachBytes: 0,
    idemKey,
    createdAt: nextCreatedAt(),
  }
  await dbClipboardInsert(row)
  const evicted = (await dbClipboardPrune(config.clipboard.maxItems)).map((item) => item.id)
  await deleteAttachmentDirs(sandbox, evicted)
  return { entry: await entryWithPosition(row), evicted }
}

export async function createWithAttachments(input: {
  text: string
  source?: string
  attachments: Array<{ name: string; stream: ReadableStream<Uint8Array> }>
}): Promise<{ entry: ClipboardEntry; evicted: EvictedIds }> {
  const { config, sandbox } = getConfig()
  await sandbox.ensureRoots()
  const text = typeof input.text === 'string' ? input.text : ''
  const bytes = validateText(text, config.clipboard.maxTextBytes)

  const incoming = Array.isArray(input.attachments) ? input.attachments : []
  if (incoming.length === 0) {
    if (text === '') {
      throw new SandboxError('empty_entry', '既没有文本也没有附件，没有什么可粘贴的。', 400)
    }
    return createText({ text, source: input.source })
  }

  const id = ulid()
  const dir = entryDir(sandbox, id)
  const names = uniqueAttachmentNames(incoming.map((item, index) => sanitizeAttachmentName(item.name, index)))
  const written: ClipboardAttachment[] = []
  let stored = false
  // 附件也吃配额（统计口径是整个受管根，`clipboard/` 就在里面）。
  // 计量走共享的 QuotaMeter：按块实时预留，`abort()` 在 finally 里无条件归还。
  const meter = new QuotaMeter(sandbox)

  try {
    await fsp.mkdir(dir, { recursive: true })
    let total = 0
    for (let index = 0; index < incoming.length; index += 1) {
      const filePath = path.join(dir, names[index])
      if (!isInside(dir, filePath)) {
        throw new SandboxError('outside_root', '附件路径越过了这一条的目录。', 403)
      }
      const size = await writeAttachment(filePath, incoming[index].stream, MAX_ATTACHMENT_BYTES - total, meter)
      total += size
      written.push({ name: names[index], bytes: size })
    }
    meter.commit()

    const row: ClipboardRow = {
      id,
      text,
      bytes,
      source: typeof input.source === 'string' && input.source !== '' ? input.source : 'web',
      attachments: JSON.stringify(written),
      attachBytes: total,
      idemKey: null,
      createdAt: nextCreatedAt(),
    }
    await dbClipboardInsert(row)
    stored = true

    const evicted = (await dbClipboardPrune(config.clipboard.maxItems)).map((item) => item.id)
    await deleteAttachmentDirs(sandbox, evicted)
    return { entry: await entryWithPosition(row), evicted }
  } catch (error) {
    // 落库失败或有附件写到一半：把这一条的目录整个删掉。
    // 库里没有的记录在磁盘上留附件 = 永远不会被清理、也永远打不开的孤儿。
    if (!stored) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  } finally {
    // 无条件归还：成功路径上 `commit()` 已经还过了，这里是幂等的（second call 是 no-op）。
    meter.abort()
  }
}

// ---------------------------------------------------------------------------
// 查询 / 纠错 / 删除
// ---------------------------------------------------------------------------

export async function list(input: {
  limit?: number
  offset?: number
  query?: string
}): Promise<{ entries: ClipboardEntry[]; total: number; maxItems: number }> {
  const { config } = getConfig()
  const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 50)))
  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const query = typeof input.query === 'string' && input.query.trim() !== '' ? input.query.trim() : undefined
  const rows = await dbClipboardList(limit, offset, query)
  const entries = rows.map((row, index) => rowToEntry(row, offset + index + 1))
  // total 是**队列总长**，不是过滤命中数：database.ts 没有带查询的计数助手，
  // 而位置/分页要用的是队列尺度。过滤结果的条数看 entries.length。
  return { entries, total: await dbClipboardCount(), maxItems: config.clipboard.maxItems }
}

export async function get(id: string): Promise<ClipboardEntry> {
  const row = await dbClipboardGet(assertEntryId(id))
  if (!row) throw new SandboxError('not_found', '剪切板里没有这一条。', 404)
  return entryWithPosition(row)
}

export async function updateText(id: string, text: string): Promise<ClipboardEntry> {
  const { config } = getConfig()
  const existing = await dbClipboardGet(assertEntryId(id))
  if (!existing) throw new SandboxError('not_found', '剪切板里没有这一条。', 404)
  const value = typeof text === 'string' ? text : ''
  if (value === '') {
    throw new SandboxError('empty_text', '文本不能改成空。要删除请调 DELETE。', 400)
  }
  const bytes = validateText(value, config.clipboard.maxTextBytes)

  // ⚠️ database.ts 没有「改文本」的助手，而服务层不许写裸 SQL。所以走
  // delete + insert，并**保留 id 与 createdAt**：队序由 (createdAt DESC, id DESC)
  // 决定，两者不变位置就不变 —— 纠错不该把这一条顶到队首。
  // insert 失败时把原行写回去，尽力不留下空洞（单用户场景下这一步几乎不会失败）。
  const next: ClipboardRow = { ...existing, text: value, bytes }
  await dbClipboardDelete(existing.id)
  try {
    await dbClipboardInsert(next)
  } catch (error) {
    try {
      await dbClipboardInsert(existing)
    } catch (restoreError) {
      console.error('[raven] 剪切板纠错回滚失败：', restoreError)
    }
    throw error
  }
  return entryWithPosition(next)
}

export async function remove(id: string): Promise<{ removed: boolean }> {
  const { sandbox } = getConfig()
  await sandbox.ensureRoots()
  const entryId = assertEntryId(id)
  const removed = await dbClipboardDelete(entryId)
  // 即使库里没有这一条也扫一次目录：历史崩溃可能留下孤儿附件目录。
  await deleteAttachmentDirs(sandbox, [entryId])
  return { removed }
}

export async function clear(): Promise<{ removed: number }> {
  const { sandbox } = getConfig()
  await sandbox.ensureRoots()
  const removed = await dbClipboardClear()
  // 库清空之后 id 已经没地方查了。剪切板根目录下**只有** `<entryId>/` 一层，
  // 所以直接扫一层删干净，顺手把历史遗留的孤儿目录也收掉。
  let children: string[] = []
  try {
    children = await fsp.readdir(sandbox.clipboardRoot)
  } catch {
    children = []
  }
  for (const child of children) {
    const target = path.join(sandbox.clipboardRoot, child)
    if (!isInside(sandbox.clipboardRoot, target)) continue
    try {
      await fsp.rm(target, { recursive: true, force: true })
    } catch (error) {
      console.error('[raven] 清理剪切板目录失败：', target, error)
    }
  }
  return { removed }
}

/**
 * 附件下载路径。
 *
 * 三重校验，缺一不可：
 * 1. id 必须是 ULID 形状（`..` 之类在第一步就死了）；
 * 2. 名字必须**原样**等于消毒结果，并且在数据库登记的附件清单里 ——
 *    只消毒不比对的话，`../x` 消毒成 `x` 之后会静默指向同目录的另一个文件；
 * 3. 最后仍走 `resolveExisting`（realpath）并复核还在 clipboardRoot 内，
 *    挡住「附件目录里被人放了软链」这种情况。
 */
export async function clipboardAttachmentPath(entryId: string, name: string): Promise<string> {
  const { sandbox } = getConfig()
  await sandbox.ensureRoots()
  const id = assertEntryId(entryId)
  const row = await dbClipboardGet(id)
  if (!row) throw new SandboxError('not_found', '剪切板里没有这一条。', 404)

  const requested = sanitizeAttachmentName(name, 0)
  if (name !== requested) {
    // 「消毒之后就放行」是不够的：`../x` 会静默变成 `x`，用户以为自己拿到的是
    // 另一个文件。清单比对已经能挡住大部分情况，这里再要求名字原样合法。
    throw new SandboxError('invalid_path', '附件名只能是单个文件名，不能带路径分隔符或控制字符。', 400)
  }
  const listed = parseAttachments(row.attachments).find((item) => item.name === requested)
  if (!listed) throw new SandboxError('not_found', '这一条没有这个附件。', 404)

  const dir = entryDir(sandbox, id)
  const candidate = path.join(dir, requested)
  if (!isInside(dir, candidate)) {
    throw new SandboxError('outside_root', '附件路径越过了这一条的目录。', 403)
  }
  const segments = path.relative(sandbox.root, candidate).split(path.sep).filter((segment) => segment !== '')
  const absolute = await sandbox.resolveExisting(segments)
  if (!isInside(sandbox.clipboardRoot, absolute)) {
    throw new SandboxError('outside_root', '附件指向了剪切板目录之外。', 403)
  }
  return absolute
}
