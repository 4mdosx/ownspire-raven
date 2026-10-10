/**
 * 建目录 + 建表 + 播种默认服务注册表。**幂等**，反复跑没副作用。
 *
 * ⚠️ 为什么要有这个脚本，而不是「首次请求时顺手建」：
 * 文件管理器的语义是「这棵树是用户的东西」，而一个**首次访问时才创建**的目录
 * 会让人分不清「空目录」和「还没建」。建目录是显式的部署步骤，
 * 这样上传之前的 `ENOENT` 永远不会出现。
 *
 * 用法：npm run init
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfigFrom } from '../backstage/lib/config'
import { ensureSchema, sqlite } from '../backstage/db/database'
import { findConfigFile } from '../backstage/lib/config-file'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function main(): Promise<void> {
  const file = findConfigFile(root)
  const { config, sandbox } = loadConfigFrom(file)
  console.log(`配置：${file}`)
  console.log(`受管根：${config.rootPath}`)

  await sandbox.ensureRoots()
  console.log(`已确保目录存在：`)
  for (const [label, dir] of Object.entries(sandbox.stats)) {
    console.log(`  ${label.padEnd(14)} ${dir}`)
  }

  await ensureSchema()
  console.log(`数据库：${path.join(config.dataDir, 'raven.db')}`)

  const registryFile = config.services.registryFile
    ? path.resolve(config.rootPath, config.services.registryFile)
    : path.join(config.dataDir, 'services.json')
  fs.mkdirSync(path.dirname(registryFile), { recursive: true })
  if (!fs.existsSync(registryFile)) {
    const example = path.join(root, 'config', 'services.example.json')
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, registryFile)
      console.log(`已播种服务注册表：${registryFile}`)
      console.log('  ⚠️ 里面的端口与路径是本机约定的示例，请按实际部署改。')
    }
  } else {
    console.log(`服务注册表已存在，未改动：${registryFile}`)
  }

  // 脚本目录里没有任何脚本时，从 examples 拷一份能跑起来的示例 ——
  // 一个空目录配上「可以跑脚本」的按钮，第一次用会不知道放什么。
  if (config.workspace.allowScriptExecution) {
    const exampleDir = path.join(root, 'scripts', 'examples')
    const existing = fs.existsSync(sandbox.scriptsRoot) ? fs.readdirSync(sandbox.scriptsRoot) : []
    if (existing.length === 0 && fs.existsSync(exampleDir)) {
      for (const name of fs.readdirSync(exampleDir)) {
        if (!name.endsWith('.mjs')) continue
        fs.copyFileSync(path.join(exampleDir, name), path.join(sandbox.scriptsRoot, name))
      }
      console.log(`已把示例脚本拷进 ${sandbox.scriptsRoot}`)
    }
  }

  const tables = sqlite()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>
  console.log(`表：${tables.map((row) => row.name).join(', ')}`)
  console.log('完成。')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
