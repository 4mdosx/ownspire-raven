# AGENTS.md

给任何进这个仓库的 agent（人类或 AI）的硬性要求。**先读这份，再动任何文件。**

---

## 一、三条不可破的边界

### 1. `rootPath` 是唯一的文件系统边界

任何路径判定都必须过 `backstage/lib/sandbox.ts`。**不允许**出现 `path.join(root, userInput)` 这种写法 ——
文件管理器的路径、脚本路径、剪切板附件路径全部来自 HTTP，字符串拼接就是任意的目录穿越。

判定必须是 **realpath 之后比完整路径段**，不是字符串前缀：

- `<root>/link` 可以是指向 `/etc` 的软链，前缀比较会放它过去；
- `<workspace>/a` 与 `<workspace>/ab` 在字符串前缀下是「包含」关系，实际不是。

目标文件**还不存在**时（上传、新建目录）走 `resolveTarget()`：向上找最近的存在祖先并 realpath，
再把剩余段接回去。这是最容易漏的一处 —— 直接 `realpath` 会 `ENOENT`，
于是有人退化成字符串比较，而 `<workspace>/link/evil.txt` 就过去了。

### 2. 配额在写入之前判定，且并发要能被算住

`assertRoomFor(bytes)` 之后还要 `reserve(bytes)`，并在 **finally 里 `release()`**。
两个上传各自看到「还有空间」是真实场景，靠进程内预留量兜住。

写到一半超配额要**中止并删掉半截文件**，而不是留一个超额的残片。上传一律先写同目录的
`.<name>.<ulid>.part` 再 `rename` —— 半成品绝不能以最终文件名被看见。

### 3. 脚本超时必须杀整个进程组

`detached: true` + `process.kill(-pid)`。只杀直接子进程的话，yt-dlp / ffmpeg 这类会留下
孙子进程继续往磁盘写 —— 那既绕过配额统计，也让「取消」变成假动作。

输出封顶之后**仍要继续消费**管道：不消费，子进程会被写阻塞，看起来像卡死。

---

## 二、删除操作的唯一正确姿势

⚠️ **本仓库的删除量极易触发批量删除告警**：一句 `rm -rf .next` 就能越过阈值，
一次「清空工作目录」按钮可以删掉几千个文件。

| 想做的事 | ❌ 不要 | ✅ 要 |
|---|---|---|
| 清构建缓存 | `rm -rf .next` | 删 `.next/types`，或让 next 自己重建 |
| 清库重来 | `rm -f raven.db*` | 先 `sqlite3 raven.db "SELECT COUNT(*) FROM clipboard_entries"` 看清有多少条 |
| 删单个文件 | `rm file` | `git rm file` |
| 删整个目录 | `rm -rf <dir>` | 先 `find <dir> -type f \| wc -l` 看清楚要删多少 |

判断标准：**要删的东西能不能重新生成？** `.next` 能，`raven.db` 与 `workspace/` 不能
（里面是采集来的参考图、下载的视频、剪切板附件）。后者必须走显式路径。

UI 上的删除同理：`remove()` 必须先递归统计，把「将删 N 个文件 / X MiB」返给调用方；
单个请求超过 `MAX_DELETE_FILES`（1000）直接拒绝。**别让一次误点变成没有回执的抹除。**

---

## 三、本机环境的坑

### dev server 与 build 必须过 `prepare-next.mjs`

WorkBuddy 的 safe-delete shim 拦 `unlink` 与部分 `rename`，而 turbopack 重建缓存要走
「写 `CURRENT.next` 再 rename 覆盖」。于是 `next dev` 与 `next build` 都会以
`EPERM: operation not permitted, rename ...` 收场。

唯一有效的解法是让 `.next` 本身成为指向工作区外的符号链接 —— 细节与「已经走过的四条弯路」
见 `scripts/next-dir.mjs` 顶部。**加新脚本时：凡是用到 `.next` 的命令都要先跑
`node scripts/prepare-next.mjs`。** 漏接的症状是 `Cannot find module '@tailwindcss/postcss'`，
看起来完全与配置无关。

