# Workbench — dsh 自托管工作台(阶段一)

自托管 AI 工作台的第一步:DeepSeek Harness(dsh)标准模式,承担日常聊天与
meta 层工作任务。设计文档见 `/Users/token/WorkBuddy/Claw/Workbench/DESIGN.md`。

## 快速启动

```bash
cp .env.example .env       # 可选:改 DATA_DIR / BIND_IP / 登录凭据
docker compose up -d --build
docker logs workbench | tail   # 取首次生成的登录密码(若 .env 未设 AUTH_PASSWORD)
```

浏览器打开 `http://<宿主IP>:3080/`(本机也可 `http://127.0.0.1:3080/`),
会先看到登录页。默认用户名 `workbench`,密码首次启动随机生成并打印在日志里,
也保存在 `${DATA_DIR}/dsh/auth-password`。登录一次拿到 Cookie 后 7 天免登录。
dsh 自带的 token 由鉴权壳自动注入,地址里不用再手写 `?token=...`。
首次进入 Web UI → 设置 → 模型,填 DeepSeek API key(官方地址
`https://api.deepseek.com`)。密钥持久化在挂载目录里,重建容器不丢。

## 自定义数据目录

宿主挂载根目录由 `.env` 里的 `DATA_DIR` 决定,默认 `./data`(相对
`docker-compose.yml` 所在目录),也支持绝对路径：

```bash
# .env
DATA_DIR=/opt/workbench-data        # 绝对路径
# DATA_DIR=../workbench-data        # 相对 compose 文件所在目录
```

该目录下仍固定分两个子目录：`dsh/`(配置、凭据、会话轨迹)和
`workspace/`(agent 工作区)；容器内路径 `/data/dsh`、`/data/workspace`
不变,所以改 `DATA_DIR` 不需要改镜像或 entrypoint。

容器内 `HOME=/data/workspace`、`DSH_HOME=/data/dsh/.dsh`：UI 的目录选择器从
`/data/workspace` 起，新建工作区默认落在 `${DATA_DIR}/workspace/`；dsh 的
profile 和会话轨迹仍在 `${DATA_DIR}/dsh/.dsh/`，鉴权凭据仍在 `${DATA_DIR}/dsh/`。
首次默认工作区的 `documentsDirectory` 也在 web profile 的 `cordis.patch.yml`
中指向 `/data/workspace`。

注意：改 `DATA_DIR` 等于指向一个新的空数据目录,旧数据不会自动搬迁。
用下面的 `migrate.sh` 过滤打包后恢复,或直接把旧目录的两个子目录拷到新目录,
再 `docker compose up -d`。

## 迁移到另一台电脑

`migrate.sh` 负责过滤并打包 `${DATA_DIR}`,默认从 `.env` 读取该变量：

```bash
./migrate.sh export --dry-run                  # 先看会打包什么
./migrate.sh export -o dsh-migration.tar.gz    # 生成归档(含校验和)
# 拷到新电脑后：
./migrate.sh inspect dsh-migration.tar.gz      # 查看摘要,不落地 payload
./migrate.sh import dsh-migration.tar.gz -d /path/to/new-data
# .env 里写 DATA_DIR=/path/to/new-data,再 docker compose up -d --build
```

默认保留 `dsh/.dsh/sessions`(会话事件流)、`profiles` 配置、`attachments`、
`storages/workspace.json`、自定义预设和 `workspace/`；剔除 npm/pnpm 缓存、
`node_modules`、`.DS_Store`、`*.log`、`*.bak/*.fixed/*.tmp`、`session.lock`。
默认**不打包**鉴权壳的 `auth-password`/`auth-secret`(新机器重新生成密码,
旧浏览器 Cookie 失效)和 `session_projcache`(避免旧预设 id 污染投影)；
确实需要时用 `--include-secrets` / `--include-projcache` 打开。

归档含 `manifest.json`、`SHA256SUMS`(导入前自动校验)和 `RESTORE.txt`。
注意 `dsh/.dsh/.credentials.yaml` 里有模型 API key 与浏览器会话 secret,
**归档等同密码文件**,请加密保存,不要发到公开渠道。

