# 接口契约（冻结）

> 这份文件是 raven 内部各层的契约。**先读完再动代码。**
> 冻结时间：v0.1。任何接口变更要同时改这份文件和调用方，别只改一边。

## 0. 目录与运行期边界

```
rootPath/                     ← 受管根，任何操作不得越过（backstage/lib/sandbox.ts 保证）
├── workspace/                ← filesRoot：文件管理器唯一可见的树，配额只算这一棵
│   └── uploads/              ← 上传暂存（约定，不是硬编码；由客户端指定路径）
├── scripts/                  ← scriptsRoot：脚本运行器只认这里的 *.mjs / *.js
├── tmp/                      ← tempRoot：临时上传脚本的一次性工作区，跑完即删
└── clipboard/                ← clipboardRoot：剪切板附件落盘处（<entryId>/<file>）

dataDir/                      ← 用户数据目录（容器里是数据卷）
├── raven.db                  ← SQLite
└── services.json             ← 服务注册表（config 里的 registryFile 可覆盖）
```

**规则：**
- `backstage/lib/sandbox.ts` 是唯一做路径判定与配额判定的地方。任何 route/service 都不得自己拼 `path.join(root, userInput)`。
- 相对路径一律 POSIX 风格、不含 `..`、不以 `/` 开头（`parseRelativePath()` 会拒）。
- 越界实时判定：先 `realpath` 再比完整路径段，不靠字符串前缀。

## 1. 配置（`types/config.ts` + `backstage/lib/config.ts`）

- `getConfig()` → `{ config, sandbox }`，按 mtime 自动重载。
- `publicConfig()` → 可暴露给浏览器的子集（**不含 PIN 散列、不含 username、不含配置路径之外的宿主信息**）。
- 配置不合法一律抛 `ConfigError`，**拒绝启动，不做默认值降级**。

## 2. 统一响应形状（`backstage/lib/http.ts`）

```
成功：{ ok: true, ...payload }
失败：{ ok: false, code: string, error: string } + 对应 HTTP status
```

`SandboxError.status` 直接当 HTTP status 用：403 越界、404 不存在、507 配额满、400 输入非法。

⚠️ **服务层抛 `SandboxError`，路由层抛 `ApiError`。** 两者都带 `code`/`status`，
`handle()` 出口形状完全一致。这样分的理由：服务层不该依赖 `next/server`，
否则验证脚本没法在纯 Node 里直接调它们（而路径穿越、队列淘汰、超时杀进程组
这三类错误只有直调才测得准）。

## 3. 文件服务（`backstage/services/file.service.ts`）

导出（全部 async，路径参数是**相对 filesRoot 的字符串**）：

```ts
export type FileKind = 'file' | 'dir' | 'symlink' | 'other'
export type FileEntry = {
  name: string
  path: string            // 相对 filesRoot，POSIX；根目录为 ''
  kind: FileKind
  size: number            // 目录为 0；symlink 为链接自身长度
  mtimeMs: number
  /** symlink 才有：链接目标（原样），以及它是否仍在沙箱内 */
  linkTarget?: string
  linkInside?: boolean
  extension: string       // 小写，不含点；目录为 ''
  mime: string            // 粗粒度，按扩展名猜
  editable: boolean       // 文本类且 < 1MiB
}

export type FileStats = {
  filesRoot: string       // 相对 server 的展示用（沙箱内的绝对路径）
  bytes: number
  files: number
  dirs: number
  quotaBytes: number | null
  remainingBytes: number | null
  usedRatio: number | null  // 0..1，未设配额为 null
}

listDirectory(input: { path?: string; search?: string; sort?: 'name'|'size'|'mtime'; order?: 'asc'|'desc' })
  : Promise<{ path: string; parent: string | null; entries: FileEntry[] }>

readTextFile(input: { path: string; maxBytes?: number })
  : Promise<{ path: string; text: string; size: number; encoding: 'utf8'; truncated: boolean }>

writeTextFile(input: { path: string; text: string; createOnly?: boolean })
  : Promise<FileEntry>          // 配额不足抛 quota_exceeded

readStream(input: { path: string }) : Promise<{ absolutePath: string; entry: FileEntry }>  // 供下载路由 fs.createReadStream

upload(input: { path: string; stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream; expectedBytes?: number; overwrite?: boolean })
  : Promise<{ entry: FileEntry; bytes: number }>

createDirectory(input: { path: string }) : Promise<FileEntry>
rename(input: { from: string; to: string }) : Promise<FileEntry>       // to 是完整新路径（含新名）
move(input: { from: string; to: string; overwrite?: boolean }) : Promise<FileEntry>
copy(input: { from: string; to: string; overwrite?: boolean }) : Promise<FileEntry>
remove(input: { paths: string[] }) : Promise<{ removed: Array<{ path: string; kind: FileKind; bytes: number }>; count: number }>
stats() : Promise<FileStats>
```

