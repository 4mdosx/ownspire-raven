# 数据结构：注册表 · 快照 · 历史 · 指标 · 运行记录

这份文件把 raven 里「关于 ownspire 各服务运行情况」的数据**逐字段**写清楚。
机制怎么用见 [03-service-registry.md](03-service-registry.md)；这里是结构本身。

---

## 0. 一张图

```
              ┌──────────────── 定义（人写的、能 cat 的） ────────────────┐
              │  config.raven.config.json: services.defs   （内联）        │
              │  <rootPath>/services.json                  （注册表文件）  │
              └───────────────────────────┬───────────────────────────────┘
                                          │ 按 id 合并，文件优先
                                          ▼
                                  ServiceSnapshot[]          （运行时视图）
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
             探针（5 种）           指标脚本（1 个/条）      治理动作（0..n 个）
                    │                     │                     │
          ┌─────────┴─────────┐           │                     │
          ▼                   ▼           ▼                     ▼
   service_snapshots    service_samples  service_metrics    run_records
   （最新一条，PK）      （时间序列）      （时间序列）        （每次执行一条）
          │                   │                 │                 │
          └───────────────────┴────────┬────────┴─────────────────┘
                                       ▼
                              GET /api/services → Dashboard
```

「定义」与「观测」是两套存储，**刻意不混**：
定义要能被人编辑、被 git 管、被别的工具重新生成；观测是时间序列，量级完全不同。

---

## 1. `ServiceSnapshot`（运行时视图，不落库）

`registry.service.ts` 的 `loadRegistry()` 产出，`ServiceDef` 加上三个来源字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `def` | `ServiceDef` | 定义本体（字段见 03 号文档 §2） |
| `origin` | `string` | `'inline'`，或定义文件的绝对路径 |
| `persistable` | `boolean` | 能否被 HTTP API 改写/删除。只有文件里的服务是 `true` |
| `enabled` | `boolean` | 缺省 `true`。`false` 时只展示、不采集 |
| `warning` | `string?` | 同 id 被文件覆盖内联时留下说明，Dashboard 要显示出来 |

---

## 2. `service_snapshots`（最新健康快照，每服务一行）

```sql
CREATE TABLE service_snapshots (
  serviceId   TEXT PRIMARY KEY,
  status      TEXT NOT NULL,      -- ok | warn | down | unknown
  latencyMs   INTEGER,            -- 最慢那个探针的耗时；无探针为 NULL
  message     TEXT NOT NULL,      -- 人话说明，失败时是「为什么」
  version     TEXT NOT NULL,      -- 从探针拿到的版本号（http.versionField）
  source      TEXT NOT NULL,      -- collector（raven 采的） | ingest（服务推的）
  details     TEXT NOT NULL,      -- JSON：逐探针结果数组
  checkedAt   INTEGER NOT NULL,   -- 毫秒时间戳
  okCount     INTEGER NOT NULL,
  totalCount  INTEGER NOT NULL
);
```

`details` 里的元素形状（即 `ProbeResult`）：

```json
{ "index": 0, "type": "http", "status": "ok", "latencyMs": 12,
  "message": "HTTP 200", "version": "a1b2c3d" }
```

⚠️ `okCount` / `totalCount` **冗余存在快照里**，不是渲染时算的：Dashboard 要能
在 `details` 被截断或探针定义后来改过的情况下，仍然说清「3 个里当时坏了 1 个」。

---

## 3. `service_samples`（健康时间序列）

```sql
CREATE TABLE service_samples (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  serviceId TEXT NOT NULL,
  status    TEXT NOT NULL,
  latencyMs INTEGER,
  message   TEXT NOT NULL,
  checkedAt INTEGER NOT NULL
);
CREATE INDEX idx_samples_service ON service_samples (serviceId, checkedAt DESC);
```

每次**真实采样**写一条（缓存命中不写 —— 否则历史会变成刷屏）。
按 `services.historyLimit`（默认 500）修剪，**每个服务各留各的**。

Dashboard 上的延迟历史条就是这张表最近 50 条。

---

## 4. `service_metrics`（指标时间序列）

```sql
CREATE TABLE service_metrics (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  serviceId TEXT NOT NULL,
  metric    TEXT NOT NULL,       -- 已加 metricPrefix 的最终名字
  value     REAL NOT NULL,
  unit      TEXT NOT NULL,       -- 展示用；'B' / '' / 'ms'
  at        INTEGER NOT NULL
);
CREATE INDEX idx_metrics_service ON service_metrics (serviceId, metric, at DESC);
```

