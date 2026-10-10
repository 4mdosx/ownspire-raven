/**
 * 服务注册表 / 健康采集 / Dashboard 的断言（`npm run verify:dashboard`）。
 *
 * ──────────────────────────────────────────────────────────────
 * ⚠️ 这个文件被两种方式调用，两种都要成立：
 *
 * 1. 独立跑 —— `node --conditions react-server --import tsx scripts/verify-dashboard.ts`
 *    自带一个最小 harness，最后打印 `✅ <n> passed`，失败打印
 *    `❌ <name>: <detail>` 并 exit 1。
 * 2. 被总入口 `scripts/verify-raven.ts` import —— 导出 `runDashboardChecks(checker, {temp})`，
 *    用它的计数器与临时目录（临时根由总入口负责删）。
 *
 * 两条硬性纪律：
 *
 * - **静态 import 只允许 node 内置模块。** `config/env.ts` 在模块加载期就把
 *   dataDir / db 路径钉死，所以所有 `@/backstage/**` 都必须在环境变量就位之后
 *   用 `await import()` 拉。tsx 以 CJS 输出，模块顶层不能 `await`，于是真正
 *   的工作包在 `runDashboardChecks()` 里（本身就是 async）。
 * - **RAVEN_CONFIG 必须换成我们自己的临时配置。** 总入口把 RAVEN_CONFIG 指向
 *   仓库里的示例配置，那份的 `rootPath` 是 `~/.local/share/ownspire-raven`，
 *   `registryFile` 又是相对 rootPath 的 —— 不换掉的话，这个「验证脚本」会去
 *   改写用户真实的服务注册表。
 * ──────────────────────────────────────────────────────────────
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Probe, ServiceDef } from '@/types/config'

export type VerifyChecker = {
  check: (name: string, work: () => void | Promise<void>) => Promise<void>
  fail: (name: string, detail: string) => void
  skip?: (name: string, reason: string) => void
}

const REGISTRATION_TOKEN = 'dash-registration-token-0123456789'

/**
 * 泄漏探针用的 PIN。
 *
 * ⚠️ 它**不是**配置项了 —— 凭据改由首次登录在数据库里设置。所以它的用途从
 * 「断言配置里的密码没泄漏」变成了「断言这个值不会出现在任何响应里」。
 * 换句话说：它是「假如这个值出现在了输出里那就一定是我们泄漏了」的哨兵，
 * 而不再是被检视的配置内容。
 */
const AUTH_PIN = '7391'

