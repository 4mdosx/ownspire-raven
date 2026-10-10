import 'server-only'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { RAVEN_VERSION, dataDir } from '@/config/env'
import type { PublicConfig, RavenConfig } from '@/types/config'
import { PathSandbox } from '@/backstage/lib/sandbox'
import { ConfigFileNotFound, findConfigFile } from '@/backstage/lib/config-file'

/**
 * 配置装载。
 *
 * ⚠️ 这里做的**不是**「读一个 JSON 就完事」—— 配置是 raven 的安全边界本身：
 * `rootPath` 决定沙箱、`auth` 决定谁能进来、`services.defs` 决定能跑哪些脚本。
 * 所以任何一条不成立都**直接抛错拒绝启动**，不做「悄悄用默认值兜住」。
 * 一个静默降级的配置比一个起不来的服务危险得多。
 */

const envValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const probeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    url: z.string().min(1),
    expectStatus: z.number().int().optional(),
    expectJson: z.record(z.unknown()).optional(),
    versionField: z.string().optional(),
    headers: z.record(z.string()).optional(),
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
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  title: z.string().optional(),
  script: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  metricPrefix: z.string().optional(),
})

const actionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  title: z.string().min(1),
  description: z.string().optional(),
  script: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
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

const serviceSchema = z.object({
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

const configSchema = z.object({
  rootPath: z.string().min(1),
  workspace: z
    .object({
      name: z.string().optional(),
      quotaBytes: z.number().int().positive().nullable().optional(),
      allowScriptExecution: z.boolean().optional(),
      scriptsDir: z.string().optional(),
    })
    .optional(),
  clipboard: z
    .object({
      maxItems: z.number().int().min(1).max(100_000).optional(),
      maxTextBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    })
    .optional(),
  auth: z.object({
    // ⚠️ 这里**只有策略，没有凭据**。PIN 是首次登录时在浏览器里设置的，
    // 存在 SQLite 里（backstage/services/pin.service.ts）。
    // 配置文件里出现 username / password 的旧写法会被下面的
    // 「遗留字段」检查明确报错，而不是被静默忽略 —— 静默忽略会让人
    // 以为密码已经生效了。
    sessionHours: z.number().int().min(1).max(24 * 365).optional(),
    loginRateLimit: z
      .object({ windowSeconds: z.number().int().min(10).max(86_400), maxFailures: z.number().int().min(1).max(1000) })
      .optional(),
  }),
  scripts: z
    .object({
      env: z.record(envValueSchema).optional(),
      execution: z
        .object({
          timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
          maxOutputBytes: z.number().int().min(1024).max(64 * 1024 * 1024).optional(),
          maxConcurrent: z.number().int().min(1).max(64).optional(),
        })
        .optional(),
      tempDir: z.string().optional(),
    })
    .optional(),
  /**
   * shell 工具的独立开关。
   *
   * ⚠️ **不复用 `workspace.allowScriptExecution`** —— 那个的语义是
   * 「允许执行 `scripts/` 目录里的脚本」，范围明确。把它当成「允许任意 shell」
   * 会让翻一个开关就等于交出整台机器，两个语义必须分开。
   */
  shell: z
    .object({
      enabled: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
      /** 允许 `sh -c` 这类把整行命令交给 shell 解释。关掉之后只能直接 spawn 可执行文件。 */
      allowShellSyntax: z.boolean().optional(),
    })
    .optional(),
  services: z
    .object({
      registryFile: z.string().optional(),
      sampleIntervalSeconds: z.number().int().min(5).max(86_400).optional(),
      historyLimit: z.number().int().min(10).max(100_000).optional(),
      metricHistoryLimit: z.number().int().min(10).max(100_000).optional(),
      collect: z.boolean().optional(),
      registrationToken: z.string().min(8).optional(),
      publicBaseUrl: z.string().optional(),
      defs: z.array(serviceSchema).optional(),
    })
    .optional(),
})

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** 拒绝把整台机器暴露出去的 rootPath。 */
const FORBIDDEN_ROOTS = new Set(['/', '/Users', '/home', '/var', '/tmp', '/etc', '/usr', '/opt', '/private'])

function assertSafeRoot(rootPath: string): void {
  const resolved = path.resolve(rootPath)
  if (FORBIDDEN_ROOTS.has(resolved)) {
    throw new ConfigError(
      `rootPath 不能是 ${resolved}：那等于把整台机器交给文件管理器。请指向一个专用目录，例如 /data 或 ~/.local/share/ownspire-raven。`
    )
  }
  if (resolved.split(path.sep).filter(Boolean).length < 2) {
    throw new ConfigError(`rootPath ${resolved} 太靠近文件系统根，请指到更深一层的专用目录。`)
  }
  if (resolved === path.resolve(process.env.HOME ?? '/nonexistent')) {
    throw new ConfigError('rootPath 不能是家目录本身，请用家目录下的一个子目录。')
  }
}

function assertSingleSegment(name: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new ConfigError(`${label} 必须是单个路径段（字母数字点下划线短横），收到 "${name}"。`)
  }
}

/** 账号密码时代留下的字段。现在一律不认。 */
const LEGACY_AUTH_FIELDS = ['username', 'password', 'passwordHash'] as const

/**
 * 配置文件里还写着账号密码时**明确报错**，而不是当它不存在。
 *
 * 理由：zod 的 `object()` 默认会**剥掉**未声明的字段，所以如果只靠 schema，
 * 一份带 `auth.password` 的旧配置文件会静默通过 —— 服务照常起来，PIN 照常要求，
 * 而配置里那个密码看起来「还在管用」。升级的人会以为登不进去是 bug，
 * 实际上是配置早就被忽略了。
 *
 * 这里从原始 JSON（不是 zod 的产物）上查，所以剥字段这件事绕不过去。
 */
function assertNoLegacyAuthFields(auth: unknown, file: string): void {
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) return
  const found = LEGACY_AUTH_FIELDS.filter((key) => key in (auth as Record<string, unknown>))
  if (found.length === 0) return
  throw new ConfigError(
    `${file} 的 auth 里还有已废弃的字段：${found.join('、')}。\n` +
      'raven 现在只用 PIN 登录，PIN 在**首次访问时于浏览器里设置**，存在数据库里，不在配置文件里。\n' +
      '请把这几行删掉 —— 留着它们不会报错生效，只是让你以为密码还有效。\n' +
      'auth 里现在只需要（都可以省略）：sessionHours、loginRateLimit。'
  )
}

