/**
 * 浏览器侧的格式化工具。
 *
 * ⚠️ **绝对不要 import `@/backstage/lib/format`**。那份带 `server-only`，
 * 一旦被客户端组件引用，构建期直接失败；而且它的 `humanBytes` 面向日志
 * （精度取舍不同），与界面上「一眼看出大小」的目标不一样。
 * 两份实现是有意的重复，不要合并。
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
const KIB = 1024

/** 人类可读字节数。1 位小数的精度不足以区分上传前后的差异，故用 0/1 位自适应。 */
export function humanBytes(bytes: number | null | undefined, options: { precise?: boolean } = {}): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < 0) return '—'
  if (bytes < KIB) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= KIB && unit < BYTE_UNITS.length - 1) {
    value /= KIB
    unit += 1
  }
  const digits = options.precise ? 2 : value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

/** 传输速率：上传进度条上要显示「还剩多久」，只显示百分比不够。 */
export function humanRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${humanBytes(bytesPerSecond)}/s`
}

/** 剩余毫秒 → 「约 12 秒」。用于上传与脚本超时的预估。 */
export function humanDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

/** `2026-10-08 13:33:05`。用本地时区 —— 这是给自己看的界面。 */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

/** 只要 `10-08 13:33` —— 列表里列宽有限，年份和秒都是噪声。 */
export function formatShortDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 相对时间。**必须传入 `now`**（调用方从状态里给），不能在函数内部 `Date.now()`：
 * 内部取时间会让 React 的渲染结果不可复现，也拿不到「每秒刷新」的驱动源。
 */
export function relativeTime(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '从未'
  const diff = now - ms
  if (diff < 0) return '刚刚'
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatShortDateTime(ms)
}

/** 指标数值：小数位按量级自适应，避免 `0.10` 与 `12345.6789` 同时难看。 */
export function formatMetric(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  let text: string
  if (Number.isInteger(value)) text = value.toLocaleString('zh-CN')
  else if (abs >= 100) text = value.toFixed(1)
  else if (abs >= 1) text = value.toFixed(2)
  else if (abs === 0) text = '0'
  else text = value.toPrecision(3)
  return unit ? `${text} ${unit}` : text
}

/** 毫秒延迟。`null` 表示这次探测根本没测出耗时。 */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * 按字节数截断**显示用**字符串。
 *
 * ⚠️ 这里只用于预览，不用于写入：真正的截断必须由服务端决定（`truncated` 字段），
 * 客户端截断后当成完整内容提交会造成静默数据损坏。
 */
export function previewText(text: string, maxChars = 200): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

/** 取路径最后一段。空路径（根）返回 `/`。 */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const index = trimmed.lastIndexOf('/')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** 拼接相对路径。**不做 `..` 归一**（那是服务端沙箱的活），只负责去掉多余斜杠。 */
export function joinPath(dir: string, name: string): string {
  const cleanDir = dir.replace(/^\/+|\/+$/g, '')
  const cleanName = name.replace(/^\/+/g, '')
  if (cleanDir === '') return cleanName
  return `${cleanDir}/${cleanName}`
}

/** 父目录；根目录返回 null。 */
export function parentPath(path: string): string | null {
  const clean = path.replace(/^\/+|\/+$/g, '')
  if (clean === '') return null
  const index = clean.lastIndexOf('/')
  return index === -1 ? '' : clean.slice(0, index)
}
