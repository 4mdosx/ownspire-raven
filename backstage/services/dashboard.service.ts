import 'server-only'
import { dbMetricInsert, dbMetricLatest, dbMetricPrune, dbSampleHistory, dbSamplePrune } from '@/backstage/db/database'
import { getConfig } from '@/backstage/lib/config'
import { ApiError } from '@/backstage/lib/http'
import { tokenMatches } from '@/backstage/services/auth.service'
import { checkService } from '@/backstage/services/health.service'
import type { HealthReport } from '@/backstage/services/health.service'
import { findService, loadRegistry, parseServiceDef, upsertService } from '@/backstage/services/registry.service'
import type { ServiceSnapshot } from '@/backstage/services/registry.service'
import { runWorkspaceScript } from '@/backstage/services/runner.service'
import type { RunResult } from '@/backstage/services/runner.service'
import type { ActionDef, EntityDef, ServiceDef } from '@/types/config'

/**
 * Dashboard 聚合层。
 *
 * 这里只做三件事：把注册表读出来、把健康状态拉到最新、把指标/历史/动作拼成
 * 前端一次就能画完的形状。三条纪律：
 *
 * 1. **渲染 dashboard 绝不执行脚本。** `actions` 只带元数据（id/标题/是否需要确认），
 *    真要跑得走 POST 并且进 SSE。否则「打开页面」就等于「跑了一遍治理脚本」，
 *    而其中一个动作可能是清库。
 * 2. **串行遍历服务**（单服务内部探针并行 ≤6）。任何时刻打到上游的并发都不超过 6，
 *    宁可 dashboard 慢一拍，也不要在 10 个服务上同时放 60 个探针。
 * 3. **不泄漏配置里的秘密。** 这里只回显服务定义自身的字段，注册令牌、密码、
 *    会话密钥一概不出现在返回值里。
 */

export type DashboardService = {
  id: string
  title: string
  kind: string
  summary: string
  enabled: boolean
  origin: string
  persistable: boolean
  /** 定义被注册表文件遮蔽时的人话提示（契约之外的补充字段，UI 可以直接展示）。 */
  warning?: string
  endpoints: Array<{ label: string; url: string }>
  entities: EntityDef[]
  repo?: string
  baseUrl?: string
  tags: string[]
  health: HealthReport
  metrics: Array<{ metric: string; value: number; unit: string; at: number }>
  history: Array<{ status: string; latencyMs: number | null; checkedAt: number; message: string }>
  actions: Array<{
    id: string
    title: string
    description: string
    readonly: boolean
    needsConfirm: boolean
    /**
     * 需要二次确认时的确认词。
     *
     * ⚠️ 这个字段必须下发，否则界面只能硬编码缺省值 `yes` ——
     * 而配置里写了 `"confirmPhrase": "backup-atlas"` 的动作就**永远跑不起来**
     * （前端发 yes、服务端要 backup-atlas，稳定 400），而报错看起来像权限问题。
     * 回显确认词不降低门槛：它本来就写在配置文件里，
     * 而「知道要打什么字」和「真的打一遍」在交互上是两件事。
     */
    confirmPhrase: string
  }>
  /**
   * 契约 §6 的 DashboardService 没有声明指标探针列表，但界面上的「跑一次」按钮
   * 必须知道 probeId（`POST /api/services/[id]/metrics {probeId}`），
   * 否则那排按钮永远不出现。字段名与 components/raven/dashboard.tsx 的读取一致。
   */
  metricProbes: Array<{ id: string; title: string; script: string; timeoutMs?: number }>
}

export type Dashboard = {
  generatedAt: number
  services: DashboardService[]
  totals: { ok: number; warn: number; down: number; unknown: number; total: number }
  config: { collect: boolean; sampleIntervalSeconds: number }
}

export type ParsedMetric = { metric: string; value: number; unit: string }

// ---------------------------------------------------------------------------
// 指标 stdout 解析（纯函数，可以单独测）
// ---------------------------------------------------------------------------