`import` 默认拒绝覆盖已有数据；确认要合并到已有目录时加 `--force`,
它只覆盖同名文件、不删除目标已有文件。另有 `--exclude GLOB` 追加过滤规则,
`-n/--dry-run` 空跑。

## 局域网访问与鉴权

容器里跑了一个轻量鉴权壳(`auth-proxy.js`),dsh 只听容器内回环,局域网流量
必须先过登录页：

```
局域网设备 ──HTTP──> 宿主 ${BIND_IP}:${HOST_PORT}(默认 0.0.0.0:3080)
                       └─> 容器 auth-proxy :3080
                            ├─ /login  登录页 + Cookie 会话(HMAC 签名,7 天)
                            └─ 其他请求 ──注入 dsh token──> 127.0.0.1:3081(dsh)
```

相关 `.env` 配置：

| 变量 | 作用 | 默认 |
|---|---|---|
| `BIND_IP` / `HOST_PORT` | 宿主监听地址/端口;只给本机用填 `127.0.0.1` | `0.0.0.0` / `3080` |
| `AUTH_USER` / `AUTH_PASSWORD` | 登录凭据;密码留空则首次启动随机生成并写入 `${DATA_DIR}/dsh/auth-password` | `workbench` / 随机 |
| `AUTH_SECRET` | Cookie 签名密钥;留空自动生成并持久化,改了会强制所有人重新登录 | 自动生成 |
| `DSH_PUBLIC_URL` | dsh 日志里打印的对外地址,填局域网 IP/域名才便于复制 | 空(打印 127 地址) |
| `DSH_TRUSTED_HOST` | dsh 的 browser-trust fence 额外放行 Host;一般不用填,代理已把 Host/Origin 改回上游 authority | 空 |

```bash
# .env 示例
BIND_IP=0.0.0.0
HOST_PORT=3080
AUTH_USER=workbench
AUTH_PASSWORD=换个强密码
DSH_PUBLIC_URL=http://192.168.1.10:3080/
# DSH_TRUSTED_HOST=extra.example.com:3080   # 仅额外域名需要时填
```

行为细节：

- 未登录访问任意路径会 303 到 `/login?next=...`;登录成功后设置
  `HttpOnly + SameSite=Lax` Cookie,`/logout` 清 Cookie。
- 连续 10 次密码错误会限流 10 分钟;用户名/密码比对走定时安全比较。
- 代理从 dsh 启动日志里抓 token 写到 `/run/dsh-token` 并自动注入。
  首页 `/` 已有 dsh Cookie 时不带 token(否则 token 会反复 303),
  但 `/connect` 始终带 token —— 它每次连接都要用 token 换 API Cookie。
  其他路径(尤其 `plugins/??...` 静态包)**一律不带 token**,否则 dsh 会把
  `token=...` 当模块名解析,返回 404,前端报
  `client-modules: HTML did not preload .../client.js`。
  旧 dsh Cookie 撞上新 token 时,代理收到 401 会重试一次:带新 token、
  清掉旧 Cookie,让 dsh 重新签发,所以容器重启后不用手动清浏览器 Cookie。
- WebSocket 升级同样走鉴权与 token 注入,聊天流式输出不受影响。
- 代理不转发 `X-Forwarded-*`,并把浏览器 `Origin` 改写为上游 authority,
  避免 dsh 的 browser-trust fence 对局域网地址返回 403。
- `/healthz` 可用于探活(token 就绪返回 200,否则 503)。

**安全边界**：当前是明文 HTTP。若局域网不可信,请在上层再套 TLS
(如 Tailscale / 反向代理 HTTPS),不要把 `0.0.0.0:3080` 直接暴露到公网。

## 架构

```
宿主 macOS
└── docker compose (${BIND_IP}:${HOST_PORT} -> 容器 3080)
    └── workbench 容器(node:26 完整镜像,锁版本 @deepseek-ai/dsh)
        ├── auth-proxy.js :3080    → 登录页 / Cookie 鉴权 / 注入 dsh token
        ├── dsh web 127.0.0.1:3081 → 只对同容器代理可见
        ├── HOME=/data/workspace    → UI 目录选择器起点 / agent shell 的 ~
        └── DSH_HOME=/data/dsh/.dsh → dsh 配置 / 会话轨迹(凭据在 /data/dsh)
宿主挂载 ${DATA_DIR}(默认 ./data) ← 以上两个目录;容器销毁重建,数据原样保留
```

