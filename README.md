# Ownspire Raven

Ownspire 的中枢：**受管文件目录 + 网络剪切板 + 脚本运行台 + 服务 Dashboard + Agent 对话界面**，
五件事在同一个登录后面。

前身是三个各自独立的项目（[creative-atlas](../creative-atlas) / [navi](../navi) / [shadow-atlas](../shadow-atlas)），raven 不动它们，只把它们**收进一张运维视图**，并提供一块共用的「能放东西、能跑脚本」的地。

端口：容器内 **5800**，宿主 **5801**（atlas 占 5600/5601，navi 占 5500/5501，shadow-atlas 本地占 5700）。改仓库前请先读 [AGENTS.md](AGENTS.md)。

---

## 五块能力

### 0. Agent 对话界面

`/agent` 页把 [ownspire-agent](../ownspire-agent)（业务无关的 Agent Runtime）接进raven 的登录态：
流式对话、工具调用卡片、以及**授权弹窗**。

**raven 在这里只做两件事，都不含 Agent 逻辑**：

| raven 侧 | 角色 |
|---|---|
| `app/api/agent/*` | **BFF**：校验自己的登录态，带 token 转发给 agent。不存会话、不缓存消息、不加工事件 |
| `app/api/agent/gateway` | **反向 gateway**：把自己的能力（文件 / 剪切板 / 用量 / 服务状态）暴露成 agent 能调的工具 |

**token 永远不下发到浏览器** —— 浏览器只跟 raven 说话，由 raven 带
`AGENT_RUNTIME_TOKEN` 转发。`backstage/services/agent.service.ts` 标了 `server-only`，
一旦有人从客户端组件 import 它，打包会直接失败，而不是悄悄把密钥打进 bundle。

⚠️ **`proxy.ts` 只放行 `/api/agent/gateway` 这一个 route**，不是整个 `/api/agent` 前缀 ——
放行前缀等于让任何进程拿着 token 就能读全部会话。同前缀下的 `tools` / `sessions` / `messages`
必须继续要 raven 的登录态。

**gateway v1 只开放只读操作。** 写操作（`files.write` / `files.remove` /
`clipboard.add` / `scripts.run`）返回 **501 + 说明为什么**：授权流程先在一个必然失败的
工具上验过一遍，拿真能删文件的工具去验审批，一旦链路有洞就是真的删掉了东西。

**路径判定留在 raven**（`backstage/lib/sandbox.ts`），agent 侧一个检查都不做——
两份判定会漂移，而漂移的那一次就是越界。

配置见 `.env.example` 的 `AGENT_RUNTIME_URL` 与 `AGENT_RUNTIME_TOKEN`；
不配时 `/agent` 页会显示「Agent Runtime 不可用」，其余四页不受影响。

### 1. 受管工作目录

`rootPath` 是**唯一**的边界，任何操作不得越过它 —— 越界判定在 `backstage/lib/sandbox.ts`，先 `realpath` 再比完整路径段，所以软链也绕不过去。

```
rootPath/
├── workspace/     ← 文件管理器唯一可见的树；配额只算这一棵
├── scripts/       ← 脚本运行台只认这里的 *.mjs / *.js
├── tmp/           ← 临时上传的脚本在这里跑，跑完即删
└── clipboard/     ← 剪切板附件
```

`workspace.quotaBytes` 是目录总大小上限（字节，`null` = 不限）。判定在写入之前，超了回 **507** 并告诉你要写多少、还剩多少；写到一半超了会中止、删掉半截文件。

文件管理器提供：浏览 / 搜索 / 排序、上传（带进度、原子落盘）、下载、在线看图片、文本编辑、新建目录、重命名、移动、复制、删除（带「将删 N 个文件」的回执）。上传是**裸流量** `PUT`，所以 `curl --upload-file` 和脚本都能直接用，不需要先学一套 multipart 协议。

### 2. 网络剪切板

