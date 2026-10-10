/**
 * PIN 重试的指数退避。**四个 ownspire 项目共用同一套参数与算法**
 * （navi / ownspire-raven / ownspire-shrine / creative-atlas）。
 *
 * ============================ 为什么是指数退避 ============================
 *
 * 固定窗口（raven 原来的「5 分钟内 10 次」）有一个致命的性质：
 * **窗口一过，攻击者立刻拿回全部额度。** 4 位 PIN 只有 10000 种可能，
 * 固定窗口下平均需要 1000 个窗口 —— 而窗口是**无限循环**的，
 * 所以它挡不住持续攻击，只是把速度除以了一个常数。
 *
 * 指数退避把「第 n 次失败」的代价变成 `2^n` 量级：
 * 前 10 次很快（几十秒到几分钟），第 20 次已经半小时，
 * 到第 25 次之后恒定 24 小时。枚举完 10000 个 PIN 的总时间从
 * 「几天」变成「天文数字」—— 这才是真正把暴破的成本抬到无意义的量级。
 *
 * ============================ 三个刻意的设计决定 ============================
 *
 * 1. **上限 24 小时，不是无限。**
 *    指数增长必须封顶，否则第 40 次会算出 `2^39` 毫秒 —— 那会让
 *    `setTimeout` 溢出（Node 的定时器上限约 24.8 天，会直接触发 TimeoutOverflowWarning
 *    并**立刻**触发）。而且「永久锁死」对一个自托管单用户服务是有害的：
 *    用户自己输错 PIN 若干次就再也进不去，而没有任何办法恢复。
 *
 * 2. **状态在内存里，进程重启即清零。** 这是明确的取舍，不是省事：
 *    落库才能跨重启封禁，但要处理「表结构变更」「多实例共享」「清表运维」三件事。
 *    内存态的**边界必须写清楚**：它的前提是**攻击者拿不到重启服务的能力**。
 *    在 Tailscale 内网 + 容器编排的部署里这通常成立（拿到重启权限
 *    意味着已经有了容器编排的控制权，那本来就能读数据库、看到 PIN 散列）。
 *    ⚠️ 所以它挡的是「从公网扫到的无差别暴破」，不是「有内网 foothold 的攻击者」。
 *
 * 3. **成功后立即归零，包括「被锁定期间」的语义。**
 *    锁定期间每次请求都只返回剩余时间，**不增加计数** —— 否则攻击者
 *    可以靠持续请求把某人的锁定时间顶到 24 小时上限，让他再也进不去
 *    （自我 DoS）。计数只在**真正校验 PIN 且失败**时 +1。
 *
 * ============================ 为什么不再叠加 IP 之外的维度 ============================
 *
 * 有 IP 计数就够，不需要按 UA / 指纹再分桶：分桶越多，单个攻击者可以低成本
 * 地把额度摊薄到多个桶里 —— 那是**帮了攻击者**。一个 IP 一个桶最严格。
 */

export type BackoffConfig = {
  /**
   * 第一次失败后锁定多久（毫秒）。
   *
   * ⚠️ 30 秒是**权衡**出来的数字，见文件头「参数为什么是这一组」。
   */
  baseMs: number
  /** 倍数。第 n 次失败的锁定时长 = baseMs * multiplier^(n-1)，封顶 maxMs。 */
  multiplier: number
  /** 封顶（毫秒）。默认 24 小时。 */
  maxMs: number
}

