import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import { and, desc, eq, sql } from 'drizzle-orm'
import { resolveDbFile } from '@/config/env'
import {
  clipboardEntries,
  LEGACY_TABLES,
  runRecords,
  serviceMetrics,
  serviceSamples,
  serviceSnapshots,
  settings,
} from './schema'

/**
 * SQLite 连接、结构初始化与查询层。
 *
 * 与 creative-atlas / shrine / navi 的四条约定保持一致，理由都在那边踩过：
 * - **惰性打开、可重开**：不在 import 时建连接，这样验证脚本可以「先设
 *   RAVEN_DB_FILE 再首次打开」。所以这里是 getter，不是模块级常量。
 * - `busy_timeout = 5000`：默认 0ms 意味着撞到锁立刻报错，dev server 和验证脚本
 *   同时开着就会随机失败。
 * - `journal_mode = WAL` + `synchronous = NORMAL`：读不挡写，省掉每次事务的 fsync。
 *   ⚠️ 别用「删 -journal 文件」修 disk I/O error —— 那会绕过回滚。
 * - **结构由 drizzle 迁移建立**：`schema.ts` 是唯一真相，这里不再有第二份
 *   `CREATE TABLE`。
 */

export type AppDatabase = NodeSQLiteDatabase

/**
 * ⚠️ **路径必须在**调用时**解析，不能在模块顶层算好。**
 *
 * 原来这里是 `const dbPath = resolveDbFile()`。而脚本的文件结构是「顶部写
 * `process.env.RAVEN_DB_FILE = ...`，下面 import service」—— ESM 的 import
 * 会**先于**任何语句执行（tsx 转 CJS 时也一样，require 被提到模块顶部），于是
 * 本模块在赋值发生**之前**就把路径定死了，脚本一直跑在**生产库**上：建测试数据、
 * 清库、收尾全发生在真库里，而日志看起来完全正常（shrine 就是这样，2026-10-10
 * 发现时库里躺着 11 条测试素材）。「验证污染生产」比验证失败危险得多。
 */
let connection: DatabaseSync | null = null
let schemaReady = false

// ⚠️ 这两个声明必须在 `closeDatabase` **之前** —— 它在函数体里引用了它们。
// `const` / `let` 有 TDZ：只要声明位置在调用点之后，早期调用就是 ReferenceError，
// 而报错信息完全指不到「声明顺序」这件事。
const globalForDb = globalThis as unknown as { db: AppDatabase | undefined }

export function dbFile(): string {
  return resolveDbFile()
}

export function sqlite(): DatabaseSync {
  if (connection) return connection
  fs.mkdirSync(path.dirname(dbFile()), { recursive: true })
  const opened = new DatabaseSync(dbFile())
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
  globalForDb.db = undefined
  // ⚠️ 必须置零 —— 否则重开后 ensureSchema 会因为「本进程建过表」直接 return，
  // 跳过所有迁移。新连接面对的是同一个文件，理应重新确认一次结构。
  schemaReady = false
}

/**
 * 迁移文件的位置。
 *
 * ⚠️ 这是**运行时**读的目录，不是构建期打包进 bundle 的资源 —— 容器镜像里
 * 必须把 `drizzle/` 一起 COPY 进去（Dockerfile 里有这一行，别删）。
 */
function migrationsFolder(): string {
  return path.join(process.cwd(), 'drizzle')
}

function db(): AppDatabase {
  if (!globalForDb.db) globalForDb.db = drizzle({ client: sqlite() })
  return globalForDb.db
}

/** 取到已迁移好的 drizzle 实例。service 层要写自己的查询时用这个。 */
export async function getDatabase(): Promise<AppDatabase> {
  await ensureSchema()
  return db()
}

/**
 * ⭐ 结构由 drizzle 迁移建立（`drizzle-kit generate` 产出，`schema.ts` 是唯一真相）。
 *
 * ⚠️ **这里不再有第二份手写 `CREATE TABLE`。** 之前是「手写 SQL 建表 + service 里
 * 裸 SQL 查询」两处各写一遍结构；现在唯一一份是 schema.ts，运行时自动跑到最新。
 *
 * ⚠️ 旧结构检测保留：迁移系统之外的旧库必须先做显式、可验证的迁移，
 * 运行时不做兼容搬运。
 */
