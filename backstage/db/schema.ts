import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * SQLite 结构 —— **这是 raven 表结构的唯一真相**。
 *
 * 以前这里是一份手写 `SCHEMA_SQL`（`CREATE TABLE ...` 字符串），service 里再写
 * 一遍裸 SQL 查询，两处各写一遍结构。现在只有这一份：它是 drizzle-kit 生成迁移
 * 的输入，也是查询层的类型来源（`typeof table.$inferSelect` 取代手写 Row 类型）。
 *
 * 为什么用 drizzle 而不是继续裸 SQL：**结构演进要有历史**。手写 `CREATE TABLE IF
 * NOT EXISTS` 只能建「当前这一版」，加一列就得再写一段 `ALTER TABLE`，跑没跑过
 * 无法从库里读出来。迁移文件是能进版本库、能 review、能在新机器上重放的东西。
 *
 * ⚠️ **列名必须与 TypeScript 侧完全同名**（尤其 `attachBytes`）。早先是
 * `attach_bytes`，而查询写的是 `attachBytes` —— SQLite 里那是两个不同的标识符，
 * 每次插入都抛 "no column named attachBytes"，剪切板 100% 不可用，而类型检查
 * 完全看不见。drizzle 之后这类漂移会在 typecheck 阶段就死掉。
 */

/**
 * 剪切板队列。
 *
 * 队序是 `createdAt DESC, id DESC`（id 是 ULID，字典序 = 时间序）。
 * `idemKey` 上的是**部分唯一索引**（`WHERE idemKey IS NOT NULL`）——
 * 没有 NULL 过滤的话，多条 `idemKey IS NULL` 的记录会互相冲突，第二条就插不进去了。
 */
export const clipboardEntries = sqliteTable(
  'clipboard_entries',
  {
    id: text('id').primaryKey(),
    text: text('text').notNull(),
    bytes: integer('bytes').notNull(),
    source: text('source').notNull().default('web'),
    attachments: text('attachments').notNull().default('[]'),
    // ⚠️ camelCase，与 ClipboardRow 同名。别改成 snake_case，理由见文件头。
    attachBytes: integer('attachBytes').notNull().default(0),
    idemKey: text('idemKey'),
    createdAt: integer('createdAt').notNull(),
  },
  (table) => [
    index('idx_clipboard_created').on(sql`${table.createdAt} DESC`),
    uniqueIndex('idx_clipboard_idem').on(table.idemKey).where(sql`${table.idemKey} IS NOT NULL`),
  ]
)

/** 服务快照：每个服务一行，健康检查的最新结论。 */
export const serviceSnapshots = sqliteTable('service_snapshots', {
  serviceId: text('serviceId').primaryKey(),
  status: text('status').notNull(),
  latencyMs: integer('latencyMs'),
  message: text('message').notNull().default(''),
  version: text('version').notNull().default(''),
  source: text('source').notNull().default('collector'),
  details: text('details').notNull().default('{}'),
  checkedAt: integer('checkedAt').notNull(),
  okCount: integer('okCount').notNull().default(0),
  totalCount: integer('totalCount').notNull().default(0),
})

/** 健康样本：每次检查一行，用来画曲线。 */
export const serviceSamples = sqliteTable(
  'service_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serviceId: text('serviceId').notNull(),
    status: text('status').notNull(),
    latencyMs: integer('latencyMs'),
    message: text('message').notNull().default(''),
    checkedAt: integer('checkedAt').notNull(),
  },
  (table) => [index('idx_samples_service').on(table.serviceId, sql`${table.checkedAt} DESC`)]
)

/** 指标时序。 */
export const serviceMetrics = sqliteTable(
  'service_metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serviceId: text('serviceId').notNull(),
    metric: text('metric').notNull(),
    value: real('value').notNull(),
    unit: text('unit').notNull().default(''),
    at: integer('at').notNull(),
  },
  (table) => [index('idx_metrics_service').on(table.serviceId, table.metric, sql`${table.at} DESC`)]
)

/** 脚本运行记录。 */
export const runRecords = sqliteTable(
  'run_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    script: text('script').notNull(),
    origin: text('origin').notNull().default('workspace'),
    status: text('status').notNull(),
    exitCode: integer('exitCode'),
    startedAt: integer('startedAt').notNull(),
    endedAt: integer('endedAt').notNull(),
    durationMs: integer('durationMs').notNull().default(0),
    stdout: text('stdout').notNull().default(''),
    stderr: text('stderr').notNull().default(''),
    truncated: integer('truncated').notNull().default(0),
    signal: text('signal').notNull().default(''),
    triggeredBy: text('triggeredBy').notNull().default('ui'),
    metricCalls: integer('metricCalls').notNull().default(0),
  },
  (table) => [
    index('idx_runs_started').on(sql`${table.startedAt} DESC`),
    index('idx_runs_script').on(table.script, sql`${table.startedAt} DESC`),
  ]
)

/**
 * 键值设置表。
 *
 * PIN 的散列与 epoch 落在这里（见 backstage/services/pin.service.ts），**不在配置
 * 文件里** —— 凭据是运行期产生的状态，配置文件是人工维护的声明，两者混在一处
 * 会让人以为「改配置文件就能改密码」。
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * 已知的、需要显式迁移才能打开的旧结构（表名 -> 说明）。
 *
 * ⚠️ 迁移系统接管的是「当前结构往后的演进」；它管不到这些**更早**的表名。
 * 撞到就直接抛错，运行时不做兼容搬运 —— 静默猜一个映射比停下来问贵得多。
 */
export const LEGACY_TABLES: Record<string, string> = {
  clipboard_items: '剪切板表在 v0.1 改名为 clipboard_entries 并加了 idemKey。',
}
