/**
 * 构建前的前置 —— 只建符号链接，不启动任何东西。
 *
 * ⚠️ **为什么 `dev` / `build` 都要过这一步**（2026-10-07）：
 * postcss 插件按**require 栈所在目录**往上找 node_modules，而 `.next` 是指向
 * /tmp 的符号链接 —— turbopack 的 chunk 跑在那边，于是找不到
 * `@tailwindcss/postcss`。而这段链接逻辑原先只存在于 `dev-local.mjs` 里，
 * `build` 那条路径上从来没被建过。
 *
 * ⚠️⚠️ **加新脚本时的判据：凡是用到 `.next` 的命令都要先跑这个。**
 * 现在接了三条（`dev` / `build` / `dev:local`）。漏接的症状是
 * `Cannot find module '@tailwindcss/postcss'`，而它看起来完全与配置无关 ——
 * 上一次就是这样绕了半天才找到根因。
 *
 * 成因、已试无效的方案、以及「已经走过的四条弯路」见 next-dir.mjs 顶部注释。
 */
import { prepareNextDir } from './next-dir.mjs'

prepareNextDir()
