import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, ensureSudo, run } from '../../lib/exec.mjs'
import {
  applyOnRouter,
  assertRouterReady,
  bindFileFor,
  releaseStale,
  rememberEndpoint,
  routerFile,
  writeBind,
} from '../../lib/publish.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const composeFile = join(here, 'compose.yaml')
const envExample = join(here, 'env.example')
const backupScriptUrl = new URL('./backup-in-container.mjs', import.meta.url)

const dataDir = '/srv/ownspire/data/raven'
const backupDir = '/srv/ownspire/backups/raven'
const envFile = '/srv/ownspire/compose/raven.env'
const tagFile = '/srv/ownspire/compose/raven.tag'
const historyFile = '/srv/ownspire/compose/raven.history'
const healthUrl = 'http://127.0.0.1:5801/healthz'
const ravenService = 'svc:raven'
const bindFile = bindFileFor(ravenService)
const tagPattern = /^[0-9a-f]{7}$/i
/** 备份三件套必须同名同时间戳，恢复时靠前缀配对。 */
const backupBaseName = /\/raven-(\d{8}T\d{6}Z)$/

function normalizeTag(value) {
  const tag = String(value ?? '').trim().toLowerCase()
  return tagPattern.test(tag) ? tag : null
}

function normalizeDeployTag(value) {
  const tag = String(value ?? '').trim().toLowerCase()
  if (tag === 'main') return 'main'
  return normalizeTag(tag)
}

function utcStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z'
}

async function isFile(target) {
  const { code } = await capture('sudo', ['test', '-f', target])
  return code === 0
}

async function containerExists(name) {
  const result = await capture('sudo', ['docker', 'inspect', name])
  if (result.code === 0) return true
  if (/no such (object|container)/i.test(result.stderr)) return false
  throw new Error(result.stderr.trim() || `docker inspect ${name} 失败`)
}

async function compose(tag, ...args) {
  const files = (await isFile(bindFile)) ? ['-f', bindFile] : []
  return run('sudo', ['--preserve-env=RAVEN_TAG', 'docker', 'compose', '-f', composeFile, ...files, ...args], {
    env: { RAVEN_TAG: tag },
  })
}

async function publishEndpoint(imageTag) {
  const plan = await releaseStale()
  if (!plan) {
    console.log(`没有 ${routerFile}。本机服务已可在 127.0.0.1:5801 访问，尚未写到路由器。`)
    console.log('把 router.example.json 复制为 /srv/ownspire/router.json 后执行：node ownspire.mjs raven publish')
    return null
  }
  const released = plan.release.some((entry) => entry.service === ravenService)
  if (released && imageTag) await compose(imageTag, 'up', '-d')
  for (const entry of plan.apply) await writeBind(entry)
  if (plan.apply.some((entry) => entry.service === ravenService) && imageTag) await compose(imageTag, 'up', '-d')
  let record = { host: plan.router.host, user: plan.router.user, entries: plan.kept }
  for (const entry of plan.apply) {
    console.log(`正在把 ${entry.service} 写到路由器 ${plan.router.host}。`)
    const applied = await applyOnRouter(plan.router, entry)
    record = await rememberEndpoint(record, applied)
  }
  if (plan.apply.length === 0) {
    if (plan.release.length === 0) console.log('router.json 和已记录的映射一致。')
    else console.log('已解除不再使用的映射。')
  }
  return record
}

async function askDeployTag(prompt) {
  for (;;) {
    const typed = (await prompt.ask('回车按当前情况部署，或输入 7 位 commit（q 取消）: ')).trim()
    if (!typed) return 'auto'
    if (typed.toLowerCase() === 'q') return null
    const tag = normalizeDeployTag(typed)
    if (tag) return tag
    console.log('留空会自动选择。固定版本需要正好 7 位十六进制，例如 a1b2c3d。')
  }
}

