import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { getConfig } from '@/backstage/lib/config'
import { ApiError } from '@/backstage/lib/http'
import {
  clearSignal,
  describeRemaining,
  describeSignal,
  lockedFor,
  recordFailure,
  recordFailureSignal,
  recordSuccess,
  resetAll,
  resetSignals,
} from '@/backstage/lib/backoff'
import { SetupPinSchema, UnlockPinSchema, UpdatePinSchema, type PinFieldErrors } from './auth.types'
import { getPinEpoch, isPinConfigured, savePin, verifyStoredPin } from './pin.service'

/**
 * 认证与鉴权。
 *
 * 登录方式对齐 navi：**没有账号密码，只有一个 PIN**。首次进入时设置，之后每次输入 PIN 解锁。
 *
 * 为什么 PIN 不写在配置文件里（这是与 raven 旧实现最大的分歧）：
 * 凭据是**运行期产生的状态**。写进配置文件意味着它会跟着配置进版本库、被 diff、
 * 在日志里露面；更根本的是，「首次登录时设置 PIN」这件事根本没法在配置文件里表达 ——
 * 配置文件必须在第一次登录**之前**就存在。所以 PIN 落 SQLite（`pin.service`），
 * 配置文件只留与登录无关的策略参数（会话时长、限流阈值）。
 *
 * 三个实现细节值得说明：
 *
 * 1. **会话绑定 `pinEpoch` 而不是配置指纹。** JWT 里存的是签发时的 epoch，
 *    校验时与数据库里的当前 epoch 比对。换 PIN → epoch 变 → 所有旧会话立刻失效。
 *    这替代了原先的 `configFingerprint`：那个指纹要读配置文件才能算，
 *    而 `proxy.ts` 跑在 Edge runtime 里读不了文件（见那里的说明）。
 * 2. **限流仍然在内存里，而且现在是必需品。** 4 位 PIN 只有 10000 种可能，
 *    没有限流的话一个循环脚本就能枚举完。进程重启清零是有意的 ——
 *    限流要挡的是暴力猜解，而落库的封禁名单会让「重启绕过限流」
 *    变成「运维要手动清表」，后者比前者更糟。
 * 3. **`sub` 不再是用户名。** 单用户场景下没有「用户名」这个概念，
 *    但 JWT 的 `sub` 建议保留（RFC 7519），所以固定填 `'owner'`。
 *    ⚠️ 它是**纯展示用**的，绝不参与任何鉴权判定。
 */

export const SESSION_COOKIE = 'raven_session'

/** 单用户部署：没有账号体系，所有登录成功者都是同一个主体。 */
const SESSION_SUBJECT = 'owner'

export type SessionPayload = {
  sub: string
  /** 签发时的 PIN epoch。与数据库里的当前值不一致即视为失效。 */
  pinEpoch: string
}

function sessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 16) {
    throw new ApiError(
      'no_session_secret',
      'SESSION_SECRET 没有设置或短于 16 字符。请在 .env 或容器 env_file 里给它一个足够长的随机串。',
      500
    )
  }
  return new TextEncoder().encode(secret)
}

// ---------------------------------------------------------------------------
// 登录限流：指数退避
// ---------------------------------------------------------------------------

/**
 * 退避算法在 `backstage/lib/backoff.ts`，四个 ownspire 项目共用同一套。
 *
 * 这里只做两件事：把「IP」变成退避的 key，以及把「被锁」翻译成 HTTP 响应。
 * 算法本身（指数曲线、24 小时封顶、成功归零、攻击信号）都在那边，
 * **不要在这里重写一份** —— 四个项目的退避行为必须一致，
 * 而「复制到第四个文件时改了一行」是这种一致性最常见的死法。
 *
 * ⚠️ `clientIp` 信任 `x-forwarded-for` 的第一个值。这在**有可信反向代理**时是对的，
 * 但意味着客户端可以自己伪造这个头 —— 一个直接暴露到公网、没有代理的部署，
 * 攻击者每次请求换一个伪造的 XFF 就能绕过全部限流。
 * ownspire 的部署形态是 Tailscale 内网 + 反代，所以这里成立。
 * ⚠️ 如果哪天要暴露到公网，必须改成只信任**已知代理**注入的最后一个值，
 * 或者干脆按「认证过的来源」而不是「IP」分桶。
 */

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'local'
}

