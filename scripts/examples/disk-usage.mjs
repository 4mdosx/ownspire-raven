#!/usr/bin/env node
/**
 * 示例脚本：把工作目录的用量打印成人话。
 *
 * ⚠️ 这个脚本演示 raven 脚本的**唯一稳定接口就是环境变量**：
 * 它完全不知道真实目录结构，只知道四个路径变量。
 * 本机调试时可以自己先 export 这几个变量，脚本照样跑得起来。
 */
import fs from 'node:fs'
import path from 'node:path'

const workspace = process.env.RAVEN_WORKSPACE
if (!workspace) {
  console.error('缺少 RAVEN_WORKSPACE。这个脚本要在 raven 里运行（或手动导出这些环境变量）。')
  process.exit(2)
}

const root = process.env.RAVEN_ROOT ?? path.dirname(workspace)

function walk(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      // ⚠️ 不跟随软链：跟随会让一个指向上层的链接把统计变成无限递归，
      // 而且会把工作目录之外的体积算进来 —— 那个数字就没有意义了。
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        files += 1
        try {
          bytes += fs.statSync(child).size
        } catch {
          // 统计期间被删掉了，跳过。
        }
      }
    }
  }
  return { bytes, files }
}

const { bytes, files } = walk(workspace)
const quota = Number(process.env.RAVEN_QUOTA_BYTES ?? '0') || null

console.log(`工作目录：${workspace}`)
console.log(`受管根：  ${root}`)
console.log(`文件数：  ${files}`)
console.log(`占用：    ${(bytes / 1024 / 1024).toFixed(2)} MiB`)
if (quota) console.log(`配额：    ${(quota / 1024 / 1024).toFixed(2)} MiB（已用 ${((bytes / quota) * 100).toFixed(1)}%）`)
console.log(`临时目录：${process.env.RAVEN_TMPDIR ?? '(未注入)'}`)

// 顺手写一个文件进临时目录，演示「脚本的中间产物不该污染工作目录」。
const tmp = process.env.RAVEN_TMPDIR
if (tmp) {
  fs.mkdirSync(tmp, { recursive: true })
  const file = path.join(tmp, 'last-report.txt')
  fs.writeFileSync(file, `files=${files}\nbytes=${bytes}\n`, 'utf8')
  console.log(`已把这次统计写到临时文件：${path.basename(file)}（运行结束会被删掉）`)
}