function chooseDeploy({ requested, previous, running }) {
  if (requested !== 'auto' && requested !== 'main') return { mode: 'pin', imageTag: requested }
  if (requested !== 'main' && !running && previous) return { mode: 'reinstall', imageTag: previous }
  if (previous) return { mode: 'update', imageTag: 'main' }
  return { mode: 'first', imageTag: 'main' }
}

function explainDeploy({ mode, imageTag, previous }) {
  if (mode === 'pin' && previous && previous !== imageTag) return `当前记录是 ${previous}，将改为 ${imageTag}。`
  if (mode === 'pin') return `将部署指定版本 ${imageTag}。`
  if (mode === 'reinstall') return `服务没在跑。找到部署记录 ${imageTag}，按该版本重装。`
  if (mode === 'update') return `当前是 ${previous}，将从该版本更新，拉取 main 上的最新镜像。`
  return '没有部署记录，初次部署，拉取 main。'
}

async function waitForVersion() {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl)
      const body = await response.json()
      const version = normalizeTag(body?.version)
      if (response.ok && body?.ok === true && version) return version
    } catch {
      // 容器还在起，/healthz 可能还不是 JSON。
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return null
}

async function readTagFile() {
  const result = await capture('sudo', ['cat', tagFile])
  if (result.code !== 0) return ''
  return result.stdout.trim()
}

function commitFromHistory(text) {
  const lines = text.trim().split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const commit = normalizeTag(lines[index].trim().split(/\s+/)[1])
    if (commit) return commit
  }
  return null
}

async function readStoredCommit() {
  const fromTag = normalizeTag(await readTagFile())
  if (fromTag) return fromTag
  const history = await capture('sudo', ['cat', historyFile])
  if (history.code !== 0) return null
  return commitFromHistory(history.stdout)
}

async function recordCommit(commit, action) {
  await run('sudo', ['mkdir', '-p', '/srv/ownspire/compose'])
  await run('sudo', ['tee', tagFile], { input: `${commit}\n`, quiet: true })
  await run('sudo', ['tee', '-a', historyFile], { input: `${utcStamp()} ${commit} ${action}\n`, quiet: true })
}

async function serviceIsRunning() {
  const name = process.env.RAVEN_CONTAINER || 'ownspire-raven-1'
  const result = await capture('sudo', ['docker', 'inspect', '-f', '{{.State.Running}}', name])
  if (result.code !== 0) {
    if (/no such (object|container)/i.test(result.stderr)) return false
    throw new Error(result.stderr.trim() || `无法确认 ${name} 是否在运行`)
  }
  return result.stdout.trim() === 'true'
}

async function readBackupCommit(file) {
  const result = await capture('sudo', ['cat', `${file}.commit`])
  if (result.code !== 0) return null
  return normalizeTag(result.stdout)
}

/**
 * 备份快照 —— db 与文件包**一起**做，配置单独一份。
 *
 * ⚠️ 为什么 db 用 VACUUM INTO 而文件包用 tar：
 * 前者要的是「事务一致的一个文件」，后者要的是「几千个文件的打包」，
 * 两件事的最佳工具不同。硬用 tar 备 db 会拿到可能不一致的库；
 * 硬用逐文件 cp 备 workspace 会得到没有可读性的输出。
 */
async function snapshot(container, paths) {
  const script = await readFile(backupScriptUrl, 'utf8')
  const env = [
    '-e', `BACKUP_DB_PATH=${paths.remoteDb}`,
    '-e', `BACKUP_FILES_PATH=${paths.remoteFiles}`,
    '-e', `BACKUP_CONFIG_PATH=${paths.remoteConfig}`,
    '-e', 'BACKUP_ROOT=/data',
  ]
  try {
    await run('sudo', ['docker', 'exec', '-i', ...env, container, 'node', '--input-type=module', '-'], {
      input: script,
    })
    await run('sudo', ['docker', 'cp', `${container}:${paths.remoteDb}`, paths.dbHost])
    await run('sudo', ['docker', 'cp', `${container}:${paths.remoteFiles}`, paths.filesHost])
    if (paths.hasConfig) {
      await run('sudo', ['docker', 'cp', `${container}:${paths.remoteConfig}`, paths.configHost])
    }
  } finally {
    await run(
      'sudo',
      ['docker', 'exec', container, 'rm', '-f', paths.remoteDb, paths.remoteFiles, paths.remoteConfig],
      { allowFail: true }
    )
  }
}

