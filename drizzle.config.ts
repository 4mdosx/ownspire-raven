import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit 配置。
 *
 * ⚠️ **两个包都锁精确版本**（package.json 里 `drizzle-orm` / `drizzle-kit` 都没有 `^`）。
 * 这是 rc 版本：drizzle-orm `1.0.0-rc.4` 才有 `node-sqlite` 驱动（`node:sqlite`），
 * 稳定版 0.45.x 只有 better-sqlite3 之类的第三方引擎。而 `^` 在 rc 上尤其危险 ——
 * `^1.0.0-rc.4` 的语义是「>=1.0.0-rc.4 <2.0.0」，会把同样带 rc 标签的后续预发布
 * 版本（rc.5、rc.6…）一路放进可接受范围，每次 `npm install` 装到的都可能不同。
 *
 * ⚠️ **generate 只需要 schema，不需要连库** —— 它做的是「schema.ts 与上一份
 * snapshot 的差异」，纯静态。dbCredentials 只是给 `studio` / `push` 之类真要连库
 * 的命令留个取路径的地方。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './backstage/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.RAVEN_DB_FILE ?? 'raven.db' },
})