function assertNotLegacySchema(): void {
  for (const [table, reason] of Object.entries(LEGACY_TABLES)) {
    const found = sqlite()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { name?: string } | undefined
    if (found?.name) {
      throw new Error(`检测到旧版表 ${table}：${reason} 请先执行显式迁移，数据库未被修改。`)
    }
  }
}

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return
  assertNotLegacySchema()
  migrate(db(), { migrationsFolder: migrationsFolder() })
  schemaReady = true
}

/** /healthz 与 verify 用：能不能真的查到东西。 */
export async function pingDatabase(): Promise<void> {
  await ensureSchema()
  sqlite().prepare('SELECT 1 AS ok').get()
}

// ---------------------------------------------------------------------------
// 行类型：从 schema 推导，不再手写第二份
// ---------------------------------------------------------------------------

export type ClipboardRow = typeof clipboardEntries.$inferSelect
export type ServiceSnapshotRow = typeof serviceSnapshots.$inferSelect
export type RunRow = typeof runRecords.$inferSelect

/** `LIKE` 的转义：`%` `_` `\` 本身都要转义，否则用户搜 "100%" 会命中所有。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

// ---------------------------------------------------------------------------
// 剪切板
// ---------------------------------------------------------------------------

export async function dbClipboardList(limit: number, offset = 0, query?: string): Promise<ClipboardRow[]> {
  const dbh = await getDatabase()
  const base = dbh.select().from(clipboardEntries)
  if (query && query.trim() !== '') {
    // ⚠️ ESCAPE 必须显式写：drizzle 的 `like()` 不带 ESCAPE 子句，而少了它，
    // 搜 "a_b" 里的 `_` 会当通配符，搜 "100%" 会命中一切。
    return base
      .where(sql`${clipboardEntries.text} LIKE ${`%${escapeLike(query.trim())}%`} ESCAPE '\\'`)
      .orderBy(desc(clipboardEntries.createdAt), desc(clipboardEntries.id))
      .limit(limit)
      .offset(offset)
  }
  return base.orderBy(desc(clipboardEntries.createdAt), desc(clipboardEntries.id)).limit(limit).offset(offset)
}

export async function dbClipboardCount(): Promise<number> {
  const dbh = await getDatabase()
  const rows = await dbh.select({ count: sql<number>`count(*)` }).from(clipboardEntries)
  return Number(rows[0]?.count ?? 0)
}

export async function dbClipboardGet(id: string): Promise<ClipboardRow | undefined> {
  const dbh = await getDatabase()
  const rows = await dbh.select().from(clipboardEntries).where(eq(clipboardEntries.id, id)).limit(1)
  return rows[0]
}

export async function dbClipboardByIdem(idemKey: string): Promise<ClipboardRow | undefined> {
  const dbh = await getDatabase()
  const rows = await dbh.select().from(clipboardEntries).where(eq(clipboardEntries.idemKey, idemKey)).limit(1)
  return rows[0]
}

export async function dbClipboardInsert(row: ClipboardRow): Promise<void> {
  const dbh = await getDatabase()
  await dbh.insert(clipboardEntries).values(row)
}

export async function dbClipboardDelete(id: string): Promise<boolean> {
  const dbh = await getDatabase()
  const result = await dbh.delete(clipboardEntries).where(eq(clipboardEntries.id, id)).run()
  return Number(result.changes) > 0
}

export async function dbClipboardClear(): Promise<number> {
  const dbh = await getDatabase()
  const result = await dbh.delete(clipboardEntries).run()
  return Number(result.changes)
}

/** 超出长度的部分按时间从旧到新删掉，返回被删的行（调用方负责删附件）。 */
export async function dbClipboardPrune(keep: number): Promise<ClipboardRow[]> {
  const dbh = await getDatabase()
  // 「保留最新 N 条」用关联子查询表达最清楚；drizzle 的 builder 写不出
  // `NOT IN (SELECT ... LIMIT n)`，所以这里是 `sql` 模板 —— 它仍是 drizzle 的
  // 表达式对象（表名/列名来自 schema，不是字符串拼接），不是绕过 ORM 的裸 SQL。
  const doomed = await dbh.all<ClipboardRow>(sql`
    SELECT * FROM ${clipboardEntries}
     WHERE ${clipboardEntries.id} NOT IN (
       SELECT id FROM ${clipboardEntries}
        ORDER BY ${clipboardEntries.createdAt} DESC, ${clipboardEntries.id} DESC
        LIMIT ${keep}
     )
     ORDER BY ${clipboardEntries.createdAt} ASC, ${clipboardEntries.id} ASC
  `)
  for (const row of doomed) await dbClipboardDelete(row.id)
  return doomed
}

