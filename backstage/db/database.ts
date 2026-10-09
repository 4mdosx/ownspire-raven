import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDbFile } from '@/config/env'
import { LEGACY_TABLES, SCHEMA_SQL } from './schema'

/**
 * SQLite 连接与结构初始化。
 *
 * 与 creative-atlas 的三条约定保持一致，理由都在那边踩过：
 * - **惰性打开、可重开**：不在 import 时建连接，这样验证脚本可以「先设 RAVEN_DB_FILE
 *   再首次打开」。所以这里是 getter，不是模块级常量。
 * - `busy_timeout = 5000`：默认 0ms 意味着撞到锁立刻报错，dev server 和验证脚本
 *   同时开着就会随机失败。
 * - `journal_mode = WAL` + `synchronous = NORMAL`：读不挡写，省掉每次事务的 fsync。
 *   ⚠️ 别用「删 -journal 文件」修 disk I/O error —— 那会绕过回滚。
 */

const dbPath = resolveDbFile()

let connection: DatabaseSync | null = null

export function dbFile(): string {
  return dbPath
}

export function sqlite(): DatabaseSync {
  if (connection) return connection
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const opened = new DatabaseSync(dbPath)
  for (const pragma of ['PRAGMA busy_timeout = 5000', 'PRAGMA journal_mode = WAL', 'PRAGMA synchronous = NORMAL']) {
    opened.exec(pragma)
  }
  connection = opened
  return connection
}

export function closeDatabase(): void {
  if (!connection) return
  try {
    connection.close()
  } catch {
    // 已经关了就算了。
  }
  connection = null
  schemaReady = false
}

let schemaReady = false

/** 只创建当前结构；撞到已知旧表直接抛错，不自动搬数据。 */
export function ensureSchema(): void {
  if (schemaReady) return
  const database = sqlite()
  for (const [table, reason] of Object.entries(LEGACY_TABLES)) {
    const found = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { name?: string } | undefined
    if (found?.name) {
      throw new Error(`检测到旧版表 ${table}：${reason} 请先执行显式迁移，数据库未被修改。`)
    }
  }
  database.exec(SCHEMA_SQL)
  schemaReady = true
}