function expandHome(value: string): string {
  if (value === '~') return process.env.HOME ?? value
  if (value.startsWith('~/')) return path.join(process.env.HOME ?? '/', value.slice(2))
  return value
}

function readJsonFile(file: string): unknown {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new ConfigError(`找不到配置文件 ${file}。`)
    throw new ConfigError(`读不到配置文件 ${file}：${(error as Error).message}`)
  }
  // 允许 JSONC：注释与尾逗号是配置文件的常态，而 JSON.parse 不接受。
  const stripped = stripJsonComments(text).replace(/,\s*([}\]])/g, '$1')
  try {
    return JSON.parse(stripped.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new ConfigError(`配置文件 ${file} 不是合法 JSON：${(error as Error).message}`)
  }
}

/** 去掉 `//` 与 `/* *\/` 注释，但不动字符串里的内容。 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index += 1
      continue
    }
    out += char
  }
  return out
}

function buildConfig(file: string, raw: unknown): RavenConfig {
  // ⚠️ 必须在 schema 校验**之前**查遗留字段：zod 的 `object()` 会把未声明的
  // 字段剥掉，等校验完再查就永远查不到了。
  assertNoLegacyAuthFields(
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['auth']
      : undefined,
    file
  )

  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(根)'}：${issue.message}`)
      .join('\n')
    throw new ConfigError(`配置文件 ${file} 校验失败：\n${issues}`)
  }
  const input = parsed.data

  const rootPath = path.resolve(expandHome(input.rootPath))
  assertSafeRoot(rootPath)

  const workspaceName = input.workspace?.name ?? 'workspace'
  const scriptsDir = input.workspace?.scriptsDir ?? 'scripts'
  const tempDir = input.scripts?.tempDir ?? 'tmp'
  assertSingleSegment(workspaceName, 'workspace.name')
  assertSingleSegment(scriptsDir, 'workspace.scriptsDir')
  assertSingleSegment(tempDir, 'scripts.tempDir')
  if (new Set([workspaceName, scriptsDir, tempDir]).size !== 3) {
    throw new ConfigError('workspace.name / workspace.scriptsDir / scripts.tempDir 必须是三个不同的目录名。')
  }

  const quota = input.workspace?.quotaBytes === undefined ? null : input.workspace.quotaBytes
  const defs = input.services?.defs ?? []

  const seen = new Set<string>()
  for (const def of defs) {
    if (seen.has(def.id)) throw new ConfigError(`services.defs 里有两份 id 相同的定义：${def.id}`)
    seen.add(def.id)
  }

  return {
    rootPath,
    sourceFile: file,
    dataDir,
    workspace: {
      name: workspaceName,
      quotaBytes: quota,
      allowScriptExecution: input.workspace?.allowScriptExecution ?? true,
      scriptsDir,
    },
    clipboard: {
      maxItems: input.clipboard?.maxItems ?? 200,
      maxTextBytes: input.clipboard?.maxTextBytes ?? 262_144,
    },
    auth: {
      sessionHours: input.auth.sessionHours ?? 24 * 7,
      loginRateLimit: input.auth.loginRateLimit ?? { windowSeconds: 300, maxFailures: 10 },
    },
    scripts: {
      env: input.scripts?.env ?? {},
      execution: {
        timeoutMs: input.scripts?.execution?.timeoutMs ?? 120_000,
        maxOutputBytes: input.scripts?.execution?.maxOutputBytes ?? 1_048_576,
        maxConcurrent: input.scripts?.execution?.maxConcurrent ?? 2,
      },
      tempDir,
    },
    shell: {
      // 默认开：raven 的定位就是 Execution Environment，工具默认不可用等于没做。
      // 要收紧就把 enabled 设成 false —— 工具会出现在 listTools 的 disabled[] 里，
      // 「存在但未开放」比「查不到」好排查。
      enabled: input.shell?.enabled ?? true,
      timeoutMs: input.shell?.timeoutMs ?? 60_000,
      allowShellSyntax: input.shell?.allowShellSyntax ?? true,
    },
    services: {
      registryFile: input.services?.registryFile,
      sampleIntervalSeconds: input.services?.sampleIntervalSeconds ?? 30,
      historyLimit: input.services?.historyLimit ?? 500,
      metricHistoryLimit: input.services?.metricHistoryLimit ?? 500,
      collect: input.services?.collect ?? true,
      registrationToken: input.services?.registrationToken,
      publicBaseUrl: input.services?.publicBaseUrl,
      defs,
    },
  }
}

type CacheEntry = { file: string; mtimeMs: number; config: RavenConfig; sandbox: PathSandbox }

let cache: CacheEntry | null = null

function sandboxFor(config: RavenConfig): PathSandbox {
  return new PathSandbox({
    rootPath: config.rootPath,
    workspaceName: config.workspace.name,
    scriptsDir: config.workspace.scriptsDir,
    tempDir: config.scripts.tempDir,
    quotaBytes: config.workspace.quotaBytes,
  })
}

/** 读配置（按 mtime 自动重载）。 */
export function getConfig(): { config: RavenConfig; sandbox: PathSandbox } {
  let file: string
  try {
    file = findConfigFile()
  } catch (error) {
    if (error instanceof ConfigFileNotFound) throw new ConfigError(error.message)
    throw error
  }
  const mtimeMs = fs.statSync(file).mtimeMs
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) {
    return { config: cache.config, sandbox: cache.sandbox }
  }
  const config = buildConfig(file, readJsonFile(file))
  const sandbox = sandboxFor(config)
  cache = { file, mtimeMs, config, sandbox }
  return { config, sandbox }
}