/**
 * 默认参数。
 *
 * ============================ 参数为什么是这一组 ============================
 *
 * 纯指数 `base * 2^(n-1)` 起步太快：base=30s、mult=2 时，**手滑 8 次
 * 就要等 2 小时**，第 13 次就顶到 24 小时。那不是防暴破，是惩罚用户 ——
 * 一个自托管单用户服务的「用户」几乎总是主人自己，他连错 8 次是完全正常的
 * （疲劳、误触、孩子按键盘），而 2 小时进不去意味着他必须去翻数据库。
 *
 * 所以选了 **base=30s / mult=3**：
 *
 * | 连续失败 | 锁定时长 | 累计要等 |
 * |---|---|---|
 * | 1 | 30 秒 | 30 秒 |
 * | 3 | 4.5 分钟 | 6 分钟 |
 * | 5 | 40 分钟 | 47 分钟 |
 * | 7 | 6 小时 | 6.3 小时 |
 * | 9+ | 24 小时（封顶） | — |
 *
 * **前 5 次累计 47 分钟** —— 手滑不会立刻把人锁死，但 5 次以上就很明显了。
 * **第 9 次起 24 小时** —— 而枚举 1 万个 PIN 需要的总等待时间是天文数字
 * （按 9 次之后每次都锁 24 小时算，尝试 1000 次需要 1000 天以上）。
 *
 * mult=3 而不是 2 的原因：封顶步数从 13 降到 9，**更早触顶**。
 * 触顶早意味着「一旦进入攻击节奏就没有退路了」，
 * 而这正是我们要的 —— 攻击者在第 9 次之后无法通过「慢慢试」绕过。
 */
export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 30_000,
  multiplier: 3,
  maxMs: 24 * 60 * 60 * 1000,
}

type Attempt = {
  /** 连续失败次数。成功即归零。 */
  failures: number
  /** 锁定截止时间戳（ms）。0 = 未锁定。 */
  blockedUntil: number
  /** 第一次失败的时间，用于清理长时间无活动的条目。 */
  firstFailureAt: number
}

const attempts = new Map<string, Attempt>()

/** 24 小时是「太久了」的边界：起到这个长度就认为已经是针对人的攻击而非手滑。 */
export const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000

/**
 * 计算第 `failures` 次失败之后的锁定时长（毫秒）。
 *
 * ⚠️ **必须先封顶再算幂**，而不是算完再取 `min`：
 * `baseMs * multiplier ** 30` 会超出 `Number.MAX_SAFE_INTEGER`，
 * 之后 `Math.min` 会返回一个已经溢出的巨大数 —— 那正是「定时器立刻触发」
 * 的来源。用 `if (failures >= capSteps) return maxMs` 在**乘法之前**截断。
 */
export function backoffMs(failures: number, config: BackoffConfig = DEFAULT_BACKOFF): number {
  if (failures <= 0) return 0
  const { baseMs, multiplier, maxMs } = config
  // 封顶步数：从这里往后的锁定时长都恒等于 maxMs，不再计算幂。
  // `Math.log` 在这里是为了回答「到第几次才封顶」，只在配置变更时算一次。
  const capSteps = Math.ceil(Math.log(maxMs / baseMs) / Math.log(multiplier)) + 1
  if (failures >= capSteps) return maxMs
  const raw = baseMs * Math.pow(multiplier, failures - 1)
  // 仍然要取 min：浮点幂在边界处可能算出略大于 maxMs 的值。
  return Math.min(raw, maxMs)
}

/**
 * 上次清理的时间戳。让 `sweep` 最多每 10 分钟跑一次，不是每次请求都遍历整个 Map。
 *
 * ⚠️ 清理挂在 `lockedFor`（每个登录请求的必经之路）上而**不是**独立定时器：
 * Node 的定时器需要额外管理（`unref`、进程退出时的清理、测试里要 fake timer），
 * 而登录请求本来就稀疏，用不着为它开一个常驻定时器。
 */
let lastSweepAt = 0
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/** 当前剩余锁定毫秒。0 = 未锁定。 */
export function lockedFor(key: string, now = Date.now()): number {
  // 惰性清理：最多每 10 分钟扫一次，防止 Map 无限增长。
  if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
    lastSweepAt = now
    sweep(now)
  }
  const entry = attempts.get(key)
  if (!entry) return 0
  const remaining = entry.blockedUntil - now
  if (remaining <= 0) return 0
  return remaining
}

/** 连续失败次数（不含被锁定期间的请求）。 */
export function failureCount(key: string): number {
  return attempts.get(key)?.failures ?? 0
}