export async function runDashboardChecks(checker: VerifyChecker, options: { temp: string }): Promise<void> {
  const temp = path.resolve(options.temp)
  const root = path.join(temp, 'dash-root')
  const scriptsDir = path.join(root, 'scripts')
  const workspaceDir = path.join(root, 'workspace')
  const outsideFile = path.join(temp, 'dash-outside-root.txt')
  const configFile = path.join(temp, 'dash.config.json')
  const registryFile = path.join(root, 'services.json')

  fs.mkdirSync(scriptsDir, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.writeFileSync(outsideFile, 'x'.repeat(64), 'utf8')

  // ---------------------------------------------------------------- 夹具
  const baseConfig = (): Record<string, unknown> => ({
    rootPath: root,
    workspace: { name: 'workspace', quotaBytes: null, allowScriptExecution: true, scriptsDir: 'scripts' },
    clipboard: { maxItems: 50, maxTextBytes: 65_536 },
    auth: { sessionHours: 1 },
    scripts: {
      env: {},
      execution: { timeoutMs: 2000, maxOutputBytes: 65_536, maxConcurrent: 4 },
      tempDir: 'tmp',
    },
    services: {
      registryFile: 'services.json',
      sampleIntervalSeconds: 5,
      historyLimit: 50,
      metricHistoryLimit: 50,
      collect: true,
      registrationToken: REGISTRATION_TOKEN,
      publicBaseUrl: 'http://127.0.0.1:5800',
      // 两个内联定义：一个只存在于配置里（用来验「内联不可删」），
      // 一个会被文件里的同名定义遮蔽（用来验合并与 warning）。
      defs: [
        { id: 'inline-only', title: '只在配置里', enabled: true, tags: ['inline'], probes: [] },
        {
          id: 'inline-shadow',
          title: '内联版',
          summary: '来自配置',
          enabled: true,
          tags: ['inline'],
          probes: [{ type: 'file', path: 'workspace/fresh.txt' }],
        },
      ],
    },
  })

  let configBumps = 0
  const writeConfig = (patch: { services?: Record<string, unknown> } = {}): void => {
    const merged = baseConfig()
    if (patch.services !== undefined) {
      merged.services = { ...(merged.services as Record<string, unknown>), ...patch.services }
    }
    fs.writeFileSync(configFile, JSON.stringify(merged, null, 2), 'utf8')
    // `getConfig()` 按 mtime 决定要不要重载，而两次写可能落在同一毫秒里 ——
    // 那样「把 collect 关掉」的断言会安静地测到上一份配置。把 mtime 单调推远。
    configBumps += 1
    const stampMs = Date.now() + configBumps * 1000
    fs.utimesSync(configFile, stampMs / 1000, stampMs / 1000)
  }

  // ⚠️ 必须在任何 getConfig() 之前。见文件头第 2 条。
  process.env.RAVEN_CONFIG = configFile
  writeConfig()

  // ---------------------------------------------------------------- 脚本夹具
  fs.writeFileSync(
    path.join(scriptsDir, 'probe-ok.mjs'),
    "console.log(JSON.stringify({ status: 'ok', message: '脚本自检通过', version: '9.9.9' }))\n",
    'utf8'
  )
  fs.writeFileSync(
    path.join(scriptsDir, 'probe-bad.mjs'),
    "console.error('boom: 依赖没装')\nprocess.exit(3)\n",
    'utf8'
  )
  fs.writeFileSync(path.join(scriptsDir, 'probe-sleep.mjs'), 'await new Promise((r) => setTimeout(r, 8000))\n', 'utf8')
  fs.writeFileSync(
    path.join(scriptsDir, 'metric-ok.mjs'),
    "console.log(JSON.stringify({ metrics: [{ name: 'db_bytes', value: 1234, unit: 'B' }], message: '来自指标脚本' }))\n",
    'utf8'
  )

  // 新鲜 / 过期两种文件（过期那个把 mtime 拨到一小时前）。
  const freshFile = path.join(workspaceDir, 'fresh.txt')
  fs.writeFileSync(freshFile, 'fresh-content', 'utf8')
  const staleFile = path.join(workspaceDir, 'stale.txt')
  fs.writeFileSync(staleFile, 'stale-content', 'utf8')
  const oneHourAgo = (Date.now() - 3600 * 1000) / 1000
  fs.utimesSync(staleFile, oneHourAgo, oneHourAgo)

  // ---------------------------------------------------------------- 测试用 HTTP 服务
  const requests: string[] = []
  let holdInFlight = 0
  let holdPeak = 0
  const sendJson = (response: http.ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }
  const server = http.createServer((request, response) => {
    const url = request.url ?? '/'
    requests.push(url)
    // 永不回应：用来测 http 探针的超时路径（也测「探针不会把整次采集挂死」）。
    if (url.startsWith('/slow')) return
    if (url.startsWith('/hold')) {
      holdInFlight += 1
      holdPeak = Math.max(holdPeak, holdInFlight)
      setTimeout(() => {
        holdInFlight -= 1
        sendJson(response, 200, { ok: true })
      }, 150)
      return
    }
    if (url.startsWith('/redirect')) {
      response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' })
      response.end()
      return
    }
    if (url.startsWith('/missing')) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('no such route here')
      return
    }
    sendJson(response, 200, { ok: true, version: 'abc1234' })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务器没拿到端口')
  const port = address.port
  const base = `http://127.0.0.1:${port}`
  const countHits = (prefix: string): number => requests.filter((url) => url.startsWith(prefix)).length

  // 一个「刚刚被释放」的端口：拿它当「没人监听」的确定答案，比猜 1 号端口稳。
  const closedPort = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const found = probe.address()
      if (found === null || typeof found === 'string') {
        reject(new Error('没拿到空闲端口'))
        return
      }
      const value = found.port
      probe.close(() => resolve(value))
    })
  })

  const skip = (name: string, reason: string): void => {
    if (checker.skip !== undefined) checker.skip(name, reason)
    else console.log(`  ~ SKIP ${name}：${reason}`)
  }

  // 全部运行时依赖在这里才拉起来：环境变量已经就位。
  const { upsertService, loadRegistry, findService, removeService, registryFilePath } = await import(
    '@/backstage/services/registry.service'
  )
  const { checkService } = await import('@/backstage/services/health.service')
  const { getDashboard, collectAll, runAction, assertActionRunnable, parseMetricOutput } = await import(
    '@/backstage/services/dashboard.service'
  )
  const { dbMetricLatest, dbRunGet, dbRunInsert, dbRunList, dbSampleHistory, dbSnapshotAll } = await import(
    '@/backstage/db/database'
  )
  const { registerRunToken } = await import('@/backstage/services/runner.service')
  type HealthReport = import('@/backstage/services/health.service').HealthReport

  const makeDef = (id: string, probes: Probe[], extra: Partial<ServiceDef> = {}): ServiceDef => ({
    id,
    title: id,
    kind: 'ownspire',
    enabled: true,
    tags: [],
    probes,
    ...extra,
  })
  const probeReport = async (id: string, probes: Probe[], extra: Partial<ServiceDef> = {}): Promise<HealthReport> => {
    const { snapshot } = await upsertService(makeDef(id, probes, extra))
    return checkService(snapshot, { force: true })
  }

  try {
    // ============================================================== 注册表
    await checker.check('注册表：upsert 先建后改，不产生重复条目', async () => {
      const first = await upsertService(makeDef('basic-svc', [], { summary: '第一版' }))
      if (!first.created) throw new Error('第一次 upsert 的 created 应为 true')
      const second = await upsertService(makeDef('basic-svc', [], { summary: '第二版' }))
      if (second.created) throw new Error('第二次 upsert 的 created 应为 false')

      const found = (await loadRegistry()).filter((item) => item.def.id === 'basic-svc')
      if (found.length !== 1) throw new Error(`注册表里有 ${found.length} 条 basic-svc`)
      if (found[0].def.summary !== '第二版') throw new Error(`summary 没更新：${found[0].def.summary}`)
      if (found[0].persistable !== true) throw new Error('文件定义应是 persistable')
      if (found[0].origin !== registryFilePath()) throw new Error(`origin=${found[0].origin}`)
      if (found[0].warning !== undefined) throw new Error('只在文件里的服务不该有遮蔽 warning')

      const onDisk = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as { version?: number; services?: Array<{ id?: string }> }
      if (onDisk.version !== 1) throw new Error(`注册表 version=${String(onDisk.version)}，应为 1`)
      if (!Array.isArray(onDisk.services)) throw new Error('注册表文件缺 services 数组')
      if (onDisk.services.filter((item) => item.id === 'basic-svc').length !== 1) throw new Error('文件里出现了重复条目')
      // 内联定义不能被物化进文件：那会让它们变成文件定义，从此配置里那份永远被自己的副本遮蔽。
      if (onDisk.services.some((item) => item.id === 'inline-only')) throw new Error('内联定义被写进注册表文件了')
    })

    await checker.check('注册表：文件定义遮蔽内联同名（逐字段合并 + warning）', async () => {
      await upsertService({ id: 'inline-shadow', title: '文件版', summary: '来自文件' })
      const snapshot = await findService('inline-shadow')
      if (snapshot.origin !== registryFilePath()) throw new Error(`origin=${snapshot.origin}`)
      if (snapshot.persistable !== true) throw new Error('被文件覆盖后的条目应是 persistable')
      if (snapshot.def.title !== '文件版') throw new Error(`title=${snapshot.def.title}`)
      if (snapshot.def.summary !== '来自文件') throw new Error(`summary=${snapshot.def.summary}`)
      if (snapshot.warning === undefined || !snapshot.warning.includes('遮蔽')) {
        throw new Error(`缺少遮蔽 warning：${String(snapshot.warning)}`)
      }
      // 文件里没写的字段要保留内联的值 —— 覆盖是逐字段，不是整份替换。
      if ((snapshot.def.probes ?? []).length !== 1) throw new Error('内联的 probes 被整份替换掉了')
      if (!(snapshot.def.tags ?? []).includes('inline')) throw new Error('内联的 tags 丢了')
    })

    await checker.check('注册表：内联定义只读（removeService 拒绝 not_persistable）', async () => {
      const snapshot = await findService('inline-only')
      if (snapshot.origin !== 'inline') throw new Error(`origin=${snapshot.origin}`)
      if (snapshot.persistable !== false) throw new Error('内联定义不该是 persistable')
      let code = ''
      try {
        await removeService('inline-only')
      } catch (error) {
        code = (error as { code?: string }).code ?? ''
      }
      if (code !== 'not_persistable') throw new Error(`removeService 内联服务的 code=${code || '(没抛错)'}`)
      if (!(await loadRegistry()).some((item) => item.def.id === 'inline-only')) throw new Error('内联定义被删掉了')
    })

    await checker.check('注册表：删文件条目、幂等删除、原子写不留临时文件', async () => {
      if (!(await removeService('basic-svc')).removed) throw new Error('文件条目没删掉')
      if ((await loadRegistry()).some((item) => item.def.id === 'basic-svc')) throw new Error('删完还能读到 basic-svc')
      if ((await removeService('basic-svc')).removed) throw new Error('重复删除应是 removed:false')
      if ((await removeService('never-existed')).removed) throw new Error('未知 id 应是 removed:false')
      const leftovers = fs.readdirSync(root).filter((name) => name.startsWith('.services.json') && name.endsWith('.tmp'))
      if (leftovers.length > 0) throw new Error(`原子写的临时文件没清掉：${leftovers.join(', ')}`)
    })

    // ============================================================== 探针
    await checker.check('http 探针：2xx + expectJson + versionField → ok 并取到 version', async () => {
      const report = await probeReport('http-ok', [
        { type: 'http', url: `${base}/healthz`, expectJson: { ok: true }, versionField: 'version', timeoutMs: 2000 },
      ])
      if (report.status !== 'ok') throw new Error(`${report.status}：${report.message}`)
      if (report.version !== 'abc1234') throw new Error(`version=${report.version}`)
      if (report.okCount !== 1 || report.totalCount !== 1) throw new Error(`okCount/totalCount=${report.okCount}/${report.totalCount}`)
      if (report.latencyMs !== Math.max(...report.probes.map((probe) => probe.latencyMs))) {
        throw new Error('latencyMs 不是最慢那条探针的耗时')
      }
    })

    await checker.check('http 探针：expectJson 不符 → down 且指出是哪个字段', async () => {
      const report = await probeReport('http-json-mismatch', [
        { type: 'http', url: `${base}/healthz`, expectJson: { ok: true, version: 'zzz' }, timeoutMs: 2000 },
      ])
      if (report.status !== 'down') throw new Error(`status=${report.status}：${report.message}`)
      if (!report.message.includes('字段不符') || !report.message.includes('version')) {
        throw new Error(`message=${report.message}`)
      }
    })

    await checker.check('http 探针：非 2xx → down 且消息带状态码与响应体摘要', async () => {
      const report = await probeReport('http-404', [{ type: 'http', url: `${base}/missing`, timeoutMs: 2000 }])
      if (report.status !== 'down') throw new Error(`status=${report.status}`)
      if (!report.message.includes('HTTP 404')) throw new Error(`message=${report.message}`)
      if (!report.message.includes('no such route here')) throw new Error(`消息里没有 body 摘要：${report.message}`)
    })

    await checker.check('http 探针：3xx 不跟随重定向，判 warn 并报出 Location', async () => {
      const report = await probeReport('http-redirect', [{ type: 'http', url: `${base}/redirect`, timeoutMs: 2000 }])
      if (report.status !== 'warn') throw new Error(`status=${report.status}：${report.message}`)
      if (!report.message.includes('302')) throw new Error(`message=${report.message}`)
    })

    await checker.check('http 探针：慢响应按 timeoutMs 收口，不拖住整次采集', async () => {
      const started = Date.now()
      const report = await probeReport('http-timeout', [{ type: 'http', url: `${base}/slow`, timeoutMs: 300 }])
      const elapsed = Date.now() - started
      if (report.status !== 'down') throw new Error(`status=${report.status}`)
      if (!report.message.includes('超时')) throw new Error(`message=${report.message}`)
      if (elapsed > 4000) throw new Error(`超时探针耗时 ${elapsed}ms，说明它没有在 timeoutMs 附近收口`)
    })

    await checker.check('http 探针：相对 URL 走 service.baseUrl', async () => {
      const report = await probeReport('http-base-url', [{ type: 'http', url: '/healthz', timeoutMs: 2000 }], { baseUrl: base })
      if (report.status !== 'ok') throw new Error(`${report.status}：${report.message}`)
    })

    await checker.check('tcp 探针：监听中的端口 → ok', async () => {
      const report = await probeReport('tcp-open', [{ type: 'tcp', host: '127.0.0.1', port, timeoutMs: 2000 }])
      if (report.status !== 'ok') throw new Error(`${report.status}：${report.message}`)
    })

    await checker.check('tcp 探针：没人监听的端口 → down（拒绝连接）', async () => {
      const report = await probeReport('tcp-closed', [{ type: 'tcp', host: '127.0.0.1', port: closedPort, timeoutMs: 2000 }])
      if (report.status !== 'down') throw new Error(`status=${report.status}：${report.message}`)
      if (!report.message.includes('拒绝')) throw new Error(`message=${report.message}`)
    })

    await checker.check('file 探针：相对 rootPath 的缺失路径 → down', async () => {
      const report = await probeReport('file-missing', [{ type: 'file', path: 'workspace/does-not-exist.txt' }])
      if (report.status !== 'down') throw new Error(`status=${report.status}：${report.message}`)
      if (!report.message.includes('不存在')) throw new Error(`message=${report.message}`)
    })

    await checker.check('file 探针：新鲜文件（maxAgeSeconds 内）→ ok', async () => {
      const report = await probeReport('file-fresh', [{ type: 'file', path: 'workspace/fresh.txt', maxAgeSeconds: 300, minBytes: 4 }])
      if (report.status !== 'ok') throw new Error(`${report.status}：${report.message}`)
    })

    await checker.check('file 探针：mtime 超过 maxAgeSeconds → down', async () => {
      const report = await probeReport('file-stale', [{ type: 'file', path: 'workspace/stale.txt', maxAgeSeconds: 60 }])
      if (report.status !== 'down') throw new Error(`status=${report.status}：${report.message}`)
      if (!report.message.includes('没更新')) throw new Error(`message=${report.message}`)
    })

    await checker.check('file 探针：minBytes 不足、绝对路径越出受管根都判 down', async () => {
      const small = await probeReport('file-tiny', [{ type: 'file', path: 'workspace/fresh.txt', minBytes: 1_000_000 }])
      if (small.status !== 'down' || !small.message.includes('要求')) throw new Error(`minBytes：${small.status} ${small.message}`)
      const outside = await probeReport('file-outside', [{ type: 'file', path: outsideFile }])
      if (outside.status !== 'down') throw new Error(`越界绝对路径 status=${outside.status}`)
      if (!outside.message.includes('受管根目录之外')) throw new Error(`message=${outside.message}`)
    })

    await checker.check('docker 探针：拿不到 socket 时报「无法访问 Docker」，不假装 down', async () => {
      const socket = process.env.RAVEN_DOCKER_SOCK ?? '/var/run/docker.sock'
      if (fs.existsSync(socket)) {
        skip('docker 探针', `${socket} 真的存在（本机有 docker daemon），不制造假通过`)
        return
      }
      const report = await probeReport('docker-svc', [{ type: 'docker', container: 'raven-verify-does-not-exist', timeoutMs: 1500 }])
      if (report.status === 'warn') {
        if (!report.message.includes('无法访问 Docker')) throw new Error(`warn 的文案不对：${report.message}`)
        return
      }
      // CLI 在而 daemon 不在时也可能走到 CLI，于是拿到「容器不存在」这个明确答案 —— 同样有效。
      if (report.status === 'down' && report.message.includes('不存在')) return
      throw new Error(`status=${report.status}：${report.message}`)
    })

    await checker.check('script 探针：退出码 0 → ok，并采纳 stdout 的 JSON 行', async () => {
      const report = await probeReport('script-ok', [{ type: 'script', script: 'probe-ok.mjs' }])
      if (report.status !== 'ok') throw new Error(`${report.status}：${report.message}`)
      // 脚本那行 JSON 细化的是**探针**的结论；服务级的 message 是汇总（`1/1 探针正常`）。
      if (report.probes[0].message !== '脚本自检通过') throw new Error(`探针消息=${report.probes[0].message}`)
      if (report.version !== '9.9.9') throw new Error(`version=${report.version}`)
    })

    await checker.check('script 探针：非 0 退出码 → down（带退出码与 stderr）', async () => {
      const report = await probeReport('script-bad', [{ type: 'script', script: 'probe-bad.mjs' }])
      if (report.status !== 'down') throw new Error(`status=${report.status}：${report.message}`)
      if (!report.message.includes('退出码 3')) throw new Error(`message=${report.message}`)
      if (!report.message.includes('boom')) throw new Error(`消息里没有 stderr：${report.message}`)
    })

    await checker.check('script 探针：超时被 runner 杀掉 → down，且不等脚本自己跑完', async () => {
      const started = Date.now()
      const report = await probeReport('script-slow', [{ type: 'script', script: 'probe-sleep.mjs' }])
      const elapsed = Date.now() - started
      if (report.status !== 'down') throw new Error(`status=${report.status}：${report.message}`)
      if (elapsed > 6000) throw new Error(`等了 ${elapsed}ms —— 超时没有真的杀掉脚本（配置里是 2000ms，脚本要睡 8000ms）`)
      if (!/超时|killed|失败/.test(report.message)) throw new Error(`message=${report.message}`)
    })

    await checker.check('汇总：ok+down → warn，全 down → down，没有探针 → unknown', async () => {
      const mixed = await probeReport('roll-mixed', [
        { type: 'http', url: `${base}/healthz`, timeoutMs: 2000 },
        { type: 'tcp', host: '127.0.0.1', port: closedPort, timeoutMs: 2000 },
      ])
      if (mixed.status !== 'warn') throw new Error(`ok+down 应为 warn，实际 ${mixed.status}：${mixed.message}`)
      if (mixed.okCount !== 1 || mixed.totalCount !== 2) throw new Error(`okCount/totalCount=${mixed.okCount}/${mixed.totalCount}`)

      const allBad = await probeReport('roll-down', [
        { type: 'tcp', host: '127.0.0.1', port: closedPort, timeoutMs: 2000 },
        { type: 'file', path: 'workspace/does-not-exist.txt' },
      ])
      if (allBad.status !== 'down') throw new Error(`全挂应为 down，实际 ${allBad.status}`)

      const none = await probeReport('roll-none', [])
      if (none.status !== 'unknown') throw new Error(`没有探针应为 unknown，实际 ${none.status}`)
      if (none.message !== '没有配置探针') throw new Error(`message=${none.message}`)
      if (none.latencyMs !== null) throw new Error(`没有探针时 latencyMs 应为 null，实际 ${String(none.latencyMs)}`)
    })

    await checker.check('探针并发：8 个并行 http 探针的峰值不超过 6', async () => {
      holdPeak = 0
      const report = await probeReport(
        'concurrency-svc',
        Array.from({ length: 8 }, () => ({ type: 'http', url: `${base}/hold`, timeoutMs: 3000 }) as Probe)
      )
      if (report.status !== 'ok') throw new Error(`${report.status}：${report.message}`)
      if (holdPeak > 6) throw new Error(`同时在飞的探针有 ${holdPeak} 个（上限 6）`)
      if (holdPeak < 2) throw new Error(`峰值只有 ${holdPeak}，说明探针没在并行跑`)
      if (report.latencyMs !== Math.max(...report.probes.map((probe) => probe.latencyMs))) {
        throw new Error('latencyMs 不是最慢那条探针的耗时')
      }
    })

    // ============================================================== 指标解析（纯函数）
    await checker.check('parseMetricOutput：嵌套形状（metrics/name/value/unit + message）', () => {
      const parsed = parseMetricOutput('{"metrics":[{"name":"db_bytes","value":1234,"unit":"B"}],"message":"来自脚本"}')
      if (parsed.metrics.length !== 1) throw new Error(`metrics=${JSON.stringify(parsed.metrics)}`)
      const metric = parsed.metrics[0]
      if (metric.metric !== 'db_bytes' || metric.value !== 1234 || metric.unit !== 'B') throw new Error(JSON.stringify(metric))
      if (parsed.message !== '来自脚本') throw new Error(`message=${parsed.message}`)
    })

    await checker.check('parseMetricOutput：扁平形状（unit 一律为空串）', () => {
      const parsed = parseMetricOutput('{"db_bytes":1234,"media_bytes":567}')
      if (parsed.metrics.length !== 2) throw new Error(`metrics=${JSON.stringify(parsed.metrics)}`)
      for (const metric of parsed.metrics) {
        if (metric.unit !== '') throw new Error(`unit 应为空串：${JSON.stringify(metric)}`)
      }
      const bytes = parsed.metrics.find((metric) => metric.metric === 'media_bytes')
      if (bytes?.value !== 567) throw new Error(JSON.stringify(parsed.metrics))
    })

    await checker.check('parseMetricOutput：非数字值一律丢掉（字符串数字也不认）', () => {
      const flat = parseMetricOutput('{"db_bytes":1234,"note":"x","flag":true,"empty":null,"nested":{"a":1}}')
      if (flat.metrics.length !== 1 || flat.metrics[0].metric !== 'db_bytes') throw new Error(JSON.stringify(flat.metrics))
      const nested = parseMetricOutput('{"metrics":[{"name":"ok_one","value":1},{"name":"stringy","value":"1234"},{"name":"no_value"}]}')
      if (nested.metrics.length !== 1 || nested.metrics[0].metric !== 'ok_one') throw new Error(JSON.stringify(nested.metrics))
    })

    await checker.check('parseMetricOutput：前面是日志，取最后一行可解析的 JSON', () => {
      const parsed = parseMetricOutput('starting up...\nWARN: slow query\n{"db_bytes":42}')
      if (parsed.metrics.length !== 1 || parsed.metrics[0].value !== 42) throw new Error(JSON.stringify(parsed.metrics))
    })

    await checker.check('parseMetricOutput：末尾的 {"ok":true} 不该抹掉前面的指标', () => {
      const parsed = parseMetricOutput('{"metrics":[{"name":"a","value":1}]}\n{"ok":true}')
      if (parsed.metrics.length !== 1 || parsed.metrics[0].metric !== 'a') throw new Error(JSON.stringify(parsed.metrics))
    })

    await checker.check('parseMetricOutput：prefix 加命名空间（点号连接，不重复加）', () => {
      const once = parseMetricOutput('{"db_bytes":1}', 'navi')
      if (once.metrics[0]?.metric !== 'navi.db_bytes') throw new Error(JSON.stringify(once.metrics))
      const twice = parseMetricOutput('{"db_bytes":1}', 'navi.')
      if (twice.metrics[0]?.metric !== 'navi.db_bytes') throw new Error(JSON.stringify(twice.metrics))
    })

    await checker.check('parseMetricOutput：一行 JSON 都没有时返回空指标 + 一句说明', () => {
      const parsed = parseMetricOutput('hello\nworld\nnot json at all')
      if (parsed.metrics.length !== 0) throw new Error(JSON.stringify(parsed.metrics))
      if (parsed.message === '') throw new Error('没有任何说明，调用方不知道是「没指标」还是「解析失败」')
    })

    // ============================================================== 采样缓存
    await checker.check('缓存：sampleInterval 内第二次不打上游，force 才重打', async () => {
      const { snapshot } = await upsertService(makeDef('cache-svc', [{ type: 'http', url: `${base}/cache-probe`, timeoutMs: 2000 }]))
      const before = countHits('/cache-probe')

      const first = await checkService(snapshot)
      if (first.fromCache) throw new Error('第一次不该命中缓存')
      const second = await checkService(snapshot)
      if (!second.fromCache) throw new Error('第二次应命中缓存')
      const afterTwo = countHits('/cache-probe')
      if (afterTwo - before !== 1) throw new Error(`两次调用打了 ${afterTwo - before} 次上游，期望 1`)

      const forced = await checkService(snapshot, { force: true })
      if (forced.fromCache) throw new Error('force 不该命中缓存')
      await checkService(snapshot, { force: true })
      const afterFour = countHits('/cache-probe')
      if (afterFour - before !== 3) throw new Error(`两次 force 之后累计 ${afterFour - before} 次，期望 3`)
      if (second.checkedAt !== first.checkedAt) throw new Error('缓存回放的 checkedAt 应与被缓存的那次一致')
    })

    // ============================================================== 治理动作
    await checker.check('动作：非 readonly 必须给对确认词；运行记录带 action:<id>/<action>', async () => {
      await upsertService(
        makeDef('action-svc', [], {
          actions: [
            { id: 'backup', title: '备份', script: 'probe-ok.mjs', confirmPhrase: 'go-ahead' },
            { id: 'peek', title: '看看', script: 'probe-ok.mjs', readonly: true },
          ],
        })
      )

      for (const wrong of [undefined, '', 'yes', 'nope']) {
        let code = ''
        try {
          await runAction('action-svc', 'backup', { confirm: wrong })
        } catch (error) {
          code = (error as { code?: string }).code ?? ''
        }
        if (code !== 'confirm_required') throw new Error(`confirm=${JSON.stringify(wrong)} 的 code=${code || '(没抛错)'}`)
      }

      const result = await runAction('action-svc', 'backup', { confirm: 'go-ahead' })
      if (result.status !== 'ok') throw new Error(`动作 status=${result.status}：${result.stderr}`)
      const row = await dbRunGet(result.recordId)
      if (row === undefined) throw new Error('动作没有写进 run_records')
      if (row.triggeredBy !== 'action:action-svc/backup') throw new Error(`triggeredBy=${row.triggeredBy}`)

      const readonly = await runAction('action-svc', 'peek')
      if (readonly.status !== 'ok') throw new Error('readonly 动作不需要确认词，应该能直接跑')

      let notFound = ''
      try {
        await assertActionRunnable('action-svc', 'nope')
      } catch (error) {
        notFound = (error as { code?: string }).code ?? ''
      }
      if (notFound !== 'not_found') throw new Error(`未知动作的 code=${notFound || '(没抛错)'}`)
    })

    // ============================================================== Dashboard
    await checker.check('Dashboard：totals 自洽、动作只给元数据、渲染时不跑脚本、不泄漏秘密', async () => {
      const runsBefore = (await dbRunList(200)).length
      const view = await getDashboard()
      const runsAfter = (await dbRunList(200)).length
      if (runsAfter !== runsBefore) throw new Error('渲染 dashboard 的过程中跑了脚本（run_records 条数变了）')

      const sum = view.totals.ok + view.totals.warn + view.totals.down + view.totals.unknown
      if (sum !== view.totals.total) throw new Error(`totals 分项和 ${sum} ≠ total ${view.totals.total}`)
      if (view.totals.total !== view.services.length) throw new Error(`total ${view.totals.total} ≠ services ${view.services.length}`)
      const counts = { ok: 0, warn: 0, down: 0, unknown: 0 }
      for (const service of view.services) counts[service.health.status] += 1
      for (const key of ['ok', 'warn', 'down', 'unknown'] as const) {
        if (counts[key] !== view.totals[key]) throw new Error(`${key} 分项 ${view.totals[key]} ≠ 实际 ${counts[key]}`)
      }

      for (const service of view.services) {
        for (const action of service.actions) {
          if (action.id === '' || typeof action.title !== 'string') throw new Error(`动作元数据不全：${JSON.stringify(action)}`)
          if (typeof action.readonly !== 'boolean' || typeof action.needsConfirm !== 'boolean') {
            throw new Error(`动作缺少 readonly/needsConfirm：${JSON.stringify(action)}`)
          }
          if (action.readonly && action.needsConfirm) throw new Error('readonly 的动作不该要求二次确认')
        }
      }

      const text = JSON.stringify(view)
      if (text.includes(REGISTRATION_TOKEN)) throw new Error('dashboard 泄漏了注册令牌')
      if (text.includes(AUTH_PIN)) throw new Error('dashboard 泄漏了 PIN')
      // 散列前缀也不能出现：出现它说明有人把 PIN 散列塞进了响应。
      if (text.includes('scrypt$')) throw new Error('dashboard 泄漏了凭据散列')

      const cached = view.services.find((service) => service.id === 'cache-svc')
      if (cached === undefined) throw new Error('dashboard 里没有 cache-svc')
      if (!Array.isArray(cached.history) || cached.history.length === 0) throw new Error('cache-svc 没有健康历史（采样没落库？）')
      if (!Array.isArray(cached.metrics)) throw new Error('metrics 不是数组')
    })

    // ============================================================== 采集
    await checker.check('采集：collectAll 落库样本/快照，并跑指标脚本', async () => {
      await upsertService(
        makeDef('metrics-svc', [{ type: 'file', path: 'workspace/fresh.txt' }], {
          metrics: [{ id: 'size', title: '体积', script: 'metric-ok.mjs', metricPrefix: 'demo' }],
        })
      )
      const described = (await getDashboard()).services.find((service) => service.id === 'metrics-svc')
      if (described === undefined) throw new Error('dashboard 里没有 metrics-svc')
      if (described.metricProbes.length !== 1 || described.metricProbes[0].id !== 'size') {
        throw new Error(`metricProbes 没下发（前端的「跑一次」按钮会消失）：${JSON.stringify(described.metricProbes)}`)
      }

      const result = await collectAll({ force: true })
      if (!result.collected.includes('metrics-svc')) throw new Error(`collected=${result.collected.join(',')}`)
      if ((await dbSampleHistory('metrics-svc', 10)).length === 0) throw new Error('没有写 service_samples')
      const rows = (await dbSnapshotAll()).filter((row) => row.serviceId === 'metrics-svc')
      if (rows.length !== 1) throw new Error(`service_snapshots 里有 ${rows.length} 条`)
      if (rows[0].status !== 'ok') throw new Error(`快照状态=${rows[0].status}：${rows[0].message}`)
      // 落库的 details 就是「重启之后缓存里还剩什么」：它必须能被读回成探针明细，
      // 否则进程重启后的第一次 dashboard 会把探针那一栏显示成空的。
      if (rows[0].okCount !== 1 || rows[0].totalCount !== 1) throw new Error(`快照计数=${rows[0].okCount}/${rows[0].totalCount}`)
      const details = JSON.parse(rows[0].details) as Array<{ type?: string; status?: string }>
      if (!Array.isArray(details) || details.length !== 1 || details[0].type !== 'file' || details[0].status !== 'ok') {
        throw new Error(`details 读不回探针明细：${rows[0].details}`)
      }

      const latest = await dbMetricLatest('metrics-svc')
      const metric = latest.find((item) => item.metric === 'demo.db_bytes')
      if (metric === undefined) throw new Error(`指标没落库：${latest.map((item) => item.metric).join(',') || '(空)'}`)
      if (metric.value !== 1234) throw new Error(`指标值=${metric.value}`)
    })

    await checker.check('采集：第二轮在采样间隔内命中缓存，不打上游', async () => {
      await upsertService(makeDef('collect-cache-svc', [{ type: 'http', url: `${base}/collect-probe`, timeoutMs: 2000 }]))
      const first = await collectAll({ force: true })
      if (!first.collected.includes('collect-cache-svc')) throw new Error(`第一轮 collected=${first.collected.join(',')}`)
      const hits = countHits('/collect-probe')
      if (hits !== 1) throw new Error(`第一轮打了 ${hits} 次上游`)
      const second = await collectAll()
      if (!second.cached.includes('collect-cache-svc')) throw new Error(`第二轮应命中缓存，cached=${second.cached.join(',')}`)
      if (countHits('/collect-probe') !== hits) throw new Error('采样间隔内又打了上游')
    })

    // ============================================================== API 路由
    // 直接调用 route 导出的 handler（Next 的 handler 就是普通函数，收 Request 返回 Response）。
    // 这一步专门抓「信封没走 handle()」「动态参数没 await」「检查发生在开流之后」三类错误。
    await checker.check('路由：GET /api/services 走统一信封且不泄漏秘密', async () => {
      const route = await import('@/app/api/services/route')
      const response = await route.GET(new Request('http://localhost/api/services?force=1'))
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as {
        ok?: boolean
        services?: Array<{ id?: string }>
        totals?: { total?: number }
        config?: { sampleIntervalSeconds?: number }
      }
      if (payload.ok !== true) throw new Error('信封里没有 ok:true')
      if (!Array.isArray(payload.services)) throw new Error('缺 services 数组')
      if (payload.totals?.total !== payload.services.length) throw new Error('totals.total 与 services 不一致')
      if (payload.config?.sampleIntervalSeconds !== 5) throw new Error('config 没带上采样间隔')
      const text = JSON.stringify(payload)
      if (text.includes(REGISTRATION_TOKEN) || text.includes(AUTH_PIN) || text.includes('scrypt$')) {
        throw new Error('路由返回体里出现了秘密')
      }
    })

    await checker.check('路由：GET /api/services/[id] await 了 params，未知 id → 404 信封', async () => {
      const route = await import('@/app/api/services/[id]/route')
      const found = await route.GET(new Request('http://localhost/api/services/metrics-svc'), {
        params: Promise.resolve({ id: 'metrics-svc' }),
      })
      const body = (await found.json()) as { ok?: boolean; service?: { id?: string } }
      if (found.status !== 200 || body.ok !== true || body.service?.id !== 'metrics-svc') {
        throw new Error(`HTTP ${found.status}：${JSON.stringify(body)}`)
      }
      // 动态段是 Promise：忘了 await 的话这里会变成 not_found（id=undefined），断言留着。
      const missing = await route.GET(new Request('http://localhost/api/services/nope'), {
        params: Promise.resolve({ id: 'nope' }),
      })
      const missingBody = (await missing.json()) as { ok?: boolean; code?: string }
      if (missing.status !== 404) throw new Error(`未知 id 的 HTTP ${missing.status}`)
      if (missingBody.ok !== false || missingBody.code !== 'not_found') throw new Error(JSON.stringify(missingBody))
    })

    await checker.check('路由：POST /api/services/[id]/metrics 校验参数并返回 {metrics, report}', async () => {
      const route = await import('@/app/api/services/[id]/metrics/route')
      const bad = await route.POST(new Request('http://localhost/api/services/metrics-svc/metrics', { method: 'POST', body: '{}' }), {
        params: Promise.resolve({ id: 'metrics-svc' }),
      })
      const badBody = (await bad.json()) as { ok?: boolean; code?: string }
      if (bad.status !== 400 || badBody.code !== 'missing_param') throw new Error(`HTTP ${bad.status}：${JSON.stringify(badBody)}`)

      const good = await route.POST(
        new Request('http://localhost/api/services/metrics-svc/metrics', {
          method: 'POST',
          body: JSON.stringify({ probeId: 'size' }),
        }),
        { params: Promise.resolve({ id: 'metrics-svc' }) }
      )
      const goodBody = (await good.json()) as { ok?: boolean; metrics?: Array<{ metric?: string }>; report?: { status?: string } }
      if (good.status !== 200 || goodBody.ok !== true) throw new Error(`HTTP ${good.status}：${JSON.stringify(goodBody)}`)
      if (goodBody.report?.status !== 'ok') throw new Error(`run 状态=${String(goodBody.report?.status)}`)
      if (!(goodBody.metrics ?? []).some((metric) => metric.metric === 'demo.db_bytes')) {
        throw new Error(`metrics=${JSON.stringify(goodBody.metrics)}`)
      }
    })

    await checker.check('路由：动作在开流之前先校验（未知动作 → JSON 404，不是一个 200 的空流）', async () => {
      const route = await import('@/app/api/services/[id]/actions/route')
      const response = await route.POST(
        new Request('http://localhost/api/services/action-svc/actions', {
          method: 'POST',
          body: JSON.stringify({ actionId: 'not-an-action' }),
        }),
        { params: Promise.resolve({ id: 'action-svc' }) }
      )
      if (response.status !== 404) throw new Error(`HTTP ${response.status}（@types 是 JSON 信封，SSE 流是 200）`)
      if (response.headers.get('content-type')?.includes('text/event-stream') === true) throw new Error('校验失败却开了事件流')
      const body = (await response.json()) as { ok?: boolean; code?: string }
      if (body.code !== 'not_found') throw new Error(JSON.stringify(body))
    })

    await checker.check('路由：POST /api/ingest/register 令牌是唯一凭据（错令牌 401 / 对令牌 201）', async () => {
      const route = await import('@/app/api/ingest/register/route')
      const def = { id: 'ingested-svc', title: '自注册服务', probes: [{ type: 'file', path: 'workspace/fresh.txt' }] }

      const denied = await route.POST(
        new Request('http://localhost/api/ingest/register', {
          method: 'POST',
          headers: { 'x-ownspire-token': 'wrong-token' },
          body: JSON.stringify({ def }),
        })
      )
      const deniedBody = (await denied.json()) as { code?: string }
      if (denied.status !== 401 || deniedBody.code !== 'unauthorized') throw new Error(`HTTP ${denied.status}：${JSON.stringify(deniedBody)}`)

      const created = await route.POST(
        new Request('http://localhost/api/ingest/register', {
          method: 'POST',
          headers: { 'x-ownspire-token': REGISTRATION_TOKEN },
          body: JSON.stringify({ def }),
        })
      )
      const createdBody = (await created.json()) as { ok?: boolean; created?: boolean; service?: { def?: { id?: string } } }
      if (created.status !== 201 || createdBody.created !== true) throw new Error(`HTTP ${created.status}：${JSON.stringify(createdBody)}`)
      if (createdBody.service?.def?.id !== 'ingested-svc') throw new Error('注册返回值里没有服务定义')
      if (!(await loadRegistry()).some((item) => item.def.id === 'ingested-svc')) throw new Error('自注册的服务没进注册表')
    })

    await checker.check('路由：POST /api/ingest/metrics 收注册令牌与运行令牌', async () => {
      const route = await import('@/app/api/ingest/metrics/route')

      const anonymous = await route.POST(
        new Request('http://localhost/api/ingest/metrics', { method: 'POST', body: JSON.stringify({ serviceId: 'metrics-svc', db_bytes: 1 }) })
      )
      if (anonymous.status !== 401) throw new Error(`无令牌应 401，实际 ${anonymous.status}`)

      const pushed = await route.POST(
        new Request('http://localhost/api/ingest/metrics', {
          method: 'POST',
          headers: { 'x-ownspire-token': REGISTRATION_TOKEN },
          body: JSON.stringify({ serviceId: 'metrics-svc', metrics: [{ name: 'pushed_bytes', value: 77, unit: 'B' }] }),
        })
      )
      const pushedBody = (await pushed.json()) as { ok?: boolean; accepted?: number }
      if (pushed.status !== 200 || pushedBody.accepted !== 1) throw new Error(`HTTP ${pushed.status}：${JSON.stringify(pushedBody)}`)
      if (!(await dbMetricLatest('metrics-svc')).some((metric) => metric.metric === 'pushed_bytes')) throw new Error('推上来的指标没落库')

      // 运行令牌：runner 在运行期登记，脚本拿 RAVEN_TOKEN 回调这里。
      const runId = await dbRunInsert({
        script: 'metric-ok.mjs',
        origin: 'metric',
        status: 'running',
        startedAt: Date.now(),
        triggeredBy: 'verify',
      })
      registerRunToken('verify-run-token-0123456789', { runId, script: 'metric-ok.mjs' })
      const viaRunToken = await route.POST(
        new Request('http://localhost/api/ingest/metrics', {
          method: 'POST',
          headers: { 'x-ownspire-token': 'verify-run-token-0123456789' },
          body: JSON.stringify({ serviceId: 'metrics-svc', db_bytes: 9 }),
        })
      )
      const viaRunTokenBody = (await viaRunToken.json()) as { ok?: boolean; runId?: number | null }
      if (viaRunToken.status !== 200) throw new Error(`HTTP ${viaRunToken.status}：${JSON.stringify(viaRunTokenBody)}`)
      if (viaRunTokenBody.runId !== runId) throw new Error(`runId 没回传对：${String(viaRunTokenBody.runId)} ≠ ${runId}`)
    })

    // 放在最后：它会改写配置里的 collect 开关。
    await checker.check('开关：collect=false 时 collectAll 是空操作，checkService 只回放缓存/unknown', async () => {
      const { snapshot } = await upsertService(
        makeDef('kill-switch-svc', [{ type: 'http', url: `${base}/kill-switch-probe`, timeoutMs: 2000 }])
      )
      await checkService(snapshot, { force: true })
      if (countHits('/kill-switch-probe') !== 1) throw new Error('基线：开关打开时应该刚好打 1 次上游')

      const { snapshot: neverProbed } = await upsertService(
        makeDef('kill-switch-unknown', [{ type: 'tcp', host: '127.0.0.1', port: closedPort, timeoutMs: 2000 }])
      )

      writeConfig({ services: { collect: false } })
      const before = requests.length
      const result = await collectAll({ force: true })
      if (result.collected.length !== 0) throw new Error(`collect=false 还采了：${result.collected.join(',')}`)
      if (!result.cached.includes('kill-switch-svc')) throw new Error(`cached 里应列出全部服务：${result.cached.join(',')}`)

      const cached = await checkService(snapshot, { force: true })
      if (cached.status !== 'ok') throw new Error(`应回放上一次 ok 的快照，实际 ${cached.status}：${cached.message}`)
      if (!cached.fromCache) throw new Error('collect=false 回放的快照应带 fromCache')

      const unknown = await checkService(neverProbed, { force: true })
      if (unknown.status !== 'unknown') throw new Error(`从没采过的服务应为 unknown，实际 ${unknown.status}`)
      if (unknown.fromCache && unknown.status !== 'unknown') throw new Error('unknown 的形状不对')

      const moved = requests.length - before
      if (moved !== 0) throw new Error(`collect=false 期间打了 ${moved} 次上游：${requests.slice(before).join(', ')}`)

      writeConfig() // 还原开关，别把配置留在「关」的位置
    })
  } finally {
    // 挂着不回的 /slow 连接要主动断掉，否则 server.close() 永远等不到回调。
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// ---------------------------------------------------------------------------
// 独立运行时的最小 harness
// ---------------------------------------------------------------------------

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

/**
 * 删掉自己 mkdtemp 出来的目录。
 *
 * 递归删除前先确认「这确实是我建的那个、并且就在系统临时目录下」——
 * 一个变量拼错就是不可回滚的删除（AGENTS.md 第二节）。顺手数一下文件数，
 * 清理日志里能看出到底删掉了什么。
 */
function removeOwnTempDirectory(target: string): void {
  const resolved = path.resolve(target)
  const name = path.basename(resolved)
  if (!name.startsWith('raven-dash-') || path.dirname(resolved) !== path.resolve(os.tmpdir())) {
    console.log(`  ~ 跳过清理（不是本脚本建的临时目录）：${resolved}`)
    return
  }
  let files = 0
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name))
      else files += 1
    }
  }
  try {
    walk(resolved)
  } catch {
    // 数不清也照删，下面的日志会说明只删了目录本身。
  }
  console.log(`  · 清理临时目录 ${resolved}（${files} 个文件）`)
  fs.rmSync(resolved, { recursive: true, force: true })
}