/**
 * 指标脚本 stdout 的解析。
 *
 * 两种形状都认（docs/10 §6）：
 * ```json
 * { "metrics": [ { "name": "db_bytes", "value": 1234, "unit": "B" } ], "message": "可选" }
 * { "db_bytes": 1234, "media_bytes": 567 }
 * ```
 *
 * 三个刻意的选择：
 *
 * - **只认 JSON number**。`"1234"` 这种字符串数字一律丢掉：一旦开始猜，
 *   `"1,234"`（带千分位）、`"12 MB"`（带单位）、`"2024-01-01"` 都会变成指标，
 *   而画在图上没人看得出哪个是错的。脚本要报数字就打 number。
 * - **从后往前找行**。脚本往 stdout 里混日志是常态，整段解析失败就按行找，
 *   取**最后一个**能解析的 JSON 行。再进一步：优先取最后一个**真的带指标**的行 ——
 *   包装脚本最后打一行 `{"ok":true}` 时，不该把前面的指标抹掉。
 * - **`message` 一个字段两用**：优先是脚本自己写的说明；一行 JSON 都没解析出来时
 *   用它说明「为什么没有指标」，调用方不用再判空。
 */
export function parseMetricOutput(stdout: string, prefix?: string): { metrics: ParsedMetric[]; message: string } {
  const candidates: string[] = []
  const whole = stdout.trim()
  if (whole.startsWith('{') && whole.endsWith('}')) candidates.push(whole)
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line.startsWith('{') && line.endsWith('}')) candidates.push(line)
  }

  let lastMessage = ''
  for (const candidate of candidates) {
    const parsed = parseMetricCandidate(candidate)
    if (parsed === null) continue
    if (parsed.metrics.length > 0) {
      return { metrics: withPrefix(parsed.metrics, prefix), message: parsed.message }
    }
    if (parsed.message !== '') lastMessage = parsed.message
  }
  return { metrics: [], message: lastMessage === '' ? '没有在 stdout 里找到可解析的指标 JSON。' : lastMessage }
}

function parseMetricCandidate(text: string): { metrics: ParsedMetric[]; message: string } | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : ''

  if (Array.isArray(record.metrics)) {
    const metrics: ParsedMetric[] = []
    for (const item of record.metrics) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.metric
      if (typeof name !== 'string' || name === '') continue
      if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) continue
      metrics.push({ metric: name, value: entry.value, unit: typeof entry.unit === 'string' ? entry.unit : '' })
    }
    return { metrics: dedupeMetrics(metrics), message }
  }

  const metrics: ParsedMetric[] = []
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    metrics.push({ metric: key, value, unit: '' })
  }
  return { metrics: dedupeMetrics(metrics), message }
}

/** 同一行里同名指标是脚本的 bug；留最后一条，避免同一个 (服务,指标,时刻) 落两行。 */
function dedupeMetrics(metrics: ParsedMetric[]): ParsedMetric[] {
  const byName = new Map<string, ParsedMetric>()
  for (const metric of metrics) byName.set(metric.metric, metric)
  return [...byName.values()]
}