/**
 * 记一次失败并施加锁定。返回新的锁定时长。
 *
 * ⚠️ 被锁定期间**不调用**这个函数 —— 调用方必须先 `lockedFor()` 判断。
 * 否则持续请求会把锁定时长无限顶高，变成一个够得着但永久解不开的锁。
 */
export function recordFailure(key: string, config: BackoffConfig = DEFAULT_BACKOFF, now = Date.now()): number {
  const existing = attempts.get(key)
  const failures = (existing?.failures ?? 0) + 1
  const duration = backoffMs(failures, config)
  attempts.set(key, {
    failures,
    blockedUntil: now + duration,
    firstFailureAt: existing?.firstFailureAt ?? now,
  })
  return duration
}

/**
 * 记一次成功 —— **清空该 key 的全部状态**。
 *
 * 「成功即归零」是这里最重要的一条：用户输错两次然后输对，
 * 计数必须回到 0，否则正常用户偶尔手滑就会逐步逼近 24 小时锁死。
 */
export function recordSuccess(key: string): void {
  attempts.delete(key)
}

/**
 * 清理过期条目。防止 Map 无限增长 —— key 是 IP，一个长期运行的服务
 * 会见过很多 IP，每个都不清理就是内存泄漏。
 *
 * 判定「过期」用「距首次失败超过 `maxMs`」。这比 `blockedUntil` 判更严：
 * 攻击者若能拿到 24 小时锁定的 key，那条记录必须留着（否则下次从 30 秒重来）；
 * 而已经过了整天还留着的记录，除了占内存没有任何用处。
 *
 * ⚠️ **不靠外部定时器调用** —— 定时器在 Node 里要额外管理（unref、进程退出清理、
 * 测试里要 fake timer），而这里 `lockedFor` 本来就是每次登录请求的必经之路，
 * 挂上去零成本。
 */
export function sweep(now = Date.now()): number {
  let removed = 0
  for (const [key, entry] of attempts) {
    if (now - entry.firstFailureAt < MAX_BACKOFF_MS) continue
    attempts.delete(key)
    failureStamps.delete(key)
    removed += 1
  }
  return removed
}

/** 清空全部退避状态。只给测试用。 */
export function resetAll(): void {
  attempts.clear()
  // ⚠️ 必须连节流时间戳一起重置：否则测试之间会残留「刚扫过」的状态，
  // 让下一个用例的惰性清理不触发，于是 Map 里留下上一条用例的条目 ——
  // 表现是「单测之间互相影响」，而且只在快慢交替的跑法下偶发。
  lastSweepAt = 0
}

/**
 * 人话版的剩余时间，用于界面显示。
 *
 * ⚠️ 界面**必须原样显示服务端算出的剩余秒数**，不要自己四舍五入成
 * 「大约一分钟」—— 用户会以为可以马上试，而服务端还在拒绝。
 */
export function describeRemaining(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds <= 0) return '现在可以重试'
  if (seconds < 60) return `请 ${seconds} 秒后再试`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `请 ${minutes} 分钟后再试`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) {
    return restMinutes > 0 ? `请 ${hours} 小时 ${restMinutes} 分钟后再试` : `请 ${hours} 小时后再试`
  }
  return '已被锁定 24 小时'
}

// ---------------------------------------------------------------------------
// 攻击感知
// ---------------------------------------------------------------------------

