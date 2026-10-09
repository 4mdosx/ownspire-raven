import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ULID（26 字符，Crockford Base32，前 10 位是时间戳）。
 *
 * 为什么不用 nanoid：剪切板的排序就是队列顺序，而**字典序 = 时间序**让
 * 「按 id 排序」在任何降级路径（时间戳精度不足、同时刻多条）下都仍然正确。
 */
export function ulid(now = Date.now()): string {
  let timePart = ''
  let remaining = now
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD[remaining % 32] + timePart
    remaining = Math.floor(remaining / 32)
  }
  const bytes = randomBytes(16)
  let randomPart = ''
  for (let index = 0; index < 16; index += 1) {
    randomPart += CROCKFORD[bytes[index] % 32]
  }
  return timePart + randomPart
}

/** 临时目录名：时间戳 + 随机段，天然可排序且不会撞。 */
export function runTempName(now = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(5).toString('hex')}`
}

/**
 * 一次工具执行的 ID（Raven Tool Protocol v1）。
 *
 * 用 ULID 而不是纯随机：`exe_` 之后仍是**字典序 = 时间序**，
 * 于是日志里按 id 排序就是按发起顺序排序，不需要额外带时间戳字段。
 */
export function executionId(now = Date.now()): string {
  return `exe_${ulid(now)}`
}
