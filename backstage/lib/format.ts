import path from 'node:path'

/**
 * 计费与配额的单位换算集中在这里。
 *
 * 二进制的 GiB/MiB 是文件系统的自然单位，而**硬盘厂标是十进制 GB** ——
 * 两套混用在配置里最容易出「明明写了 10GB 怎么只能放 9.3G」的误会。
 * 所以 raven 的配置**只接受字节数**，需要人读的展示才换算；配置里用 `_GB`/`_GiB`
 * 这类键名（`quotaBytes` 是显式例外）都是显式拆开的。
 */
export const KB = 1000
export const MB = 1000 * 1000
export const GB = 1000 * 1000 * 1000
export const KiB = 1024
export const MiB = 1024 * 1024
export const GiB = 1024 * 1024 * 1024

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

/** 从查询串里取一个正整数，带上下界与默认值。 */
export function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

export function nowMs(): number {
  return Date.now()
}

/** 安全拼接：只用于已经过沙箱校验的绝对路径。 */
export function safeJoin(base: string, ...parts: string[]): string {
  return path.join(base, ...parts)
}