async function ensureEnvFile() {
  if (!(await isFile(envFile))) {
    throw new Error(`没有 ${envFile}。把 ${envExample} 复制过去，填上 SESSION_SECRET，再部署。`)
  }
  const content = await capture('sudo', ['cat', envFile])
  if (content.code === 0 && !/^SESSION_SECRET=\S/m.test(content.stdout)) {
    throw new Error(`${envFile} 里 SESSION_SECRET 是空的。raven 会拒绝启动（这是刻意的，不是 bug）。`)
  }
  await run('sudo', ['chmod', '600', envFile])
}

async function ensureConfigFile() {
  const configPath = join(dataDir, 'raven.config.json')
  if (!(await isFile(configPath))) {
    throw new Error(
      `没有 ${configPath}。在数据卷里放一份 raven 配置（放在 /srv/ownspire/data/raven/raven.config.json，` +
        'rootPath 必须是 /data/raven，auth 要有账号密码，' +
        '建议用 npm run hash-password 生成 passwordHash），再部署。'
    )
  }
  // ⚠️ 配置里是密码，权限必须收紧；容器以 uid 1000 跑，所以属主也要对。
  await run('sudo', ['chmod', '600', configPath])
  await run('sudo', ['chown', '1000:1000', configPath])
}

function rejectExtraArgs(ctx, command) {
  if (ctx.args.length > 0) throw new Error(`${command} 不接受参数。`)
}

export async function deploy(ctx) {
  if (ctx.args.length > 1) throw new Error('deploy 只接受一个可选的 7 位 commit。')
  let requested = 'auto'
  if (ctx.args[0]) {
    requested = normalizeDeployTag(ctx.args[0])
    if (!requested) throw new Error(`"${ctx.args[0]}" 不是 main，也不是 7 位 commit。`)
  } else if (ctx.prompt) {
    requested = await askDeployTag(ctx.prompt)
    if (!requested) return null
  }

  await ensureSudo()
  await assertRouterReady()
  const previous = await readStoredCommit()
  const running = await serviceIsRunning()
  const choice = chooseDeploy({ requested, previous, running })
  console.log(explainDeploy({ ...choice, previous }))

  await run('sudo', ['mkdir', '-p', '/srv/ownspire/compose', dataDir, backupDir, '/srv/ownspire/logs/raven'])
  // ⚠️ 部署前把数据卷的属主拉正：容器以 1000:1000 跑，
  // 而 `docker cp` / `sudo tar` 这些操作会留下 root 属主的文件，
  // 之后写上传就会 EACCES —— 症状是「昨天还好好的，今天不能上传了」。
  await run('sudo', ['chown', '-R', '1000:1000', dataDir])
  await ensureEnvFile()
  await ensureConfigFile()

  console.log(`拉取并启动 ghcr.io/4mdosx/ownspire-raven:${choice.imageTag}`)
  await compose(choice.imageTag, 'pull')
  await compose(choice.imageTag, 'up', '-d')

  if (choice.imageTag === 'main') {
    console.log('正在等 /healthz 报出这次 main 对应的版本。')
    const resolved = await waitForVersion()
    if (!resolved) {
      console.log(`raven 已按 main 启动，监听 127.0.0.1:5801。/healthz 还没有返回版本，没有改动 ${tagFile}。`)
    } else {
      await recordCommit(resolved, choice.mode)
      if (choice.mode === 'update' && previous && previous !== resolved) {
        console.log(`已从 ${previous} 更新到 ${resolved}。监听 127.0.0.1:5801。`)
      } else if (choice.mode === 'update') {
        console.log(`拉取完成，当前仍是 ${resolved}。监听 127.0.0.1:5801。`)
      } else {
        console.log(`初次部署完成，当前是 ${resolved}。监听 127.0.0.1:5801。`)
      }
    }
  } else {
    await recordCommit(choice.imageTag, choice.mode)
    if (choice.mode === 'reinstall') console.log(`已按记录 ${choice.imageTag} 重装。监听 127.0.0.1:5801。`)
    else if (previous && previous !== choice.imageTag) console.log(`已从 ${previous} 换成 ${choice.imageTag}。监听 127.0.0.1:5801。`)
    else console.log(`raven 已用 ${choice.imageTag} 启动，监听 127.0.0.1:5801。`)
  }
  await publishEndpoint(choice.imageTag)
}

