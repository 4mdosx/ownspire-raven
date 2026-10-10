/**
 * MCP 端点（/api/agent/mcp）的验证。
 *
 * ## 为什么直接打 route handler 而不走 HTTP
 *
 * 与 verify-agent-config-bff 同一条理由：走 HTTP 要先过 raven 登录态，
 * 而拿得到密码就不该拿。MCP 端点的鉴权是 AGENT_RUNTIME_TOKEN Bearer
 *（与浏览器登录态无关），这里在进程内带上它，验证的是这一层真正负责的东西：
 * **JSON-RPC 信封、工具名 sanitize 与还原、annotations 映射、错误码透传。**
 *
 * 不需要 little-one：MCP 端点分发的全是 raven 自己的工具。
 * 需要 raven 的配置（rootPath / DB），用临时目录给一份干净的。
 *
 * 用法：AGENT_RUNTIME_TOKEN=... node --conditions react-server --import tsx scripts/verify-agent-mcp.ts
 */

// ⚠️ 必须在 import 之前：config/env.ts 在模块加载期钉死路径。
process.env.AGENT_RUNTIME_TOKEN = process.env.AGENT_RUNTIME_TOKEN ?? 'verify-agent-mcp-token'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-mcp-verify-'))
const configPath = path.join(TMP, 'raven.config.json')
fs.writeFileSync(
  configPath,
  JSON.stringify({
    rootPath: path.join(TMP, 'root'),
    workspace: { name: 'workspace', quotaBytes: null, allowScriptExecution: false, scriptsDir: 'scripts' },
    clipboard: { maxItems: 100, maxTextBytes: 65536 },
    // auth 段必填（策略,不是凭据;PIN 在数据库里）。缺了它 config 校验直接拒,
    // 症状是所有工具调用都报 internal_error「auth: Required」。
    auth: { sessionHours: 1, loginRateLimit: { windowSeconds: 60, maxFailures: 5 } },
  })
)
process.env.RAVEN_CONFIG = configPath
process.env.RAVEN_DB_FILE = path.join(TMP, 'raven.db')

const TOKEN = process.env.AGENT_RUNTIME_TOKEN
const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

// handler 在 main() 里动态 import（env 之后）。模块级 let:post() 助手要引用它们。
let POST: (request: Request) => Promise<Response>
let GET: (request: Request) => Promise<Response>
let DELETE: (request: Request) => Promise<Response>