**镜像内置开发工具**(基于完整 `node:26` 镜像加装,agent 工作环境即开即用):
`git` / `bash` / `curl` / `wget` / `openssh-client`(git 走 SSH)/
`build-essential` + `python3`(原生模块编译)/ `jq` / `ripgrep` / `fd` /
`tree` / `unzip` / `zip` / `less` / `procps` / `sqlite3`。
缺 git 会导致 UI 无法创建工作空间,所以基础工具链是硬依赖。

**实测到的安全事实与应对**(2026-11-24/25,dsh 0.2.2-rc.5):

1. dsh **明确拒绝绑 `0.0.0.0`**——官方防 RCE 设计,只接受具体地址。
   现在直接绑容器内 `127.0.0.1:3081`,外部只能通过同容器的鉴权壳访问,
   比之前绑容器 IP 再映射更符合最小暴露面。
2. dsh web 自带访问 token,原 URL 形如 `http://127.0.0.1:3081/?token=...`。
   鉴权壳从日志抓取并自动注入,所以局域网端只需登录页账号密码;
   直接绕过代理访问 3081 仍会被 dsh 以无 token 401 拒绝。
3. dsh 的 `/api` 有 browser-trust fence。代理把 `Host` 改写回
   `127.0.0.1:3081` 并用 `--trusted-host` 放行；用域名/别的端口访问时,
   按上文配 `DSH_TRUSTED_HOST`,否则部分 API 会被拦。

设计原则:**容器是无状态的,`DATA_DIR` 指向的宿主目录(默认 `./data/`)是唯一事实。**
升级 dsh 版本 = 改 compose/Dockerfile 里的版本号重新 build;
升级前备份 `${DATA_DIR}/dsh/`
(会话轨迹是 append-only 事件流,是后续工厂审计的地基,丢了不可再生)。

## 第三方网关接入(Magpie 等 token 网关)

dsh 原生支持 OpenAI 兼容网关(模型层是插件,provider 可自由添加),这也是
DESIGN.md D6 模型路由的实现落点。两条路径:

**路径 A:UI 配置(推荐,落盘在 `${DATA_DIR}/dsh/`,天然持久)**

设置 → 模型 → 添加模型提供商 → 自定义模型 API。四个必填:
Provider ID(小写,**保存后不可改名**,会话日志引用它)、Base URL、
协议、模型 ID。

**路径 B:配置文件 `${DATA_DIR}/dsh/.dsh/profiles/web/cordis.patch.yml`**

```yaml
- id: llm-pi-ai
  config:
    providers:
      magpie:                      # 自定义 provider id
        api: openai-completions
        baseURL: https://<网关地址>/v1
        apiKeyEnv: GATEWAY_API_KEY # 走环境变量,不写死在配置里
        models:
          - id: deepseek-flash
          - id: deepseek-v4-pro
```

环境变量经 compose `environment:` 注入容器即可。

**避坑(均来自官方文档与社区实测)**

- Base URL 填网关文档的根(通常以 `/v1` 结尾),**别拼 `/chat/completions`**——
  dsh 自己补路径,拼两层是最常见 404
- 网关不提供 `GET /models` 时,Fetch models 报 401/404 属正常,手动填模型 ID
- 一个 provider 只能一种协议;网关同时有 OpenAI 与 Anthropic 风格就建两个 provider
- 第三方网关不识别 `developer` 角色或 `max_completion_tokens` 时,在
  cordis.patch.yml 同层加 `compat: { supportsDeveloperRole: false, maxTokensField: max_tokens }`
  (这类兼容性配置不在 UI 表单里)
- 改 patch 前可用 `dsh --profile web --dump-config` 打印整棵插件树核对

## 本地插件(out-of-tree bundle)