export async function publish(ctx) {
  rejectExtraArgs(ctx, 'publish')
  await ensureSudo()
  const tag = await readStoredCommit()
  if (!tag) throw new Error('还没有部署记录。先执行 node ownspire.mjs raven deploy。')
  await publishEndpoint(tag)
}

export async function health(ctx) {
  rejectExtraArgs(ctx, 'health')
  let response
  try {
    response = await fetch(healthUrl)
  } catch (error) {
    throw new Error(`连不上 ${healthUrl}：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  process.stdout.write(text.endsWith('\n') || text.length === 0 ? text : `${text}\n`)
  if (!response.ok) throw new Error(`${healthUrl} 返回 ${response.status}`)
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  if (!body || body.ok !== true) throw new Error(`${healthUrl} 没有返回 "ok": true`)
  // 受管根不在，文件管理器与脚本全都没法用 —— 早说，别等到用户点了上传才发现。
  if (body.root === false) console.warn('注意：容器里的受管根不存在。检查数据卷挂载与权限（uid 1000）。')
}

async function listBackups() {
  const directory = await capture('sudo', ['test', '-d', backupDir])
  if (directory.code !== 0) return []
  const found = await capture('sudo', ['find', backupDir, '-maxdepth', '1', '-type', 'f', '-name', 'raven-*.db'])
  if (found.code !== 0) throw new Error(found.stderr.trim() || `无法列出 ${backupDir}`)
  return found.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => backupBaseName.test(line))
    .sort()
    .reverse()
}

async function askBackup(prompt) {
  const backups = await listBackups()
  if (backups.length === 0) {
    const typed = (await prompt.ask(`备份路径（${backupDir} 里还没有备份，空行取消）: `)).trim()
    return typed || null
  }
  console.log('选择一份备份')
  const shown = backups.slice(0, 15)
  for (let index = 0; index < shown.length; index += 1) {
    const base = shown[index].replace(/\.db$/, '')
    const commit = await readBackupCommit(shown[index])
    const files = (await isFile(`${base}.tar.gz`)) ? '' : '（无文件包）'
    const config = (await isFile(`${base}.config.json`)) ? '' : '（无配置副本）'
    const mark = commit ? `  ${commit}` : '  （没有 commit 标记）'
    console.log(`  ${index + 1}) ${shown[index]}${mark}${files}${config}`)
  }
  if (backups.length > shown.length) console.log(`  还有 ${backups.length - shown.length} 份更早的备份，选 p 输入路径。`)
  console.log('  p) 输入其他路径')
  for (;;) {
    const choice = (await prompt.ask('> ')).trim().toLowerCase()
    if (!choice) return null
    if (choice === 'p') {
      const typed = (await prompt.ask('备份文件路径（空行取消）: ')).trim()
      return typed || null
    }
    const index = Number(choice)
    if (Number.isInteger(index) && index >= 1 && index <= shown.length) return shown[index - 1]
    console.log('没有这个选项。')
  }
}

async function confirmRestore(prompt, db, files, commit) {
  console.log(`将停止 raven，把 ${dataDir} 整个挪走，再用备份换上。`)
  console.log(`db:   ${db}`)
  console.log(`文件: ${files || '（这份备份没有文件包 —— 恢复后工作目录与剪切板附件全部为空）'}`)
  console.log(`对应版本是 ${commit}。`)
  console.log('⚠️ 配置（raven.config.json）不在文件包里，会沿用现在卷上的那份。')
  const answer = (await prompt.ask('输入 yes 继续: ')).trim()
  return answer === 'yes'
}

async function resolveTag(ctx) {
  const fromEnv = normalizeTag(process.env.RAVEN_TAG)
  if (fromEnv) return fromEnv
  const fromFile = normalizeTag(await readTagFile())
  if (fromFile) return fromFile
  if (!ctx.prompt) throw new Error('设置 RAVEN_TAG，或先部署一次，让版本写进 /srv/ownspire/compose/raven.tag。')
  console.log('没有记录正在运行的版本。')
  const typed = (await ctx.prompt.ask('7 位 commit（空行取消）: ')).trim()
  return typed ? normalizeTag(typed) : null
}

function sha256AsRoot(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['cat', file], { stdio: ['ignore', 'pipe', 'inherit'] })
    const hash = createHash('sha256')
    child.stdout.on('data', (chunk) => hash.update(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`读不到 ${file}`))
      else resolve(hash.digest('hex'))
    })
  })
}

export async function backup(ctx) {
  rejectExtraArgs(ctx, 'backup')
  await ensureSudo()
  const container = process.env.RAVEN_CONTAINER || 'ownspire-raven-1'
  if (!(await containerExists(container))) {
    throw new Error(`容器 ${container} 没在跑，无法做在线备份。`)
  }
  const commit = (await runningCommit()) ?? (await readStoredCommit())
  if (!commit) throw new Error('不知道当前 commit，无法给备份做标记。先确认 /healthz，或先完成一次部署。')

  await run('sudo', ['mkdir', '-p', backupDir])
  const stamp = utcStamp()
  const base = join(backupDir, `raven-${stamp}`)
  const dbFile = `${base}.db`
  const filesFile = `${base}.tar.gz`
  const configFile = `${base}.config.json`
  console.log(`从 ${container} 做 VACUUM INTO + 打包 /data，当前版本是 ${commit}。`)
  // ⚠️ 用 capture 取退出码，不要用 run(...).then(成功, 失败)：
  // run 在失败时**抛错**而不是返回 rejected promise 的语义差异很容易写反，
  // 写反的后果是「配置不存在也去 docker cp」，然后报一个与真正原因无关的错。
  const hasConfig = (await capture('sudo', ['docker', 'exec', container, 'test', '-f', '/data/raven.config.json'])).code === 0
  await snapshot(container, {
    remoteDb: '/data/.backup-snapshot.db',
    remoteFiles: '/data/.backup-files.tar.gz',
    remoteConfig: '/data/.backup-config.json',
    dbHost: dbFile,
    filesHost: filesFile,
    configHost: configFile,
    hasConfig,
  })

  const hex = await sha256AsRoot(dbFile)
  await run('sudo', ['tee', `${dbFile}.sha256`], { input: `${hex}  ${dbFile}\n`, quiet: true })
  await run('sudo', ['tee', `${dbFile}.commit`], { input: `${commit}\n`, quiet: true })
  const stored = await readStoredCommit()
  if (stored !== commit) await recordCommit(commit, 'running')

  console.log(dbFile)
  console.log(`${dbFile}.sha256`)
  console.log(`${dbFile}.commit ${commit}`)
  console.log(filesFile)
  if (hasConfig) console.log(`${configFile}（仅供参考，恢复时不用它覆盖卷上的配置）`)
}

async function runningCommit() {
  try {
    const response = await fetch(healthUrl)
    if (!response.ok) return null
    const body = await response.json()
    return normalizeTag(body?.version)
  } catch {
    return null
  }
}

export async function restore(ctx) {
  if (ctx.args.length > 1) throw new Error('restore 只接受一个备份路径。')
  if (!ctx.args[0] && !ctx.prompt) throw new Error('restore 需要备份文件路径。')
  if (!ctx.prompt && !ctx.yes) throw new Error('加上 --yes 才会替换正在使用的数据。')
  await ensureSudo()

  let backupPath = ctx.args[0] ?? null
  if (!backupPath && ctx.prompt) {
    backupPath = await askBackup(ctx.prompt)
    if (!backupPath) return null
  }
  if (!backupPath) throw new Error('restore 需要备份文件路径。')
  if (!(await isFile(backupPath))) throw new Error(`找不到 ${backupPath}`)

  // 文件包与 db 同前缀成对存在。缺了要明确告知 —— 恢复成功但工作目录全空，
  // 是比「恢复失败」更糟的结果，因为它不报错。
  const base = backupPath.replace(/\.db$/, '')
  const filesPath = (await isFile(`${base}.tar.gz`)) ? `${base}.tar.gz` : null
  const marked = await readBackupCommit(backupPath)
  const tag = marked ?? (await resolveTag(ctx))
  if (!tag) return null

  const confirmed = ctx.yes || (ctx.prompt ? await confirmRestore(ctx.prompt, backupPath, filesPath, tag) : false)
  if (!confirmed) {
    if (!ctx.prompt) throw new Error('加上 --yes 才会替换正在使用的数据。')
    return null
  }

  const stamp = utcStamp()
  await compose(tag, 'stop', 'raven')
  const before = `${dataDir}.bak-${stamp}`
  await run('sudo', ['mv', dataDir, before])
  await run('sudo', ['mkdir', '-p', dataDir])

  await run('sudo', ['cp', backupPath, join(dataDir, 'raven.db')])
  // 先把配置从旧目录抄回来：文件包里没有它，而容器没有配置根本起不来。
  if (await isFile(join(before, 'raven.config.json'))) {
    await run('sudo', ['cp', join(before, 'raven.config.json'), join(dataDir, 'raven.config.json')])
  } else {
    console.log('⚠️ 旧目录里没有 raven.config.json —— 恢复后需要手动放一份，否则容器起不来。')
  }
  if (filesPath) {
    // 包内路径是 `./workspace/...` 这种相对形式，所以 -C 到 dataDir 解。
    await run('sudo', ['tar', '-xzf', filesPath, '-C', dataDir])
  } else {
    for (const dir of ['workspace', 'scripts', 'tmp', 'clipboard']) {
      await run('sudo', ['mkdir', '-p', join(dataDir, dir)])
    }
    console.log('⚠️  这份备份没有文件包。db 已恢复，工作目录与剪切板附件是空的。')
  }
  // ⚠️ 解包出来的东西是 root 属主，而容器以 1000:1000 跑 —— 不拉正就写不进文件。
  await run('sudo', ['chown', '-R', '1000:1000', dataDir])

  await compose(tag, 'up', '-d')
  await recordCommit(tag, 'restore')
  console.log(`已用 ${backupPath} 恢复，对应 ${tag}。原来的数据在 ${before}。`)
  if (filesPath) console.log(`文件已从 ${filesPath} 解出。`)
}

export const service = {
  id: 'raven',
  title: 'raven',
  summary: '127.0.0.1:5801，数据在 /srv/ownspire/data/raven（db + workspace + clipboard + 配置）',
  actions: [
    { id: 'deploy', label: '部署 — 初次和更新拉 main；重装沿用已记录的版本；也可指定 7 位 commit', usage: '[7位commit]', run: deploy },
    { id: 'publish', label: '发布 — 把端口写到路由器，登记 svc:raven 的 Tailscale 域名', usage: '', run: publish },
    { id: 'health', label: '健康检查 — GET /healthz', usage: '', run: health },
    { id: 'backup', label: '备份 — VACUUM INTO + 打包 /data（不含配置），并记下当时的 commit', usage: '', run: backup },
    { id: 'restore', label: '恢复 — 用备份与它标记的 commit 换上正在使用的数据', usage: '<backup.db> --yes', run: restore },
  ],
}
