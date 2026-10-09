# 05 · Tool Protocol（raven 侧 = 执行方）

协议正文在 [../../ownspire-little-one/docs/04-raven-tool-protocol.md](../../ownspire-little-one/docs/04-raven-tool-protocol.md)。
**那份是对外的凭据**；这份只写 raven 这一侧要守住什么、代码在哪。

| | 位置 |
|---|---|
| 协议类型 | `backstage/lib/tool-protocol.ts` |
| 执行注册表 | `backstage/tools/`（`registry.ts` + 各工具文件 + `index.ts` 显式清单） |
| 执行生命周期 | `backstage/services/execution.service.ts` |
| 子进程纪律 | `backstage/lib/proc.ts`（脚本运行器与 shell 共用一份） |
| 传输层 | `app/api/agent/gateway/route.ts`（单入口，`op` 分发） |

---

## §一 现有工具清单

| 工具 | risk | 说明 |
|---|---|---|
| `raven.files.list` | read | 列目录，可按名过滤 |
| `raven.files.read` | read | 读文本（1 MiB 封顶，返回 `truncated`） |
| `raven.files.write` | write | **整体覆盖**，不是追加。`createOnly: true` 时不覆盖 |
| `raven.files.mkdir` | write | 递归建目录 |
| `raven.files.move` | write | 移动 / 改名，`overwrite` 默认 false |
| `raven.files.copy` | write | 复制（含整棵子树），`overwrite` 默认 false |
| `raven.files.rename` | write | 同目录改名，**永远不覆盖**（没有 overwrite 参数） |
| `raven.files.remove` | destructive | 永久删除，无回收站。任一路径不合法则整批不删 |
| `raven.shell.exec` | write | 执行命令，见 §四 |
| `raven.clipboard.list` | read | 网络剪切板 |
| `raven.storage.stats` | read | 受管根用量与配额 |
| `raven.services.dashboard` | read | ownspire 各服务健康状态 |

⚠️ **没有 `fs.manage(action=...)` 这种大工具**，一个工具只做一件事。
理由在 `backstage/tools/registry.ts` 的纪律里：既是「失败时能分清是哪一半出的问题」，
也是「`risk` 可以自报」—— 一个既读又删的工具，风险等级取决于参数，
而**取决于参数的风险就是假的授权**。

---

## §三 加一个工具的三步

Runtime 那边有一份「面向模型的 Tool Registry」，它决定模型**看见**什么。
这一份决定**真干得了**什么。两者通过协议连，不共享内部实现。

**归属判据**：完全移除 LLM 之后仍有独立意义的能力，归这里。
一个 `rg`、一次读文件、一次 Shell，不走模型也照样有人要 ——
所以 raven 是 LLM 无关的 **Execution Environment**，不是 runtime 的附属。

反过来的边界一样要守：raven **不需要知道**当前是 GLM 还是 MiMo、
模型为什么调这个工具、Loop 跑到第几轮、上下文还剩多少。

---

## §四 加一个工具的三步

```ts
// backstage/tools/<主题>.ts
defineTool({
  name: 'fs.read',
  title: '读文件',
  description: '……（给模型看的，比 UI 文案重要）',
  risk: 'read',                      // read | write | destructive
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  timeoutMs: 10_000,                 // 可选；工具自报上限，调用方只能调短
  async execute(args, context) {
    // context: { workspaceId, executionId, signal }
    // ⚠️ 长命令必须听 context.signal，否则取消接口是摆设
    return { ... }
  },
})
```

然后在 `backstage/tools/index.ts` 里 import 这个文件。

⚠️ **漏了第二步不会报错** —— 注册表只是「少一个工具」，而「少一个工具」
比抛异常难查得多。所以那份显式 import 清单是刻意的，不是啰嗦。

`enabled: false` 的工具照样注册，出现在 `listTools` 的 `disabled[]` 里。
**明说「存在但未开放」**，好过让 runtime 以为 raven 没这个工具，
然后去查一条根本没坏的链路。

---

## §五 执行生命周期：ID · 超时 · 取消

`execution.service.ts` 持有 in-flight 注册表。三件事缺一不可：

| 机制 | 为什么 |
|---|---|
| **每次执行一个 `executionId`** | 没有 ID 的执行无法取消 —— 取消接口拿什么指认它 |
| 调用方自带 `executionId` = 幂等重试 | 网络超时后重发同一 ID，raven 认它是同一次 |
| `timeoutMs` 由工具自报，可短不可长 | 上限握在 raven 手里（`clampTimeout`） |

**取消是两步**：注册表里先钉状态，执行体再听 `signal` 收尾。
只钉状态 = 进程还在跑；只听 signal = 查不到这次执行。**两者缺一，取消就是假动作。**

