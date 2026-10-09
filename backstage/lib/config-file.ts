import fs from 'node:fs'
import { configCandidates } from '@/config/env'

/**
 * 「配置文件在哪」这一个问题的答案，只在这个文件里。
 *
 * 抽出来的原因很实际：`backstage/lib/config.ts` 带着 `server-only`，
 * 而建库/建目录这类 CLI 脚本要在纯 Node 下跑（`server-only` 在 CLI 里会直接抛）。
 * 两个入口必须给出**同一个**答案，否则会出现「服务读的是这份、init 写的是那份」
 * 这种最难查的分裂。
 */
export class ConfigFileNotFound extends Error {}

export function findConfigFile(cwd = process.cwd()): string {
  const candidates = configCandidates(cwd)
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  throw new ConfigFileNotFound(
    `没有找到 raven 配置。按这个顺序找过：\n${candidates.map((item) => `  - ${item}`).join('\n')}\n` +
      '把 config/raven.config.example.json 复制成 config/raven.config.local.json 并填好 rootPath 与账号密码。'
  )
}