async function main(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-dash-'))
  // ⚠️ 必须在任何 `@/backstage/**` 的动态 import 之前 —— config/env.ts 是在
  // 模块加载期把 dataDir / db 路径定下来的。
  process.env.RAVEN_DATA_DIR = path.join(temp, 'data')
  process.env.RAVEN_DB_FILE = path.join(temp, 'data', 'raven.db')
  process.env.RAVEN_CONFIG = path.join(temp, 'raven.config.json')
  process.env.SESSION_SECRET ??= 'verify-dashboard-secret-0123456789'
  fs.mkdirSync(process.env.RAVEN_DATA_DIR, { recursive: true })

  const passed: string[] = []
  const failed: string[] = []
  const skipped: string[] = []
  const checker: VerifyChecker = {
    async check(name, work) {
      try {
        await work()
        passed.push(name)
        console.log(`  ✓ ${name}`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        failed.push(`${name}: ${detail}`)
        console.log(`  ✗ ${name}: ${detail}`)
      }
    },
    fail(name, detail) {
      failed.push(`${name}: ${detail}`)
      console.log(`  ✗ ${name}: ${detail}`)
    },
    skip(name, reason) {
      skipped.push(`${name}（${reason}）`)
      console.log(`  ~ SKIP ${name}：${reason}`)
    },
  }

  console.log(`临时目录：${temp}`)
  console.log('── 服务注册表 / 健康采集 / Dashboard ───────────')
  try {
    await runDashboardChecks(checker, { temp })
  } finally {
    removeOwnTempDirectory(temp)
  }

  console.log('')
  if (skipped.length > 0) {
    console.log('跳过：')
    for (const item of skipped) console.log(`  ~ ${item}`)
  }
  if (failed.length > 0) {
    for (const item of failed) console.log(`❌ ${item}`)
    console.log(`\n❌ ${failed.length} failed，${passed.length} passed`)
    process.exitCode = 1
    return
  }
  console.log(`✅ ${passed.length} passed${skipped.length > 0 ? `（跳过 ${skipped.length}）` : ''}`)
}

if (isDirectRun()) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