- 最新值 = `GROUP BY metric` 取 `MAX(at)`（`dbMetricLatest`）。
- 单指标历史 = 按 `at DESC` 取 N 条（`dbMetricSeries`）。
- 修剪：每个 `(serviceId, metric)` 留 `metricHistoryLimit` 条（默认 500）。
- `unit` 是**观测时**脚本给的，不是查询时猜的：同一个指标名换单位是脚本的错，
  数据里留着两种单位比统一改口径更容易发现。

---

## 5. `run_records`（每次脚本执行一条）

```sql
CREATE TABLE run_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  script      TEXT NOT NULL,      -- 文件名；临时脚本是上传时的文件名
  origin      TEXT NOT NULL,      -- workspace | temp | probe | metric | action
  status      TEXT NOT NULL,      -- running | ok | failed | timeout | killed
  exitCode    INTEGER,
  startedAt   INTEGER NOT NULL,
  endedAt     INTEGER NOT NULL,
  durationMs  INTEGER NOT NULL,
  stdout      TEXT NOT NULL,      -- 已按 maxOutputBytes 截断
  stderr      TEXT NOT NULL,
  truncated   INTEGER NOT NULL,   -- 0/1
  signal      TEXT NOT NULL,      -- 空串，或 SIGTERM / SIGKILL
  triggeredBy TEXT NOT NULL,      -- ui | health | metric:<id> | action:<svc>/<act> | api
  metricCalls INTEGER NOT NULL    -- 这次运行回推了几条指标
);
```

**为什么所有执行都进同一张表**：健康探针、指标脚本、治理动作、用户手点，
它们的失败原因往往是同一类（路径不对、依赖没装、超时）。
分表存会让「这个服务最近为什么一直 warn」变成要查三个地方。

保留最近 1000 条运行记录（`dbRunPrune`）。运行记录的完整输出用于事后追查；
流式展示是**尽力而为**的，权威结果永远是结束时的 `RunResult`。

---

## 6. `clipboard_entries`（顺带记在这里，因为它也带队列语义）

```sql
CREATE TABLE clipboard_entries (
  id           TEXT PRIMARY KEY,   -- ULID：字典序 == 时间序
  text         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  source       TEXT NOT NULL DEFAULT 'web',
  attachments  TEXT NOT NULL DEFAULT '[]',  -- JSON: [{name, bytes}]
  attachBytes  INTEGER NOT NULL DEFAULT 0,
  idemKey      TEXT,               -- 幂等键，可空；有值时不重复插入
  createdAt    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_clipboard_idem ON clipboard_entries (idemKey) WHERE idemKey IS NOT NULL;
```

队列语义：**插入即入队**，`createdAt DESC, id DESC` 是队列顺序，超出
`clipboard.maxItems` 的部分从队尾删，连附件目录一起删。

`idemKey` 是部分唯一索引（`WHERE idemKey IS NOT NULL`）—— 网络抖动导致的重发
不该产生两条记录，而「不传 idemKey」必须是**合法**的（同一个文本粘两次是正常操作）。

---

## 7. 外部推指标的形状（`POST /api/ingest/metrics`）

```json
{
  "serviceId": "navi",
  "metrics": [ { "name": "todo_count", "value": 42, "unit": "" } ],
  "status": "ok",
  "message": "可选",
  "version": "a1b2c3d"
}
```

- `metrics` 可空：只报一个状态也可以（服务自己知道的情况比探针多）。
- `serviceId` 必须在注册表里；**未注册的服务不会被自动创建** ——
  否则任何拿到令牌的东西都能往 Dashboard 上塞卡片，那是垃圾数据入口。
- 用运行期一次性令牌（脚本里的 `RAVEN_TOKEN`）推送时，会记到对应 `run_records.metricCalls`，
  这样「脚本说它推了 3 条」和「库里真的多了 3 条」能对上。

---

## 8. 一致性约束（写代码时要守的）

1. 任何写观测数据的地方都要**先确认服务仍在注册表里**（`findService`），
   否则会留下永远不会被清理、也不会被展示的孤儿样本。
2. 注册表删除服务时要一并删掉它的 `service_snapshots` / `service_samples` / `service_metrics`
   —— 保留孤儿时间序列只会让下次同 id 的服务继承一份来源不明的历史。
3. 历史修剪必须在**写入之后**执行，且是幂等的（多余的 `DELETE` 不报错）。
4. 所有时间戳都是**毫秒整数**，没有字符串时间戳。SQLite 里没有时区概念，
   存字符串会立刻遇到「排序对但比较不对」的问题。
