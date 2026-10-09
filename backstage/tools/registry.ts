import type {
  JsonSchemaObject,
  ListToolsData,
  ToolDefinition,
  ToolRisk,
} from '@/backstage/lib/tool-protocol'
import { RAVEN_TOOL_PROTOCOL_VERSION } from '@/backstage/lib/tool-protocol'

/**
 * Tool Executor Registry —— **raven 拥有的是这一份**。
 *
 * Runtime 那边也有一份「面向模型的 Tool Registry」，那是它的；这份是**能真干活**的。
 * 两者通过协议连，不共享内部实现。判据见 AGENTS.md 与 docs/05：
 * **完全移除 LLM 之后仍有独立意义的能力，属于这里。**
 *
 * ## 三条纪律
 *
 * 1. **`risk` 由工具自己声明。** 删文件的工具自己知道它会删文件 ——
 *    猜出来的风险等级是假的授权。
 * 2. **一个工具只做一件事。** 「顺便更新点别的」会变成两个能力，
 *    而失败时你分不清是哪一半出的问题。
 * 3. **未开放的工具也要注册。** 它出现在 `listTools` 的 `disabled[]` 里，
 *    明说「存在但未开放」，而不是让 runtime 以为 raven 没这个工具 ——
 *    后者会让人去查一个根本没坏的链路。
 */

export type ToolContext = {
  workspaceId: string
  executionId: string
  /** 取消信号。**长命令必须听它**，否则取消接口是个摆设。 */
  signal: AbortSignal
}

export type ToolExecutor = {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
  /** false = 注册但不开放（出现在 disabled[]）。默认 true。 */
  enabled?: boolean
}

const registry = new Map<string, ToolExecutor>()

export function registerTool(executor: ToolExecutor): void {
  const name = executor.definition.name
  if (registry.has(name)) {
    throw new Error(
      `工具 ${name} 重复注册。工具名是契约的一部分，不允许后注册顶掉先注册。`
    )
  }
  registry.set(name, executor)
}

export function findTool(name: string): ToolExecutor | undefined {
  return registry.get(name)
}

export function allTools(): ToolExecutor[] {
  return [...registry.values()]
}

export function toolNames(): string[] {
  return [...registry.keys()]
}

/** `listTools` 的回执。开放与未开放分开列，不混在一起让调用方猜。 */
export function listToolsData(workspaceId: string): ListToolsData {
  const tools: ToolDefinition[] = []
  const disabled: string[] = []
  for (const executor of registry.values()) {
    if (executor.enabled === false) {
      disabled.push(executor.definition.name)
      continue
    }
    tools.push(executor.definition)
  }
  return { protocolVersion: RAVEN_TOOL_PROTOCOL_VERSION, workspaceId, tools, disabled }
}

/** 声明工具用的小助手：省掉每个文件里重复写 `registerTool({...})`。 */
export function defineTool(input: {
  name: string
  title: string
  description: string
  risk: ToolRisk
  inputSchema: JsonSchemaObject
  timeoutMs?: number
  confirmationPhrase?: string | null
  enabled?: boolean
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}): void {
  registerTool({
    definition: {
      name: input.name,
      title: input.title,
      description: input.description,
      inputSchema: input.inputSchema,
      risk: input.risk,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.confirmationPhrase !== undefined ? { confirmationPhrase: input.confirmationPhrase } : {}),
    },
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    execute: input.execute,
  })
}

/** 取一个字符串参数，缺了就抛 `invalid_input`。模型给错参数是常态，得说清楚哪个字段。 */
export function requireString(
  args: Record<string, unknown>,
  field: string
): string {
  const value = args[field]
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`参数 ${field} 必须是非空字符串。`)
    ;(error as Error & { code?: string }).code = 'invalid_input'
    throw error
  }
  return value
}

export function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    const error = new Error(`参数 ${field} 必须是字符串。`)
    ;(error as Error & { code?: string }).code = 'invalid_input'
    throw error
  }
  return value
}

export function optionalNumber(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const error = new Error(`参数 ${field} 必须是数字。`)
    ;(error as Error & { code?: string }).code = 'invalid_input'
    throw error
  }
  return value
}
