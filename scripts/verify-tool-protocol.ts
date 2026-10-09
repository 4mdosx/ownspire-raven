/**
 * Raven Tool Protocol v1 的服务端语义验证。
 *
 * 这里测的是**取消与超时**这两条最容易被写成摆设的语义：
 * 它们都能通过类型检查、都能在 happy path 下「看起来能用」，
 * 而真出事的时候（一个跑飞的命令）没人能刹住车。
 *
 * 配套：`ownspire-little-one/scripts/protocol/verify-tool-protocol.ts` 测的是
 * client 侧往返（拉一个假 raven）。**两边测的是同一份协议的不同半边。**
 */
import {
  cancelExecution,
  clearExecutions,
  finishExecution,
  runExecution,
  beginExecution,
} from '@/backstage/services/execution.service'
import {
  clampTimeout,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TIMEOUT_MS,
  resolveWorkspaceId,
  toToolError,
  ToolProtocolError,
  TOOL_ERROR_CODES,
} from '@/backstage/lib/tool-protocol'
import { findTool, listToolsData } from '@/backstage/tools'
import '@/backstage/tools'

type Checker = {
  check: (name: string, fn: () => void | Promise<void>) => Promise<void>
  fail: (name: string, detail: string) => void
  skip: (name: string, reason: string) => void
}

