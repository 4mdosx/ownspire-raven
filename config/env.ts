import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * ⚠️ `.env` 必须在**这里**加载，而且必须在读 `process.env` 之前。
 *
 * 这层依赖一开始是没有的：dev server 走 `next.config.js`（那里会 `require('dotenv')`），
 * 但 `npm run init` 与 `npm run verify` 是纯 Node 入口 —— 它们不经过 next.config，
 * 于是 `.env` 里的 `RAVEN_DATA_DIR` 读不到，默认值把人写到了 `~/.local/share/` 下，
 * 而那个位置在沙箱里被拒。症状是 `EPERM: mkdir '/Users/<user>/.local/share/...'`，
 * 看起来像权限问题，其实是「环境变量没加载」。
 *
 * 为什么用 `createRequire` 而不是 `import 'dotenv/config'`：
 * dotenv 是运行期依赖，而 `config/env.ts` 同时被 Next 的构建期加载 —— 在那里
 * 顶层 import 一个运行期依赖，会把构建期和运行期的解析路径绑在一起。
 * 包不存在时静默降级（Docker 里根本没有 .env，靠 env_file 注入）。
 */
function loadDotEnv(): void {
  try {
    const require = createRequire(import.meta.url)
    const dotenv = require('dotenv') as { config: (options?: { path?: string }) => unknown }
    dotenv.config({ path: path.resolve(process.cwd(), '.env') })
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true } as never)
  } catch {
    // 没有 dotenv 或没有 .env —— 两种情况都不用管。
  }
}

loadDotEnv()

/**
 * 运行期目录。
 *
 * ⚠️ 与 creative-atlas 的差别：atlas 的数据目录默认落在 `~/.local/share/`，
 * raven 不行 —— raven 的 dataDir 同时是**受管根目录的宿主**，它下面要有
 * `workspace/`、`clipboard/`、`scripts/` 三个子目录，其中 `workspace/` 是
 * 唯一对文件管理器开放的那一棵树。默认放 `~/.local/share/ownspire-raven/`
 * 与 atlas 保持同一习惯。
 */
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'ownspire-raven')

export const dataDir = process.env.RAVEN_DATA_DIR
  ? path.resolve(process.env.RAVEN_DATA_DIR)
  : DEFAULT_DATA_DIR

/**
 * 配置文件的查找顺序（先命中先用）：
 *
 * 1. `RAVEN_CONFIG` 显式指定的绝对/相对路径 —— 容器与 pm2 用这个。
 * 2. `<dataDir>/raven.config.json` —— 部署时挂在数据卷上的那份。
 * 3. `<repo>/config/raven.config.json` + 同名 `.local.json` 覆盖 —— 本机开发。
 *
 * 第 3 项里的 `.local.json` 是给人放**真实密码**的：它在 .gitignore 里，
 * 而 `raven.config.json` 只放占位符。这样「配置里写账号密码」这条要求
 * 不需要用提交密码来换。
 */
export function configCandidates(cwd = process.cwd()): string[] {
  const list: string[] = []
  if (process.env.RAVEN_CONFIG) list.push(path.resolve(process.env.RAVEN_CONFIG))
  list.push(path.join(dataDir, 'raven.config.json'))
  list.push(path.join(cwd, 'config', 'raven.config.json'))
  list.push(path.join(cwd, 'config', 'raven.config.local.json'))
  return list
}

/** 服务注册表的缺省位置；config 里的 `registryFile` 可以覆盖它。 */
export function defaultRegistryFile(): string {
  return path.join(dataDir, 'services.json')
}

/** SQLite 文件。`RAVEN_DB_FILE` 优先，验证脚本靠它指向临时路径。 */
export function resolveDbFile(): string {
  return process.env.RAVEN_DB_FILE
    ? path.resolve(process.env.RAVEN_DB_FILE)
    : path.join(dataDir, 'raven.db')
}

export const RAVEN_VERSION = process.env.RAVEN_VERSION ?? 'dev'

export const isProduction = process.env.NODE_ENV === 'production'
