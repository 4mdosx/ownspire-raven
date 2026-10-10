import { cancelExecution, runExecution } from '@/backstage/services/execution.service'
import { findTool, listToolsData } from '@/backstage/tools'
import '@/backstage/tools'
import {
  clampTimeout,
  resolveWorkspaceId,
  ToolProtocolError,
  type CancelExecutionData,
  type ListToolsData,
  type ToolProtocolRequest,
  type ToolResult,
} from '@/backstage/lib/tool-protocol'

/**
 * Tool Protocol 的**分发层** —— gateway 路由与 MCP 端点的唯一共享实现。
 *
 * ## 为什么抽出来
 *
 * `POST /api/agent/gateway`（runtime 走的）与 `POST /api/agent/mcp`
 * （claude-cli 走的）是**同一份能力的两种传输**。分发逻辑（workspace 校验、
 * 工具存在性、enabled 检查、超时钳制、执行与取消）写两份必然漂移 ——
 * 而「gateway 能跑、mcp 不能」正是最难排查的那类问题。
 *
 * ## 归属不变（docs/04 §一）
 *
 * 路径边界判定留在 raven（`sandbox.ts` 的 realpath 段比较是唯一一份）；
 * 权限校验自己做 —— 调用方传来的 workspaceId 是意图，不是凭证。
 *
 * 函数返回**数据**，不返回 Response —— 信封（gateway 的 `{ok,v,...}`）
 * 与 JSON-RPC（MCP 的 result/error）各自在传输层组装。
 */

/** workspace 解析。**传来的不是已知 workspace 就报错，不静默回退到默认。** */
export function workspaceOf(request: { workspaceId?: string }): string {
  const resolved = resolveWorkspaceId(request.workspaceId)
  if (resolved === null) {
    throw new ToolProtocolError(
      'workspace_unknown',
      `没有这个 workspace：${String(request.workspaceId)}（当前只有一个受管工作区）`
    )
  }
  return resolved
}

export async function dispatchListTools(request: Extract<ToolProtocolRequest, { op: 'listTools' }>): Promise<ListToolsData> {
  return listToolsData(workspaceOf(request))
}

export async function dispatchExecuteTool(
  request: Extract<ToolProtocolRequest, { op: 'executeTool' }>
): Promise<ToolResult> {
  const workspaceId = workspaceOf(request)
  const executor = findTool(request.toolName)
  if (!executor) {
    throw new ToolProtocolError('unknown_tool', `raven 没有这个工具：${request.toolName}`)
  }
  if (executor.enabled === false) {
    throw new ToolProtocolError(
      'tool_disabled',
      `${request.toolName} 已注册但未开放。它出现在 listTools 的 disabled 列表里。`
    )
  }
  const timeoutMs = clampTimeout(request.timeoutMs, executor.definition.timeoutMs ?? 0)
  return runExecution({
    ...(request.executionId !== undefined ? { executionId: request.executionId } : {}),
    toolName: request.toolName,
    workspaceId,
    timeoutMs,
    work: ({ executionId, signal }) =>
      executor.execute(request.arguments, { workspaceId, executionId, signal }),
  })
}

export async function dispatchCancelExecution(
  request: Extract<ToolProtocolRequest, { op: 'cancelExecution' }>
): Promise<CancelExecutionData> {
  const outcome = cancelExecution(request.executionId)
  if (outcome === null) {
    throw new ToolProtocolError(
      'execution_not_found',
      `raven 不认识这个 executionId：${request.executionId}（可能已结束并被清理，或从未开始）`
    )
  }
  return outcome
}