**上传的配额纪律：** 先 `sandbox.assertRoomFor(expectedBytes ?? 0)`，
再用 `sandbox.reserve(bytes)` 逐步预留、`sandbox.release(bytes)` 归还，
**任何失败路径都必须 release**。写到一半超配额要中止并删掉半截文件。

**删除纪律：** 递归删除前必须先递归统计（文件数、字节数），把统计结果返给调用方；
单个请求删除的文件数超过 `MAX_DELETE_FILES`（1000）直接拒绝并告知数量，
避免一次点击抹掉整个工作目录而没有可读的回执。

## 4. 剪切板服务（`backstage/services/clipboard.service.ts`）

```ts
export type ClipboardAttachment = { name: string; bytes: number; }   // 存储位置的推导见下
export type ClipboardEntry = {
  id: string
  text: string
  bytes: number
  source: string
  createdAt: number
  attachments: ClipboardAttachment[]
  attachBytes: number
  /** 本条的队列位置，1 是最新 */
  position: number
}

// ⚠️ evicted 是 **string[]**：剪辑板 id 是 TEXT/ULID，库里没有数字 id。
// 界面要的是「清掉了哪几条」，而 id 就是那件事的唯一标识。
createText(input: { text: string; source?: string; idemKey?: string })
  : Promise<{ entry: ClipboardEntry; evicted: string[] }>

createWithAttachments(input: {
  text: string
  source?: string
  attachments: Array<{ name: string; stream: ReadableStream<Uint8Array> }>
}) : Promise<{ entry: ClipboardEntry; evicted: string[] }>

list(input: { limit?: number; offset?: number; query?: string })
  : Promise<{ entries: ClipboardEntry[]; total: number; maxItems: number }>

get(id: string) : Promise<ClipboardEntry>
updateText(id: string, text: string) : Promise<ClipboardEntry>
remove(id: string) : Promise<{ removed: boolean }>        // 同时删掉 <clipboardRoot>/<id>/
clear() : Promise<{ removed: number }>
```

**纪律：**
- 「每次粘贴创建一条新记录」= 只有 `createText` / `createWithAttachments` 入队；
  `updateText` 是纠错，不改变队列顺序。
- 超长淘汰：插入成功后 `dbClipboardPrune(maxItems)`，被淘汰的 id 要连同附件目录一起删，
  并且**返回值里带上被淘汰的 id**，让 UI 能说清"顺手清了 2 条"。
- 文本上限 `clipboard.maxTextBytes`：超了**拒绝**，不截断。
- 附件名要消毒（只留 basename，去掉路径分隔符与控制字符），落盘为
  `<clipboardRoot>/<entryId>/<sanitized>`；附件总大小上限 32MiB/条。
- 附件下载走 `clipboardAttachmentPath(entryId, name)` → 校验后返回绝对路径。

## 5. 脚本运行（`backstage/services/runner.service.ts`）