**每次粘贴 = 一条新记录。** 队列长度由 `clipboard.maxItems` 决定，超出按时间从旧到新淘汰，被淘汰的附件目录一起删掉。文本超过 `maxTextBytes` 是**拒绝**而不是截断 —— 截断是静默的数据损坏。

支持拖入附件（单条合计上限 32 MiB）。界面上的主交互就是「粘贴」，焦点默认在输入框，`Ctrl/Cmd+Enter` 也能手动提交。

### 3. 脚本运行台

`scripts/` 下的脚本可以在界面上点着跑，结果实时流式显示（stdout / stderr / 退出码 / 耗时 / 超时）。也支持**临时上传脚本直接跑**，跑完临时目录删除。

脚本对目录结构的全部认知就是几个环境变量，所以脚本换部署、换 `rootPath`、换配额都不用改：

| 变量 | 含义 |
|---|---|
| `RAVEN_WORKSPACE` / `RAVEN_FILES` | 工作目录（脚本的默认输出位置） |
| `RAVEN_UPLOADS` | `<workspace>/uploads`，约定俗成的上传落点 |
| `RAVEN_TMPDIR` | 本次运行的临时目录，跑完删除 |
| `RAVEN_CLIPBOARD` / `RAVEN_SCRIPTS` / `RAVEN_ROOT` | 对应的目录 |
| `RAVEN_SCRIPT_NAME` / `RAVEN_SCRIPT_ARGS` | 脚本名与参数（JSON 数组） |
| `RAVEN_API` / `RAVEN_TOKEN` | raven 基址与本次运行的一次性令牌（可回推指标） |
| `RAVEN_VERSION` | raven 版本 |

`scripts.env` 里可以再注入自定义变量，值支持 `{workspace}` `{uploads}` `{tmp}` `{clipboard}` `{scripts}` `{root}` 占位符 —— 例如给 yt-dlp 用的画质、cookie 路径。

仓库自带几个能直接跑的示例（`scripts/examples/`，`npm run init` 会拷进 `scripts/`）：

- `bilibili-download.mjs` —— **需求里点名的场景**：给一个哔哩哔哩链接，下到工作目录的 `downloads/`。依赖 `yt-dlp`，画质从 `BILI_QUALITY` 来。
- `disk-usage.mjs` —— 工作目录用量；演示「中间产物只写 `RAVEN_TMPDIR`」。
- `db-size.mjs` —— 指标脚本样板：stdout 打一行 JSON。
- `tail-log.mjs` —— 既当健康探针（`--check` 打 JSON 状态）又当治理动作（看容器日志）。

执行纪律：超时**杀整个进程组**（否则 yt-dlp 会留下孙子进程继续写盘，绕过配额统计）；输出超限截断但仍继续消费（不消费子进程会被管道写阻塞）；并发上限之外排队而不是报错；每次运行都写一条 `run_records`。

### 4. 服务 Dashboard 与健康采集

服务注册表是**文件**（默认 `<rootPath>/services.json`），加上配置里的内联定义，按 `id` 合并、文件优先。注册表里描述四件事：

- **探针**：`http` / `tcp` / `docker` / `file` / `script` 五种，按顺序跑，全 ok → `ok`，部分 ok → `warn`，全挂 → `down`。
- **指标脚本**：跑一个脚本，stdout 打一行 JSON，raven 拆成时序样本存下来。
- **治理动作**：Dashboard 上按一个按钮就跑的脚本（读日志、备份、drill、重启），非只读的必须输入确认词。
- **实体与地址**：服务有几份、跑在哪、数据在哪、对外地址是什么。

采样有**最短间隔**（`sampleIntervalSeconds`，默认 30s）：Dashboard 轮询不会每次打上游。上游是别的服务，不是 raven 的免费资源 —— 这条在实现里是硬约束，不是建议。

`/healthz` 返回 `{ ok, version, root, quota }`；不返回任何路径与密钥。ownspire-infra 的 deploy 靠 `version` 判断「跑的是哪一版」，与 atlas / navi 同一套契约。

