/**
 * BFF 转发层的验证（agent 契约 §三「配置目录」）。
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
  console.log('\n[BFF · 配置目录转发]')

  // ⚠️ route 模块在 env 就位之后才加载（见文件头）。
  const { DELETE, GET, POST, PUT } = await import('../app/api/agent/config/[[...path]]/route')

  // 临时库里设一次 PIN → 签发登录 cookie。BFF 现在每条路由都校验登录态
  //（2026-10-09 审计裁定:全权代理不能挂在无鉴权端口上）,脚本扮演已登录浏览器。
  const { savePin } = await import('../backstage/services/pin.service')
  const { createSessionToken, SESSION_COOKIE } = await import('../backstage/services/auth.service')
  await savePin('0000')
  AUTH_COOKIE = `${SESSION_COOKIE}=${await createSessionToken()}`

  // ⚠️ **用一次性厂商，不要动 seed 里的deepseek。**
  // 早先这个脚本直接删 deepseek，于是它自我毁坏：第一次跑把端点删了，
  // 第二次跑就没有「下级」可拒，409 那条断言静默变成 200 ——
  // 而「测试跑第二遍开始就不准」这件事，往往要等到某天它掩盖了一个真 bug 才被发现。
  const PROVIDER = 'bff-verify-tmp'

  // ---- 读 ----
  const read = await call(GET, '/api/config')
  check('GET 透传 → 200', read.status === 200, read.status)
  // ⚠️ raven 的 envelope 是**扁平**的：`ok()` 把 agent 的返回直接摊到顶层
  // （`{ ok: true, providers, endpoints, models }`），**没有 data 层**。
  // 按「常见惯例」去读 `json.data` 会拿到 undefined，
  // 而症状是「三段都没回来」—— 指向一个根本不存在的层级问题。
  check(
    '三段都回来了（在顶层，不在 data 里）',
    Array.isArray(read.json['providers']) &&
      Array.isArray(read.json['endpoints']) &&
      Array.isArray(read.json['models']),
    Object.keys(read.json)
  )
  check('⚠️ 响应里搜不到 "apiKey" 键', !read.text.includes('"apiKey"'))
  check('脱敏字段确实在（apiKeySource / apiKeySet）', read.text.includes('apiKeySource'))
  // ⚠️ keyEnvVar 已从契约里删掉（2026-10-09，key 只从库里来）。
  // 这条断言守着 BFF **不做字段增补** —— 它只转发，不加工。
  // 万一哪天有人在 envelope 里补了个 keyEnvVar，界面就会显示一个填了不生效的输入框。
  check('响应里没有 keyEnvVar（BFF 不补字段，只转发）', !read.text.includes('keyEnvVar'))

  try {
    // ---- 建厂商 + 端点 + 模型（给删除准备「下级」）----
    const makeProvider = await call(PUT, `/api/config/providers/${PROVIDER}`, {
      init: {
        method: 'PUT',
        body: JSON.stringify({
          label: 'BFF 验证用',
          defaultProtocol: 'openai-chat-completions',
          apiKey: 'sk-bff-verify-7777',
        }),
      },
    })
    check('PUT 建厂商 → 200', makeProvider.status === 200, `${makeProvider.status} ${makeProvider.text.slice(0, 160)}`)
    check('⚠️ 写接口的响应里也搜不到 "apiKey"', !makeProvider.text.includes('"apiKey"'))
    check('回执带掩码（说明 key 真写进去了）', makeProvider.text.includes('****7777'), makeProvider.text.slice(0, 200))
    check('来源标成 db（body 确实到了 agent 而不是被丢掉）', makeProvider.text.includes('"apiKeySource":"db"'))

    const makeEndpoint = await call(PUT, `/api/config/endpoints/${PROVIDER}-chat`, {
      init: {
        method: 'PUT',
        body: JSON.stringify({ providerId: PROVIDER, label: '验证端点', baseUrl: 'https://example.invalid/v1' }),
      },
    })
    check('PUT 建端点 → 200', makeEndpoint.status === 200, makeEndpoint.text.slice(0, 160))

    const makeModel = await call(PUT, '/api/config/models', {
      init: {
        method: 'PUT',
        body: JSON.stringify({ id: 'bff-verify-model', endpointId: `${PROVIDER}-chat`, label: '验证模型' }),
      },
    })
    check('PUT 建模型 → 200', makeModel.status === 200, makeModel.text.slice(0, 160))

    const probe = await call(POST, `/api/config/providers/${PROVIDER}/probe`, {
      init: { method: 'POST', body: JSON.stringify({}) },
    })
    check('POST 检测被转发且连不上也是 200', probe.status === 200 && probe.json['reached'] === false, `${probe.status} ${probe.text.slice(0, 180)}`)
    check('⚠️ 检测响应里搜不到 "apiKey"，也没有明文 key', !probe.text.includes('"apiKey"') && !probe.text.includes('sk-bff-verify-7777'))

    // ---- 级联：query string 必须转发 ----
    const noCascade = await call(DELETE, `/api/config/providers/${PROVIDER}`)
    check('DELETE 不带 cascade → 409', noCascade.status === 409, `${noCascade.status} ${noCascade.text.slice(0, 160)}`)
    check('code 如实透传（前端靠它弹确认框）', noCascade.json['code'] === 'cascade_required', noCascade.json)

    // ---- 400 与 405 ----
    const bad = await call(PUT, '/api/config/models', {
      init: {
        method: 'PUT',
        body: JSON.stringify({ id: 'x', endpointId: `${PROVIDER}-chat`, reasoningEffort: 'ludicrous' }),
      },
    })
    check('参数不合法 → 400（不是 500）', bad.status === 400, `${bad.status} ${bad.text.slice(0, 160)}`)
    check('agent 的原话透传（不在这里二次翻译）', bad.text.includes('low / high / max'), bad.text.slice(0, 200))

    const wrongMethod = await call(POST, '/api/config', { init: { method: 'POST' } })
    check('不支持的动词 → 405 而不是 Next 的默认页', wrongMethod.status === 405, wrongMethod.status)

    // ---- 删不存在的 ----
    const missing = await call(DELETE, '/api/config/providers/nope', { query: 'cascade=1' })
    check('删不存在的 → 404', missing.status === 404, `${missing.status} ${missing.text.slice(0, 120)}`)

    // ---- query string 转发（放在最后：它会真删东西）----
    const cascade = await call(DELETE, `/api/config/providers/${PROVIDER}`, { query: 'cascade=1' })
    check('⚠️ query string 转发 → 带 cascade 就成功', cascade.status === 200, `${cascade.status} ${cascade.text.slice(0, 160)}`)
    check('回执报清连带删了什么', cascade.text.includes('removedEndpoints') && cascade.text.includes('removedModels'), cascade.text.slice(0, 200))

    const after = await call(GET, '/api/config')
    check(
      '⚠️ 没留下孤儿（厂商、端点、模型都不在了）',
      !after.text.includes(PROVIDER) && !after.text.includes('bff-verify-model'),
      after.text.slice(0, 200)
    )
  } finally {
    // 兜底清理：断言失败时也要把临时厂商删掉，否则下次跑会被上一轮的残留影响。
    await call(DELETE, `/api/config/providers/${PROVIDER}`, { query: 'cascade=1' })
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