```ts
export type ScriptInfo = {
  name: string
  bytes: number
  mtimeMs: number
  /** 文件开头 80 字符的用途说明；脚本第一行注释会被当作描述 */
  description: string
  /** 最近一次运行（可为空） */
  lastRun?: { status: RunStatus; exitCode: number | null; startedAt: number; durationMs: number }
}

export type RunStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'killed'

export type RunResult = {
  status: RunStatus
  exitCode: number | null
  signal: string
  startedAt: number
  endedAt: number
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  recordId: number
}

export listScripts() : Promise<ScriptInfo[]>
export buildEnv(extra?: Record<string,string>) : Record<string,string>   // 见下
// priority / timeoutMs / origin 是实现期补的三个可选字段：
//   priority  —— 契约正文要求（探针不受并发闸门影响）
//   timeoutMs —— ProbeScript.timeoutMs 与治理动作需要
//   origin    —— run_records.origin('workspace'|'temp'|'probe'|'metric'|'action')，
//                见 docs/02-data-model.md §5
export runWorkspaceScript(input: {
  name: string; args?: string[]; triggeredBy?: string
  priority?: boolean; timeoutMs?: number; origin?: RunOrigin
  onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void
}) : Promise<RunResult>
export runTempScript(input: {
  name: string; content: string; args?: string[]; triggeredBy?: string
  priority?: boolean; timeoutMs?: number; origin?: RunOrigin
  onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void
}) : Promise<RunResult>
export listRuns(limit: number, script?: string) : RunRow[]
export getRun(id: number) : RunRow | undefined
```

**注入的环境变量（脚本的稳定接口，脚本不关心实际目录结构）：**

| 变量 | 含义 |
|---|---|
| `RAVEN_WORKSPACE` | 文件管理器那棵树的绝对路径（脚本的默认输出位置） |
| `RAVEN_FILES` | 同 `RAVEN_WORKSPACE`；语义化别名 |
| `RAVEN_UPLOADS` | `<workspace>/uploads`，约定俗成的上传落点（会自动建） |
| `RAVEN_TMPDIR` | 本次运行的临时目录（跑完删除） |
| `RAVEN_CLIPBOARD` | 剪切板附件目录 |
| `RAVEN_SCRIPTS` | 脚本目录 |
| `RAVEN_SCRIPT_NAME` | 脚本文件名 |
| `RAVEN_SCRIPT_ARGS` | 参数数组的 JSON |
| `RAVEN_ROOT` | `rootPath`（**只读用途**；脚本不得在它下面乱写） |
| `RAVEN_API` | raven 的基址，脚本可回调 API |
| `RAVEN_TOKEN` | 本次运行的一次性令牌；放 `POST /api/ingest/metrics` 的 `x-ownspire-token` |
| `RAVEN_RUN_ID` | 运行记录 id（先占位，结束时回填） |
| `RAVEN_VERSION` | raven 版本 |
| 配置里的 `scripts.env` | 逐条展开 `{workspace}` `{uploads}` `{tmp}` `{clipboard}` `{scripts}` `{root}` 占位符 |

**执行纪律：**
- 用 `node --input-type=module -`（临时脚本走 stdin）或 `node <abs>`（workspace 脚本），
  `cwd = RAVEN_WORKSPACE`（临时脚本 `cwd = RAVEN_TMPDIR`）。
- 并发上限 `execution.maxConcurrent`；超了排队（FIFO），不是报错。
  `runWorkspaceScript` / `runTempScript` 接受可选的 `priority?: boolean`：
  **只跳过并发闸门，不跳过任何计数或记录** —— 健康采集的 script 探针与指标探针
  必须用 `priority: true`，否则「2 个长任务占满槽位」会让整个 Dashboard 停摆，
  而那是运维最先看的页面。`MAX_PRIORITY_INFLIGHT = 4` 作为兜底上限。
- 超时 `execution.timeoutMs`：**杀整个进程组**（`detached: true` + `process.kill(-pid)`），
  否则 ffmpeg/yt-dlp 这类会留下孙子进程继续往磁盘写（那会绕过配额统计）。
  超时判定用 `timeout`（SIGTERM 给进程组）后再 `SIGKILL` 收尾。
- stdout/stderr 各自封顶 `execution.maxOutputBytes`，超了截断并置 `truncated`，
  但**输出仍继续消费**（不消费会让子进程被管道写阻塞，看起来像卡死）。
