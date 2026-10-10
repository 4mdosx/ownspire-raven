# 部署与备份

与 creative-atlas / navi 同一套路数：镜像推到 ghcr，NUC 上用 [ownspire-infra](../../ownspire-infra)
的 `node ownspire.mjs raven deploy` 起 compose，宿主 `127.0.0.1:5801`，
路由器上做 Tailscale serve。

---

## 1. 端口与数据布局

| | 容器内 | 宿主 |
|---|---|---|
| raven | 5800 | 5801 |
| atlas | 5600 | 5601 |
| navi | 5500 | 5501 |
| shadow-atlas | 5700（本机开发） | — |

```
/srv/ownspire/data/raven/          ← 挂进容器的 /data（RAVEN_DATA_DIR）
└── raven/                         ← rootPath：受管根（RAVEN_CONFIG 指这里）
    ├── raven.config.json          ← 真配置（权限 600）
    ├── raven.db                   ← SQLite（+ -wal / -shm）
    ├── services.json              ← 服务注册表（含真实地址，随部署变）
    ├── workspace/                 ← 文件管理器唯一可见的树；配额只算它
    ├── scripts/                   ← 脚本运行台
    ├── tmp/                       ← 临时脚本工作区
    └── clipboard/                 ← 剪切板附件
```

**为什么配置也放数据卷**：配置文件里就是账号密码，而镜像里那份只是构建期占位符。
把它放卷上意味着「改密码 = 改一个文件 + 重启」，不需要重新构建镜像、也不需要把密码
写进 compose 的 env（env 会出现在 `docker inspect` 输出里，卷里的文件不会）。

## 2. 部署

```bash
# NUC 上，ownspire-infra 仓库里
node ownspire.mjs raven deploy          # 初次或更新，拉 main
node ownspire.mjs raven deploy a1b2c3d  # 固定到某个 7 位 commit
node ownspire.mjs raven health          # GET /healthz
node ownspire.mjs raven publish         # 把端口写到路由器，登记 svc:raven
```

不带参数时的决策与 atlas 一致：没有部署记录 → 初次部署拉 `main`；
服务在跑 → 从记录版本更新再拉 `main`；服务没跑但有记录 → 按记录重装，不跟 `main`。

`/healthz` 返回 `{ ok, version, root, quota }`，deploy 靠 `version`（7 位 commit）判断
「跑的是哪一版」，写进 `/srv/ownspire/compose/raven.tag`。

首次部署前要在 `/srv/ownspire/compose/raven.env`（权限 600，从 `services/raven/env.example` 复制）里填：

```
SESSION_SECRET=<48 字节随机串>
```

并准备 `/srv/ownspire/data/raven/raven.config.json`：

```jsonc
{
  "//": "容器里受管根就是数据卷挂载点 /data",
  "rootPath": "/data/raven",
  "workspace": {
    "name": "workspace",
    "quotaBytes": 214748364800,     // 200 GiB，按卷的实际大小改
    "allowScriptExecution": true,
    "scriptsDir": "scripts"
  },
  "clipboard": { "maxItems": 200 },
  "auth": {
    // 这里只有策略，没有凭据。PIN 在首次访问登录页时于浏览器里设置，
    // 存在数据卷里的数据库（settings 表），不在这份配置里。
    "sessionHours": 168,
    "loginRateLimit": { "windowSeconds": 300, "maxFailures": 10 }
  },
  "services": {
    "registryFile": "services.json",
    "sampleIntervalSeconds": 30,
    "registrationToken": "<长随机串，不填就不开自注册>",
    "defs": []
  }
}
```

不用手工建目录：`/healthz` 每次被调用时都会顺手 `ensureRoots()` + `ensureSchema()`
（幂等），而 compose 的 healthcheck 与 `deploy` 都会在服务对外可用之前打它 ——
所以空卷第一次起来时会自动把 `workspace/` `scripts/` `tmp/` `clipboard/` 和表建好。
**这也是为什么不要关掉 compose 的 healthcheck**：它不只是探活，还是首次初始化。

想在部署前先放几个脚本进去，就在 NUC 上建好目录再放：

