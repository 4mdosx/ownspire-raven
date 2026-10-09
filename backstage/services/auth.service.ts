import 'server-only'
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { getConfig } from '@/backstage/lib/config'
import { ApiError } from '@/backstage/lib/http'

/**
 * 认证与鉴权。
 *
 * 按需求：账号密码写在配置里，**单账号、全权限**。所以这里没有角色表，
 * 只有「登录 / 未登录」两种状态，登录后所有能力都开。
 *
 * 两个实现细节值得说明：
 *
 * 1. **密码两种存法**。`auth.password` 是明文（需求明确要求"账号密码写在配置里面"，
 *    对自托管单用户场景这是可接受的），`auth.passwordHash` 是 `scrypt$...`，
 *    存在就优先用。明文比较也走 `timingSafeEqual`，避免长度/前缀差异的时序泄漏。
 * 2. **登录限流在内存里**。单实例部署下足够；进程重启就清零，这是有意的 ——
 *    限流的目的是挡住暴力猜解，不是持久化的封禁名单，而落库会让"重启绕过"
 *    变成"运维要手动清表"。
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number }
) => Promise<Buffer>

export const SESSION_COOKIE = 'raven_session'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts
  const N = Number.parseInt(nRaw, 10)
  const r = Number.parseInt(rRaw, 10)
  const p = Number.parseInt(pRaw, 10)
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  // ⚠️ 光判「六个字段」是不够的：`scrypt$1$2$3$4$5` 恰好也是六个字段，
  // 而 N=1 / r=2 / p=3 会让 node 抛 `RangeError: Invalid scrypt params` ——
  // 一个畸形（或被改坏的）配置项会把「密码错误」变成 500，
  // 而调用方完全无法从现象判断到底哪一步错了。所以参数范围必须显式判。
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return false
  const memory = 128 * N * r
  if (memory <= 0 || memory > 1 << 30) return false // 单次散列最多吃 1 GiB，防配置写错把自己 DoS
  let expected: Buffer
  let salt: Buffer
  try {
    expected = Buffer.from(hashRaw, 'base64url')
    salt = Buffer.from(saltRaw, 'base64url')
  } catch {
    return false
  }
  if (expected.length === 0 || salt.length === 0) return false
  const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: memory * 2 })
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

function constantTimeStringEqual(left: string, right: string): boolean {
  // 先各自散列成定长，再比 —— 这样长度差异不会从比较耗时里漏出去。
  const a = createHash('sha256').update(left, 'utf8').digest()
  const b = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(a, b)
}

async function checkCredentials(username: unknown, password: unknown): Promise<boolean> {
  const { config } = getConfig()
  if (typeof username !== 'string' || typeof password !== 'string') return false
  const usernameOk = constantTimeStringEqual(username, config.auth.username)
  const passwordOk = config.auth.passwordHash
    ? await verifyPasswordHash(password, config.auth.passwordHash)
    : constantTimeStringEqual(password, config.auth.password ?? '')
  // 两个都算完再合并，避免用户名不存在时提前返回（那会变成一个用户名枚举信道）。
  return usernameOk && passwordOk
}

// ---------------------------------------------------------------------------
// 登录限流
// ---------------------------------------------------------------------------

type Attempt = { failures: number; firstAt: number; blockedUntil: number }
const attempts = new Map<string, Attempt>()

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'local'
}

export function assertNotRateLimited(ip: string): void {
  const { config } = getConfig()
  const { windowSeconds, maxFailures } = config.auth.loginRateLimit
  const entry = attempts.get(ip)
  if (!entry) return
  const now = Date.now()
  if (entry.blockedUntil > now) {
    const seconds = Math.ceil((entry.blockedUntil - now) / 1000)
    throw new ApiError('rate_limited', `登录失败次数过多，请 ${seconds} 秒后再试。`, 429)
  }
  if (now - entry.firstAt > windowSeconds * 1000) attempts.delete(ip)
  void maxFailures
}

export function recordLoginFailure(ip: string): void {
  const { config } = getConfig()
  const { windowSeconds, maxFailures } = config.auth.loginRateLimit
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || now - entry.firstAt > windowSeconds * 1000) {
    attempts.set(ip, { failures: 1, firstAt: now, blockedUntil: 0 })
    return
  }
  entry.failures += 1
  if (entry.failures >= maxFailures) {
    entry.blockedUntil = now + windowSeconds * 1000
  }
}

export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip)
}

export function resetRateLimits(): void {
  attempts.clear()
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

type SessionPayload = {
  sub: string
  /** 配置指纹：改密码/改用户名之后旧会话立即失效，不用手动清 cookie。 */
  fingerprint: string
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

export function configFingerprint(): string {
  const { config } = getConfig()
  return createHash('sha256')
    .update(`${config.auth.username}|${config.auth.passwordHash ?? config.auth.password ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

export async function createSessionToken(): Promise<string> {
  const { config } = getConfig()
  const payload: SessionPayload = { sub: config.auth.username, fingerprint: configFingerprint() }
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
    if (payload.fingerprint !== configFingerprint()) return null
    return { sub: payload.sub, fingerprint: String(payload.fingerprint) }
  } catch {
    return null
  }
}

export async function login(
  username: unknown,
  password: unknown,
  ip: string
): Promise<{ token: string; expiresAt: number }> {
  assertNotRateLimited(ip)
  const valid = await checkCredentials(username, password)
  if (!valid) {
    recordLoginFailure(ip)
    throw new ApiError('invalid_credentials', '用户名或密码不正确。', 401)
  }
  recordLoginSuccess(ip)
  const { config } = getConfig()
  const token = await createSessionToken()
  return { token, expiresAt: Date.now() + config.auth.sessionHours * 3600 * 1000 }
}

/** 页面与 API 共用的守卫。未登录一律 401（由 proxy 拦在前面，这里是第二道）。 */
export async function requireSession(): Promise<SessionPayload> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const session = await verifySessionToken(token)
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

/**
 * 常量时间的脚本令牌比较 —— 给服务自注册与脚本回调 API 用。
 *
 * ⚠️ `expected` 为空必须**直接判否**，不能落到下面的比较里：
 * 配置里没设 `registrationToken` 时它可能是空串，而
 * `constantTimeStringEqual('', '')` 是 true —— 那会让「没配令牌」
 * 变成「任何令牌都通」，是一个静默的完全认证绕过。
 */
export function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false
  return constantTimeStringEqual(provided, expected)
}