- 每次运行写一条 `run_records`；`onStdout`/`onStderr` 回调是**尽力而为**的流式展示，
  最终权威结果永远是 `RunResult`（一次回调都没收到也要能跑完）。
- `runTempScript` 的临时目录建在 `sandbox.tempRoot` 下，`finally` 里删掉，
  失败也不能泄漏（实在删不掉就记一行日志，不要让运行结果变成失败）。

## 6. 服务注册表与健康采集

`backstage/services/registry.service.ts`

```ts
export type ServiceSnapshot = {
  def: ServiceDef
  /** 'inline' = 写在 config.services.defs；否则是定义文件的绝对路径 */
  origin: string
  enabled: boolean
  persistable: boolean   // 只在定义文件里的服务可被 API 改写
}
export loadRegistry() : Promise<ServiceSnapshot[]>            // 内联 + registryFile 文件，按 id 合并
export findService(id: string) : Promise<ServiceSnapshot>
export upsertService(def: ServiceDef) : Promise<{ snapshot: ServiceSnapshot; created: boolean }>
export removeService(id: string) : Promise<{ removed: boolean }>
export registryFilePath() : string
```

`backstage/services/health.service.ts`

```ts
export type ProbeResult = {
  index: number; type: Probe['type']; status: 'ok'|'warn'|'down'
  latencyMs: number; message: string; version: string
}
export type HealthReport = {
  serviceId: string
  status: 'ok'|'warn'|'down'|'unknown'
  latencyMs: number | null
  message: string
  version: string
  checkedAt: number
  okCount: number
  totalCount: number
  probes: ProbeResult[]
  fromCache: boolean
}
export checkService(snapshot: ServiceSnapshot, options?: { force?: boolean })
  : Promise<HealthReport>
```

**状态判定：** 全部 ok → `ok`；有 ok 也有异常 → `warn`；全异常或没有探针 → `down`/`unknown`。
**缓存（重要）：** 最近一次采样早于 `services.sampleIntervalSeconds` 就直接返回缓存并置
`fromCache: true`；`force` 绕过。Dashboard 的轮询不能每次都打上游 —— 上游是别的服务，
不是 raven 的免费资源。
**落库：** 每次真实采样写 `service_samples`（历史） + `service_snapshots`（最新），按 `historyLimit` 修剪。
**docker 探针：** 优先走 Docker Engine API over unix socket（`/var/run/docker.sock`，可用 `RAVEN_DOCKER_SOCK` 覆盖），
拿不到 socket 时回退 `docker inspect`。两者都不行就明确报「无法访问 Docker」而不是含糊的 down。

`backstage/services/dashboard.service.ts`

```ts
export type DashboardService = {
  id: string; title: string; kind: string; summary: string; enabled: boolean
  origin: string; persistable: boolean
  endpoints: { label: string; url: string }[]
  entities: EntityDef[]
  repo?: string
  baseUrl?: string
  tags: string[]
  health: HealthReport
  metrics: Array<{ metric: string; value: number; unit: string; at: number }>
  history: Array<{ status: string; latencyMs: number | null; checkedAt: number; message: string }>
  actions: Array<{
    id: string; title: string; description: string
    readonly: boolean; needsConfirm: boolean
    // ⚠️ confirmPhrase 必须下发。不下发的话界面只能硬编码 `yes`，
    // 而配置里写了自定义确认词的动作会**永远跑不起来**（前端发 yes、
    // 服务端要 backup-atlas，稳定 400），且报错看起来像权限问题。
    confirmPhrase: string
  }>
  // 契约补充：metricProbes 必须下发，否则「跑一次」按钮拿不到 probeId。
  metricProbes: Array<{ id: string; title: string; script: string; timeoutMs?: number }>
  // 契约补充：注册表文件遮蔽内联同名定义时的人话提示，界面要显示出来。
  warning?: string
}
export getDashboard(options?: { force?: boolean }) : Promise<{
  generatedAt: number
  services: DashboardService[]
  totals: { ok: number; warn: number; down: number; unknown: number; total: number }
  config: { collect: boolean; sampleIntervalSeconds: number }
}>
export collectAll(options?: { force?: boolean }) : Promise<{ collected: string[]; cached: string[] }>
export runMetricProbe(serviceId: string, probeId: string) : Promise<{ metrics: {metric:string;value:number;unit:string}[]; report: RunResult }>
export runAction(serviceId: string, actionId: string, options?: { trigger?: string }) : Promise<RunResult>
export registerService(input: { def: ServiceDef; token: string | null }) : Promise<{ snapshot: ServiceSnapshot; created: boolean }>
```

