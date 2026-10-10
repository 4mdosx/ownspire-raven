/**
 * 配置 / 沙箱 / 鉴权三块的断言。
 *
 * ⚠️ 这个文件**在模块加载期就会读环境变量**（`config/env.ts` 是在 import 时
 * 把 dataDir 与 db 路径定下来的），所以它不能被别人在顶层静态 import 之后再改环境。
 * 规矩：**谁要 import 它，谁先把 RAVEN_* 环境变量设好。**
 * `scripts/verify-raven.ts` 就是这么做的（先设环境，再动态 import）。
 * 单独跑时（`npm run verify:config`）由本文件自己兜底设默认值。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

type Checker = { check: (name: string, fn: () => void | Promise<void>) => Promise<void>; fail: (name: string, detail: string) => void }

export async function runConfigChecks({ check, fail }: Checker): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-cfg-'))
  const repo = repoRoot

  const { loadConfigFrom, publicConfig, stripJsonComments, ConfigError } = await import('@/backstage/lib/config')
  const { PathSandbox, parseRelativePath, isInside } = await import('@/backstage/lib/sandbox')
  const auth = await import('@/backstage/services/auth.service')
  const pin = await import('@/backstage/services/pin.service')

  const readExample = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(repo, 'config', 'raven.config.example.json'), 'utf8'))

  const writeConfig = (patch: Record<string, unknown>): string => {
    const merged = { ...readExample(), ...patch }
    const file = path.join(temp, `config-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8')
    return file
  }

  // ---------------------------------------------------------------- 配置
  await check('配置：示例配置能被解析，且字段落到预期值', () => {
    const { config, sandbox } = loadConfigFrom(path.join(repo, 'config', 'raven.config.example.json'))
    if (config.workspace.name !== 'workspace') throw new Error(`workspace.name=${config.workspace.name}`)
    if (config.workspace.quotaBytes !== 10 * 1024 * 1024 * 1024) throw new Error(`quotaBytes=${config.workspace.quotaBytes}`)
    if (config.clipboard.maxItems !== 200) throw new Error(`maxItems=${config.clipboard.maxItems}`)
    if (config.scripts.execution.timeoutMs !== 120_000) throw new Error('timeoutMs 没生效')
    if (!isInside(sandbox.root, sandbox.filesRoot)) throw new Error('filesRoot 不在 root 里')
    if (sandbox.quotaBytes !== config.workspace.quotaBytes) throw new Error('沙箱没拿到配额')
  })

  await check('配置：publicConfig 不含凭据与宿主路径', () => {
    const view = publicConfig() as unknown as Record<string, unknown>
    const text = JSON.stringify(view)
    if (/change-me/.test(text)) throw new Error('publicConfig 里出现了示例密码')
    // ⚠️ username 也不该在了：PIN 登录没有「账号」这个概念。
    // 留着它会让人以为顶栏显示的名字是某种真实身份。
    for (const banned of ['password', 'passwordHash', 'username', 'registrationToken', 'rootPath']) {
      if (banned in view) throw new Error(`publicConfig 泄漏了 ${banned}`)
    }
  })

  await check('配置：rootPath 为文件系统根时拒绝启动', () => {
    for (const bad of ['/', '/Users', '~']) {
      const file = writeConfig({ rootPath: bad })
      let threw = false
      try {
        loadConfigFrom(file)
      } catch (error) {
        threw = error instanceof ConfigError
      }
      if (!threw) throw new Error(`rootPath=${bad} 没有被拒绝`)
    }
  })

  await check('配置：auth 里的账号密码遗留字段必须报错（不能静默忽略）', () => {
    // ⚠️ 这条是 PIN 迁移的回归锁。zod 的 object() 会剥掉未声明的字段，
    // 所以如果只靠 schema，一份带 auth.password 的旧配置会**静默通过** ——
    // 服务照常起来、PIN 照常要求，而配置里那个密码看起来「还在管用」。
    // 升级的人会以为登不进去是 bug。所以必须显式拒绝。
    const cases: Array<Record<string, unknown>> = [
      { auth: { username: 'admin' } },
      { auth: { username: 'admin', password: 'x' } },
      { auth: { password: 'x', sessionHours: 24 } },
      { auth: { passwordHash: 'scrypt$16384$8$1$abc$def' } },
    ]
    for (const patch of cases) {
      let threw = false
      try {
        loadConfigFrom(writeConfig(patch))
      } catch (error) {
        threw = error instanceof ConfigError
      }
      if (!threw) throw new Error(`没有被拒绝：${JSON.stringify(patch)}`)
    }
  })

  await check('配置：auth 只有策略字段时正常通过', () => {
    // 与上一条成对：合法的 auth 不能被误伤。
    loadConfigFrom(writeConfig({ auth: { sessionHours: 24, loginRateLimit: { windowSeconds: 60, maxFailures: 5 } } }))
    loadConfigFrom(writeConfig({ auth: {} }))
  })

  await check('配置：services 里重复 id 拒绝', () => {
    const file = writeConfig({
      services: { defs: [{ id: 'x', title: 'X' }, { id: 'x', title: 'X2' }] },
    })
    let threw = false
    try {
      loadConfigFrom(file)
    } catch (error) {
      threw = error instanceof ConfigError
    }
    if (!threw) throw new Error('重复服务 id 没有被拒绝')
  })

  await check('配置：目录名必须是三个互不相同的单路径段', () => {
    for (const patch of [
      { workspace: { name: 'a/b' } },
      { workspace: { name: '..' } },
      { workspace: { name: 'same', scriptsDir: 'same' } },
    ]) {
      let threw = false
      try {
        loadConfigFrom(writeConfig(patch))
      } catch (error) {
        threw = error instanceof ConfigError
      }
      if (!threw) throw new Error(`没有被拒绝：${JSON.stringify(patch)}`)
    }
  })

  await check('配置：JSONC（注释 + 尾逗号）能被解析', () => {
    const parsed = JSON.parse(
      stripJsonComments(
        `{
          // 行注释
          "a": 1, /* 块注释 */
          "b": "含 // 与 /* 的字符串",
          "c": [1, 2,],
        }`
      ).replace(/,\s*([}\]])/g, '$1')
    )
    if (parsed.a !== 1 || parsed.b !== '含 // 与 /* 的字符串') throw new Error(JSON.stringify(parsed))
  })

  // ---------------------------------------------------------------- 路径沙箱
  await check('沙箱：越界写法在解析阶段就被拒', () => {
    const bad = ['../x', 'a/../../b', '/etc/passwd', 'C:/Windows', 'a\u0000b', '..']
    for (const input of bad) {
      let threw = false
      try {
        parseRelativePath(input)
      } catch {
        threw = true
      }
      if (!threw) throw new Error(`没有被拒：${JSON.stringify(input)}`)
    }
    if (parseRelativePath('a//b/./c').join('/') !== 'a/b/c') throw new Error('合法路径没有归一化')
  })

  await check('沙箱：软链逃逸被 realpath 判定挡住', async () => {
    const root = path.join(temp, 'root')
    const outside = path.join(temp, 'outside')
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true })
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8')
    fs.symlinkSync(outside, path.join(root, 'workspace', 'link'), 'dir')

    const sandbox = new PathSandbox({
      rootPath: root,
      workspaceName: 'workspace',
      scriptsDir: 'scripts',
      tempDir: 'tmp',
      quotaBytes: 1024,
    })

    // 读：软链本身可以解析，但它指向 root 之外 → 拒。
    let code = ''
    try {
      await sandbox.resolveExisting('workspace/link/secret.txt')
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    if (code !== 'outside_root') throw new Error(`读软链逃逸没有被拒，code=${code}`)

    // 写：目标还不存在，走的必须是 resolveTarget 那条「最长存在祖先」的路径。
    code = ''
    try {
      await sandbox.resolveWrite('workspace/link/new.txt')
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    if (code !== 'outside_root') throw new Error(`写软链逃逸没有被拒，code=${code}`)

    // 合法路径照常通过。
    const ok = await sandbox.resolveWrite('workspace/a/b.txt')
    if (!isInside(root, ok)) throw new Error('合法路径被判成越界')

    // 统计不看软链：既不跟随，也不把外面的体积算进来。
    const measured = await sandbox.measure({ ttlMs: 0 })
    if (measured.bytes !== 0) throw new Error(`统计把软链算进去了：${measured.bytes}`)
  })

  await check('沙箱：脚本名只认单段且只认 .mjs/.js', async () => {
    const root = path.join(temp, 'root2')
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts', 'a.mjs'), '// x\n', 'utf8')
    const sandbox = new PathSandbox({
      rootPath: root,
      workspaceName: 'workspace',
      scriptsDir: 'scripts',
      tempDir: 'tmp',
      quotaBytes: null,
    })
    for (const bad of ['../a.mjs', 'sub/a.mjs', 'a.sh', 'a', 'a.mjs/../b.mjs']) {
      let threw = false
      try {
        await sandbox.resolveScript(bad)
      } catch {
        threw = true
      }
      if (!threw) throw new Error(`脚本名没有被拒：${bad}`)
    }
    const good = await sandbox.resolveScript('a.mjs')
    if (!good.absolute.endsWith('a.mjs')) throw new Error('合法脚本名被拒')
  })

  await check('沙箱：配额判定 + 预留量 + 不限配额', async () => {
    const root = path.join(temp, 'root3')
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true })
    fs.writeFileSync(path.join(root, 'workspace', 'f.bin'), Buffer.alloc(100))
    const sandbox = new PathSandbox({
      rootPath: root,
      workspaceName: 'workspace',
      scriptsDir: 'scripts',
      tempDir: 'tmp',
      quotaBytes: 150,
    })
    await sandbox.assertRoomFor(50) // 100 + 50 == 150，边界上应当允许
    let threw = false
    try {
      await sandbox.assertRoomFor(51)
    } catch (error) {
      threw = (error as { code?: string }).code === 'quota_exceeded'
    }
    if (!threw) throw new Error('超配额没有被拒')

    sandbox.reserve(100)
    threw = false
    try {
      await sandbox.assertRoomFor(1)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('预留量没有计入判定')
    sandbox.release(100)
    await sandbox.assertRoomFor(50)

    const unlimited = new PathSandbox({
      rootPath: root,
      workspaceName: 'workspace',
      scriptsDir: 'scripts',
      tempDir: 'tmp',
      quotaBytes: null,
    })
    await unlimited.assertRoomFor(Number.MAX_SAFE_INTEGER)
    if ((await unlimited.remainingBytes()) !== null) throw new Error('不限配额时 remainingBytes 应为 null')
  })

  // ---------------------------------------------------------------- 鉴权
  await check('鉴权：PIN 散列可验证、错 PIN 不通过、畸形值不抛错', async () => {
    const hash = await pin.hashPin('1234')
    if (!hash.startsWith('scrypt$')) throw new Error(`散列前缀不对：${hash.slice(0, 12)}`)
    if (hash.split('$').length !== 6) throw new Error('散列字段数不是 6')
    if (!(await pin.verifyPinHash('1234', hash))) throw new Error('正确 PIN 没通过')
    if (await pin.verifyPinHash('9999', hash)) throw new Error('错误 PIN 通过了')
    // ⚠️ 畸形散列必须返回 false 而不是抛错：`scrypt$1$2$3$4$5` 恰好也是六个字段，
    // 而 N=1 会让 node 抛 RangeError。抛错会把「PIN 不正确」变成 500，
    // 调用方完全无法从现象反推是哪一步错了。
    for (const bad of ['scrypt$1$2$3$4$5', 'scrypt$16384$8$1$!!$!!', '', 'not-a-hash', 'scrypt$3$8$1$aa$bb']) {
      if (await pin.verifyPinHash('1234', bad)) throw new Error(`畸形散列不该通过：${bad}`)
    }
    // 同一个 PIN 两次散列必须不同（盐生效）。
    if (hash === (await pin.hashPin('1234'))) throw new Error('盐没有生效')
  })

  await check('鉴权：tokenMatches 拒绝空值且比较正确', () => {
    if (!auth.tokenMatches('abc', 'abc')) throw new Error('相同 token 没通过')
    if (auth.tokenMatches('abc', 'abd')) throw new Error('不同 token 通过了')
    if (auth.tokenMatches(null, 'abc')) throw new Error('null 通过了')
    if (auth.tokenMatches('', 'abc')) throw new Error('空串通过了')
    if (auth.tokenMatches('abc', '')) throw new Error('空期望值不该通过')
  })

  await check('鉴权：指数退避 —— 锁定时长递增、24h 封顶、成功后归零', async () => {
    const backoff = await import('@/backstage/lib/backoff')
    auth.resetRateLimits()

    // 1) 时长必须严格递增，且封顶 24 小时。
    let previous = 0
    for (let failures = 1; failures <= 12; failures += 1) {
      const ms = backoff.backoffMs(failures)
      if (ms > backoff.MAX_BACKOFF_MS) throw new Error(`第 ${failures} 次超过 24 小时封顶：${ms}`)
      if (ms <= previous && failures <= 9) {
        throw new Error(`第 ${failures} 次的锁定没有比上一次长：${ms} vs ${previous}`)
      }
      previous = ms
    }
    if (backoff.backoffMs(30) !== backoff.MAX_BACKOFF_MS) throw new Error('第 30 次没有封顶到 24 小时')
    if (backoff.backoffMs(1e9) !== backoff.MAX_BACKOFF_MS) {
      // ⚠️ 这条专门盯「幂运算溢出」：`base * 3^1e9` 是 Infinity，
      // 而 Infinity 经过 Math.min 会变成 maxMs —— 表面上看不出错，
      // 但如果哪天改成先取 min 再算幂，就会得到一个巨大的定时器值。
      throw new Error('极大失败次数没有安全封顶')
    }

    // 2) 真实调用路径：连续失败必须在第 1 次就锁，且剩余时间单调递减。
    const ip = 'test-ip-exponential'
    auth.assertNotRateLimited(ip) // 还没失败过，必须放行
    auth.recordLoginFailure(ip)
    let caught = ''
    try {
      auth.assertNotRateLimited(ip)
    } catch (error) {
      caught = (error as { code?: string }).code ?? ''
    }
    if (caught !== 'rate_limited') throw new Error(`第一次失败就该锁定，得到 ${caught || '(没抛错)'}`)

    // 错误文案必须带「还要等多久」，否则用户不知道什么时候能再试。
    try {
      auth.assertNotRateLimited(ip)
    } catch (error) {
      const message = (error as Error).message
      if (!/\d/.test(message)) throw new Error(`锁定文案里没有剩余时间：${message}`)
    }

    // 3) 成功后归零 —— 这一条最容易被漏，且漏了会「正常用户手滑就被锁死」。
    auth.recordLoginSuccess(ip)
    auth.assertNotRateLimited(ip)
    if (backoff.failureCount(ip) !== 0) throw new Error('成功后失败计数没有归零')

    auth.resetRateLimits()
  })

  await check('鉴权：不同 IP 之间互不影响', async () => {
    auth.resetRateLimits()
    // 一个 IP 被锁不该牵连另一个 —— 否则一个人输错会让所有人进不来。
    for (let index = 0; index < 6; index += 1) auth.recordLoginFailure('ip-a')
    let aBlocked = false
    try {
      auth.assertNotRateLimited('ip-a')
    } catch {
      aBlocked = true
    }
    if (!aBlocked) throw new Error('ip-a 连续失败后没有被锁')
    auth.assertNotRateLimited('ip-b') // 必须放行
    auth.resetRateLimits()
  })

  await check('鉴权：攻击信号 —— 爆发与分布式扫描都能被感知', async () => {
    const backoff = await import('@/backstage/lib/backoff')
    type Signal = import('@/backstage/lib/backoff').AttackSignal
    backoff.resetAll()
    backoff.resetSignals()

    // 1) 单个 IP 在窗口内失败够多次 → burst。
    // ⚠️ 类型要显式标成 `AttackSignal`：`let signal = { reason: 'none' as const }`
    // 会把 reason 窄成字面量 'none'，后面赋别的值就编译不过。
    let burst: Signal = { suspicious: false, reason: 'none', failures: 0, lockedKeys: 0 }
    for (let index = 0; index < 5; index += 1) {
      burst = backoff.recordFailureSignal('attacker-1')
    }
    if (!burst.suspicious || burst.reason !== 'burst') {
      throw new Error(`5 次失败应该触发 burst，得到 ${JSON.stringify(burst)}`)
    }
    // 必须能直接进日志 —— 「感知到有人在重试」靠的就是这行。
    const line = backoff.describeSignal(burst, 'attacker-1')
    if (!line.includes('attacker-1')) throw new Error(`信号文案里没有来源：${line}`)

    // 2) 很多 IP 各错一两次 → distributed。单看任何一个都像手滑。
    backoff.resetAll()
    backoff.resetSignals()
    for (const key of ['scan-1', 'scan-2', 'scan-3', 'scan-4']) {
      backoff.recordFailure(key)
      backoff.recordFailureSignal(key)
    }
    let distributed: Signal = { suspicious: false, reason: 'none', failures: 0, lockedKeys: 0 }
    for (const key of ['scan-5', 'scan-6']) {
      distributed = backoff.recordFailureSignal(key)
    }
    if (!distributed.suspicious || distributed.reason !== 'distributed') {
      throw new Error(`多来源同时被锁应该触发 distributed，得到 ${JSON.stringify(distributed)}`)
    }

    // 3) 正常用户手滑两三次**不该**被判成攻击 —— 误报会让主人收到假警报。
    backoff.resetAll()
    backoff.resetSignals()
    let quiet: Signal = { suspicious: false, reason: 'none', failures: 0, lockedKeys: 0 }
    for (let index = 0; index < 3; index += 1) quiet = backoff.recordFailureSignal('normal-user')
    if (quiet.suspicious) throw new Error('手滑 3 次被误判成攻击了')

    backoff.resetAll()
    backoff.resetSignals()
  })

  await check('鉴权：换 PIN 之后旧会话立即失效（pinEpoch 机制）', async () => {
    // 这是 PIN 改造的核心：pinEpoch 不匹配 = 会话作废。
    // 没有这条断言，「PIN 泄露后改 PIN 就等于把窃取者锁在外面」这句话是空的。
    const previous = process.env.SESSION_SECRET
    process.env.SESSION_SECRET = 'c'.repeat(40)

    // ⚠️ 显式设一个 PIN 作为前置条件。`createSessionToken` 在没设过 PIN 时
    // 会抛 `pin_not_configured`（这是有意的），所以这条用例**不能**假设
    // 「前面某条已经设好了」—— 用例之间不该有隐藏的顺序依赖。
    await pin.savePin('1234')

    const firstToken = await auth.createSessionToken()
    if (!(await auth.verifySessionToken(firstToken))) throw new Error('刚签的令牌没通过')

    // 换 PIN → epoch 变 → 旧令牌必须立刻作废。
    await pin.savePin('5678')
    if (await auth.verifySessionToken(firstToken)) {
      throw new Error('换 PIN 之后旧会话仍然有效 —— pinEpoch 没生效')
    }

    // 换发的新会话必须能用（否则用户改完 PIN 会立刻被弹回登录页）。
    const secondToken = await auth.createSessionToken()
    if (!(await auth.verifySessionToken(secondToken))) throw new Error('换发的新会话没通过')

    // 故意**不**清 PIN：后面的用例需要它。收尾统一清。
    process.env.SESSION_SECRET = previous
  })

  await check('鉴权：没有 PIN 时拒绝签发会话（不是签一个空 epoch 的假会话）', async () => {
    const previous = process.env.SESSION_SECRET
    process.env.SESSION_SECRET = 'd'.repeat(40)
    pin.clearStoredPin()
    let code = ''
    try {
      await auth.createSessionToken()
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    // 恢复，后面的用例要一个已设好的 PIN。
    await pin.savePin('1234')
    process.env.SESSION_SECRET = previous
    // 「看起来已登录」的会话比登不进去危险得多 —— 那会让人以为已经解锁了。
    if (code !== 'pin_not_configured') throw new Error(`预期 pin_not_configured，得到 ${code || '(没抛错)'}`)
  })

  await check('鉴权：会话令牌只能被自己的密钥验证', async () => {
    const previous = process.env.SESSION_SECRET
    process.env.SESSION_SECRET = 'a'.repeat(40)
    // ⚠️ SESSION_SECRET 是**每次调用时读**的，所以换掉它应当立刻让旧令牌失效 ——
    // 这条断言就是在钉住「不是模块加载期缓存密钥」这个实现选择。
    const token = await auth.createSessionToken()
    const okSession = await auth.verifySessionToken(token)
    if (!okSession) throw new Error('自签令牌没通过')
    process.env.SESSION_SECRET = 'b'.repeat(40)
    const badSession = await auth.verifySessionToken(token)
    if (badSession) throw new Error('换密钥后旧令牌仍然有效')
    process.env.SESSION_SECRET = previous
  })

  await check('鉴权：SESSION_SECRET 缺失时明确报错而不是静默放行', async () => {
    const previous = process.env.SESSION_SECRET
    // 前置条件自备：签发令牌需要「已设 PIN」+「有密钥」，缺哪个都验不到目标分支。
    await pin.savePin('1234')
    delete process.env.SESSION_SECRET
    let code = ''
    try {
      await auth.createSessionToken()
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    process.env.SESSION_SECRET = previous
    if (code !== 'no_session_secret') throw new Error(`预期 no_session_secret，得到 ${code || '(没抛错)'}`)
  })

  // 清理：临时根可能含软链，用 rmSync recursive 而不是逐文件。
  try {
    fs.rmSync(temp, { recursive: true, force: true })
  } catch (error) {
    fail('清理', `临时目录没删干净：${(error as Error).message}`)
  }
}

/** 单独跑（npm run verify:config）时的入口。 */
async function standalone(): Promise<void> {
  if (!process.env.RAVEN_CONFIG) {
    process.env.RAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-cfgstandalone-'))
    process.env.RAVEN_DB_FILE = path.join(process.env.RAVEN_DATA_DIR, 'raven.db')
    process.env.RAVEN_CONFIG = path.join(repoRoot, 'config', 'raven.config.example.json')
  }
  let passed = 0
  const failures: string[] = []
  const checker: Checker = {
    async check(name, fn) {
      try {
        await fn()
        passed += 1
        console.log(`  ✓ ${name}`)
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`)
        console.log(`  ✗ ${name}: ${(error as Error).message}`)
      }
    },
    fail(name, detail) {
      failures.push(`${name}: ${detail}`)
      console.log(`  ✗ ${name}: ${detail}`)
    },
  }
  await runConfigChecks(checker)
  console.log(failures.length === 0 ? `\n✅ ${passed} passed` : `\n❌ ${failures.length} failed / ${passed} passed`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

// ⚠️ tsx 以 CJS 输出，**静态路径里不支持 top-level await** —— 所以包一层。
if (process.argv[1] && process.argv[1].endsWith('verify-config.ts')) {
  standalone().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exitCode = 1
  })
}