```bash
sudo mkdir -p /srv/ownspire/data/raven/{workspace,scripts,tmp,clipboard}
sudo cp 你的脚本.mjs /srv/ownspire/data/raven/scripts/
sudo chown -R 1000:1000 /srv/ownspire/data/raven
```

`chmod 600`。**位置必须是 `/data/raven/raven.config.json`**：`RAVEN_CONFIG` 指向那里，
而 `RAVEN_DATA_DIR=/data` 决定 SQLite 落在 `/data/raven.db`（存量数据在 `/data` 下，
所以升级不会丢库）。

⚠️ `rootPath` 必须是 `/data/raven`，**不能写 `/data`**：配置加载会拒绝只有一段的
文件系统根路径（`/`、`/Users`、`/data` 这类），因为那等于把整台机器交给文件管理器。
写错了服务会**拒绝启动**并打印原因，而不是降级运行。

## 3. 系统依赖（脚本运行台）

镜像里只有 Node。要用 `yt-dlp`、`ffmpeg` 这类工具，二选一：

1. **改 Dockerfile**，在 runner 阶段装（`apt-get install -y yt-dlp ffmpeg`）——
   干净、可复现，代价是镜像变大；
2. **宿主上装，脚本里用绝对路径调用** —— 但容器里看不到宿主二进制，所以这条只在
   pm2 直接跑的场景成立。

推荐第 1 条。`bilibili-download.mjs` 在找不到 `yt-dlp` 时会明确告诉你要装什么，
而不是抛一堆栈。

## 4. 备份：必须一起带走三个东西

⚠️ **raven 的备份与 navi 不一样，与 atlas 更不一样。** navi 整个数据集在一个 `.db` 里；
atlas 是 `local.db` + `media/`；raven 是：

```
raven.db          ← 元数据：剪切板条目、健康样本、指标、运行历史
workspace/        ← 文件本体与用户下载的东西（配额只算这一棵）
clipboard/        ← 剪切板附件
```

**db 里只有相对路径。** 只备 db 会恢复出一个「条目都在、文件全丢」的界面 ——
而那不是报错，是最糟的那种静默失败。

```bash
node ownspire.mjs raven backup
# → /srv/ownspire/backups/raven/raven-<UTC时间戳>.db       VACUUM INTO 一致性快照
# → /srv/ownspire/backups/raven/raven-<UTC时间戳>.tar.gz   workspace/ + clipboard/
# → ...<时间戳>.commit                                     当时的 7 位 commit
# → ...<时间戳>.sha256                                     db 的校验和
```

`restore` 按同前缀把压缩包找回来一起解开，缺包时会**明确警告**（与 atlas 的 restore 同一纪律）。

打包用 `tar` 而不是逐文件 `cp`：`workspace/` 是几千个文件，逐文件的输出没有可读性，
而一个包是自描述的。

## 5. 恢复

```bash
node ownspire.mjs raven restore /srv/ownspire/backups/raven/raven-20261008T120000Z.db --yes
```

会：停容器 → 把现有 `data/raven` 改名成 `data/raven.bak-<时间戳>` → 铺回 db 与文件 →
按 `.commit` 标记的那个版本起容器。**旧数据不会被删**，改名留在旁边，确认没问题再自己清。

## 6. 出问题时的排查顺序

1. `node ownspire.mjs raven health` —— `/healthz` 里 `ok: false` 会带回错的路径线索；
   `root: false` 说明受管根不存在（卷没挂上或权限不对）。
2. `docker logs --tail 80 ownspire-raven-1` —— 配置校验失败会在启动时就打印缺哪个字段。
3. **起不来最常见的原因就是配置**：`rootPath` 写成了只有一段的路径（例如 `/data` 而不是 `/data/raven`）、
   `auth` 既没 password 也没 passwordHash、
   `SESSION_SECRET` 缺失或短于 16 字符。这三种都会**拒绝启动**而不是降级运行 —— 这是刻意的，
   一个静默降级的配置比一个起不来的服务危险得多。
4. 上传报 `507 quota_exceeded`：看 Dashboard 的配额，或调大 `workspace.quotaBytes`
   （改完不需要重建镜像，改卷上的配置文件再重启即可）。