/**
 * 「有人在暴破」的判定阈值。
 *
 * ============================ 为什么要单独有一个信号 ============================
 *
 * 你要的不是「锁住就完事」，而是「**攻击并且感知到有人在重试**」。
 * 指数退避解决的是前者（让攻击慢到无意义），而这个信号解决后者：
 * **被锁 24 小时的那 24 小时里，最危险的时刻不是被锁住，是被锁住之后没人知道。**
 * 攻击者可能在凌晨三点试了 9 次然后离开，而服务只在内存里
 * 默默记着一个时间戳 —— 主人第二天看到的是「它昨天好像有问题」。
 *
 * 所以这个信号做的事是：**把「单个 IP 手滑」与「有人在扫」区分开**，
 * 并提供一个能被日志/告警看到的出口。
 *
 * 判定条件（满足任一即视为可疑）：
 * - 同一 IP 在 `windowMs`（默认 10 分钟）内失败 `minFailures` 次（默认 5 次）；
 * - 或者**全局**同时有 `globalKeys` 个 key（默认 3）处于被锁状态
 *   —— 这条抓的是**分布式扫描**：每个 IP 只错一两次、但很多 IP 同时在试，
 *   单看任何一个都像手滑，合起来看就是自动化。
 */
export type SignalConfig = {
  /** 滑动窗口长度（毫秒）。默认 10 分钟。 */
  windowMs: number
  /** 窗口内失败多少次算可疑。默认 5。 */
  minFailures: number
  /** 同时被锁的 key 达到多少个算分布式扫描。默认 3。 */
  globalKeys: number
}

export const DEFAULT_SIGNAL: SignalConfig = {
  windowMs: 10 * 60 * 1000,
  minFailures: 5,
  globalKeys: 3,
}

export type AttackSignal = {
  /** 是否判定为可疑。 */
  suspicious: boolean
  /** 触发原因。用于日志与告警，人读。 */
  reason: 'burst' | 'distributed' | 'none'
  /** 窗口内失败次数。 */
  failures: number
  /** 被锁住的 key 总数（分布式信号用）。 */
  lockedKeys: number
}

/**
 * 滑动窗口内的失败时间戳，per key。
 *
 * ⚠️ 为什么要留完整的时间戳而不只是计数：计数分不清
 * 「10 分钟内错 5 次（有人在扫）」与「1 小时内错 5 次（可能只是手滑）」。
 * 后者在退避下根本不可能发生（第二次就要等 30 秒），但代码不该依赖这个推理 ——
 * 依赖推理的代码在参数一改就悄悄失效。所以这里真的按窗口过滤。
 */
const failureStamps = new Map<string, number[]>()

/** 记录一次失败的时间戳，并返回当前的信号判定。 */
export function recordFailureSignal(
  key: string,
  config: SignalConfig = DEFAULT_SIGNAL,
  now = Date.now()
): AttackSignal {
  const stamps = (failureStamps.get(key) ?? []).filter((at) => now - at < config.windowMs)
  stamps.push(now)
  failureStamps.set(key, stamps)

  const lockedKeys = countLocked(now)
  // ⚠️ 判定顺序：先看 burst（单点爆发）再看分布式。
  // 单点爆发是更明确的信号，应该优先报出来 —— 它能直接告诉你「哪个 IP 在扫」。
  if (stamps.length >= config.minFailures) {
    return { suspicious: true, reason: 'burst', failures: stamps.length, lockedKeys }
  }
  if (lockedKeys >= config.globalKeys) {
    return { suspicious: true, reason: 'distributed', failures: stamps.length, lockedKeys }
  }
  return { suspicious: false, reason: 'none', failures: stamps.length, lockedKeys }
}

/** 成功时清掉该 key 的失败时间戳。 */
export function clearSignal(key: string): void {
  failureStamps.delete(key)
}

function countLocked(now: number): number {
  let count = 0
  for (const entry of attempts.values()) {
    if (entry.blockedUntil > now) count += 1
  }
  return count
}

/** 把信号变成一行可以直接进日志的文本。 */
export function describeSignal(signal: AttackSignal, key: string): string {
  if (!signal.suspicious) return ''
  if (signal.reason === 'burst') {
    return `[pin-attack] 单 IP 爆发：${key} 在窗口内失败 ${signal.failures} 次`
  }
  return `[pin-attack] 疑似分布式扫描：同时有 ${signal.lockedKeys} 个来源被锁（本 IP 失败 ${signal.failures} 次）`
}

/** 清空攻击信号。测试用。 */
export function resetSignals(): void {
  failureStamps.clear()
}