完整机制说明：[docs/03-service-registry.md](docs/03-service-registry.md)。

---

## 登录

单账号、全权限，账号密码写在配置里。想避免明文就用散列：

```bash
npm run hash-password '你的密码'      # 输出 scrypt$... ，填进 auth.passwordHash，删掉 auth.password
```

改用户名或密码会让已签发的会话**立即失效**（会话里带配置指纹，不是靠过期时间兜）。连续登录失败会按 IP 限流（`auth.loginRateLimit`）。

登录态是 HttpOnly 的签名 JWT，签名密钥是 `SESSION_SECRET`（**必填**，至少 16 字符）。换掉它等于让所有人重新登录 —— 那是它的用途。

---

## 本地开发

需要 Node.js 24.15 或更新。

```bash
npm install
cp .env.example .env                      # 填 SESSION_SECRET（至少 16 字符）
cp config/raven.config.example.json config/raven.config.local.json
# 改 rootPath 与 auth，然后：
npm run init                              # 建目录 + 建表 + 播种服务注册表与示例脚本
npm run dev                               # http://127.0.0.1:5800
```

`npm run init` 是可选的：`/healthz` 每次被调用时都会顺手把受管目录与表建好（幂等），
而 `next dev` 起来之后浏览器一打开就会先打它。init 的价值在于**顺便播种** ——
把 `config/services.example.json` 拷成受管根下的 `services.json`，
并把 `scripts/examples/*.mjs` 拷进脚本目录，这样第一次打开界面就有东西可点。

> ⚠️ **`next` 精确锁在 `16.3.8`，不要改成 `^`。**
> 16.4.0 下 Turbopack 构建立刻失败（`Cannot find module '@vercel/turbopack/postcss'`），
> 而同一个仓库换 `--webpack` 就能过 —— 是上游回归，与本项目配置无关。
> 升级时请连着跑一遍 `npm run build`，别只看 `npm install` 是否成功。

本机 `next dev` / `next build` 会撞上 WorkBuddy 对 `rename` 的拦截，所以 `dev` / `build` 都以前置脚本 `scripts/prepare-next.mjs` 开头（把 `.next` 链到工作区外）。来龙去脉写在 `scripts/next-dir.mjs` 顶部 —— **加新脚本时，凡是用到 `.next` 的命令都要先跑它。**

## 验证

```bash
npm run typecheck      # tsc --noEmit
npm run build          # Turbopack 构建（锁 16.3.8 的原因见上）
npm run verify         # 配置 / 沙箱 / 鉴权 + 文件 / 剪切板 / 脚本 + 注册表 / 健康采集
npm run verify:config  # 只跑配置/沙箱/鉴权
```

`npm run verify` 当前是 **123 条通过、1 条失败**，覆盖三类 tsc 抓不到的错误：
路径穿越（含软链逃逸）、配额与并发预留、超时杀整个进程组（含孙子进程）、
队列淘汰与附件清理、SSE 帧形状、注册表合并与遮蔽。

> ⚠️ **那条失败是既有的**（2026-10-08 实测，与Agent 改动无关）：
> 「剪切板：32MiB 附件上限」期望 `attachments_too_large`，实际拿到 `quota_exceeded` ——
> 配额校验先触发了。要查它得先确认 `config/raven.config.example.json` 的 `quotaBytes`
> 够装下测试要写的 33MiB。

`verify` 直接调 service 层，不经过 HTTP。**改 service 层就必须补断言** —— 沙箱越界、队列淘汰、超时杀进程组这三类错误 tsc 一个都抓不到。

## 部署和备份

通过 [ownspire-infra](../ownspire-infra) 部署（`node ownspire.mjs raven deploy`）。备份要**一起**带走 `raven.db`、`workspace/`、`clipboard/`：数据库只存元数据与相对路径，文件本体在目录里 —— 只备 db 等于丢掉全部文件和附件。细节见 [docs/04-deploy.md](docs/04-deploy.md)。