**指标脚本 stdout 约定**（两种都认）：
```json
{ "metrics": [ { "name": "db_bytes", "value": 1234, "unit": "B" } ], "message": "可选" }
```
```json
{ "db_bytes": 1234, "media_bytes": 567 }     ← 扁平对象，unit 一律 ''
```
再兜一层：整行解析失败就尝试从输出里找**最后一个**能解析成 JSON 的行。

## 7. SSE 事件形状（`backstage/lib/sse.ts`）

脚本运行与治理动作都用它，前端一套解析逻辑吃到底：

```
event: start    data: { script, runId?, startedAt, origin }
event: stdout   data: { chunk: string }
event: stderr   data: { chunk: string }
event: metrics  data: { items: [{metric,value,unit}] }     // 仅指标探针
event: done     data: RunResult（见 §5）
event: error    data: { code, error }
```

`createSseStream(work: (emit) => Promise<void>)` → `Response`（`text/event-stream`，
`Cache-Control: no-cache, no-transform`，`X-Accel-Buffering: no`）。
`work` 抛错时把它作为 `error` 事件发出去，**HTTP 状态仍是 200**（头已经发出去了）。

## 8. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/setup` | `{pin,confirmPin}` → 设 PIN 并发 cookie。**仅首次可用**，已设则 409 |
| POST | `/api/auth/login` | `{pin}` → 设 cookie |
| POST | `/api/auth/pin` | `{currentPin,pin,confirmPin}` → 换 PIN，**需登录**，换发 cookie |
| POST | `/api/auth/logout` | 清 cookie |
| GET | `/api/auth/session` | 当前会话 + `pin:{configured,length}` + `publicConfig()` |
| GET | `/api/files` | `?path=&search=&sort=&order=` 列目录 |
| PUT | `/api/files/upload` | `?path=dir/name.ext[&overwrite=1]`，**裸流** body |
| GET | `/api/files/download` | `?path=` 流式下载（`Content-Disposition: attachment`） |
| GET | `/api/files/raw` | `?path=` 内联返回（图片/文本预览） |
| GET | `/api/files/content` | `?path=` 读文本（编辑器用） |
| PUT | `/api/files/content` | `{path,text}` 存文本 |
| POST | `/api/files/mkdir` | `{path}` |
| POST | `/api/files/rename` | `{from,to}` |
| POST | `/api/files/move` | `{from,to,overwrite?}` |
| POST | `/api/files/copy` | `{from,to,overwrite?}` |
| POST | `/api/files/delete` | `{paths:[]}` |
| GET | `/api/files/stats` | 配额与用量 |
| GET | `/api/clipboard` | `?limit=&offset=&q=` |
| POST | `/api/clipboard` | `{text,source?,idemKey?}` |
| POST | `/api/clipboard/attachments` | multipart：`text` + 文件字段 |
| GET | `/api/clipboard/[id]/attachment` | `?name=` 取附件 |
| PATCH | `/api/clipboard/[id]` | `{text}` |
| DELETE | `/api/clipboard/[id]` | 删一条（含附件） |
| DELETE | `/api/clipboard` | 清空 |
| GET | `/api/scripts` | 脚本列表 + 配置 + 最近运行 |
| POST | `/api/scripts/run` | `{name,args?}` → **SSE** |
| POST | `/api/scripts/run-temp` | multipart：`file` + `args` → **SSE** |
| GET | `/api/scripts/runs` | `?limit=&script=` |
| GET | `/api/scripts/runs/[id]` | 单条运行详情（含完整输出） |
| GET | `/api/services` | Dashboard 数据（`?force=1` 绕过采样缓存） |
| GET | `/api/services/[id]` | 单个服务详情 |
| POST | `/api/services/collect` | 强制采一轮 |
| POST | `/api/services/[id]/metrics` | `{probeId}` 跑指标脚本 |
| POST | `/api/services/[id]/actions` | `{actionId}` → **SSE** |
| POST | `/api/services/registry` | 注册/更新（需登录 **或** 注册令牌） |
| DELETE | `/api/services/registry/[id]` | 注销（只能删文件里的，不能删内联） |
| POST | `/api/ingest/register` | 服务自注册（`x-ownspire-token`） |
| POST | `/api/ingest/metrics` | 外部推指标（`x-ownspire-token`） |
| GET | `/healthz` | `{ok,version,root,quota}`，**不返回任何路径细节之外的敏感信息** |

