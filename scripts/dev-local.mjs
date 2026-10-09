/**
 * 本机开发用的 dev server —— 把 Next 的构建目录挪到工作区外。
 *
 * ⚠️ 为什么不写在脚本里而抽成 `next-dir.mjs`（2026-10-07）：
 * 原来这段「建 .next 与 node_modules 符号链接」的逻辑只存在于本脚本里，
 * 而 **`npm run build` 不经过它** —— 于是 `build` 与 `pm2:start` 两条路径上
 * 链接都不存在，症状是 `Cannot find module '@tailwindcss/postcss'`。
 * 那个 bug 的成因与完整说明见 next-dir.mjs 顶部的注释。
 *
 * 用法：npm run dev:local
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { prepareNextDir, root } from './next-dir.mjs'

const workDir = prepareNextDir()


const child = spawn('npx', ['next', 'dev', '-p', process.env.PORT ?? '5800'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

const bye = () => {
  child.kill('SIGTERM')
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
child.on('exit', (code) => process.exit(code ?? 0))
