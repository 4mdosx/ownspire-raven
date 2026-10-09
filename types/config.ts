/**
 * raven 的全部配置类型。
 *
 * 设计约束（与用户需求一一对应）：
 *
 * 1. `rootPath` 是**唯一**的受管边界。任何路径解析都要过 `backstage/lib/sandbox.ts`，
 *    那里保证 realpath 之后仍在 rootPath 之内。配置文件本身、数据库、脚本目录
 *    都落在这个边界里，文件管理器只看得到 `<rootPath>/<workspace.name>` 那一棵。
 * 2. `workspace.quotaBytes` 是目录总大小上限，null 表示不限。
 * 3. `clipboard.maxItems` 是队列长度，超了从队尾淘汰。
 * 4. 账号密码直接写在配置里（单账号、全权限）。
 * 5. 脚本运行前注入环境变量表，脚本不关心真实目录结构。
 * 6. `services` 是 ownspire 服务注册表与健康检查/指标采集的机制。
 */

/** 脚本目录里的**静态**环境变量；`{workspace}` / `{files}` 这类占位符在运行期展开。 */
export type EnvValue = string | number | boolean | null

export type WorkspaceConfig = {
  /** 工作目录名（相对 rootPath 的单个路径段）。默认 `workspace`。 */
  name: string
  /** 目录总大小上限（字节）。null = 不限。 */
  quotaBytes: number | null
  /** 允许脚本读取 `<rootPath>/scripts/` 下的文件。关掉之后只能跑临时上传的脚本。 */
  allowScriptExecution: boolean
  /** 脚本目录名（相对 rootPath）。默认 `scripts`。 */
  scriptsDir: string
}

export type ClipboardConfig = {
  /** 队列长度；每粘贴一条入队，超出从队尾淘汰。 */
  maxItems: number
  /** 单条文本上限（字节），超出拒绝而不是截断 —— 截断是静默数据损坏。 */
  maxTextBytes: number
}

export type ExecutionConfig = {
  /** 单个脚本的墙钟超时（毫秒）。 */
  timeoutMs: number
  /** stdout/stderr 各自保留的最大字节数，超出标记 truncated。 */
  maxOutputBytes: number
  /** 同时运行的脚本数上限。 */
  maxConcurrent: number
}

export type AuthConfig = {
  username: string
  /** 明文密码。与 passwordHash 二选一。 */
  password?: string
  /** `scrypt$N$r$p$salt$hash` 形式的密码散列。与 password 二选一，优先。 */
  passwordHash?: string
  /** 会话有效期（小时）。 */
  sessionHours: number
  /** 登录失败限流：窗口秒数与窗口内最大失败次数。 */
  loginRateLimit: { windowSeconds: number; maxFailures: number }
}

export type EntityDef = {
  id: string
  title?: string
  /** 只读的服务地址；列表/详情接口会原样回显。 */
  endpoint?: string
  port?: number
  source?: string
  commit?: string
  dataDir?: string
  notes?: string
  /** 该实体对外提供的能力，自由文本，例如 `files`、`clipboard`、`healthz`。 */
  capabilities?: string[]
}