## 9. 前端约定

- `lib/api.ts`：`apiGet/apiPost/apiDelete/apiUpload`，统一解析 `{ok,...}` 信封，
  失败时抛 `ApiClientError { code, message, status }`。
- 服务端组件只做「取配置/取会话」这类轻活；交互密集的页面用 `'use client'` +
  自己的 `fetch`，**不引入状态管理库**（三个页面各自 `useState` 就够）。
- 样式走 Tailwind 4 + `@theme inline`；`cn()` 在 `lib/utils.ts`。
- 中文界面。错误一律把 `error` 字符串显示出来，不要吞掉。

---

## 10. 实现期定案（v0.1 冻结后的补充，都已落进代码与验证）

契约是冻结的，但下面这些是**实现时才发现必须定的**。逐条记在这里，
免得下一个人从代码里反推为什么是这样。

| 项 | 定案 | 理由 |
|---|---|---|
| 剪切板淘汰返回值 | `string[]`（不是 `number[]`） | id 是 TEXT/ULID，没有数字 id 可返回 |
| `runWorkspaceScript` 入参 | 补 `priority` / `timeoutMs` / `origin` | 探针、指标脚本、治理动作三者对并发与超时的需求不同 |
| `DashboardService` | 补 `metricProbes` / `warning` / `actions[].confirmPhrase` | 不下发就等于界面上那两个功能不可用（详见上文注释） |
| 服务层错误类型 | `SandboxError`（不 import `next/server`） | 让验证脚本能在纯 Node 直调 service 层 |
| 临时脚本落盘扩展名 | 强制 `.mjs` | `.js` 的 ESM/CJS 取决于最近的 `package.json` 的 `type`，同一份内容在不同目录语义不同 |
| `updateText` 实现 | delete + insert（保留 id/createdAt，失败回滚） | 避免在服务层写裸 SQL；库里目前没有单列更新助手 |
| `rename` 的覆盖语义 | **不覆盖**，撞到就 409 | 要覆盖用 `move` + `overwrite`：改名和覆盖是两件事，混在一起容易一次点错丢掉文件 |
| `consumeRunToken` | 有效期内可重复 + 滑动续期，不是一次性核销 | 一次运行可能分多批推指标（`metricCalls` 就是为此存在） |
| Docker 探针 | socket 优先，CLI 兜底；超时不退 CLI | CLI 走同一个 daemon，再等一轮只是把耗时翻倍 |
| HTTP 探针重定向 | `redirect: 'manual'`，3xx 判 `warn` 并报出 Location | 跟随重定向会掩盖 `baseUrl` 写错，也可能跳到未授权的主机 |
| 指标命名空间 | 点号（`navi.db_bytes`） | 与配置里的 `metricPrefix` 直观对应 |
| `next` 版本 | **精确锁 16.3.8** | 16.4.0 下 Turbopack 构建立刻失败（`Cannot find module '@vercel/turbopack/postcss'`），而 `--webpack` 能过 —— 属于上游回归，不是本项目配置问题。锁精确版本，不用 `^` |