### zsh

- heredoc 里的 `${...}` 会被展开 —— 写含模板字符串的脚本用 Write 工具。
- `rm -f path/*.lock` 无匹配时整条命令不执行 —— 用 `find -delete`。

### `node:sqlite` 的规矩（沿用 creative-atlas 的教训）

- 连接**惰性打开、可重关重开**，不能在 import 时建连接 —— 否则验证脚本没法先设 `RAVEN_DB_FILE`。
- 连接建立时立刻设 `busy_timeout = 5000` / `journal_mode = WAL` / `synchronous = NORMAL`。
  默认 `busy_timeout = 0` 意味着「一撞到锁就报错」，dev server 与验证脚本同时开着就会随机失败。
- ⚠️ **别用「删 `-journal` 文件」修 `disk I/O error`**：那个文件的出现意味着上一个进程被中断、
  SQLite 要回滚未完成的事务；删掉 journal 就绕过了回滚，剩下的半截数据会变成 `disk I/O error`。
  正确做法是让下一个进程自己回滚（设 busy_timeout 并重开连接）。

### `server-only`

`backstage/**` 里带 `server-only` 的文件在纯 Node CLI 里 import 会直接抛错。
CLI 脚本要用的东西必须拆出去（例如 `backstage/lib/config-file.ts` 就是为这个从 `config.ts` 里拆的）。
跑 service 层脚本时加 `--conditions react-server` 让它解析到官方空桩。

---

## 四、schema 改动的门禁

`backstage/db/database.ts` 的 `ensureSchema` 只创建**当前**结构。
`LEGACY_TABLES` 里登记过的旧表一旦存在就**直接抛错，不自动搬数据**。

理由与 atlas 一致：真到有数据时再做一次显式、可验证的迁移 —— 那时数据形态与语义都要人工确认。
**自动迁移的静默错误比停下来问更贵。**

改 schema 前先看库里有多少条：

```bash
sqlite3 "$RAVEN_DATA_DIR/raven.db" "SELECT COUNT(*) FROM clipboard_entries"
```

---

## 五、验证

```bash
npm run typecheck
npm run verify          # 全部
npm run verify:config   # 只跑配置/沙箱/鉴权
```

`verify` 抓 bug 的能力是真的 —— 这一轮它已经抓出过三处实现错误：

1. `tokenMatches('', '')` 返回 `true`：配置里没设注册令牌时，
   「没配令牌」会变成「任何令牌都通」，是一个静默的完全认证绕过。现在 `expected` 为空直接判否。
2. 沙箱的 `measure()` 一开始想统计软链指向的目标体积，那会把工作目录之外的用量算进配额，
   而且指向上层的软链会造成无限递归。现在软链只计数、不跟随。
3. `resolveScript()` 把 `path.join(scriptsRoot, name)` 这个**绝对路径**传给了
   `resolveExisting()`，而后者内部会走 `parseRelativePath()`（刻意拒绝绝对路径）——
   于是**每一个合法脚本名都被拒**，报错还是「不接受绝对路径」，看起来像调用方写错了。
   同理 `verifyPasswordHash()` 只判「六个字段」，`scrypt$1$2$3$4$5` 恰好也是六个字段，
   于是畸形配置项让「密码错误」变成 500。两处都已修，断言留着。

注意验证脚本里反复踩的点：

- 环境变量必须在 `config/env.ts` 被加载**之前**设好（`RAVEN_CONFIG` / `RAVEN_DB_FILE` / `RAVEN_DATA_DIR` 指向临时路径）。总入口 `verify-raven.ts` 就是这么做的，各段再动态 import。
- tsx 以 CJS 输出，**静态路径里不支持 top-level await** —— 脚本要包在 `main()` 里。
- 断言失败时打印 `detail`，不然不知道是「行为错」还是「报错文案变了」。

## 六、提交前自查

```bash
npx tsc --noEmit && npm run verify
```

两件都过了再提交。**别把「类型过了但没跑验证」当成验证过了** —— 路径穿越、队列淘汰、
超时杀进程组这三类错误，tsc 一个都抓不到。
