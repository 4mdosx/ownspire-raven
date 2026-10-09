#!/usr/bin/env node
/**
 * 示例脚本：指标采集。
 *
 * 用法：node db-size.mjs <数据目录>
 *
 * stdout 必须是**一行 JSON**，raven 按 docs/03-service-registry.md 的约定解析：
 *   { "metrics": [ { "name": "...", "value": 123, "unit": "B" } ], "message": "可选" }
 *
 * ⚠️ 数字一律用**字节**或**计数**，不要自己换算成 MiB —— 单位是展示层的事，
 * 换算过的数字在报警阈值里就没法用了（阈值要跟着单位一起改）。
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('用法：node db-size.mjs <数据目录>')
  process.exit(2)
}

function sizeOfFile(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function sizeOfTree(target) {
  let total = 0
  let files = 0
  const stack = [target]
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
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        files += 1
        total += sizeOfFile(child)
      }
    }
  }
  return { total, files }
}

if (!fs.existsSync(dir)) {
  console.log(JSON.stringify({ metrics: [], message: `数据目录不存在：${dir}` }))
  process.exit(0)
}

const metrics = []
const db = path.join(dir, 'local.db')
if (fs.existsSync(db)) metrics.push({ name: 'db_bytes', value: sizeOfFile(db), unit: 'B' })
// WAL 不一起看会低估正在写入时的真实占用 —— 它可能是 db 的好几倍。
for (const suffix of ['-wal', '-shm']) {
  const side = `${db}${suffix}`
  if (fs.existsSync(side)) metrics.push({ name: `db${suffix.replace('-', '_')}_bytes`, value: sizeOfFile(side), unit: 'B' })
}

const media = path.join(dir, 'media')
if (fs.existsSync(media)) {
  const { total, files } = sizeOfTree(media)
  metrics.push({ name: 'media_bytes', value: total, unit: 'B' })
  metrics.push({ name: 'media_files', value: files, unit: '' })
}

console.log(JSON.stringify({ metrics, message: dir }))
