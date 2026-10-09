/**
 * 容器内备份。stdin 接收，产物用 docker cp 取出。
 *
 * ⚠️ 这是三个服务里最麻烦的一份，原因值得写清楚：
 *
 *   navi  整个数据集在 SQLite 里        → VACUUM INTO 一个 .db 就完整
 *   atlas db + media/ 两样              → 一对文件（.db + .tar）
 *   raven **整个数据卷都是数据**         → 一个 .db + 一个压缩包
 *
 * raven 的数据卷里除了 raven.db 还有 workspace/（用户文件与下载）、
 * clipboard/（剪切板附件）、scripts/、tmp/。db 里只存**相对路径**，
 * 所以只备 db 会恢复出一个「条目都在、文件全丢」的界面 ——
 * 而那不是报错，是最糟的那种静默失败。
 *
 * ⚠️ 另外**单独**备一份 raven.config.json（不进文件包）：
 * 配置文件是运维资产，不是数据。让恢复用「备份当时的配置」覆盖掉
 * 「现在的配置」，会把一次操作员改过的密码或配额悄悄回退 —— 那是没人期待的结果。
 *
 * 环境变量：
 *   BACKUP_DB_PATH     容器内 db 快照落地路径
 *   BACKUP_FILES_PATH  容器内文件包落地路径
 *   BACKUP_CONFIG_PATH 容器内配置副本落地路径
 *   BACKUP_ROOT        受管根，默认 /data
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const dbPath = process.env.BACKUP_DB_PATH
const filesPath = process.env.BACKUP_FILES_PATH
const configPath = process.env.BACKUP_CONFIG_PATH
const root = process.env.BACKUP_ROOT || '/data'

if (!dbPath || !filesPath || !configPath) {
  console.error('需要 BACKUP_DB_PATH、BACKUP_FILES_PATH、BACKUP_CONFIG_PATH 三个环境变量。')
  process.exit(1)
}

const liveDb = `${root}/raven.db`
if (!existsSync(liveDb)) {
  console.error(`找不到 ${liveDb}。数据卷挂错了吗？`)
  process.exit(1)
}

// ① 数据库一致性快照。
// ⚠️ 用 VACUUM INTO 而不是直接 cp：WAL 模式下 `cp raven.db` 会漏掉还没
// checkpoint 的事务，备出来的库可能缺最近几条记录 —— 而它看上去完全正常。
const db = new DatabaseSync(liveDb, { readOnly: true })
try {
  db.exec(`VACUUM INTO '${dbPath}'`)
} finally {
  db.close()
}

// ② 配置文件单独一份。文件不存在不算失败（配置也可能来自别处），但要说明。
const liveConfig = `${root}/raven.config.json`
if (existsSync(liveConfig)) {
  copyFileSync(liveConfig, configPath)
} else {
  console.log(`注意：${liveConfig} 不存在，这次备份没有配置副本。`)
}

// ③ 文件包：整个受管根，排除 db 本体、配置、以及它们可能带出的临时文件。
//
// ⚠️ 排除 `./raven.db*` 是刻意的：把正在使用的库打进文件包，
// 恢复时就会用一份「可能不一致」的库覆盖掉快照恢复出来的那份，
// 而两者只差几个字节，很难发现。
//
// 用 tar 而不是逐文件 cp：workspace/ 是几千个文件，逐文件的输出没有可读性，
// 而一个自描述的包还能顺手看清单。
const excludes = ['./raven.db', './raven.db-wal', './raven.db-shm', './raven.db-journal', './raven.config.json']
execFileSync('tar', ['-czf', filesPath, '-C', root, ...excludes.flatMap((item) => ['--exclude', item]), '.'], {
  stdio: ['ignore', 'inherit', 'pipe'],
})
console.log(`已打包 ${root}（排除 raven.db* 与 raven.config.json）`)
