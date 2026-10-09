/**
 * ⚠️ 别试图用 `distDir` 绕开本机 WorkBuddy 的 rename 拦截（2026-10 在 creative-atlas
 * 上实测无效）：dev server 与 `next build` 都会以
 * `EPERM: operation not permitted, rename .../CURRENT.next -> .../CURRENT` 收场。
 *
 * 唯一有效的路径是让 `.next` 本身成为指向工作区外的符号链接 —— 见
 * `scripts/next-dir.mjs` 的注释。`dev` / `build` / `dev:local` 都以
 * `prepare-next.mjs` 开头就是为了这个，少一条路径就会缺那个链接。
 *
 * 本文件其余部分与 creative-atlas 保持一致：Server Action 的来源白名单
 * （raven 的 Server Action 用得很少，但保持同一套约定）。
 */
/**
 * ⚠️ 在**最前面**加载 `.env`，而且要在这里而不是在代码里调 dotenv：
 * `SESSION_SECRET` 是签发会话的密钥，它必须在任何 route / proxy 被加载之前就位。
 * 放到某个模块顶层去读，就会出现「取决于谁先被 import」的时序问题 ——
 * 那类 bug 表现为「本地能登录、Docker 里不行」。
 *
 * Node 24 也支持 `node --env-file`，但 next 的 CLI 是我们不控制的入口，
 * 所以在 next.config 里兜住这一层最省事（与 creative-atlas 同一做法）。
 */
require('dotenv').config()

const allowedOrigins = (process.env.SERVER_ACTION_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins,
    },
  },
}

module.exports = nextConfig
