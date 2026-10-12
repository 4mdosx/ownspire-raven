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

**结构由 drizzle 迁移产出，`backstage/db/schema.ts` 是唯一真相。**
`database.ts` 里不再有任何 `CREATE TABLE` —— 运行时靠 `migrate()` 把库跑到最新。

`LEGACY_TABLES` 里登记过的旧表一旦存在就**直接抛错，不自动搬数据**（迁移系统管不到
比它更早的表名）。理由与 atlas / shrine / navi 一致：真到有数据时再做一次显式、
可验证的迁移。**自动迁移的静默错误比停下来问更贵。**

改 schema 的流程：

```bash
# 1. 改 backstage/db/schema.ts（唯一一处）
# 2. 生成迁移
npm run db:generate
# 3. 门禁：schema.ts 与 drizzle/ 是否一致
npm run db:check
# 4. 跑起来时自动迁移（也可以手动）
npm run db:migrate
```

⚠️ **别信 `drizzle-kit check`。** 实测（rc.4）在「schema 改了、迁移没生成」这种最该拦的
情况下它照样输出 `Everything's fine` 并以 0 退出 —— 它比对的是迁移文件之间的自洽性，
不是「schema 与最新 snapshot 是否一致」。`db:check` 用的判据是**跑一次 generate 看
`drizzle/` 有没有变脏**，generate 是纯静态的（不连库），所以可以随便跑。

⚠️ **两个包锁精确版本**（`drizzle-orm` / `drizzle-kit` 都是 `1.0.0-rc.4`，没有 `^`）。
稳定版 0.45.x 没有 `node:sqlite` 驱动；而 `^1.0.0-rc.4` 的语义是「>=rc.4 <2.0.0」，
会把后续所有 rc 一路放进可接受范围。

⚠️ **`drizzle/` 是运行时读的目录**，Dockerfile 里有 `COPY drizzle/`，别删。

改 schema 前先看库里有多少条：

```bash
sqlite3 "$RAVEN_DATA_DIR/raven.db" "SELECT COUNT(*) FROM clipboard_entries"
```

### 数据层是异步的

`ensureSchema()` / `pingDatabase()` / 所有 `db*` 函数都返回 Promise。同步调用会拿到
一个 Promise —— `if (promise)` 恒真，表现为「永远显示已设置 PIN」这类怪症状。
这类裂缝 tsc 能抓住（缺 `await` 处直接报错），所以**别用 `as` 或 `void` 绕**。

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
   同理 `verifyPinHash()` 只判「六个字段」，`scrypt$1$2$3$4$5` 恰好也是六个字段，
   于是畸形值让「PIN 不正确」变成 500。两处都已修，断言留着。

### 登录：PIN，不是账号密码

登录只有 4 位数字 PIN，**首次访问时在浏览器里设置**，散列存 SQLite 的 `settings` 表。
配置文件里**没有凭据**，`auth` 段只剩 `sessionHours` 与 `loginRateLimit`。

三条不能改回去的决定：

1. **PIN 不进配置文件。** 凭据是运行期产生的状态，而配置文件必须在第一次登录
   **之前**就存在 —— 「首次设置」这件事根本没法用配置文件表达。附带好处是它不会
   跟着配置进版本库、被 diff、在日志里露面。
2. **旧字段必须报错，不能静默忽略。** zod 的 `object()` 会剥掉未声明的字段，
   所以只靠 schema 的话，一份带 `auth.password` 的旧配置会**静默通过**：服务照常起来、
   PIN 照常要求，而配置里那个密码看起来「还在管用」。`assertNoLegacyAuthFields()`
   从**原始 JSON**（不是 zod 产物）上查，就是为了绕开剥字段这一层。
3. **会话绑 `pinEpoch` 而不是配置指纹。** 换 PIN → epoch 变 → 旧会话失效。
   指纹方案要在每次校验时读配置文件，而 proxy 跑在 Edge runtime 里读不了。

⚠️ **已知缺口（不是这一轮引入的）**：40 个 route 里只有
`/api/services/registry/[id]` 真的调了 `requireSession()`，其余全靠 `proxy.ts` 一道门。
proxy 只验签、读不了 SQLite，所以**换 PIN / 换密钥后旧 cookie 仍能访问页面与 API**。
`pinEpoch` 校验只发生在真正调了 `requireSession()` 的那条路径上。
要真正做到「换 PIN 立即作废所有会话」，得给每个路由补 `requireSession()`。

⚠️ 4 位 PIN 只有 10000 种可能，`loginRateLimit` **不是可选项是必需品**。

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
