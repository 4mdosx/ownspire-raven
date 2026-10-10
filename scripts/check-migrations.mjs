#!/usr/bin/env node
/**
 * 迁移门禁：schema.ts 改了但没 generate，就让 CI / 本机红掉。
 *
 * ⚠️ 不能直接信 `drizzle-kit check`。实测（rc.4）在「schema 改了、迁移没生成」
 * 这种最该拦的情况下它照样输出 `Everything's fine` 并以 0 退出 —— 它比对的是
 * 迁移文件之间的一致性，不是「schema 与最新 snapshot 是否一致」。
 *
 * 所以真正的门禁是：**跑一次 generate，看 `drizzle/` 有没有变脏**。
 * generate 是纯静态的（只读 schema.ts 与上一份 snapshot，不连库），
 * 于是这个检查可以随便跑，也不会动到真实数据。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'drizzle')

function snapshot(dir) {
  const map = new Map()
  const walk = (current, prefix = '') => {
    for (const name of readdirSync(current)) {
      const abs = path.join(current, name)
      if (statSync(abs).isDirectory()) {
        walk(abs, `${prefix}${name}/`)
        continue
      }
      map.set(`${prefix}${name}`, statSync(abs).size)
    }
  }
  walk(dir)
  return map
}

const before = exists(outDir) ? snapshot(outDir) : new Map()

function exists(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

const kit = path.join(root, 'node_modules', '.bin', 'drizzle-kit')
execFileSync(kit, ['generate'], { cwd: root, stdio: 'pipe' })

const after = snapshot(outDir)
const changed = [...after.keys()].filter((key) => !before.has(key) || before.get(key) !== after.get(key))
const removed = [...before.keys()].filter((key) => !after.has(key))

// generate 已经把新迁移写进去了，门禁不该留下副作用 —— 把新增的撤掉。
for (const key of changed) {
  if (!before.has(key)) rmSync(path.join(outDir, key), { recursive: true, force: true })
}

if (changed.length > 0 || removed.length > 0) {
  console.error('\n[db:check] schema.ts 与 drizzle/ 不一致 —— 你改了结构却没生成迁移。')
  console.error('  跑：npm run db:generate')
  if (changed.length > 0) console.error(`  generate 新增/变更了：${changed.join(', ')}`)
  if (removed.length > 0) console.error(`  迁移文件被删了：${removed.join(', ')}`)
  process.exit(1)
}

console.log(`[db:check] drizzle/ 与 schema.ts 一致（${after.size} 个文件）。`)
