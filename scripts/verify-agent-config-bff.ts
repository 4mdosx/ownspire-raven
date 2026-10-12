/**
 * BFF 转发层的验证：预算透传，模型目录接口是 404。
 *
 * ## 为什么直接打 route handler 而不走 HTTP
 *
 * 走 HTTP 要先过 raven 的登录态，而**拿得到密码就不该拿** ——
 * 验证脚本持有管理员凭据这件事本身是个风险。
 * 直接调用 handler 验的是这一层真正负责的东西：
 * **路径拼接、query string 转发、body 转发、状态码与 code 透传。**
 * 登录那一层由 proxy 管，不在这里重复验。
 *
 * ⚠️ 断言的主体是**搜字符串**：`"apiKey"` 这个键在任何响应里都不该出现。
 * 只检查「有没有 apiKeySet 字段」是不够的 —— 明文可能藏在别的字段名下面。
 *
 * 需要 little-one 在 5900 上跑着。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ⚠️ **必须在 route 模块加载之前写好 env**（ESM 静态 import 会提升,所以
// route 用 main 里的动态 import）。raven 的库与配置指向临时目录 ——
// requireSessionFrom 现在要读 raven 自己的 pin 表,不能碰真库。
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'verify-bff-secret-16-chars!!'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-bff-verify-'))
process.env.RAVEN_CONFIG = path.join(TMP, 'raven.config.json')
fs.writeFileSync(
  process.env.RAVEN_CONFIG,
  JSON.stringify({
    rootPath: path.join(TMP, 'root'),
    workspace: { name: 'workspace', quotaBytes: null, allowScriptExecution: false, scriptsDir: 'scripts' },
    clipboard: { maxItems: 100, maxTextBytes: 65536 },
    auth: { sessionHours: 1, loginRateLimit: { windowSeconds: 60, maxFailures: 5 } },
  })
)
process.env.RAVEN_DB_FILE = path.join(TMP, 'raven.db')

const BASE = 'http://127.0.0.1:5900'

/** 登录态 cookie。main 里签发（需要先在临时库里设一次 PIN）。 */
let AUTH_COOKIE = ''

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

function ctx(path?: string[]): { params: Promise<{ path?: string[] }> } {
  return { params: Promise.resolve(path === undefined ? {} : { path }) }
}

type Seen = { status: number; text: string; json: Record<string, unknown> }

/**
 * 打一次转发。
 *
 * ⚠️ `agentPath` 是**agent 侧**的路径（`/api/config/...`），而 handler 要的是
 * raven 侧的 URL 与 catch-all 捕获的那几段。两个前缀不一样，混起来会得到
 * `/api/config/api/config/providers/x` —— 症状是 404「没有这个接口」，
 * 看起来像转发坏了，其实是调用方拼错了路径。
 *
 * ⚠️ **query 必须单独传，不能拼在 path 后面。** 拼进去的话它会变成
 * 路径的最后一���（`厂商 deepseek?cascade=1 不存在`）——
 * 而真实浏览器请求的 query 是 URL 的独立部分，不会进 path。
 * 这个错在测试里表现为「级联删不掉」，很容易被误判成转发层的 bug。
 */
async function call(
  fn: unknown,
  agentPath: string,
  options: { query?: string; init?: RequestInit } = {}
): Promise<Seen> {
  const relative = agentPath.replace(/^\/api\/config\/?/, '')
  const segments = relative === '' ? [] : relative.split('/')
  const search = options.query === undefined ? '' : `?${options.query}`
  const url = `${BASE}/api/agent/config${relative === '' ? '' : `/${relative}`}${search}`
  // 登录态走 cookie 头 —— requireSessionFrom(request) 从这里解析（契约 §二：
  // 浏览器只跟 raven 说话；验证脚本扮演的正是那个已登录的浏览器）。
  const headers = new Headers(options.init?.headers)
  if (AUTH_COOKIE !== '') headers.set('Cookie', AUTH_COOKIE)
  const init: RequestInit = { ...options.init, headers }
  const res = await (fn as (request: Request, context: unknown) => Promise<Response>)(
    new Request(url, init),
    ctx(segments.length === 0 ? undefined : segments)
  )
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* 非 JSON 也照样能断言状态码 */
  }
  return { status: res.status, text, json }
}

async function main(): Promise<void> {
  console.log('\n[BFF · 预算转发]')

  const { GET, POST, PUT } = await import('../app/api/agent/config/[[...path]]/route')

  const { savePin } = await import('../backstage/services/pin.service')
  const { createSessionToken, SESSION_COOKIE } = await import('../backstage/services/auth.service')
  await savePin('0000')
  AUTH_COOKIE = `${SESSION_COOKIE}=${await createSessionToken()}`

  const read = await call(GET, '/api/config')
  check('GET 透传 → 200', read.status === 200, read.status)
  const budget = read.json['budget'] as { limit?: unknown } | undefined
  check('顶层是预算，没有厂商目录', budget !== undefined && !('providers' in read.json), Object.keys(read.json))
  check('响应里搜不到 apiKey', !read.text.includes('apiKey'))

  const previous = budget?.limit ?? null
  try {
    const put = await call(PUT, '/api/config/budget', {
      init: { method: 'PUT', body: JSON.stringify({ limit: 1000 }) },
    })
    check('PUT 预算 → 200', put.status === 200, put.text.slice(0, 160))
    const gone = await call(PUT, '/api/config/providers/zhipu', {
      init: { method: 'PUT', body: JSON.stringify({ label: '智谱' }) },
    })
    check('PUT 厂商 → 404', gone.status === 404, gone.status)
    const wrongMethod = await call(POST, '/api/config', { init: { method: 'POST' } })
    check('POST /api/config → 405', wrongMethod.status === 405, wrongMethod.status)
  } finally {
    await call(PUT, '/api/config/budget', {
      init: { method: 'PUT', body: JSON.stringify({ limit: previous }) },
    })
  }

  console.log('')
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`${assertions - failures}/${assertions} 条断言`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error('✗', error)
  process.exitCode = 1
})