以 `${DATA_DIR}/dsh/default/ravelle-preset`、`ravelle-skin` 为例。它们挂在
`/Users/token/dshdata/dsh/default/...`,容器内对应 `/data/dsh/default/...`。
镜像已装 pnpm(ARG `PNPM_VERSION`,当前 10.34.9)——`dsh plugin` 只是把参数
转发给 profile 目录里的 pnpm,所以**没装 pnpm 时任何 `dsh plugin` 命令都会失败**。

1. 编辑 `${DATA_DIR}/dsh/.dsh/profiles/web/package.json`,加依赖和 bundle
   顺序(bundle 列表决定 patch 层应用顺序,本地包放最后便于覆盖)：

   ```json
   {
     "dependencies": {
       "@local/dsh-ravelle-preset": "link:/data/dsh/default/ravelle-preset",
       "@local/ravelle-skin": "link:/data/dsh/default/ravelle-skin"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@deepseek-ai/dsh-experimental-auto-review",
           "@deepseek-ai/dsh-experimental-voice-input-bundle",
           "@deepseek-ai/dsh-personalized-recommendations",
           "@local/dsh-ravelle-preset",
           "@local/ravelle-skin"
         ]
       }
     }
   }
   ```

2. 让 pnpm 建立链接(`link:` 依赖,锁文件会变,所以要 `--no-frozen-lockfile`):

   ```bash
   docker exec -e CI=true workbench dsh plugin --profile web install --no-frozen-lockfile
   ```

3. **每个本地插件自己的依赖要装到插件目录里**。Node 从插件真实路径找
   `node_modules`,不会去 profile 的 hoisted 目录;漏这步会报
   `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`:

   ```bash
   docker exec -e CI=true workbench sh -c \
     'cd /data/dsh/default/ravelle-skin && pnpm install --ignore-workspace --no-frozen-lockfile'
   # ravelle-preset 无 dependencies,不用装
   ```

   缺 peer 的警告是正常的,dsh 的 runtime resolution 会提供 `cordis` 等宿主包。

4. 重启容器生效,核对配置树:

   ```bash
   docker restart workbench
   docker logs --tail 20 workbench          # 不应再出现 skipping profile bundle
   docker exec workbench dsh web --dump-config | grep ravelle
   ```

换别的本地插件:替换目录路径与 `package.json` 里的包名即可;包名必须和插件
自己的 `package.json` 中 `name` 一致。

## 目录

| 路径 | 说明 |
|---|---|
| `Dockerfile` | 镜像定义;版本锁在 ARG `DSH_VERSION` |
| `docker-compose.yml` | `${BIND_IP}:${HOST_PORT}` 映射到容器 3080;挂载 `${DATA_DIR}`;`restart: unless-stopped` |
| `auth-proxy.js` | 登录页 + Cookie 鉴权、反向代理、token 注入、WebSocket 升级 |
| `docker-entrypoint.sh` | 生成/恢复凭据、启动 dsh(127.0.0.1:3081)并抓 token、拉起鉴权壳 |
| `.env.example` | `DATA_DIR`、端口、登录凭据、dsh 对外地址等占位 |
| `.env` | 本地环境变量(不入库),见「自定义数据目录」「局域网访问与鉴权」 |
| `migrate.sh` | 过滤打包 / 校验恢复 `DATA_DIR`,见「迁移到另一台电脑」 |
| `data/` | 默认运行时数据目录(gitignore),宿主持有 |

## 升级与风险

- dsh 处于 developer preview,官方明示会有破坏性变更 → **版本锁死在
  Dockerfile,不追 latest**;升级前跑通一次冒烟(启动 + 发一条消息 + 会话可恢复)
- 会话轨迹、凭据都在 `${DATA_DIR}/dsh/`(默认 `./data/dsh/`);整机迁移 =
  拷走这两个子目录,或用 `migrate.sh` 过滤打包后恢复
- 插件启用前人工审核(DESIGN.md R2),一期默认不装任何社区插件

## 阶段一验收(DESIGN.md)

连续使用 7 天,聊天与至少 3 类工作任务(整理、检索、定时提醒)不回退到旧工具。