// ---------------------------------------------------------------------------
// 服务快照 / 健康样本 / 指标
// ---------------------------------------------------------------------------

export async function dbSnapshotAll(): Promise<ServiceSnapshotRow[]> {
  const dbh = await getDatabase()
  return dbh.select().from(serviceSnapshots)
}

export async function dbSnapshotPut(row: ServiceSnapshotRow): Promise<void> {
  const dbh = await getDatabase()
  await dbh
    .insert(serviceSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: serviceSnapshots.serviceId,
      set: {
        status: row.status,
        latencyMs: row.latencyMs,
        message: row.message,
        version: row.version,
        source: row.source,
        details: row.details,
        checkedAt: row.checkedAt,
        okCount: row.okCount,
        totalCount: row.totalCount,
      },
    })
}

export async function dbSnapshotDelete(serviceId: string): Promise<void> {
  const dbh = await getDatabase()
  await dbh.delete(serviceSnapshots).where(eq(serviceSnapshots.serviceId, serviceId))
}

export async function dbSampleInsert(row: {
  serviceId: string
  status: string
  latencyMs: number | null
  message: string
  checkedAt: number
}): Promise<void> {
  const dbh = await getDatabase()
  await dbh.insert(serviceSamples).values(row)
}

export async function dbSampleHistory(
  serviceId: string,
  limit: number
): Promise<Array<{ status: string; latencyMs: number | null; message: string; checkedAt: number }>> {
  const dbh = await getDatabase()
  return dbh
    .select({
      status: serviceSamples.status,
      latencyMs: serviceSamples.latencyMs,
      message: serviceSamples.message,
      checkedAt: serviceSamples.checkedAt,
    })
    .from(serviceSamples)
    .where(eq(serviceSamples.serviceId, serviceId))
    .orderBy(desc(serviceSamples.checkedAt))
    .limit(limit)
}

/** 每个服务只留最新 N 条。 */
export async function dbSamplePrune(keep: number): Promise<number> {
  const dbh = await getDatabase()
  const result = await dbh.run(sql`
    DELETE FROM ${serviceSamples}
     WHERE id NOT IN (
       SELECT id FROM ${serviceSamples} AS inner_samples
        WHERE inner_samples.serviceId = ${serviceSamples.serviceId}
        ORDER BY inner_samples.checkedAt DESC LIMIT ${keep}
     )
  `)
  return Number(result.changes)
}

export async function dbMetricInsert(
  rows: Array<{ serviceId: string; metric: string; value: number; unit: string; at: number }>
): Promise<void> {
  if (rows.length === 0) return
  const dbh = await getDatabase()
  await dbh.insert(serviceMetrics).values(rows)
}

export async function dbMetricLatest(
  serviceId: string
): Promise<Array<{ metric: string; value: number; unit: string; at: number }>> {
  const dbh = await getDatabase()
  return dbh
    .select({
      metric: serviceMetrics.metric,
      value: serviceMetrics.value,
      unit: serviceMetrics.unit,
      // SQLite 里 `MAX(at)` 配上裸列会取「at 最大的那一行」的其它列 ——
      // 正是「每个指标的最新值」要的语义。
      at: sql<number>`max(${serviceMetrics.at})`,
    })
    .from(serviceMetrics)
    .where(eq(serviceMetrics.serviceId, serviceId))
    .groupBy(serviceMetrics.metric)
    .orderBy(serviceMetrics.metric)
}