/** 会被取消的等待。**不响应 signal 的等待会让取消测试变成假通过**。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('已取消'))
      return
    }
    const onAbort = (): void => {
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('已取消'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    function cleanup(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function runToolProtocolChecks(checker: Checker): Promise<void> {
  clearExecutions()

  // ── 协议常量与纯函数 ────────────────────────────────────────
  await checker.check('workspace：省略与匹配都回到默认，不匹配的拒绝而不是静默回退', () => {
    if (resolveWorkspaceId(undefined) !== 'workspace') throw new Error('省略时应返回默认 workspace')
    if (resolveWorkspaceId('workspace') !== 'workspace') throw new Error('匹配时应返回它自己')
    // ⚠️ 这条是重点：静默回退会造成「我以为在 A 里写，实际写进了 B」。
    if (resolveWorkspaceId('somewhere-else') !== null) {
      throw new Error('未知 workspace 必须返回 null（由调用方转成 workspace_unknown）')
    }
    if (resolveWorkspaceId(42) !== null) throw new Error('非字符串必须返回 null')
  })

  await checker.check('超时：可以调短，不能调长，非法值回落到默认', () => {
    if (clampTimeout(undefined, 5_000) !== 5_000) throw new Error('未指定时应用工具自报的默认值')
    if (clampTimeout(undefined, 0) !== DEFAULT_EXECUTION_TIMEOUT_MS) {
      throw new Error('工具没自报时应用协议默认')
    }
    if (clampTimeout(MAX_EXECUTION_TIMEOUT_MS * 10, 1_000) !== MAX_EXECUTION_TIMEOUT_MS) {
      throw new Error('超过硬上限必须封顶')
    }
    if (clampTimeout(-1, 2_000) !== 2_000) throw new Error('负数/零应回落默认')
    if (clampTimeout(Number.NaN, 2_000) !== 2_000) throw new Error('NaN 应回落默认')
  })

  await checker.check('错误归一：协议错误保留 code，未知异常降级为 internal_error', () => {
    const known = toToolError(new ToolProtocolError('unknown_tool', '没有这个工具'))
    if (known.code !== 'unknown_tool' || known.retryable !== false) {
      throw new Error(`协议错误必须保留 code：${JSON.stringify(known)}`)
    }
    const unknown = toToolError(new Error('数据库连接断了'))
    if (unknown.code !== 'internal_error' || unknown.retryable !== true) {
      throw new Error(`未知异常应为可重试的 internal_error：${JSON.stringify(unknown)}`)
    }
    if (unknown.message !== '数据库连接断了') throw new Error('message 必须原样保留（运维要看）')
  })

  await checker.check('每个错误码都有 HTTP 状态与重试标记', () => {
    for (const [code, meta] of Object.entries(TOOL_ERROR_CODES)) {
      if (typeof meta.http !== 'number' || meta.http < 400 || meta.http > 599) {
        throw new Error(`${code} 的 http 状态不合法：${String(meta.http)}`)
      }
      if (typeof meta.retryable !== 'boolean') throw new Error(`${code} 缺 retryable`)
    }
    // ⚠️ 必须显式转number：`as const` 让每个 http 成了字面量类型，
    // TS 会把「两个不同字面量比相等」判成永假（TS2367）而报错 ——
    // 而这正是这条断言要检查的东西。
    const cancelledHttp: number = TOOL_ERROR_CODES.cancelled.http
    const timeoutHttp: number = TOOL_ERROR_CODES.timeout.http
    if (cancelledHttp === timeoutHttp) {
      throw new Error('cancelled 与 timeout 必须是不同的状态 —— 两者的处理方式完全不同')
    }
  })

  // ── 注册表 ─────────────────────────────────────────────────
  await checker.check('listTools 返回完整定义：字段齐、risk 合法、disabled 明说', () => {
    const data = listToolsData('workspace')
    if (data.protocolVersion !== 1) throw new Error(`协议版本应为 1，实际 ${data.protocolVersion}`)
    if (data.workspaceId !== 'workspace') throw new Error('workspaceId 应回显')
    if (data.tools.length === 0) throw new Error('注册表是空的 —— 工具文件忘了在 index 里 import？')
    for (const tool of data.tools) {
      if (!tool.name || !tool.title || !tool.description) {
        throw new Error(`工具 ${tool.name} 缺 name/title/description`)
      }
      if (!['read', 'write', 'destructive'].includes(tool.risk)) {
        throw new Error(`工具 ${tool.name} 的 risk 不合法：${tool.risk}`)
      }
      if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null) {
        throw new Error(`工具 ${tool.name} 缺 inputSchema`)
      }
    }
    if (!Array.isArray(data.disabled)) throw new Error('disabled 必须是数组（空也要给）')
  })

  await checker.check('工具名带命名空间前缀，且 risk 自报得诚实', () => {
    const data = listToolsData('workspace')
    for (const tool of data.tools) {
      if (!tool.name.startsWith('raven.')) {
        throw new Error(`工具名应带 raven. 前缀，避免和 runtime 侧的工具撞名：${tool.name}`)
      }
    }
    // ⚠️ 这条断言不写「哪些工具该存在」——**那种断言会随功能增长腐烂**，
    // 每次加工具都要来改一次，改久了就没人看它了。写死的是两条不会变的纪律：
    // ① risk 由工具自报，不许「按参数猜」；
    //    ② destructive 必须带 confirmationPhrase，UI 才有机会要求用户确认。
    const byName = new Map(data.tools.map((tool) => [tool.name, tool]))
    const expected: Array<[string, string]> = [
      ['raven.files.read', 'read'],
      ['raven.files.write', 'write'],
      ['raven.files.remove', 'destructive'],
      ['raven.shell.exec', 'write'],
    ]
    for (const [name, risk] of expected) {
      const tool = byName.get(name)
      if (!tool) throw new Error(`缺工具：${name}`)
      if (tool.risk !== risk) throw new Error(`${name} 的 risk 应为 ${risk}，实际 ${tool.risk}`)
    }
    for (const tool of data.tools) {
      if (tool.risk === 'destructive' && !tool.confirmationPhrase) {
        throw new Error(`破坏性工具 ${tool.name} 必须带 confirmationPhrase，否则 UI 无从要求确认`)
      }
    }
  })

  await checker.check('会覆盖目标的工具，默认都不覆盖', () => {
    // `overwrite` 是一个「不说就是吃掉别人文件」的开关，默认值必须是 false。
    // 这条检查的是**默认值**，不是描述文本 —— 模型读的是 description，
    // 而真正兜底的是代码。
    const data = listToolsData('workspace')
    for (const name of ['raven.files.move', 'raven.files.copy']) {
      const tool = data.tools.find((item) => item.name === name)
      if (!tool) throw new Error(`缺工具：${name}`)
      const schema = tool.inputSchema.properties?.overwrite as { default?: unknown } | undefined
      if (schema?.default !== false) {
        throw new Error(`${name} 的 overwrite 默认值应为 false，实际 ${JSON.stringify(schema?.default)}`)
      }
    }
  })

  await checker.check('findTool 对未知工具返回 undefined（由调用方转成 unknown_tool）', () => {
    if (findTool('raven.nope') !== undefined) throw new Error('未知工具应返回 undefined')
    if (findTool('raven.storage.stats') === undefined) throw new Error('已注册工具应能找到')
  })

  // ── 执行语义 ───────────────────────────────────────────────
  await checker.check('执行成功：终态 ok，output 到位，executionId 用调用方给的', async () => {
    const result = await runExecution({
      executionId: 'exe_test_ok',
      toolName: 'raven.storage.stats',
      workspaceId: 'workspace',
      timeoutMs: 1_000,
      work: async () => ({ bytes: 123 }),
    })
    if (result.status !== 'ok') throw new Error(`应为 ok，实际 ${result.status}`)
    if (result.executionId !== 'exe_test_ok') throw new Error('应沿用调用方给的 executionId')
    if (result.error !== null) throw new Error('成功时 error 必须是 null')
    if (result.durationMs < 0 || result.endedAt < result.startedAt) {
      throw new Error('时间字段不自洽')
    }
  })

  await checker.check('没给 executionId 时由 raven 生成（exe_ 前缀）', async () => {
    const result = await runExecution({
      toolName: 'raven.storage.stats',
      workspaceId: 'workspace',
      timeoutMs: 1_000,
      work: async () => 'done',
    })
    if (!result.executionId.startsWith('exe_')) {
      throw new Error(`生成的 executionId 应带 exe_ 前缀，实际 ${result.executionId}`)
    }
  })

  await checker.check('超时：钉成 timeout 而不是 error', async () => {
    const result = await runExecution({
      toolName: 'raven.test.sleep',
      workspaceId: 'workspace',
      timeoutMs: 60,
      work: async ({ signal }) => {
        await sleep(5_000, signal)
        return '不该到这里'
      },
    })
    if (result.status !== 'timeout') throw new Error(`应为 timeout，实际 ${result.status}`)
    if (result.error === null || result.error.code !== 'timeout') {
      throw new Error(`error.code 应为 timeout，实际 ${JSON.stringify(result.error)}`)
    }
  })

  await checker.check('取消：执行中途取消 → 终态 cancelled', async () => {
    const executionId = 'exe_test_cancel'
    const work = runExecution({
      executionId,
      toolName: 'raven.test.sleep',
      workspaceId: 'workspace',
      timeoutMs: 5_000,
      work: async ({ signal }) => {
        await sleep(5_000, signal)
        return '不该到这里'
      },
    })
    // 等它真的进入在飞状态再取消，否则 cancel 会落到 execution_not_found 上。
    await sleep(50)
    const outcome = cancelExecution(executionId)
    if (outcome === null) throw new Error('取消应命中在飞的执行')
    if (outcome.cancelled !== true) throw new Error('第一次取消应真的发出终止信号')
    if (outcome.status !== 'cancelled') throw new Error(`应为 cancelled，实际 ${outcome.status}`)

    const result = await work
    if (result.status !== 'cancelled') throw new Error(`终态应为 cancelled，实际 ${result.status}`)
  })

  await checker.check('取消来晚了不是错误：返回真实终态且 cancelled=false', async () => {
    const result = await runExecution({
      executionId: 'exe_test_late',
      toolName: 'raven.storage.stats',
      workspaceId: 'workspace',
      timeoutMs: 1_000,
      work: async () => 'done',
    })
    if (result.status !== 'ok') throw new Error('先跑一个成功的出来')
    const outcome = cancelExecution('exe_test_late')
    if (outcome === null) throw new Error('已结束的执行应仍能被查到（终态要留一会儿）')
    if (outcome.cancelled !== false) throw new Error('来晚了不该声称取消了')
    if (outcome.status !== 'ok') throw new Error(`应回显真实终态 ok，实际 ${outcome.status}`)
  })

  await checker.check('取消不认识的 executionId → null（调用方转成 execution_not_found）', () => {
    if (cancelExecution('exe_never_started') !== null) {
      throw new Error('未知 executionId 应返回 null')
    }
  })

  await checker.check('工具抛协议错误 → 终态 error 且 code 原样保留', async () => {
    const result = await runExecution({
      toolName: 'raven.files.read',
      workspaceId: 'workspace',
      timeoutMs: 1_000,
      work: async () => {
        throw new ToolProtocolError('invalid_input', '参数 path 必须是非空字符串。')
      },
    })
    if (result.status !== 'error') throw new Error(`应为 error，实际 ${result.status}`)
    if (result.error?.code !== 'invalid_input') {
      throw new Error(`code 应为 invalid_input，实际 ${result.error?.code}`)
    }
    // ⚠️ 这条在守「runtime 能不能把错误喂回模型改参数」—— 降级成 internal_error 就废了。
    if (!result.error?.message.includes('path')) throw new Error('message 里应说清是哪个字段')
  })

  await checker.check('工具抛普通异常 → internal_error 且可重试', async () => {
    const result = await runExecution({
      toolName: 'raven.files.read',
      workspaceId: 'workspace',
      timeoutMs: 1_000,
      work: async () => {
        throw new Error('磁盘坏了')
      },
    })
    if (result.status !== 'error') throw new Error(`应为 error，实际 ${result.status}`)
    if (result.error?.code !== 'internal_error') throw new Error('应为 internal_error')
    if (result.error?.retryable !== true) throw new Error('未知异常应标记为可重试')
  })

  await checker.check('终态之后执行体再写结果也改不了（先到先写）', () => {
    const { executionId } = beginExecution({ toolName: 'raven.test', workspaceId: 'workspace' })
    finishExecution(executionId, 'ok', { output: 'first' })
    const second = finishExecution(executionId, 'error', { error: new Error('后来者') })
    if (second.status !== 'ok') throw new Error(`终态应钉死在 ok，实际 ${second.status}`)
  })

  clearExecutions()
}