/**
 * 抛出 429，如果这个 IP 正处于退避锁定中。
 *
 * 错误文案用 `describeRemaining()` 而不是自己拼 —— 四个项目的界面文案要一致，
 * 而且这个函数是唯一知道「锁定还剩多久」的地方。
 */
export function assertNotRateLimited(ip: string): void {
  const remaining = lockedFor(ip)
  if (remaining <= 0) return
  throw new ApiError('rate_limited', describeRemaining(remaining), 429)
}

/**
 * 记一次 PIN 校验失败，施加指数退避，并在判定可疑时打一行日志。
 *
 * ⚠️ **调用方必须先 `assertNotRateLimited()`。** 锁定期间继续调它会让
 * 锁定时长无限顶高 —— 攻击者（或误操作的用户）只要一直点，就能把某人的
 * 锁定顶到 24 小时上限且再也解不开。
 */
export function recordLoginFailure(ip: string): void {
  recordFailure(ip)
  const signal = recordFailureSignal(ip)
  if (signal.suspicious) {
    // ⚠️ 走 console.warn 而不是静默：这是「感知到有人在重试」的唯一出口。
    // PM2 / docker logs 都能直接看到，主人不需要改任何配置。
    console.warn(describeSignal(signal, ip))
  }
}

/** 登录成功 —— 退避计数与攻击信号**一起**清空。 */
export function recordLoginSuccess(ip: string): void {
  recordSuccess(ip)
  clearSignal(ip)
}

