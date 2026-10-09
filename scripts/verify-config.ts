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
    if (config.auth.passwordHash !== undefined) throw new Error('示例不该带 passwordHash')
    if (!isInside(sandbox.root, sandbox.filesRoot)) throw new Error('filesRoot 不在 root 里')
    if (sandbox.quotaBytes !== config.workspace.quotaBytes) throw new Error('沙箱没拿到配额')
  })

  await check('配置：publicConfig 不含密码与散列', () => {
    const view = publicConfig() as unknown as Record<string, unknown>
    const text = JSON.stringify(view)
    if (/change-me/.test(text)) throw new Error('publicConfig 里出现了示例密码')
    for (const banned of ['password', 'passwordHash', 'registrationToken', 'rootPath']) {
      if (banned in view) throw new Error(`publicConfig 泄漏了 ${banned}`)
    }
    if (typeof view['username'] !== 'string') throw new Error('publicConfig 缺 username')
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

  await check('配置：auth 缺密码 / 空 passwordHash 前缀错误都拒绝', () => {
    const cases: Array<Record<string, unknown>> = [
      { auth: { username: 'admin' } },
      { auth: { username: 'admin', passwordHash: 'deadbeef' } },
      { auth: { username: '', password: 'x' } },
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
  await check('鉴权：scrypt 散列可验证、错密码不通过、格式是六个字段', async () => {
    const hash = await auth.hashPassword('correct horse battery staple')
    if (!hash.startsWith('scrypt$')) throw new Error(`散列前缀不对：${hash.slice(0, 12)}`)
    if (hash.split('$').length !== 6) throw new Error('散列字段数不是 6')
    if (!(await auth.verifyPasswordHash('correct horse battery staple', hash))) throw new Error('正确密码没通过')
    if (await auth.verifyPasswordHash('wrong', hash)) throw new Error('错误密码通过了')
    if (await auth.verifyPasswordHash('x', 'scrypt$1$2$3$4$5')) throw new Error('畸形散列应返回 false')
    // 同一个密码两次散列必须不同（盐生效）。
    if (hash === (await auth.hashPassword('correct horse battery staple'))) throw new Error('盐没有生效')
  })

  await check('鉴权：hash-password.mjs 生成的散列能被服务端验证（格式必须两边一致）', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('node', [path.join(repo, 'scripts', 'hash-password.mjs'), 'cli-password'], {
      timeout: 30_000,
    })
    const line = stdout
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.startsWith('scrypt$'))
    if (!line) throw new Error(`CLI 没输出散列：${stdout}`)
    if (!(await auth.verifyPasswordHash('cli-password', line))) throw new Error('CLI 生成的散列验证失败')
    if (await auth.verifyPasswordHash('other', line)) throw new Error('CLI 散列对错误密码也通过了')
  })

  await check('鉴权：tokenMatches 拒绝空值且比较正确', () => {
    if (!auth.tokenMatches('abc', 'abc')) throw new Error('相同 token 没通过')
    if (auth.tokenMatches('abc', 'abd')) throw new Error('不同 token 通过了')
    if (auth.tokenMatches(null, 'abc')) throw new Error('null 通过了')
    if (auth.tokenMatches('', 'abc')) throw new Error('空串通过了')
    if (auth.tokenMatches('abc', '')) throw new Error('空期望值不该通过')
  })

  await check('鉴权：限流在连续失败后封锁，成功后清空', async () => {
    auth.resetRateLimits()
    const ip = 'test-ip-1'
    let blocked = false
    for (let index = 0; index < 12; index += 1) {
      try {
        auth.assertNotRateLimited(ip)
      } catch (error) {
        blocked = (error as { code?: string }).code === 'rate_limited'
        break
      }
      auth.recordLoginFailure(ip)
    }
    if (!blocked) throw new Error('连续失败没有触发限流')
    auth.recordLoginSuccess(ip)
    auth.assertNotRateLimited(ip) // 清空之后必须放行
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
