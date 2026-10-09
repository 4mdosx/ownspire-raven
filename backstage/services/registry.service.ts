import 'server-only'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defaultRegistryFile } from '@/config/env'
import { dbSnapshotDelete } from '@/backstage/db/database'
import { getConfig } from '@/backstage/lib/config'
import { ApiError } from '@/backstage/lib/http'
import type { ServiceDef } from '@/types/config'

/**
 * 服务注册表。
 *
 * 视图有两层，来源有三处，揉在一起才是 dashboard 认识的那个列表：
 *
 * 1. `config.services.defs` —— 内联定义，跟着配置文件走，**只能改配置，不能改 API**。
 *    运维手上那份配置是权威，我们的接口不应该有本事把它的内容截走一半。
 * 2. `config.services.registryFile`（默认 `<dataDir>/services.json`）—— 文件定义，
 *    API 能增删改，`origin` 记绝对路径。
 *
 * 合并规则只有一条：**同 id 时文件覆盖内联**（逐字段覆盖，不是整份替换 ——
 * 文件里只写 `summary` 时，内联的探针还得留着，否则一次局部更新就把探针全抹了）。
 * 覆盖必须在快照上留 `warning`：不然运维会盯着配置里的探针纳闷「为什么改了没用」，
 * 而真正生效的那份在另一个文件里。
 *
 * 写文件只有一条纪律：**只写文件里本来就有的条目**。绝不能把 `loadRegistry()` 的
 * 结果整体写回去 —— 那会把内联定义物化进文件，从此它们变成文件定义，
 * 配置里的那一份永远被自己的副本遮蔽，且两条来源再也分不开。
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const probeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    url: z.string().min(1),
    expectStatus: z.number().int().optional(),
    expectJson: z.record(z.string(), z.unknown()).optional(),
    versionField: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  z.object({
    type: z.literal('tcp'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  z.object({
    type: z.literal('docker'),
    container: z.string().min(1),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  z.object({
    type: z.literal('file'),
    path: z.string().min(1),
    maxAgeSeconds: z.number().int().positive().optional(),
    minBytes: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('script'),
    script: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  }),
])

const metricProbeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, '指标探针 id 只接受字母数字点下划线短横。'),
  title: z.string().optional(),
  script: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  metricPrefix: z.string().optional(),
})

const actionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, '动作 id 只接受字母数字点下划线短横。'),
  title: z.string().min(1),
  description: z.string().optional(),
  script: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  // 危险操作的闸门：必须显式写 readonly: true 才算只读。写漏了会走确认流程，
  // 也就是「多问一句」而不是「悄悄执行」，这个方向的错是安全的。
  readonly: z.boolean().optional(),
  confirmPhrase: z.string().optional(),
})

const entitySchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  endpoint: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  source: z.string().optional(),
  commit: z.string().optional(),
  dataDir: z.string().optional(),
  notes: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
})

/**
 * 服务定义的唯一校验入口（route 与 ingest 都走它）。
 *
 * ⚠️ 这份 schema 与 `backstage/lib/config.ts` 里那份**私有**的 `serviceSchema` 是
 * 同一个东西的两份拷贝：config.ts 冻结了、也不导出，而 ingest 进来的定义不能
 * 借用「配置装载」那条路径去校验。要改字段形状就两边一起改（docs/10 §6）。
 */
export const serviceDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, '服务 id 只接受字母数字点下划线短横。'),
  title: z.string().min(1),
  kind: z.enum(['ownspire', 'external']).optional(),
  summary: z.string().optional(),
  repo: z.string().optional(),
  baseUrl: z.string().optional(),
  origin: z.string().optional(),
  enabled: z.boolean().optional(),
  endpoints: z.array(z.object({ label: z.string().min(1), url: z.string().min(1) })).optional(),
  entities: z.array(entitySchema).optional(),
  probes: z.array(probeSchema).optional(),
  metrics: z.array(metricProbeSchema).optional(),
  actions: z.array(actionSchema).optional(),
  tags: z.array(z.string()).optional(),
})

/** 注册表文件的壳。`version` 允许缺省（当成 1），但出现了别的值就拒绝读。 */
const registryDocumentSchema = z.object({
  version: z.number().int().optional(),
  services: z.array(serviceDefSchema).optional(),
})

