/**
 * SQLite 结构。
 *
 * 用 `node:sqlite`（Node 24 内置），和 creative-atlas 一样不引第三方驱动 ——
 * 但**不用 drizzle**：raven 的表都是窄表（剪切板、健康样本、脚本运行记录、
 * 服务快照），原生 SQL 比一层 ORM 更好读，也少一层构建期依赖。
 *
 * 迁移策略沿用 atlas 的纪律：`ensureSchema` 只创建**当前**结构；撞到已知的旧结构
 * 就抛错，不做自动搬运。
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS clipboard_entries (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  source        TEXT NOT NULL DEFAULT 'web',
  attachments   TEXT NOT NULL DEFAULT '[]',
  -- ⚠️ 列名是 camelCase 的 attachBytes，与 TypeScript 侧 ClipboardRow 完全同名。
  -- 早先这里是 attach_bytes，而 dbClipboardInsert 写的是 attachBytes ——
  -- SQLite 里那是两个不同的标识符，于是每一次插入都抛
  -- "table clipboard_entries has no column named attachBytes"，剪切板 100% 不可用。
  -- 教训：db 层是 SELECT *，列名一旦和类型定义不同名，
  -- 类型检查完全看不见，只有真跑一次插入才会暴露。所以这里坚持同名。
  attachBytes   INTEGER NOT NULL DEFAULT 0,
  idemKey       TEXT,
  createdAt     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_entries (createdAt DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clipboard_idem ON clipboard_entries (idemKey) WHERE idemKey IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_snapshots (
  serviceId   TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  latencyMs   INTEGER,
  message     TEXT NOT NULL DEFAULT '',
  version     TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'collector',
  details     TEXT NOT NULL DEFAULT '{}',
  checkedAt   INTEGER NOT NULL,
  okCount     INTEGER NOT NULL DEFAULT 0,
  totalCount  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  serviceId   TEXT NOT NULL,
  status      TEXT NOT NULL,
  latencyMs   INTEGER,
  message     TEXT NOT NULL DEFAULT '',
  checkedAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_service ON service_samples (serviceId, checkedAt DESC);

CREATE TABLE IF NOT EXISTS service_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  serviceId   TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  unit        TEXT NOT NULL DEFAULT '',
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_service ON service_metrics (serviceId, metric, at DESC);

CREATE TABLE IF NOT EXISTS run_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  script      TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'workspace',
  status      TEXT NOT NULL,
  exitCode    INTEGER,
  startedAt   INTEGER NOT NULL,
  endedAt     INTEGER NOT NULL,
  durationMs  INTEGER NOT NULL DEFAULT 0,
  stdout      TEXT NOT NULL DEFAULT '',
  stderr      TEXT NOT NULL DEFAULT '',
  truncated   INTEGER NOT NULL DEFAULT 0,
  signal      TEXT NOT NULL DEFAULT '',
  triggeredBy TEXT NOT NULL DEFAULT 'ui',
  metricCalls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON run_records (startedAt DESC);
CREATE INDEX IF NOT EXISTS idx_runs_script ON run_records (script, startedAt DESC);
`

/** 已知的、需要显式迁移才能打开的旧结构（表名 -> 说明）。 */
export const LEGACY_TABLES: Record<string, string> = {
  clipboard_items: '剪切板表在 v0.1 改名为 clipboard_entries 并加了 idemKey。',
}