**来晚了不是错误**：执行已到终态时返回 `cancelled: false` 加真实终态。
网络重试会让取消接口被重复调用，报「找不到」会误导调用方以为取消失败。

---

## §六 权限归 raven，不归调用方

Runtime 传来的 `workspaceId` 是**意图**，不是凭证。

- 调用方身份由 `AGENT_RUNTIME_TOKEN` 决定（`unauthorized`）；
- 能不能碰这个 workspace、这条路径、这点配额，**全部由 raven 判**；
- 沙箱判定（`backstage/lib/sandbox.ts` 的 realpath 段比较）**只有一份**，
  runtime 里不复制 —— 两套判定漂移的那一次就是越界。

当前只有一个 workspace（`DEFAULT_WORKSPACE_ID`）。所以做的是**校验**不是查找：
传来的不是它 → `workspace_unknown`，绝不静默当成默认。
字段为以后预留，不等于现在支持多 workspace。

---

## §七 错误只认 code

错误形状固定 `{ code, message, retryable }`，HTTP 状态由 code 决定（表见协议正文）。
**按 `code` 分支，不要匹配 `message`** —— message 给人看，随时会改。

工具里抛错时挂上 `code`：

```ts
const error = new Error(`参数 ${field} 必须是非空字符串。`)
;(error as Error & { code?: string }).code = 'invalid_input'
throw error
```

没挂 `code` 的错误会被兜成 `internal_error`（500 + 可重试）——
**那是「raven 自己崩了」的意思，不是「你传错了」**。
参数类错误一定要自己标，否则调用方会去重试一个永远失败的请求。

⚠️ 沙箱抛的错（`SandboxError`）也是同一个问题，所以有一张
**`SANDBOX_ERROR_CODES` 映射表**：`exists` / `invalid_path` 这类
「换个参数就能救」的错一律归 `invalid_input`。
没有这张表的话，目标已存在会被说成「raven 崩了，重试吧」——
调用方于是重试一个永远失败的请求。归并判据只有一条：**改参数能不能救。**

---

## §八 shell 工具的三个决定

```jsonc
"shell": { "enabled": true, "timeoutMs": 60000, "allowShellSyntax": true }
```

**① argv 直传，不经过 shell。** `{ command, args[] }` 直接 spawn。
理由不是「安全」而是**可预测**：命令与参数在协议层就是分开的字段，
工具调用记录里能看清每个参数。走 `sh -c 'a && b'` 的话一切被压成一个字符串，
引号、空格、重定向全靠模型拼对，而拼错的症状是「命令莫名其妙不一样」。

需要管道时**显式**写 `command: 'sh'` + `args: ['-c', '...']`：
解释器是模型自己挑的、写进调用记录、也在允许清单里，不是隐式发生的。
`allowShellSyntax: false` 把这条路也关掉。

**② 开关不复用 `workspace.allowScriptExecution`。** 那个的语义是
「允许执行 `scripts/` 目录里的脚本」，范围明确；把它当成「允许任意 shell」
等于翻一个开关就交出整台机器。两个语义必须分开。

**③ 退出码非 0 不是协议错误。** 命令跑了，跑了并失败了——
该由调用方判断的是 `exitCode`，不是这里。报成 `error` 会让 runtime
换参数重试，而它重试一万次也是同一个退出码。

子进程纪律全部来自 `backstage/lib/proc.ts`（与脚本运行器共用一份）：
进程组 kill、输出按字节封顶且封顶后继续读、SIGTERM→3s→SIGKILL。
加上 `context.signal` —— 协议承诺的 `cancelExecution` 才真的能刹住车。

---

## §九 验证

```bash
npm run verify     # 全量（含协议段与工具段）
```

段文件（`verify-tool-protocol.ts` / `verify-tools.ts`）**没有各自的 npm script**，
这不是漏了：它们静态 import raven 模块，单独跑会在自己设好 `RAVEN_DATA_DIR`
之前就加载配置，于是悄悄用上真实数据目录。要单段调试就在总入口上加参数，
而不是新开一个入口。

协议里「取消」「超时」「来晚了不报错」，以及工具里「进程组真的被杀掉了」，
**tsc 一条都抓不到** —— 只能靠脚本里的真实时序断言。
改 `execution.service.ts`、`proc.ts`、`shell.ts` 之后必须跑。

`verify-tools.ts` 里有个 `expectFailure()` 帮手：
**不要写 `try { 期待它抛 } catch {}`** —— 那样「期待的那次 throw」会被
自己的 catch 吃掉，断言变成永远通过。假通过比失败更糟，
因为后面所有断言都建立在「它确实报错了」这个未经验证的假设上。
