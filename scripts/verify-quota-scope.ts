/**
 * 配额口径的隔离验证：**配额统计的是整个 `rootPath`，不只是 `workspace/`**。
 *
 * ──────────────────────────────────────────────────────────────
 * ⚠️ 为什么这是一个**独立进程**的脚本，而不是并入 verify-storage.ts 的一段断言
 *
 * `config/env.ts` 在模块加载期就把 dataDir / db 路径定下来了，`getConfig()` 又按
 * 文件路径缓存（配置路径 + mtime）。所以「在同一个进程里换一个临时 rootPath 再验一次」
 * 是不安全的：先加载的那份配置会把路径钉死在模块状态里，断言可能落在另一个根上，
 * 而失败现象看起来像业务逻辑错了。
 *
 * 这个口径本身是**安全属性**（配额能不能被绕过），值得一个干净的环境来验。
 * 子进程 + 独立临时根是最省事也最可信的做法。
 * `verify-storage.ts` 里另有一组「在本段自己的根上量一遍各子目录之和」的断言，
 * 两组互补：那组证明统计确实覆盖了各子目录，这组证明它真的能拦住写入。
 * ──────────────────────────────────────────────────────────────
 *
 * 用法：node --conditions react-server --import tsx scripts/verify-quota-scope.ts
 * 全部通过 exit 0；任何一条不过打印 `❌ <名称>: <detail>` 并 exit 1。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const passed: string[] = []
const failed: string[] = []

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed.push(name)
    console.log(`  ✓ ${name}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failed.push(`${name}: ${detail}`)
    console.log(`  ✗ ${name}: ${detail}`)
  }
}

function assert(condition: boolean, detail: string): void {
  if (!condition) throw new Error(detail)
}

/** 一个受控大小的假附件流：不真读文件，避免测试依赖磁盘。 */
function streamOf(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(bytes)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function main(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-quota-scope-'))
  const root = path.join(temp, 'root')
  const dataDir = path.join(temp, 'data')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })

  // ⚠️ 环境变量必须在任何 `@/backstage/**` 被动态 import 之前设好。
  process.env.RAVEN_DATA_DIR = dataDir
  process.env.RAVEN_DB_FILE = path.join(dataDir, 'raven.db')
  process.env.SESSION_SECRET = 'quota-scope-secret-0123456789'
  const configFile = path.join(temp, 'raven.config.json')
  process.env.RAVEN_CONFIG = configFile

  // 4 KiB 配额。刻意很小，让「哪些目录被算进去」这件事无法含糊过去。
  const QUOTA = 4 * 1024
  fs.writeFileSync(
    configFile,
    JSON.stringify(
      {
        rootPath: root,
        workspace: { name: 'workspace', quotaBytes: QUOTA, allowScriptExecution: true, scriptsDir: 'scripts' },
        clipboard: { maxItems: 10, maxTextBytes: 1024 },
        auth: {},
        scripts: { execution: { timeoutMs: 5000, maxOutputBytes: 4096, maxConcurrent: 1 }, tempDir: 'tmp' },
        services: { collect: false, defs: [] },
      },
      null,
      2
    ),
    'utf8'
  )

  try {
    const { getConfig } = await import('@/backstage/lib/config')
    const { isSandboxError } = await import('@/backstage/lib/sandbox')
    const fileService = await import('@/backstage/services/file.service')
    const clipboardService = await import('@/backstage/services/clipboard.service')

    const { sandbox } = getConfig()
    await sandbox.ensureRoots()

    await check('初始状态：4 KiB 配额、用量 0、可用 = 配额', async () => {
      const summary = await fileService.stats()
      assert(summary.quotaBytes === QUOTA, `quotaBytes=${String(summary.quotaBytes)}`)
      assert(summary.bytes === 0, `初始 bytes=${summary.bytes}`)
      assert(summary.remainingBytes === QUOTA, `remaining=${String(summary.remainingBytes)}`)
    })

    await check('workspace/ 里的文件计入配额', async () => {
      await fileService.writeTextFile({ path: 'a.txt', text: 'x'.repeat(1000) })
      const summary = await fileService.stats()
      assert(summary.bytes >= 1000, `写入 1000 字节后 bytes=${summary.bytes}`)
      assert(
        summary.remainingBytes === QUOTA - summary.bytes,
        `remaining=${String(summary.remainingBytes)} bytes=${summary.bytes}`
      )
    })

    // 这一条是本次改动的核心：光写 clipboard/（**不经过** file.service 的配额判定）
    // 也必须让 stats 的用量涨上去。旧实现下这里 bytes 会保持不变。
    await check('clipboard/ 里的附件计入配额（旧口径下这里会漏）', async () => {
      const before = await fileService.stats()
      fs.mkdirSync(path.join(root, 'clipboard'), { recursive: true })
      fs.writeFileSync(path.join(root, 'clipboard', 'probe.bin'), Buffer.alloc(2048))
      // 直接落盘的文件绕过了进程内缓存，所以要让统计重新走一遍。
      sandbox.invalidateMeasurement()
      const after = await fileService.stats()
      assert(
        after.bytes === before.bytes + 2048,
        `clipboard 的 2048 字节没有被计入：before=${before.bytes} after=${after.bytes}`
      )
      assert(
        after.remainingBytes === QUOTA - after.bytes,
        `remaining=${String(after.remainingBytes)} bytes=${after.bytes}`
      )
    })

    await check('tmp/ 里的中间产物计入配额', async () => {
      const before = await fileService.stats()
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
      fs.writeFileSync(path.join(root, 'tmp', 'part.bin'), Buffer.alloc(1024))
      sandbox.invalidateMeasurement()
      const after = await fileService.stats()
      assert(after.bytes === before.bytes + 1024, `tmp 的 1024 字节没有被计入：${before.bytes} → ${after.bytes}`)
    })

    await check('scripts/ 里的脚本本体计入配额', async () => {
      const before = await fileService.stats()
      fs.writeFileSync(path.join(root, 'scripts', 'probe.mjs'), '// 占位\n'.repeat(64))
      sandbox.invalidateMeasurement()
      const after = await fileService.stats()
      assert(after.bytes > before.bytes, `scripts 的字节没有被计入：${before.bytes} → ${after.bytes}`)
    })

    await check('配额真的被拦住：上传撞上限 → 507，且不落盘', async () => {
      let code = ''
      try {
        await fileService.upload({ path: 'too-big.bin', stream: streamOf(8192) })
      } catch (error) {
        code = isSandboxError(error) ? error.code : `非沙箱错误：${String(error)}`
      }
      assert(code === 'quota_exceeded', `预期 quota_exceeded，得到 ${code || '(没抛错)'}`)
      assert(!fs.existsSync(path.join(root, 'workspace', 'too-big.bin')), '超限文件不该出现在最终位置')
    })

    await check('附件写入也撞同一条上限：不落附件、也不留孤儿记录', async () => {
      await clipboardService.clear()
      let code = ''
      try {
        await clipboardService.createWithAttachments({
          text: '带附件的一条',
          attachments: [{ name: 'big.bin', stream: streamOf(8192) }],
        })
      } catch (error) {
        code = isSandboxError(error) ? error.code : `非沙箱错误：${String(error)}`
      }
      assert(code === 'quota_exceeded', `预期 quota_exceeded，得到 ${code || '(没抛错)'}`)
      const listing = await clipboardService.list({})
      assert(listing.total === 0, `超限的粘贴不该入库，total=${listing.total}`)
      const dirs = fs.existsSync(path.join(root, 'clipboard')) ? fs.readdirSync(path.join(root, 'clipboard')) : []
      assert(dirs.length === 0, `超限的附件目录没有清干净：${dirs.join(', ')}`)
    })

    await check('附件预留量按实际字节数归还（不会永久吃掉额度）', async () => {
      // 先腾出空间：把之前那 2048 + 1024 的探针文件删掉。
      fs.rmSync(path.join(root, 'clipboard', 'probe.bin'), { force: true })
      fs.rmSync(path.join(root, 'tmp', 'part.bin'), { force: true })
      sandbox.invalidateMeasurement()
      const before = await sandbox.remainingBytes()
      const result = await clipboardService.createWithAttachments({
        text: '小附件',
        attachments: [{ name: 'small.bin', stream: streamOf(16) }],
      })
      assert(result.entry.attachBytes === 16, `attachBytes=${result.entry.attachBytes}`)
      const after = await sandbox.remainingBytes()
      // 预留是「先按剩余额度全占、写完再归还」。归还漏了的话，
      // 这里的差值会是负数（额度被永久吃掉），而不是正好少 16 字节。
      assert(
        after !== null && before !== null && before - after === 16,
        `可用额度应只减少 16 字节：before=${String(before)} after=${String(after)}`
      )
    })

    await check('不限配额时 remainingBytes 为 null，写入不受限', async () => {
      const unlimitedFile = path.join(temp, 'unlimited.config.json')
      fs.writeFileSync(
        unlimitedFile,
        JSON.stringify({
          rootPath: path.join(temp, 'root-unlimited'),
          workspace: { name: 'workspace', quotaBytes: null },
          auth: {},
        }),
        'utf8'
      )
      const { loadConfigFrom } = await import('@/backstage/lib/config')
      const loaded = loadConfigFrom(unlimitedFile)
      assert(loaded.sandbox.quotaBytes === null, `quotaBytes=${String(loaded.sandbox.quotaBytes)}`)
      assert((await loaded.sandbox.remainingBytes()) === null, '不限配额时 remainingBytes 应为 null')
      await loaded.sandbox.assertRoomFor(Number.MAX_SAFE_INTEGER)
    })
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不该让验证结果变色。
    }
  }

  console.log('')
  if (failed.length === 0) {
    console.log(`✅ ${passed.length} passed`)
    return
  }
  console.log(`❌ ${failed.length} failed / ${passed.length} passed`)
  for (const item of failed) console.log(`  ✗ ${item}`)
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