export type ServiceSnapshot = {
  def: ServiceDef
  /** `inline` = 写在 config.services.defs；否则是定义文件的绝对路径。 */
  origin: string
  enabled: boolean
  /** 只有文件里的服务能被 API 改写或删除。 */
  persistable: boolean
  /** 同 id 被文件定义遮蔽时给出的人话说明，dashboard 原样展示。 */
  warning?: string
}

const INLINE_ORIGIN = 'inline'

// ---------------------------------------------------------------------------
// 路径与读写
// ---------------------------------------------------------------------------

/** 注册表文件位置：配置里可以写绝对路径，也可以写相对 `rootPath` 的路径。 */
export function registryFilePath(): string {
  const { config, sandbox } = getConfig()
  const configured = config.services.registryFile
  if (configured === undefined || configured.trim() === '') return defaultRegistryFile()
  // 相对路径必须过沙箱（`..`、盘符在 parseRelativePath 里就被拒了）——
  // 注册表本身也是被 `rootPath` 圈住的东西，不能靠字符串拼接放行。
  return path.isAbsolute(configured) ? path.resolve(configured) : sandbox.lexicalAbsolute(configured)
}

function registryIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
    .join('；')
}

/** 校验一份服务定义；失败抛 400 而不是抛 ZodError，好让错误里带上「服务定义」这个上下文。 */
export function parseServiceDef(input: unknown): ServiceDef {
  const parsed = serviceDefSchema.safeParse(input)
  if (!parsed.success) {
    throw new ApiError('invalid_input', `服务定义校验失败：${registryIssues(parsed.error)}`, 400)
  }
  return parsed.data
}

type RegistryDocument = { path: string; defs: ServiceDef[]; exists: boolean }

/**
 * 读注册表文件。**文件不存在 = 空注册表**（首次启动的正常状态，不是错误）；
 * 但文件存在却读不动 / 不是合法 JSON / 版本不认识，一律抛错 —— 静默当成空表
 * 会让下一次 upsert 把别人写的服务全部覆盖掉。
 */
async function readRegistryDocument(): Promise<RegistryDocument> {
  const file = registryFilePath()
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, defs: [], exists: false }
    throw new ApiError('registry_unreadable', `读不到服务注册表 ${file}：${(error as Error).message}`, 500)
  }
  if (text.trim() === '') return { path: file, defs: [], exists: true }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ApiError('invalid_registry', `服务注册表 ${file} 不是合法 JSON：${(error as Error).message}`, 500)
  }
  const parsed = registryDocumentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiError('invalid_registry', `服务注册表 ${file} 校验失败：${registryIssues(parsed.error)}`, 500)
  }
  const version = parsed.data.version
  if (version !== undefined && version !== 1) {
    throw new ApiError(
      'registry_version_unsupported',
      `服务注册表 ${file} 的 version=${version}，当前只认识 version 1，请先做显式迁移。`,
      500
    )
  }
  return { path: file, defs: parsed.data.services ?? [], exists: true }
}

/**
 * 原子写：同目录临时文件 + `rename`。
 *
 * 直接 `writeFile` 到目标路径有个真实的坑 —— 写到一半断电/被杀，注册表就变成半截
 * JSON，而下次启动读不动它（我们不会静默降级成空表，于是整个 dashboard 起不来）。
 * 同目录是必须的：跨设备的 `rename` 不是原子操作，会退化成复制。
 * 顺手 `fsync`：tmpfs 上的 rename 语义对「进程崩溃」够用，对「机器掉电」不够。
 */
async function writeRegistryFile(defs: ServiceDef[]): Promise<void> {
  const file = registryFilePath()
  const directory = path.dirname(file)
  const payload = `${JSON.stringify({ version: 1, services: defs }, null, 2)}\n`
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await fsp.mkdir(directory, { recursive: true })
    const handle = await fsp.open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsp.rename(temporary, file)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
    throw new ApiError('registry_write_failed', `写服务注册表 ${file} 失败：${(error as Error).message}`, 500)
  }
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

/** 逐字段覆盖：`override` 里显式为 `undefined` 的键不算「有话说」，保留 `base` 的值。 */
function overlayDef(base: ServiceDef, override: ServiceDef): ServiceDef {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    merged[key] = value
  }
  return merged as ServiceDef
}