/** 测试用：清空退避状态与攻击信号。 */
export function resetRateLimits(): void {
  resetAll()
  resetSignals()
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export async function createSessionToken(): Promise<string> {
  const pinEpoch = await getPinEpoch()
  // ⚠️ 没有 epoch 就没有会话可签发 —— 那是「还没设过 PIN」，属于调用顺序错误。
  // 显式抛错，而不是签一个空 epoch 的 token：后者会在未设 PIN 时产生一个
  // 「看起来已登录」的会话。
  if (!pinEpoch) {
    throw new ApiError('pin_not_configured', '尚未设置 PIN，无法签发会话。', 409)
  }
  const { config } = getConfig()
  const payload: SessionPayload = { sub: SESSION_SUBJECT, pinEpoch }
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.auth.sessionHours}h`)
    .sign(sessionKey())
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string') return null
    const pinEpoch = typeof payload.pinEpoch === 'string' ? payload.pinEpoch : ''
    if (pinEpoch === '') return null
    // 与数据库里的当前 epoch 比对：换过 PIN 之后，所有旧会话在这里全部失效。
    const currentEpoch = await getPinEpoch()
    if (!currentEpoch || pinEpoch !== currentEpoch) return null
    return { sub: payload.sub, pinEpoch }
  } catch {
    return null
  }
}

/** 页面与 API 共用的守卫。未登录一律 401（由 proxy 拦在前面，这里是第二道）。 */
export async function requireSession(): Promise<SessionPayload> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const session = await verifySessionToken(token)
  if (!session) throw new ApiError('unauthorized', '需要登录。', 401)
  return session
}

/**
 * Request 版的登录校验。**agent BFF 路由用这个,不用 requireSession()**：
 * `next/headers` 的 `cookies()` 依赖 Next 的请求作用域,而 BFF 的验证脚本
 * 直调 route handler（scripts/verify-agent-config-bff.ts）没有那个作用域 ——
 * 从 Request 头解析 cookie 让「生产路径」与「直调验证」是同一份代码。
 * 校验逻辑与 requireSession 完全一致（同一个 JWT、同一个 epoch 比对）。
 */
export async function requireSessionFrom(request: Request): Promise<SessionPayload> {
  const cookie = request.headers.get('cookie') ?? ''
  const pair = cookie
    .split(/;\s*/)
    .find((item) => item.startsWith(`${SESSION_COOKIE}=`))
  const session = await verifySessionToken(pair?.slice(SESSION_COOKIE.length + 1))
  if (!session) throw new ApiError('unauthorized', '需要登录。', 401)
  return session
}

export async function currentSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return verifySessionToken(token)
}

export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt),
  }
}

// ---------------------------------------------------------------------------
// 三个登录动作：设置 / 解锁 / 修改
// ---------------------------------------------------------------------------

export type AuthResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; errors: PinFieldErrors }

function sessionLifetimeMs(): number {
  return getConfig().config.auth.sessionHours * 3600 * 1000
}

/**
 * 首次设置 PIN。
 *
 * ⚠️ 已设置过就拒绝 —— 否则任何能打开 `/login` 的人都能覆盖掉现有 PIN。
 * 这条边界是「首次设置」与「修改」的分界：修改必须先验当前 PIN（见 `updatePin`）。
 */
export async function setupPin(input: unknown, ip: string): Promise<AuthResult> {
  assertNotRateLimited(ip)
  if (await isPinConfigured()) {
    return { ok: false, errors: { pin: ['PIN 已设置，请直接解锁'] } }
  }
  const parsed = SetupPinSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.flatten().fieldErrors }
  }
  await savePin(parsed.data.pin)
  recordLoginSuccess(ip)
  return { ok: true, token: await createSessionToken(), expiresAt: Date.now() + sessionLifetimeMs() }
}

/**
 * 用 PIN 解锁。
 *
 * PIN 错误时**不回显是哪一位错**：4 位数字的组合本来就少，
 * 任何额外信息都只会缩小枚举空间。
 */
export async function loginWithPin(input: unknown, ip: string): Promise<AuthResult> {
  assertNotRateLimited(ip)
  if (!(await isPinConfigured())) {
    return { ok: false, errors: { pin: ['尚未设置 PIN'] } }
  }
  const parsed = UnlockPinSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.flatten().fieldErrors }
  }
  const valid = await verifyStoredPin(parsed.data.pin)
  if (!valid) {
    recordLoginFailure(ip)
    return { ok: false, errors: { pin: ['PIN 不正确'] } }
  }
  recordLoginSuccess(ip)
  return { ok: true, token: await createSessionToken(), expiresAt: Date.now() + sessionLifetimeMs() }
}

/**
 * 修改 PIN。必须先验当前 PIN。
 *
 * `savePin` 会换掉 epoch，于是**除本次签发的会话外，所有旧会话立即失效** ——
 * 这就是「PIN 泄露之后改 PIN 等于把窃取者锁在外面」的全部机制，没有任何额外代码。
 */
export async function updatePin(input: unknown, ip: string): Promise<AuthResult> {
  assertNotRateLimited(ip)
  if (!(await isPinConfigured())) {
    return { ok: false, errors: { currentPin: ['尚未设置 PIN'] } }
  }
  const parsed = UpdatePinSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.flatten().fieldErrors }
  }
  const valid = await verifyStoredPin(parsed.data.currentPin)
  if (!valid) {
    recordLoginFailure(ip)
    return { ok: false, errors: { currentPin: ['当前 PIN 不正确'] } }
  }
  await savePin(parsed.data.pin)
  recordLoginSuccess(ip)
  return { ok: true, token: await createSessionToken(), expiresAt: Date.now() + sessionLifetimeMs() }
}

/**
 * 常量时间的令牌比较 —— 给服务自注册与脚本回调 API 用。
 *
 * ⚠️ `expected` 为空必须**直接判否**，不能落到下面的比较里：
 * 配置里没设 `registrationToken` 时它可能是空串，而空串比空串是 true ——
 * 那会让「没配令牌」变成「任何令牌都通」，是一个静默的完全认证绕过。
 */
export function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false
  // 先各自散列成定长再比：这样长度差异不会从比较耗时里漏出去。
  const a = createHash('sha256').update(provided, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}