/** 验证用：显式指定配置路径并忽略缓存。 */
export function loadConfigFrom(file: string): { config: RavenConfig; sandbox: PathSandbox } {
  const config = buildConfig(file, readJsonFile(file))
  return { config, sandbox: sandboxFor(config) }
}

export function getSandbox(): PathSandbox {
  return getConfig().sandbox
}

export function publicConfig(): PublicConfig {
  const { config } = getConfig()
  return {
    version: RAVEN_VERSION,
    dataDir: config.dataDir,
    workspace: {
      name: config.workspace.name,
      quotaBytes: config.workspace.quotaBytes,
      allowScriptExecution: config.workspace.allowScriptExecution,
    },
    clipboard: {
      maxItems: config.clipboard.maxItems,
      maxTextBytes: config.clipboard.maxTextBytes,
    },
    scripts: {
      timeoutMs: config.scripts.execution.timeoutMs,
      maxOutputBytes: config.scripts.execution.maxOutputBytes,
      maxConcurrent: config.scripts.execution.maxConcurrent,
      extraEnvKeys: Object.keys(config.scripts.env),
    },
    services: {
      collect: config.services.collect,
      sampleIntervalSeconds: config.services.sampleIntervalSeconds,
      count: config.services.defs.length,
    },
  }
}