let assertions = 0
let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  assertions += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}`)
  if (detail !== undefined) console.log(`      ${String(detail).slice(0, 300)}`)
}

async function post(body: unknown, headers: Record<string, string> = authHeaders): Promise<Response> {
  return POST(
    new Request('http://raven.local/api/agent/mcp', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })

async function main(): Promise<void> {
  // ⚠️ 延迟 import：必须在 env 写完之后 —— config/env.ts 在模块加载期钉死路径。
  const handlers = await import('../app/api/agent/mcp/route')
  POST = handlers.POST
  GET = handlers.GET
  DELETE = handlers.DELETE

  // ---- 鉴权 ----
  const noAuth = await post(rpc(1, 'ping'), { 'Content-Type': 'application/json' })
  check('无 token → 401', noAuth.status === 401, noAuth.status)
  const badAuth = await post(rpc(1, 'ping'), { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' })
  check('错 token → 401', badAuth.status === 401, badAuth.status)

  // ---- initialize ----
  const init = await post(rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'verify', version: '0' } }))
  const initBody = (await init.json()) as any
  check('initialize → 200', init.status === 200, init.status)
  check('返回 protocolVersion（日期形）', /^\d{4}-\d{2}-\d{2}$/.test(initBody?.result?.protocolVersion ?? ''), initBody)
  check('serverInfo 是 ownspire-raven', initBody?.result?.serverInfo?.name === 'ownspire-raven', initBody?.result?.serverInfo)
  check('发 Mcp-Session-Id 头', (init.headers.get('mcp-session-id') ?? '') !== '', init.headers.get('mcp-session-id'))

  // 通知（无 id）→ 202 无正文
  const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  check('通知 → 202 无正文', notified.status === 202, notified.status)

  // ---- tools/list ----
  const listed = await post(rpc(2, 'tools/list'))
  const listBody = (await listed.json()) as any
  const tools: any[] = listBody?.result?.tools ?? []
  check('tools/list 非空', tools.length > 0, tools.length)
  check('工具名已 sanitize（无点）', tools.every((t) => !t.name.includes('.')), tools.map((t) => t.name))
  const filesList = tools.find((t) => t.name === 'raven_files_list')
  check('raven.files.list 映射为 raven_files_list', filesList !== undefined, tools.map((t) => t.name))
  check('readOnlyHint 进 annotations（read 工具）', filesList?.annotations?.readOnlyHint === true, filesList?.annotations)
  const filesRemove = tools.find((t) => t.name === 'raven_files_remove')
  check('destructiveHint 进 annotations（删除工具）', filesRemove?.annotations?.destructiveHint === true, filesRemove?.annotations)
  check('inputSchema 是 JSON Schema（有 properties 或 type）', filesList !== undefined && filesList.inputSchema !== undefined, filesList)

  // ---- tools/call：真执行（raven_files_list 在临时根上）----
  const called = await post(rpc(3, 'tools/call', { name: 'raven_files_list', arguments: {} }))
  const callBody = (await called.json()) as any
  check('tools/call → 200', called.status === 200, called.status)
  check('正常执行 → isError false', callBody?.result?.isError === false, callBody)
  check('content[0].type = text', callBody?.result?.content?.[0]?.type === 'text', callBody?.result)

  // ---- 错误映射 ----
  const unknownTool = await post(rpc(4, 'tools/call', { name: 'no_such_tool', arguments: {} }))
  const unknownBody = (await unknownTool.json()) as any
  check('未知工具 → JSON-RPC error', unknownBody?.error !== undefined, unknownBody)
  check('data.code = unknown_tool（raven 的 code 原样透传）', unknownBody?.error?.data?.code === 'unknown_tool', unknownBody?.error)
  check('未知工具 → invalidParams 码', unknownBody?.error?.code === -32602, unknownBody?.error?.code)

  // 点名调用 → sanitize 后查不到 → 明确报 unknown_tool（证明名字还原存在）
  const dotName = await post(rpc(5, 'tools/call', { name: 'raven.files.list', arguments: {} }))
  const dotBody = (await dotName.json()) as any
  check('点名（raven.files.list）→ unknown_tool（名字已 sanitize,不静默通融）', dotBody?.error?.data?.code === 'unknown_tool', dotBody?.error)

  // ---- 传输边界 ----
  const ping = await post(rpc(6, 'ping'))
  check('ping → 空 result', ping.status === 200 && (await ping.json()).result !== undefined, ping.status)
  const methodNotFound = await post(rpc(7, 'resources/list'))
  check('未知方法 → methodNotFound', (await methodNotFound.json()).error?.code === -32601)
  const garbage = await post('这不是 JSON', authHeaders)
  check('非法 JSON → parseError', garbage.status === 400, garbage.status)
  const badRpc = await post({ jsonrpc: '2.0', id: 8, method: 123 })
  check('method 非字符串 → 不炸（methodNotFound 或 invalidRequest）', [ -32600, -32601 ].includes((await badRpc.json()).error?.code))

  const gotten = await GET(new Request('http://raven.local/api/agent/mcp'))
  check('GET → 405（不提供推送）', gotten.status === 405, gotten.status)
  const deleted = await DELETE(new Request('http://raven.local/api/agent/mcp'))
  check('DELETE → 204', deleted.status === 204, deleted.status)

  console.log(`\n${assertions - failures}/${assertions} 条断言通过。`)
  fs.rmSync(TMP, { recursive: true, force: true })
  if (failures > 0) process.exitCode = 1
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

void main()
