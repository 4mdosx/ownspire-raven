# 05 · Tool Protocol（raven 侧 = 执行方）

协议正文在 [../../ownspire-little-one/docs/04-raven-tool-protocol.md](../../ownspire-little-one/docs/04-raven-tool-protocol.md)。
**那份是对外的凭据**；这份只写 raven 这一侧要守住什么、代码在哪。

| | 位置 |
|---|---|
| 协议类型 | `backstage/lib/tool-protocol.ts` |
| 执行注册表 | `backstage/tools/`（`registry.ts` + 各工具文件 + `index.ts` 显式清单） |
| 执行生命周期 | `backstage/services/execution.service.ts` |
| 传输层 | `app/api/agent/gateway/route.ts`（单入口，`op` 分发） |

---

## §一 raven 拥有的是 Executor Registry

Runtime 那边有一份「面向模型的 Tool Registry」，它决定模型**看见**什么。
这一份决定**真干得了**什么。两者通过协议连，不共享内部实现。

**归属判据**：完全移除 LLM 之后仍有独立意义的能力，归这里。
一个 `rg`、一次读文件、一次 Shell，不走模型也照样有人要 ——
所以 raven 是 LLM 无关的 **Execution Environment**，不是 runtime 的附属。

反过来的边界一样要守：raven **不需要知道**当前是 GLM 还是 MiMo、
模型为什么调这个工具、Loop 跑到第几轮、上下文还剩多少。

---

## §二 加一个工具的三步

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

## §三 执行生命周期：ID · 超时 · 取消

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

## §四 权限归 raven，不归调用方

Runtime 传来的 `workspaceId` 是**意图**，不是凭证。

- 调用方身份由 `AGENT_RUNTIME_TOKEN` 决定（`unauthorized`）；
- 能不能碰这个 workspace、这条路径、这点配额，**全部由 raven 判**；
- 沙箱判定（`backstage/lib/sandbox.ts` 的 realpath 段比较）**只有一份**，
  runtime 里不复制 —— 两套判定漂移的那一次就是越界。

当前只有一个 workspace（`DEFAULT_WORKSPACE_ID`）。所以做的是**校验**不是查找：
传来的不是它 → `workspace_unknown`，绝不静默当成默认。
字段为以后预留，不等于现在支持多 workspace。

---

## §五 错误只认 code

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

---

## §六 验证

```bash
node --conditions react-server --import tsx scripts/verify-tool-protocol.ts   # 协议单独跑
node --conditions react-server --import tsx scripts/verify-raven.ts           # 全量（含上面这段）
```

协议里「取消」「超时」「来晚了不报错」这几条，**tsc 一条都抓不到** ——
只能靠脚本里的真实时序断言。改 `execution.service.ts` 之后必须跑。
