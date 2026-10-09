#!/usr/bin/env node
/**
 * 示例脚本：健康探针 / 治理动作两用的**文件与容器日志检查**。
 *
 * 用法（从 raven 的脚本参数里传）：
 *   node tail-log.mjs <容器名> [行数]      → 打日志尾部
 *   node tail-log.mjs --check <容器名>     → 只判活，exit 0/1（给 health 探针用）
 *
 * ⚠️ 刻意只用 `docker logs`，不去解析 JSON 结构：探针脚本的价值在于
 * 「出问题时能一眼看出为什么」，而不是给一个漂亮的数字。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const args = process.argv.slice(2)
const checkOnly = args[0] === '--check'
const container = (checkOnly ? args[1] : args[0]) ?? ''
const lines = String(Number(args[checkOnly ? 2 : 1] ?? 80) || 80)

if (!container) {
  console.error('用法：node tail-log.mjs [--check] <容器名> [行数]')
  process.exit(2)
}

try {
  if (checkOnly) {
    // 探针模式：容器在跑就算 ok，并把它的状态写到 stdout 的 JSON 行里。
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Status}}', container], { timeout: 10_000 })
    const status = stdout.trim()
    const running = status === 'running'
    console.log(JSON.stringify({ status: running ? 'ok' : 'down', message: `${container} 状态 ${status}` }))
    process.exit(running ? 0 : 1)
  }
  const { stdout, stderr } = await run('docker', ['logs', '--tail', lines, container], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  // ⚠️ docker logs 把应用日志写在 stderr 里是常态，两个都要打出来，
  // 否则「没有日志」和「日志全在另一路」看起来一模一样。
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (checkOnly) {
    console.log(JSON.stringify({ status: 'down', message }))
    process.exit(1)
  }
  console.error(`读取 ${container} 日志失败：${message}`)
  process.exit(1)
}