/** /healthz 用：能不能真的查到东西。 */
export function pingDatabase(): void {
  ensureSchema()
  sqlite().prepare('SELECT 1 AS ok').get()
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

export function run(sql: string, params: Record<string, unknown> = {}): void {
  ensureSchema()
  const statement = sqlite().prepare(sql)
  if (Object.keys(params).length === 0) statement.run()
  else statement.run(params as never)
}

export function all<T>(sql: string, params: Record<string, unknown> = {}): T[] {
  ensureSchema()
  const statement = sqlite().prepare(sql)
  return (Object.keys(params).length === 0 ? statement.all() : statement.all(params as never)) as T[]
}

export function get<T>(sql: string, params: Record<string, unknown> = {}): T | undefined {
  ensureSchema()
  const statement = sqlite().prepare(sql)
  return (Object.keys(params).length === 0 ? statement.get() : statement.get(params as never)) as T | undefined
}

// ---------------------------------------------------------------------------
// 剪切板
// ---------------------------------------------------------------------------

export type ClipboardRow = {
  id: string
  text: string
  bytes: number
  source: string
  attachments: string
  attachBytes: number
  idemKey: string | null
  createdAt: number
}

export function dbClipboardList(limit: number, offset = 0, query?: string): ClipboardRow[] {
  if (query && query.trim() !== '') {
    return all<ClipboardRow>(
      `SELECT * FROM clipboard_entries
        WHERE text LIKE :like ESCAPE '\\'
        ORDER BY createdAt DESC, id DESC LIMIT :limit OFFSET :offset`,
      { like: `%${escapeLike(query.trim())}%`, limit, offset }
    )
  }
  return all<ClipboardRow>(
    'SELECT * FROM clipboard_entries ORDER BY createdAt DESC, id DESC LIMIT :limit OFFSET :offset',
    { limit, offset }
  )
}

export function dbClipboardCount(): number {
  const row = get<{ count: number }>('SELECT COUNT(*) AS count FROM clipboard_entries')
  return row?.count ?? 0
}

export function dbClipboardGet(id: string): ClipboardRow | undefined {
  return get<ClipboardRow>('SELECT * FROM clipboard_entries WHERE id = :id', { id })
}

export function dbClipboardByIdem(idemKey: string): ClipboardRow | undefined {
  return get<ClipboardRow>('SELECT * FROM clipboard_entries WHERE idemKey = :idemKey', { idemKey })
}

export function dbClipboardInsert(row: ClipboardRow): void {
  run(
    `INSERT INTO clipboard_entries (id, text, bytes, source, attachments, attachBytes, idemKey, createdAt)
     VALUES (:id, :text, :bytes, :source, :attachments, :attachBytes, :idemKey, :createdAt)`,
    { ...row }
  )
}

export function dbClipboardDelete(id: string): boolean {
  ensureSchema()
  const statement = sqlite().prepare('DELETE FROM clipboard_entries WHERE id = :id')
  const result = statement.run({ id })
  return Number(result.changes) > 0
}

export function dbClipboardClear(): number {
  ensureSchema()
  const statement = sqlite().prepare('DELETE FROM clipboard_entries')
  const result = statement.run()
  return Number(result.changes)
}

/** 超出长度的部分按时间从旧到新删掉，返回被删的行（调用方负责删附件）。 */
export function dbClipboardPrune(keep: number): ClipboardRow[] {
  ensureSchema()
  const doomed = all<ClipboardRow>(
    `SELECT * FROM clipboard_entries
      WHERE id NOT IN (
        SELECT id FROM clipboard_entries ORDER BY createdAt DESC, id DESC LIMIT :keep
      )
      ORDER BY createdAt ASC, id ASC`,
    { keep }
  )
  for (const row of doomed) dbClipboardDelete(row.id)
  return doomed
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

// ---------------------------------------------------------------------------
// 服务快照 / 健康样本 / 指标
// ---------------------------------------------------------------------------

export type ServiceSnapshotRow = {
  serviceId: string
  status: string
  latencyMs: number | null
  message: string
  version: string
  source: string
  details: string
  checkedAt: number
  okCount: number
  totalCount: number
}

export function dbSnapshotAll(): ServiceSnapshotRow[] {
  return all<ServiceSnapshotRow>('SELECT * FROM service_snapshots')
}

export function dbSnapshotPut(row: ServiceSnapshotRow): void {
  run(
    `INSERT INTO service_snapshots (serviceId, status, latencyMs, message, version, source, details, checkedAt, okCount, totalCount)
     VALUES (:serviceId, :status, :latencyMs, :message, :version, :source, :details, :checkedAt, :okCount, :totalCount)
     ON CONFLICT(serviceId) DO UPDATE SET
       status = excluded.status,
       latencyMs = excluded.latencyMs,
       message = excluded.message,
       version = excluded.version,
       source = excluded.source,
       details = excluded.details,
       checkedAt = excluded.checkedAt,
       okCount = excluded.okCount,
       totalCount = excluded.totalCount`,
    { ...row }
  )
}

export function dbSnapshotDelete(serviceId: string): void {
  run('DELETE FROM service_snapshots WHERE serviceId = :serviceId', { serviceId })
}

export function dbSampleInsert(row: {
  serviceId: string
  status: string
  latencyMs: number | null
  message: string
  checkedAt: number
}): void {
  run(
    `INSERT INTO service_samples (serviceId, status, latencyMs, message, checkedAt)
     VALUES (:serviceId, :status, :latencyMs, :message, :checkedAt)`,
    { ...row }
  )
}

export function dbSampleHistory(serviceId: string, limit: number): Array<{
  status: string
  latencyMs: number | null
  message: string
  checkedAt: number
}> {
  return all(
    `SELECT status, latencyMs, message, checkedAt FROM service_samples
      WHERE serviceId = :serviceId ORDER BY checkedAt DESC LIMIT :limit`,
    { serviceId, limit }
  )
}

/** 每个服务只留最新 N 条。 */
export function dbSamplePrune(keep: number): number {
  ensureSchema()
  const result = sqlite()
    .prepare(
      `DELETE FROM service_samples
        WHERE id NOT IN (
          SELECT id FROM service_samples AS inner_samples
           WHERE inner_samples.serviceId = service_samples.serviceId
           ORDER BY checkedAt DESC LIMIT :keep
        )`
    )
    .run({ keep })
  return Number(result.changes)
}

export function dbMetricInsert(rows: Array<{
  serviceId: string
  metric: string
  value: number
  unit: string
  at: number
}>): void {
  ensureSchema()
  const statement = sqlite().prepare(
    `INSERT INTO service_metrics (serviceId, metric, value, unit, at)
     VALUES (:serviceId, :metric, :value, :unit, :at)`
  )
  for (const row of rows) statement.run(row as never)
}

export function dbMetricLatest(serviceId: string): Array<{
  metric: string
  value: number
  unit: string
  at: number
}> {
  return all(
    `SELECT metric, value, unit, MAX(at) AS at FROM service_metrics
      WHERE serviceId = :serviceId GROUP BY metric ORDER BY metric`,
    { serviceId }
  )
}

export function dbMetricSeries(serviceId: string, metric: string, limit: number): Array<{
  value: number
  unit: string
  at: number
}> {
  return all(
    `SELECT value, unit, at FROM service_metrics
      WHERE serviceId = :serviceId AND metric = :metric ORDER BY at DESC LIMIT :limit`,
    { serviceId, metric, limit }
  )
}

export function dbMetricPrune(keep: number): number {
  ensureSchema()
  const result = sqlite()
    .prepare(
      `DELETE FROM service_metrics
        WHERE id NOT IN (
          SELECT id FROM service_metrics AS inner_metrics
           WHERE inner_metrics.serviceId = service_metrics.serviceId
             AND inner_metrics.metric = service_metrics.metric
           ORDER BY at DESC LIMIT :keep
        )`
    )
    .run({ keep })
  return Number(result.changes)
}

// ---------------------------------------------------------------------------
// 脚本运行记录
// ---------------------------------------------------------------------------

export type RunRow = {
  id: number
  script: string
  origin: string
  status: string
  exitCode: number | null
  startedAt: number
  endedAt: number
  durationMs: number
  stdout: string
  stderr: string
  truncated: number
  signal: string
  triggeredBy: string
  metricCalls: number
}

export function dbRunInsert(row: {
  script: string
  origin: string
  status: string
  startedAt: number
  triggeredBy: string
}): number {
  ensureSchema()
  const statement = sqlite().prepare(
    `INSERT INTO run_records (script, origin, status, startedAt, endedAt, durationMs, triggeredBy)
     VALUES (:script, :origin, :status, :startedAt, :startedAt, 0, :triggeredBy)`
  )
  const result = statement.run({ ...row })
  return Number(result.lastInsertRowid)
}

export function dbRunFinish(
  id: number,
  patch: {
    status: string
    exitCode: number | null
    endedAt: number
    durationMs: number
    stdout: string
    stderr: string
    truncated: number
    signal: string
  }
): void {
  run(
    `UPDATE run_records SET status = :status, exitCode = :exitCode, endedAt = :endedAt,
       durationMs = :durationMs, stdout = :stdout, stderr = :stderr, truncated = :truncated, signal = :signal
     WHERE id = :id`,
    { ...patch, id }
  )
}

export function dbRunGet(id: number): RunRow | undefined {
  return get<RunRow>('SELECT * FROM run_records WHERE id = :id', { id })
}

/**
 * 记一笔「这次运行回推了 n 条指标」。
 *
 * ⚠️ 单独一个 helper 而不是塞进 `dbRunFinish` 的 patch：指标是在**运行过程中**
 * 推回来的，而 `dbRunFinish` 发生在进程退出之后 —— 中间那段时间里
 * `metricCalls` 会一直是 0，界面上看起来就像「脚本说它推了，其实没推」。
 * 增量更新（`+ :n`）而不是赋值，是因为一个脚本可能分多批推。
 */
export function dbRunMetricCalls(id: number, n = 1): void {
  run('UPDATE run_records SET metricCalls = metricCalls + :n WHERE id = :id', { id, n })
}

export function dbRunList(limit: number, script?: string): RunRow[] {
  if (script) {
    return all<RunRow>(
      'SELECT * FROM run_records WHERE script = :script ORDER BY startedAt DESC LIMIT :limit',
      { script, limit }
    )
  }
  return all<RunRow>('SELECT * FROM run_records ORDER BY startedAt DESC LIMIT :limit', { limit })
}

export function dbRunPrune(keep: number): number {
  ensureSchema()
  const result = sqlite()
    .prepare(
      `DELETE FROM run_records WHERE id NOT IN (
         SELECT id FROM run_records ORDER BY startedAt DESC LIMIT :keep
       )`
    )
    .run({ keep })
  return Number(result.changes)
}
