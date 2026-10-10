/**
 * 把旧库（迁移系统之前那份手建库）的数据搬进迁移建出来的新库。
 *
 * ⚠️ 为什么是「建新库 + 导入」而不是「在旧库上补迁移」：
 * 旧库里没有 `__drizzle_migrations`，drizzle 会把 0000 当成「还没跑」去执行，
 * 于是 `CREATE TABLE` 撞上已存在的表直接炸。它的迁移记录只认自己写过的那张表，
 * 没有「检测到结构已等价就跳过」这回事。所以老老实实：备份 → 建无历史新库 → 导入。
 *
 * 用法：
 *   RAVEN_DB_FILE=<新库> npm run db:import-legacy -- <旧库路径>
 *
 * ⚠️ 脚本**只读**旧库，不删不改；新库用 `ON CONFLICT DO NOTHING` 灌入，
 * 重复跑不会翻倍。
 */
import { DatabaseSync } from 'node:sqlite'
import { dbFile, getDatabase } from '../backstage/db/database'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
  clipboardEntries,
  runRecords,
  serviceMetrics,
  serviceSamples,
  serviceSnapshots,
  settings,
} from '../backstage/db/schema'

const legacyPath = process.argv[2]

if (!legacyPath) {
  console.error('用法：npm run db:import-legacy -- <旧库路径>')
  process.exit(1)
}

const legacy = new DatabaseSync(legacyPath)

/** 逐表搬：列名由 schema.ts 保证一致，这里只做「搬」，不改形状。 */
async function copy(label: string, table: SQLiteTable): Promise<number> {
  const rows = legacy.prepare(`SELECT * FROM ${label}`).all()
  if (rows.length === 0) {
    console.log(`  ${label.padEnd(20)} 0（旧库为空）`)
    return 0
  }
  const db = await getDatabase()
  // 分批插入：一次塞几千行的 SQL 会撞 SQLite 的变量数上限（默认 999）。
  const CHUNK = 200
  for (let index = 0; index < rows.length; index += CHUNK) {
    await db.insert(table).values(rows.slice(index, index + CHUNK) as never[]).onConflictDoNothing()
  }
  console.log(`  ${label.padEnd(20)} ${rows.length}`)
  return rows.length
}

async function main(): Promise<void> {
  console.log(`旧库：${legacyPath}`)
  console.log(`新库：${dbFile()}`)
  console.log('导入：')
  let total = 0
  total += await copy('clipboard_entries', clipboardEntries)
  total += await copy('service_snapshots', serviceSnapshots)
  total += await copy('service_samples', serviceSamples)
  total += await copy('service_metrics', serviceMetrics)
  total += await copy('run_records', runRecords)
  total += await copy('settings', settings)
  console.log(`完成，共 ${total} 行。`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
