# 服务注册表 · 健康检查 · 指标采集

这是 raven 第 3 项功能的机制说明书。**先定数据结构，再谈采集** —— 因为「采集什么」
是由「注册了什么」决定的，反过来做就会写出一堆只为当前三个服务服务的硬编码。

---

## 1. 为什么是「文件 + 内联」两层

服务定义有两个来源：

| 来源 | 位置 | 谁能改 | 用途 |
|---|---|---|---|
| 内联 | 配置文件的 `services.defs` | 只有改配置文件 | 基线、跨环境共用的定义、谁都不能从 UI 删掉的东西 |
| 注册表文件 | `services.registryFile`（默认 `<rootPath>/services.json`） | 配置文件 + HTTP API | 具体部署：端口、容器名、数据目录、地址；服务自注册写这里 |

两者按 `id` 合并，**文件优先**（同 id 时文件覆盖内联，并在快照上记一条 `warning` 让 Dashboard 能说明这件事）。
内联服务不可被 API 删除（`origin: 'inline'`, `persistable: false`）。

**为什么不做成数据库表**：注册表是**部署描述**，它要能被人 `cat`、被 git 管、被别的部署工具重新生成。
放进 SQLite 会变成「想改一条服务定义得先连上那个服务的 UI」—— 而 UI 挂了的时候你正需要改它。
健康**样本**才进数据库，因为那是时间序列，量级和用途完全不同。

写文件是原子的（同目录临时文件 + `rename`），并且**永不丢内联定义**。

---

## 2. 服务定义字段

```jsonc
{
  "id": "creative-atlas",              // 必填，[a-z0-9._-]，合并的主键
  "title": "Creative Atlas",           // 必填，界面显示名
  "kind": "ownspire",                  // ownspire | external，只影响分组展示
  "summary": "一句话说明",
  "repo": "/Users/token/pre-research/creative-atlas",
  "baseUrl": "http://127.0.0.1:5601",  // http 探针写相对路径时的基址

  "endpoints": [                       // 界面上可以直接点开的地址；不参与探针
    { "label": "本机", "url": "http://127.0.0.1:5601" }
  ],

  "entities": [                        // 「这个服务有几份、跑在哪」
    {
      "id": "primary",
      "port": 5601,
      "source": "ownspire-infra/services/atlas",
      "dataDir": "/srv/ownspire/data/atlas",
      "capabilities": ["healthz", "sqlite", "media"],
      "notes": "容器端口 5600，宿主 127.0.0.1:5601"
    }
  ],

  "probes": [ /* 见 §3 */ ],
  "metrics": [ /* 见 §4 */ ],
  "actions": [ /* 见 §5 */ ],
  "tags": ["采集"],
  "enabled": true                      // 缺省 true；false 时只展示不采集
}
```

`entities` 里的字段都是**给人看的**，raven 不去校验它们是否与事实相符 ——
它们的作用是让 Dashboard 上能回答「这个东西的数据在哪、端口多少、谁在管」，
而不必 SSH 上去翻 compose 文件。**刻意保持只读**：raven 不替你改别的服务的配置。

---

## 3. 探针（probes）

按数组顺序跑，每个探针必须有唯一的 `type`：

| type | 必填 | 说明 |
|---|---|---|
| `http` | `url` | `url` 可以是完整地址，也可以是相对 `baseUrl` 的路径。`expectStatus` 钉住状态码（缺省 2xx 即健康）；`expectJson` 要求 body 里这些字段相等；`versionField` 从 body 取版本号。 |
| `tcp` | `host` + `port` | 只判「能不能连上」。给没有 HTTP 接口的东西用。 |
| `docker` | `container` | 优先走 Docker Engine API over unix socket（`RAVEN_DOCKER_SOCK` 可覆盖），拿不到 socket 时回退 `docker inspect`。两者都不行会明确报「无法访问 Docker」而不是含混的 down。 |
| `file` | `path` | `path` 绝对或相对 `rootPath`。`maxAgeSeconds` 判新鲜度、`minBytes` 判有没有内容。给「备份有没有按时产出」这类检查用。 |
| `script` | `script` | 跑 `<rootPath>/<scriptsDir>/` 下的脚本（`priority: true`，不受并发上限影响）。退出码 0 即 ok；脚本可以在 stdout 打一行 JSON 覆盖判定与说明：`{"status":"warn","message":"..."}`。 |

**汇总规则**：全部 ok → `ok`；有 ok 也有异常 → `warn`；全异常 → `down`；一个探针都没配 → `unknown`。
`latencyMs` 取**最慢**那个探针的耗时 —— 那是能解释「页面为什么慢」的数字，平均值会把它稀释掉。

**脚本探针为什么要 `priority`**：健康采集如果排在用户的长任务后面，
「两个 10 分钟的下载占满槽位」就会让整个 Dashboard 停摆 —— 而 Dashboard 恰恰是你那时最想看的东西。
`priority` 只跳过并发闸门，计数与运行记录一个都不少（有 4 个并发上限兜底）。

---

