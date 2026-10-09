/**
 * 总验证入口：`npm run verify`。
 *
 * ──────────────────────────────────────────────────────────────
 * ⚠️ 为什么是这个形状（而不是三段 `&&` 串起来）
 *
 * `config/env.ts` 在**模块加载期**就把 dataDir / db 路径定下来了，而三个验证
 * 文件各自需要独立的临时根与临时库。如果一个进程里先后跑三段，先加载的那段
 * 会把路径钉死，后面两段就悄悄写进了别人的临时目录 —— 那种错误表现为
 * 「某些断言单独跑能过、一起跑就挂」，最难查。
 *
 * 所以：**总入口只负责设一次环境变量（指向自己的临时目录），然后动态 import
 * 三段**。每段自己再建 temp 配置，但库与 dataDir 共享总入口给的那一份 ——
 * 共享是安全的，因为表结构互不冲突、且各段用的数据完全独立。
 *
 * 单独跑某一段时（`npm run verify:storage` / `verify:dashboard`），
 * 由那一段自己兜底设环境变量。
 * ──────────────────────────────────────────────────────────────
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Checker = {
  check: (name: string, fn: () => void | Promise<void>) => Promise<void>
  fail: (name: string, detail: string) => void
  skip: (name: string, reason: string) => void
}

const passed: string[] = []
const failed: string[] = []
const skipped: string[] = []

const checker: Checker = {
  async check(name, fn) {
    try {
      await fn()
      passed.push(name)
      console.log(`  ✓ ${name}`)
    } catch (error) {
      const detail = error instanceof Error ? `${error.message}` : String(error)
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
    console.log(`  ~ ${name} — SKIP：${reason}`)
  },
}

async function main(): Promise<void> {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-verify-'))

  // ⚠️ 必须在任何动态 import 之前设好 —— 见文件头注释。
  process.env.RAVEN_DATA_DIR = path.join(temp, 'data')
  process.env.RAVEN_DB_FILE = path.join(temp, 'data', 'raven.db')
  process.env.RAVEN_CONFIG = path.join(repo, 'config', 'raven.config.example.json')
  process.env.SESSION_SECRET ??= 'verify-secret-that-is-long-enough-0123456789'
  process.env.TZ ??= 'Asia/Shanghai'
  fs.mkdirSync(process.env.RAVEN_DATA_DIR, { recursive: true })

  console.log(`临时目录：${temp}`)
  console.log(`临时库：  ${process.env.RAVEN_DB_FILE}`)
  console.log('')

  console.log('── 配置 / 沙箱 / 鉴权 ─────────────────────────')
  const { runConfigChecks } = await import('./verify-config')
  await runConfigChecks(checker)

  console.log('')
  console.log('── 文件 / 剪切板 / 脚本运行 ────────────────────')
  const storage = await loadOptional('./verify-storage')
  const storageChecks = storage?.['runStorageChecks']
  if (typeof storageChecks === 'function') {
    await (storageChecks as (c: Checker, o: { temp: string }) => Promise<void>)(checker, { temp })
  } else {
    checker.skip('storage 段', 'scripts/verify-storage.ts 还没有可用的 runStorageChecks 导出')
  }

  console.log('')
  console.log('── 服务注册表 / 健康采集 / Dashboard ───────────')
  const dashboard = await loadOptional('./verify-dashboard')
  const dashboardChecks = dashboard?.['runDashboardChecks']
  if (typeof dashboardChecks === 'function') {
    await (dashboardChecks as (c: Checker, o: { temp: string }) => Promise<void>)(checker, { temp })
  } else {
    checker.skip('dashboard 段', 'scripts/verify-dashboard.ts 还没有可用的 runDashboardChecks 导出')
  }

  console.log('')
  console.log('── Raven Tool Protocol v1（发现 / 调用 / 结果 / 错误 / 取消）')
  const toolProtocol = await loadOptional('./verify-tool-protocol')
  const protocolChecks = toolProtocol?.['runToolProtocolChecks']
  if (typeof protocolChecks === 'function') {
    await (protocolChecks as (c: Checker) => Promise<void>)(checker)
  } else {
    checker.skip('tool protocol 段', 'scripts/verify-tool-protocol.ts 还没有可用的 runToolProtocolChecks 导出')
  }

  console.log('')
  console.log('── 真实工具：FS Tools 与 shell ───────────────────')
  const tools = await loadOptional('./verify-tools')
  const toolChecks = tools?.['runToolChecks']
  if (typeof toolChecks === 'function') {
    await (toolChecks as (c: Checker) => Promise<void>)(checker)
  } else {
    checker.skip('工具段', 'scripts/verify-tools.ts 还没有可用的 runToolChecks 导出')
  }

  console.log('')
  console.log('── 产物一致性 ─────────────────────────────────')
  await checker.check('部署占位配置能被解析，且 rootPath 是数据卷下的专用子目录', async () => {
    const { loadConfigFrom } = await import('@/backstage/lib/config')
    const dockerConfig = loadConfigFrom(path.join(repo, 'config', 'raven.config.docker.json'))
    // ⚠️ 这条断言真正在守的是「镜像里的占位配置必须能过 assertSafeRoot()」。
    // 早先它写的是 `/data` —— 那是**只有一段**的文件系统根路径，会被直接拒，
    // 于是镜像根本起不来，而错误信息指向配置内容，看起来像手误而不是设计约束。
    if (dockerConfig.config.rootPath !== '/data/raven') {
      throw new Error(
        `容器占位配置的 rootPath 应为 /data/raven（不能是只有一段的 /data），实际 ${dockerConfig.config.rootPath}`
      )
    }
    if (dockerConfig.config.rootPath.split('/').filter(Boolean).length < 2) {
      throw new Error('rootPath 只有一段，assertSafeRoot 现在放它过去了 —— 沙箱边界被削弱了。')
    }
  })

  await checker.check('ecosystem / Dockerfile / package.json 的端口是同一个', async () => {
    const ecosystem = fs.readFileSync(path.join(repo, 'ecosystem.config.js'), 'utf8')
    const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8')
    const pkg = fs.readFileSync(path.join(repo, 'package.json'), 'utf8')
    for (const [label, text] of [
      ['ecosystem.config.js', ecosystem],
      ['Dockerfile', dockerfile],
      ['package.json', pkg],
    ] as const) {
      if (!text.includes('5800')) throw new Error(`${label} 里没有端口 5800`)
      if (text.includes('5700')) throw new Error(`${label} 里混进了 shadow-atlas 的端口 5700`)
    }
  })

  await checker.check('proxy.ts 放行的公开路径与文档一致', async () => {
    const proxy = fs.readFileSync(path.join(repo, 'proxy.ts'), 'utf8')
    for (const required of ["'/login'", "'/healthz'", "'/api/auth/login'", "'/api/ingest'"]) {
      if (!proxy.includes(required)) throw new Error(`proxy.ts 缺少公开路径 ${required}`)
    }
  })

  // 清理。临时根下可能有软链，用 recursive。
  try {
    fs.rmSync(temp, { recursive: true, force: true })
  } catch (error) {
    failed.push(`清理临时目录：${(error as Error).message}`)
  }

  console.log('')
  console.log('═══════════════════════════════════════════════')
  console.log(`通过 ${passed.length} 条，失败 ${failed.length} 条，跳过 ${skipped.length} 条`)
  if (skipped.length > 0) {
    console.log('跳过：')
    for (const item of skipped) console.log(`  ~ ${item}`)
  }
  if (failed.length > 0) {
    console.log('失败：')
    for (const item of failed) console.log(`  ✗ ${item}`)
    process.exitCode = 1
  } else {
    console.log('✅ 全部通过')
  }
}

/** 动态加载可选模块：文件不存在或没有导出时返回 null，而不是让总入口崩掉。 */
async function loadOptional(specifier: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(specifier)) as Record<string, unknown>
  } catch (error) {
    // 只吞「模块不存在 / 语法上还没写」这一类；真的执行期异常要漏出来。
    const message = error instanceof Error ? error.message : String(error)
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) return null
    throw error
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