function snapshotFor(def: ServiceDef, origin: string, persistable: boolean): ServiceSnapshot {
  return { def, origin, enabled: def.enabled !== false, persistable }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 内联定义 + 注册表文件，按 id 合并；文件覆盖内联并在快照上留 warning。 */
export async function loadRegistry(): Promise<ServiceSnapshot[]> {
  const { config } = getConfig()
  const byId = new Map<string, ServiceSnapshot>()

  // 先铺内联：顺序就是配置文件里的书写顺序，作者排过的顺序比按 id 字典序更有意义。
  for (const raw of config.services.defs) {
    const def: ServiceDef = { ...raw, origin: INLINE_ORIGIN }
    byId.set(def.id, snapshotFor(def, INLINE_ORIGIN, false))
  }

  const document = await readRegistryDocument()
  for (const raw of document.defs) {
    const incoming: ServiceDef = { ...raw }
    delete incoming.origin
    const previous = byId.get(incoming.id)
    const merged = previous ? overlayDef(previous.def, incoming) : incoming
    const snapshot = snapshotFor({ ...merged, origin: document.path }, document.path, true)
    if (previous !== undefined) {
      // 两种情况都值得说清楚：同一份文件里重复 id（多半是手改文件手滑，后者覆盖前者），
      // 或者文件遮蔽了内联定义（运维会去改配置里那份，然后纳闷为什么没生效）。
      snapshot.warning =
        previous.origin === document.path
          ? `注册表文件 ${document.path} 里 ${incoming.id} 出现了多次，已按最后一条生效。`
          : `配置内联定义与注册表文件 ${document.path} 里都有 ${incoming.id}，已按文件定义生效（内联的那份被遮蔽）。`
    }
    byId.set(incoming.id, snapshot)
  }

  return [...byId.values()]
}

export async function findService(id: string): Promise<ServiceSnapshot> {
  const snapshots = await loadRegistry()
  const found = snapshots.find((snapshot) => snapshot.def.id === id)
  if (!found) throw new ApiError('not_found', `没有找到服务 ${id}。`, 404)
  return found
}

/**
 * 新增或更新一份文件定义。
 *
 * 更新是**逐字段覆盖**而不是整份替换（理由见文件头）：想删探针就显式写 `probes: []`。
 */
export async function upsertService(input: ServiceDef): Promise<{ snapshot: ServiceSnapshot; created: boolean }> {
  const def = parseServiceDef(input)
  const document = await readRegistryDocument()
  const stored: ServiceDef = { ...def }
  delete stored.origin

  const entries = [...document.defs]
  const index = entries.findIndex((item) => item.id === stored.id)
  const created = index < 0
  if (created) entries.push(stored)
  else entries[index] = overlayDef(entries[index], stored)

  await writeRegistryFile(entries)

  // 写完读回一遍，而不是自己拼快照：刚写进去的那份可能还和内联定义有覆盖关系，
  // 复用 loadRegistry 的合并逻辑才不会出现「返回的快照和列表里的不一致」。
  const snapshot = (await loadRegistry()).find((item) => item.def.id === stored.id)
  if (!snapshot) {
    throw new ApiError('registry_write_failed', `写入 ${document.path} 之后读不回服务 ${stored.id}。`, 500)
  }
  return { snapshot, created }
}

/** 只删注册表文件里的条目；内联定义属于配置文件，API 无权删。 */
export async function removeService(id: string): Promise<{ removed: boolean }> {
  const document = await readRegistryDocument()
  const index = document.defs.findIndex((item) => item.id === id)
  if (index < 0) {
    const inline = getConfig().config.services.defs.some((item) => item.id === id)
    if (inline) {
      throw new ApiError(
        'not_persistable',
        `服务 ${id} 写在配置文件的 services.defs 里，只能改配置，不能通过 API 删除。`,
        400
      )
    }
    // 不存在的 id 返回 removed:false 而不是 404 —— DELETE 是幂等的，
    // 重复点击不该弹一个吓人的错误。
    return { removed: false }
  }

  await writeRegistryFile(document.defs.filter((_, position) => position !== index))
  // 「最新快照」跟着定义一起消失。历史样本/指标不在这里删：database.ts 没有暴露
  // 按服务删除历史的入口（不该在这里手写 SQL），它们会被 historyLimit 自然修剪。
  dbSnapshotDelete(id)
  return { removed: true }
}