## 4. 指标脚本（metrics）

```jsonc
{
  "id": "db-size",
  "title": "数据库与媒体体积",
  "script": "db-size.mjs",
  "args": ["/srv/ownspire/data/atlas"],
  "metricPrefix": "atlas"      // 可选，给所有指标名加前缀，避免多服务撞名
}
```

stdout 必须是**一行 JSON**，两种形状都认：

```json
{ "metrics": [ { "name": "db_bytes", "value": 12345, "unit": "B" } ], "message": "可选说明" }
```

```json
{ "db_bytes": 12345, "media_files": 42 }
```

再兜一层：整行解析失败时，会尝试输出里**最后一个**能解析成 JSON 的行 ——
脚本里夹带进度输出（yt-dlp、npm 都这样）时不用为此改脚本。

约定与纪律：

- 值必须是**数字**。换算成人类单位是展示层的事：`bytes` 一律给字节、`files` 一律给个数。
  换算过的数字在设报警阈值时没法用（阈值要跟着单位一起改）。
- 非数字的值会被**丢掉**并计入 `message`，不会写成 0 —— 0 和「没采到」在图上完全不同。
- 采集会写 `run_records`，所以指标脚本失败的原因在运行历史里能查到，不必去翻服务日志。
- 采样频率由采集轮次决定（`sampleIntervalSeconds`），每个 `(服务, 指标)` 保留
  `metricHistoryLimit` 条（默认 500）。

---

## 5. 治理动作（actions）

```jsonc
{
  "id": "backup",
  "title": "备份（db + media）",
  "script": "ownspire.mjs",
  "args": ["atlas", "backup"],
  "readonly": false,
  "confirmPhrase": "backup-atlas"
}
```

- `readonly: true` 的动作（看日志、drill、探活）点一下就跑。
- 非只读动作需要调用方传 `confirm`，且必须等于 `confirmPhrase`（缺省 `yes`）。
  **这是刻意的摩擦**：备份、重启、恢复这类动作误触的代价是数据，而确认框的成本是两秒。
- 每次动作运行都写 `run_records`，`triggeredBy` 记成 `action:<服务>/<动作>`，
  这样「谁在什么时候按了备份」在运行历史里是一条可查的记录，而不是一条日志。
- raven **不做**动作排队、重试、回滚。它是「按一下就执行、并把输出给你看」的窗口，
  不是编排引擎 —— 假装自己是编排引擎比不做更危险。

---

## 6. 采集与缓存

- 每个服务的健康快照落 `service_snapshots`（最新一条），历史落 `service_samples`。
- **最短采样间隔**：`sampleIntervalSeconds`（默认 30s）。Dashboard 轮询、页面刷新都不会
  比它更密地打上游；`?force=1` 才绕过。缓存命中时报告里带 `fromCache: true`，
  界面必须显示「数据是缓存的」，否则你会对着 5 分钟前的绿点做判断。
- `collect: false` 是**总开关**：采集变成 no-op，但仍返回已存的快照。
  服务出问题怀疑是 raven 在打它时，这个开关比改代码快。
- 历史修剪：`historyLimit`（服务健康）、`metricHistoryLimit`（指标），每次采集后执行。

## 7. 服务自注册

`POST /api/ingest/register`，请求头 `x-ownspire-token: <services.registrationToken>`，body：

```json
{ "def": { "id": "new-service", "title": "New Service", "baseUrl": "http://127.0.0.1:5900",
           "probes": [{ "type": "http", "url": "/healthz", "expectJson": { "ok": true } }] } }
```

- **没设 `registrationToken` 就是关闭的**（不是「空令牌可通」—— 那个 bug 在验证里被钉住过）。
- 注册进的是注册表**文件**，因此可被 API 改、也可被 API 删。
- 注册完立刻做一次健康检查，注册失败不会留下半条记录。

`POST /api/ingest/metrics` 同一套令牌；脚本运行时还会拿到一个**一次性**令牌
（`RAVEN_TOKEN`），服务可以把运行期指标推回来，这样脚本不用自己算平均值。

## 8. 已注册的 ownspire 服务

`config/services.example.json` 里已经把现有三个项目都登记好了：

| 服务 | 地址 | 数据 | 备注 |
|---|---|---|---|
| creative-atlas | `127.0.0.1:5601`（容器 5600） | `/srv/ownspire/data/atlas`（db + media） | 备份必须成对带走 db 与媒体包 |
| navi | `127.0.0.1:5501`（容器 5500） | `/srv/ownspire/data/navi`（只有 db） | 有 `drill` 恢复演练 |
| shadow-atlas | `127.0.0.1:5700`（本机开发） | `~/.local/share/shadow-atlas` | 还没进 ownspire-infra，暂无 docker 探针 |
| raven | `127.0.0.1:5801`（容器 5800） | `/srv/ownspire/data/raven` | 自监控 |

⚠️ 示例里的地址是**本机约定**。真实部署（Tailscale 域名、非标准端口）请改注册表文件，
不要改代码 —— 这正是注册表存在的理由。