export async function dbMetricSeries(
  serviceId: string,
  metric: string,
  limit: number
): Promise<Array<{ value: number; unit: string; at: number }>> {
  const dbh = await getDatabase()
  return dbh
    .select({ value: serviceMetrics.value, unit: serviceMetrics.unit, at: serviceMetrics.at })
    .from(serviceMetrics)
    .where(and(eq(serviceMetrics.serviceId, serviceId), eq(serviceMetrics.metric, metric)))
    .orderBy(desc(serviceMetrics.at))
    .limit(limit)
}

export async function dbMetricPrune(keep: number): Promise<number> {
  const dbh = await getDatabase()
  const result = await dbh.run(sql`
    DELETE FROM ${serviceMetrics}
     WHERE id NOT IN (
       SELECT id FROM ${serviceMetrics} AS inner_metrics
        WHERE inner_metrics.serviceId = ${serviceMetrics.serviceId}
          AND inner_metrics.metric = ${serviceMetrics.metric}
        ORDER BY inner_metrics.at DESC LIMIT ${keep}
     )
  `)
  return Number(result.changes)
}

// ---------------------------------------------------------------------------
// 脚本运行记录
// ---------------------------------------------------------------------------

export async function dbRunInsert(row: {
  script: string
  origin: string
  status: string
  startedAt: number
  triggeredBy: string
}): Promise<number> {
  const dbh = await getDatabase()
  const result = await dbh
    .insert(runRecords)
    .values({
      script: row.script,
      origin: row.origin,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.startedAt,
      durationMs: 0,
      triggeredBy: row.triggeredBy,
    })
    .run()
  return Number(result.lastInsertRowid)
}

export async function dbRunFinish(
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
): Promise<void> {
  const dbh = await getDatabase()
  await dbh.update(runRecords).set(patch).where(eq(runRecords.id, id))
}

export async function dbRunGet(id: number): Promise<RunRow | undefined> {
  const dbh = await getDatabase()
  const rows = await dbh.select().from(runRecords).where(eq(runRecords.id, id)).limit(1)
  return rows[0]
}

/**
 * 记一笔「这次运行回推了 n 条指标」。
 *
 * ⚠️ 单独一个 helper 而不是塞进 `dbRunFinish` 的 patch：指标是在**运行过程中**
 * 推回来的，而 `dbRunFinish` 发生在进程退出之后 —— 中间那段时间里
 * `metricCalls` 会一直是 0，界面上看起来就像「脚本说它推了，其实没推」。
 * 增量更新（`+ n`）而不是赋值，是因为一个脚本可能分多批推。
 */
export async function dbRunMetricCalls(id: number, n = 1): Promise<void> {
  const dbh = await getDatabase()
  await dbh
    .update(runRecords)
    .set({ metricCalls: sql`${runRecords.metricCalls} + ${n}` })
    .where(eq(runRecords.id, id))
}

export async function dbRunList(limit: number, script?: string): Promise<RunRow[]> {
  const dbh = await getDatabase()
  const base = dbh.select().from(runRecords)
  if (script) {
    return base.where(eq(runRecords.script, script)).orderBy(desc(runRecords.startedAt)).limit(limit)
  }
  return base.orderBy(desc(runRecords.startedAt)).limit(limit)
}

export async function dbRunPrune(keep: number): Promise<number> {
  const dbh = await getDatabase()
  const result = await dbh.run(sql`
    DELETE FROM ${runRecords}
     WHERE id NOT IN (
       SELECT id FROM ${runRecords} ORDER BY ${runRecords.startedAt} DESC LIMIT ${keep}
     )
  `)
  return Number(result.changes)
}

// ---------------------------------------------------------------------------
// 键值设置（PIN 的散列与 epoch）
// ---------------------------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  const dbh = await getDatabase()
  const rows = await dbh.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1)
  return rows[0]?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  const dbh = await getDatabase()
  await dbh
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

export async function deleteSetting(key: string): Promise<void> {
  const dbh = await getDatabase()
  await dbh.delete(settings).where(eq(settings.key, key))
}
