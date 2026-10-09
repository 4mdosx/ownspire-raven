/**
 * 生成 `auth.passwordHash`。
 *
 * 用法：
 *   node scripts/hash-password.mjs '你的密码'
 * 或交互式（不回显）：
 *   node scripts/hash-password.mjs
 *
 * ⚠️ 为什么不复用 backstage/services/auth.service.ts：那个文件有 `server-only`，
 * 在 Node CLI 里 import 会直接抛错。散列格式必须两边一致
 * （`scrypt$N$r$p$salt$hash`，盐与散列都是 base64url），
 * 所以这里**故意重复**了参数常量 —— 改一处必须改另一处，
 * 验证脚本里有一条断言专门盯这个一致性。
 */
import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 32

async function readPassword() {
  const fromArgv = process.argv[2]
  if (fromArgv) return fromArgv
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
    if (value === '') throw new Error('没有从标准输入读到密码。')
    return value
  }
  // readline 不回显密码需要关掉 echo，而跨平台做法不一致；这里明确提示
  // 「密码会显示在终端上」，比假装安全更好 —— 单机生成散列时泄漏面是终端历史。
  console.log('提示：交互输入会显示在终端上。要避免的话用参数形式并注意 shell 历史。')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const value = (await rl.question('密码: ')).trim()
    if (value === '') throw new Error('密码不能为空。')
    return value
  } finally {
    rl.close()
  }
}

async function main() {
  const password = await readPassword()
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P })
  const hash = ['scrypt', N, R, P, salt.toString('base64url'), derived.toString('base64url')].join('$')
  console.log('')
  console.log('把下面这一行填进配置的 auth.passwordHash（同时删掉 auth.password）：')
  console.log('')
  console.log(hash)
  console.log('')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