/** 命名空间前缀用 `.` 连接；已经带过前缀的不重复加。 */
function withPrefix(metrics: ParsedMetric[], prefix?: string): ParsedMetric[] {
  const namespace = (prefix ?? '').trim().replace(/[._-]+$/, '')
  if (namespace === '') return metrics
  return metrics.map((metric) =>
    metric.metric === namespace || metric.metric.startsWith(`${namespace}.`) ? metric : { ...metric, metric: `${namespace}.${metric.metric}` }
  )
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function actionMeta(action: ActionDef): DashboardService['actions'][number] {
  // 写漏 readonly 按「需要确认」处理：错的方向是多问一句，不是静默执行。
  const readonly = action.readonly === true
  return {
    id: action.id,
    title: action.title,
    description: action.description ?? '',
    readonly,
    needsConfirm: !readonly,
    confirmPhrase: action.confirmPhrase ?? 'yes',
  }
}

async function describe(snapshot: ServiceSnapshot, health: HealthReport): Promise<DashboardService> {
  const def = snapshot.def
  return {
    id: def.id,
    title: def.title,
    kind: def.kind ?? 'ownspire',
    summary: def.summary ?? '',
    enabled: snapshot.enabled,
    origin: snapshot.origin,
    persistable: snapshot.persistable,
    ...(snapshot.warning === undefined ? {} : { warning: snapshot.warning }),
    endpoints: (def.endpoints ?? []).map((endpoint) => ({ label: endpoint.label, url: endpoint.url })),
    entities: def.entities ?? [],
    repo: def.repo,
    baseUrl: def.baseUrl,
    tags: def.tags ?? [],
    health,
    metrics: await dbMetricLatest(def.id),
    // 顺序保持 database.ts 的原样（最新在前）；画图方向交给前端，
    // 服务端再翻一次只会让两边的「第一条」含义不同。
    history: await dbSampleHistory(def.id, 50),
    actions: (def.actions ?? []).map(actionMeta),
    metricProbes: (def.metrics ?? []).map((probe) => ({
      id: probe.id,
      title: probe.title ?? probe.id,
      script: probe.script,
      timeoutMs: probe.timeoutMs,
    })),
  }
}

export async function getDashboard(options: { force?: boolean } = {}): Promise<Dashboard> {
  const { config } = getConfig()
  const snapshots = await loadRegistry()
  const services: DashboardService[] = []
  for (const snapshot of snapshots) {
    services.push(await describe(snapshot, await checkService(snapshot, { force: options.force })))
  }
  const totals = { ok: 0, warn: 0, down: 0, unknown: 0, total: services.length }
  for (const service of services) totals[service.health.status] += 1
  return {
    generatedAt: Date.now(),
    services,
    totals,
    config: { collect: config.services.collect, sampleIntervalSeconds: config.services.sampleIntervalSeconds },
  }
}

/** 单个服务详情。不复用 `getDashboard()`：为了一个 id 去探所有服务是纯浪费。 */
export async function getServiceDetail(id: string, options: { force?: boolean } = {}): Promise<DashboardService> {
  const snapshot = await findService(id)
  return describe(snapshot, await checkService(snapshot, { force: options.force }))
}

/**
 * 采一轮：健康样本由 `checkService` 落库，这里负责指标脚本与修剪。
 *
 * `services.collect === false` 是硬开关 —— 连 `checkService` 都不进，
 * 直接返回「全都走缓存」，一个上游请求都不发。
 */
export async function collectAll(options: { force?: boolean } = {}): Promise<{ collected: string[]; cached: string[] }> {
  const { config } = getConfig()
  const snapshots = await loadRegistry()
  const collected: string[] = []
  const cached: string[] = []

  if (!config.services.collect) {
    return { collected: [], cached: snapshots.map((snapshot) => snapshot.def.id) }
  }

  for (const snapshot of snapshots) {
    const report = await checkService(snapshot, { force: options.force })
    if (report.fromCache) cached.push(snapshot.def.id)
    else collected.push(snapshot.def.id)
    if (!snapshot.enabled) continue
    for (const probe of snapshot.def.metrics ?? []) {
      try {
        const result = await runMetricProbe(snapshot.def.id, probe.id)
        if (result.report.status !== 'ok') {
          // 不抛：一轮采集不能因为一个指标脚本失败就整轮失败。失败已经在
          // run_records 里（runner 写的 status/stderr），这里只补一行服务端日志。
          console.error(`[raven] 指标探针 ${snapshot.def.id}/${probe.id} 状态 ${result.report.status}：${result.report.stderr.trim()}`)
        }
      } catch (error) {
        console.error(`[raven] 指标探针 ${snapshot.def.id}/${probe.id} 执行失败：`, error)
      }
    }
  }

  await dbSamplePrune(config.services.historyLimit)
  await dbMetricPrune(config.services.metricHistoryLimit)
  return { collected, cached }
}

/**
 * 跑一个指标探针，解析并落库，返回解析结果 + 完整 RunResult。
 *
 * 只有 `status === 'ok'` 才落库：失败运行的 stdout 里可能是半截内容或错误栈，
 * 让它进时序库就等于在图上画一个假点。失败事实由 RunResult 和 run_records 承载。
 */
export async function runMetricProbe(
  serviceId: string,
  probeId: string
): Promise<{ metrics: ParsedMetric[]; report: RunResult }> {
  const snapshot = await findService(serviceId)
  const probe = (snapshot.def.metrics ?? []).find((item) => item.id === probeId)
  if (probe === undefined) {
    throw new ApiError('not_found', `服务 ${serviceId} 没有指标探针 ${probeId}。`, 404)
  }

  // priority: true —— 与健康探针同理，指标脚本也不能排在长任务后面（docs/10 §5）。
  const report = await runWorkspaceScript({
    name: probe.script,
    args: probe.args,
    origin: 'metric',
    timeoutMs: probe.timeoutMs,
    priority: true,
    triggeredBy: `metric:${serviceId}/${probeId}`,
  })
  const parsed = parseMetricOutput(report.stdout, probe.metricPrefix)

  if (report.status === 'ok' && parsed.metrics.length > 0) {
    const at = Date.now()
    try {
      await dbMetricInsert(parsed.metrics.map((metric) => ({ serviceId, metric: metric.metric, value: metric.value, unit: metric.unit, at })))
      await dbMetricPrune(getConfig().config.services.metricHistoryLimit)
    } catch (error) {
      console.error(`[raven] 指标落库失败（${serviceId}/${probeId}）：`, error)
    }
  }

  return { metrics: parsed.metrics, report }
}

// ---------------------------------------------------------------------------
// 治理动作
// ---------------------------------------------------------------------------

export type ActionRunOptions = {
  trigger?: string
  confirm?: string
  /** 给 SSE 用的流式回调；不传就只有最终 RunResult。 */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

/**
 * 动作的存在性与确认词检查。
 *
 * 单独导出是给 route 用的：SSE 的头一旦发出去就只剩 `error` 事件了，而
 * 「动作不存在」「确认词不对」必须在**发头之前**变成正常的 404/400 JSON。
 */
export async function assertActionRunnable(serviceId: string, actionId: string, confirm?: string): Promise<ActionDef> {
  const snapshot = await findService(serviceId)
  const action = (snapshot.def.actions ?? []).find((item) => item.id === actionId)
  if (action === undefined) {
    throw new ApiError('not_found', `服务 ${serviceId} 没有治理动作 ${actionId}。`, 404)
  }
  if (action.readonly !== true) {
    const expected = action.confirmPhrase ?? 'yes'
    if (confirm !== expected) {
      // 不回显确认词：它虽然写在配置里，但把它印在错误响应里等于把闸门拆了 ——
      // 前端只要把这句话读出来再原样发一次就能过。
      throw new ApiError('confirm_required', `动作「${action.title}」会改动线上状态，需要确认词（缺省 yes）。`, 400)
    }
  }
  return action
}

/**
 * 跑一个治理动作。运行记录由 runner 写，`triggeredBy` 固定成
 * `action:<serviceId>/<actionId>`，事后能一条条对上是哪个按钮干的。
 */
export async function runAction(serviceId: string, actionId: string, options: ActionRunOptions = {}): Promise<RunResult> {
  const action = await assertActionRunnable(serviceId, actionId, options.confirm)
  return runWorkspaceScript({
    name: action.script,
    args: action.args,
    origin: 'action',
    timeoutMs: action.timeoutMs,
    // 运维按了按钮就是在等结果；和两个长任务一起排队跟坏了没区别。上限由
    // runner 的 MAX_PRIORITY_INFLIGHT 兜底。
    priority: true,
    triggeredBy: `action:${serviceId}/${actionId}`,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  })
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册/更新一个服务。
 *
 * 凭据在**这里**判，但「有没有登录」由 route 传进来（`sessionAuthorized`）：
 * 这个模块不该 import `next/headers`，否则它就没法在验证脚本里被拉起来了
 * （cookies() 在 Next 运行时之外直接抛错）。
 */
export async function registerService(input: {
  def: unknown
  token: string | null
  sessionAuthorized?: boolean
}): Promise<{ snapshot: ServiceSnapshot; created: boolean }> {
  const { config } = getConfig()
  const def: ServiceDef = parseServiceDef(input.def)

  const expected = config.services.registrationToken
  const tokenOk = expected !== undefined && expected !== '' && tokenMatches(input.token, expected)
  if (!tokenOk && input.sessionAuthorized !== true) {
    throw new ApiError('unauthorized', '需要登录，或提供正确的注册令牌。', 401)
  }

  const { snapshot, created } = await upsertService(def)
  // 注册完立刻采一次：注册方（脚本/CI）期待马上在 dashboard 上看到状态，
  // 而 sampleInterval 的缓存对刚注册的服务本来也不存在。
  await checkService(snapshot, { force: true })
  return { snapshot, created }
}