export type ProbeHttp = {
  type: 'http'
  /** 完整 URL，或相对 `service.baseUrl` 的路径。 */
  url: string
  /** 期望的 HTTP 状态码，缺省「2xx 即健康」。 */
  expectStatus?: number
  /** 期望 body 里的 JSON 字段值，例如 `{ ok: true }`。 */
  expectJson?: Record<string, unknown>
  /** 可选：从 body JSON 里取版本号的字段路径，例如 `version`。 */
  versionField?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export type ProbeTcp = {
  type: 'tcp'
  /** `host:port`，或 `host` + `port`。 */
  host: string
  port: number
  timeoutMs?: number
}

export type ProbeDocker = {
  type: 'docker'
  /** 容器名。 */
  container: string
  timeoutMs?: number
}

export type ProbeFile = {
  type: 'file'
  /** 绝对路径，或相对 rootPath 的路径。 */
  path: string
  /** 文件在多少秒内被改写过算「新鲜」；不给就只看存在与否。 */
  maxAgeSeconds?: number
  /** 文件必须至少这么长（字节）。 */
  minBytes?: number
}

export type ProbeScript = {
  type: 'script'
  /** `<rootPath>/<scriptsDir>/` 下的脚本名，例如 `check-navi.mjs`。 */
  script: string
  /** 传给脚本的参数。 */
  args?: string[]
  timeoutMs?: number
}

export type Probe = ProbeHttp | ProbeTcp | ProbeDocker | ProbeFile | ProbeScript

/**
 * 指标探针：跑一个脚本，要求它在 stdout 打出一行 JSON 对象，
 * raven 把它拆成若干条时序样本。
 *
 * 约定（见 docs/03-service-registry.md）：
 * ```json
 * { "metrics": [ { "name": "db_bytes", "value": 123, "unit": "B" } ],
 *   "message": "可选的人类可读说明" }
 * ```
 * 也接受直接把扁平对象当指标：`{ "db_bytes": 123 }`。
 */
export type MetricProbe = {
  id: string
  title?: string
  script: string
  args?: string[]
  timeoutMs?: number
  metricPrefix?: string
}

/** 治理动作：在 Dashboard 上按一个按钮就跑的脚本。 */
export type ActionDef = {
  id: string
  title: string
  description?: string
  script: string
  args?: string[]
  timeoutMs?: number
  /** true = 只读探查，不需要二次确认；false/null = 要输入确认词。 */
  readonly?: boolean
  /** 需要二次确认时，必须原样输入的词。缺省 `yes`。 */
  confirmPhrase?: string
}

export type ServiceEndpointDef = {
  /** Dashboard 上优先打开的地址。 */
  label: string
  url: string
}

export type ServiceDef = {
  id: string
  title: string
  kind?: 'ownspire' | 'external'
  summary?: string
  repo?: string
  baseUrl?: string
  /** 定义文件的来源：`inline` 或 `<绝对路径>.json`。只读字段。 */
  origin?: string
  enabled?: boolean
  endpoints?: ServiceEndpointDef[]
  entities?: EntityDef[]
  probes?: Probe[]
  metrics?: MetricProbe[]
  actions?: ActionDef[]
  tags?: string[]
}

export type ServicesConfig = {
  /** 服务定义文件位置（相对 rootPath，或绝对路径）。缺省 `<rootPath>/services.json`。 */
  registryFile?: string
  /** 健康采样最短间隔（秒）。Dashboard 刷新不会比它更密地打上游。 */
  sampleIntervalSeconds: number
  /** 每个服务保留多少条健康样本。 */
  historyLimit: number
  /** 每个 (服务, 指标) 保留多少条指标样本。 */
  metricHistoryLimit: number
  /** 采集总开关。关掉之后 Dashboard 只显示历史数据。 */
  collect: boolean
  /** 服务自注册用的令牌。不设则 /api/ingest/register 关闭。 */
  registrationToken?: string
  /** raven 的对外基址，写进脚本周边的环境变量里。 */
  publicBaseUrl?: string
  defs: ServiceDef[]
}

export type ScriptsConfig = {
  /** 在脚本进程里额外注入的环境变量；值支持 `{workspace}` 等占位符。 */
  env: Record<string, EnvValue>
  execution: ExecutionConfig
  /** 临时上传脚本的一次性目录前缀（相对 rootPath）。 */
  tempDir: string
}

export type ShellConfig = {
  /** shell 工具的总开关。关掉后工具仍注册，但出现在 listTools 的 disabled[] 里。 */
  enabled: boolean
  /** 单条命令的墙钟超时（毫秒）。 */
  timeoutMs: number
  /** 允许 `sh -c` 这类把整行交给 shell 解释。关掉后只能直接 spawn 可执行文件。 */
  allowShellSyntax: boolean
}

export type RavenConfig = {
  rootPath: string
  workspace: WorkspaceConfig
  clipboard: ClipboardConfig
  auth: AuthConfig
  scripts: ScriptsConfig
  shell: ShellConfig
  services: ServicesConfig
  /** 配置来源文件，供 /api/system/config 回显（不返回密码）。 */
  sourceFile: string
  /** 用户数据目录（容器里是数据卷挂载点）。 */
  dataDir: string
}

/** 能在浏览器里安全暴露的配置子集。 */
export type PublicConfig = {
  version: string
  dataDir: string
  workspace: {
    name: string
    quotaBytes: number | null
    allowScriptExecution: boolean
  }
  clipboard: {
    maxItems: number
    maxTextBytes: number
  }
  scripts: {
    timeoutMs: number
    maxOutputBytes: number
    maxConcurrent: number
    extraEnvKeys: string[]
  }
  services: {
    collect: boolean
    sampleIntervalSeconds: number
    count: number
  }
  username: string
}
