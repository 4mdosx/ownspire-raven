import 'server-only'
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { deleteSetting, getSetting, setSetting } from '@/backstage/db/database'

/**
 * PIN 的存储与校验。
 *
 * 对齐 navi 的做法：**散列存进 SQLite，不进配置文件**。凭据是运行期产生的状态，
 * 配置文件是人工维护的声明 —— 把密码写进配置意味着它会跟着配置一起进版本库、
 * 一起被 diff、一起在日志里露面。
 *
 * 散列格式沿用 raven 原有的 `scrypt$N$r$p$salt$hash`，而不是 navi 的三段式
 * `scrypt$salt$hash`。理由是 raven 原来那版已经踩过这个坑并修掉了：只判
 * 「字段数 == 6」是不够的，`scrypt$1$2$3$4$5` 恰好也是六字段，而 N=1 会让 node 抛
 * `RangeError: Invalid scrypt params` —— 一个畸形值把「PIN 不正确」变成 500，
 * 调用方完全无法从现象反推是哪一步错了。换成 PIN 之后这条更该守住：PIN 只有
 * 4 位，**空间小到值得认真对待枚举**，参数校验漏了就是能被远程利用的拒绝服务。
 *
 * 三个设计决定：
 *
 * 1. **PIN 是 4 位数字**（`PIN_LENGTH` 定义在 auth.types）。沿用 navi 的选择。
 *    自托管单用户场景下它的作用是「挡住无意访问」，不是「抵御有备而来的攻击者」——
 *    所以 `loginRateLimit` 必须继续开着：4 位 PIN 让暴力猜解的成本降了一个数量级，
 *    这正是限流从「锦上添花」变成「必需品」的原因。
 * 2. **`pinEpoch` 是一次性 UUID**。换 PIN 就换一个 epoch，会话里存的是签发时的
 *    epoch，对不上即失效。这替代了原先的「配置指纹」：改凭据作废旧会话，
 *    但不必在每次校验时去读配置文件。
 * 3. **限流留在内存里，故意不落库。** 落库的封禁名单会让「重启绕过限流」
 *    变成「运维要手动清表」—— 后者比前者更糟。
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number }
) => Promise<Buffer>

export const PIN_HASH_KEY = 'pin.hash'
export const PIN_EPOCH_KEY = 'pin.epoch'
export const PIN_UPDATED_AT_KEY = 'pin.updatedAt'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32

export type PinStatus = {
  configured: boolean
  updatedAt: string | null
}

// ---------------------------------------------------------------------------
// settings 键值读写
// ---------------------------------------------------------------------------

/**
 * settings 键值读写。
 *
 * ⚠️ 这三个函数在 drizzle 之后变成 async —— 数据库层整体是异步的。
 * 于是 `isPinConfigured()` / `getPinEpoch()` / `getPinStatus()` 也跟着变成
 * async，调用方（登录页、auth.service）必须 await。这不是可选的：少了 await
 * 拿到的是一个 Promise，而 `Promise !== null` 恒真 —— 表现为「永远显示已设置
 * PIN」，而类型检查在 `await` 缺失处会直接报错，所以这条裂缝是能被 tsc 抓住的。
 */
async function readSetting(key: string): Promise<string | null> {
  return getSetting(key)
}

async function writeSetting(key: string, value: string): Promise<void> {
  await setSetting(key, value)
}

async function removeSetting(key: string): Promise<void> {
  await deleteSetting(key)
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 有没有设过 PIN。登录页靠它决定进「设置」还是「解锁」。 */
export async function isPinConfigured(): Promise<boolean> {
  return (await readSetting(PIN_HASH_KEY)) !== null
}

/** 当前 epoch。会话校验时与 cookie 里的比对，不一致即失效。 */
export async function getPinEpoch(): Promise<string | null> {
  return readSetting(PIN_EPOCH_KEY)
}

export async function getPinStatus(): Promise<PinStatus> {
  return {
    configured: await isPinConfigured(),
    updatedAt: await readSetting(PIN_UPDATED_AT_KEY),
  }
}

/**
 * 存一个新 PIN，返回新的 epoch。
 *
 * 三个 key 必须一起写。调用方（auth.service）拿到 epoch 之后立刻签发带它的会话 ——
 * 如果 epoch 没落库，会话校验会永远失败，表现为「刚设完 PIN 就被弹回登录页」。
 */
export async function savePin(pin: string): Promise<string> {
  const hash = await hashPin(pin)
  const epoch = randomUUID()
  const updatedAt = new Date().toISOString()
  await writeSetting(PIN_HASH_KEY, hash)
  await writeSetting(PIN_EPOCH_KEY, epoch)
  await writeSetting(PIN_UPDATED_AT_KEY, updatedAt)
  return epoch
}
/**
 * 校验一个 PIN。
 *
 * ⚠️ 散列不存在一律判否 —— 那是「还没设过」，不是「空 PIN 恰好正确」。
 * 这与 `tokenMatches` 里那条「`expected` 为空直接判否」是同一个道理：
 * 「没配」绝不能等价于「什么都对」。
 */
export async function verifyStoredPin(pin: string): Promise<boolean> {
  const stored = await readSetting(PIN_HASH_KEY)
  if (!stored) return false
  return verifyPinHash(pin, stored)
}

/** 清掉 PIN，回到「未设置」状态。运维忘了 PIN 时的逃生门。 */
export async function clearStoredPin(): Promise<void> {
  await removeSetting(PIN_HASH_KEY)
  await removeSetting(PIN_EPOCH_KEY)
  await removeSetting(PIN_UPDATED_AT_KEY)
}

// ---------------------------------------------------------------------------
// 散列
// ---------------------------------------------------------------------------

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(pin, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

/**
 * 校验散列。
 *
 * ⚠️ 参数范围必须显式判，不能只判字段数 —— 理由见文件头。
 */
export async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts
  const N = Number.parseInt(nRaw, 10)
  const r = Number.parseInt(rRaw, 10)
  const p = Number.parseInt(pRaw, 10)
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  // N 必须是 2 的幂（scrypt 的硬性要求）；r / p 至少为 1。
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return false
  // 单次散列最多吃 1 GiB，防一个畸形值把自己 DoS 掉。
  const memory = 128 * N * r
  if (memory <= 0 || memory > 1 << 30) return false
  let expected: Buffer
  let salt: Buffer
  try {
    expected = Buffer.from(hashRaw, 'base64url')
    salt = Buffer.from(saltRaw, 'base64url')
  } catch {
    return false
  }
  if (expected.length === 0 || salt.length === 0) return false
  const derived = (await scrypt(pin, salt, expected.length, {
    N,
    r,
    p,
    maxmem: memory * 2,
  })) as Buffer
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}
