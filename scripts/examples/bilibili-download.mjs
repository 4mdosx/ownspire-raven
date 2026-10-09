#!/usr/bin/env node
/**
 * ⭐ 需求里点名的场景：给一个哔哩哔哩链接，把视频下到工作目录。
 *
 * 用法（在 raven 的脚本页里，参数填链接即可）：
 *   node bilibili-download.mjs <链接> [更多链接...]
 *
 * 依赖 `yt-dlp`。没装的话脚本会在第一行告诉你装什么，而不是抛一堆栈。
 *   容器里：  apt-get update && apt-get install -y yt-dlp ffmpeg
 *   本机 macOS：brew install yt-dlp ffmpeg
 *
 * ⚠️ 三条与 raven 有关的纪律，改这个脚本时别破坏：
 *
 * 1. **输出位置只用 RAVEN_WORKSPACE**，不写绝对路径也不写 `../`。
 *    脚本对目录结构的全部认知就是这一个变量 —— 这样换部署、
 *    换 rootPath、换配额都不需要改脚本。
 * 2. **中间产物放 RAVEN_TMPDIR**，不要往工作目录里丢 `.part` 文件。
 *    工作目录是给人看的、且**计入配额**的；临时目录跑完就没。
 * 3. **不碰 RAVEN_ROOT 下的其它目录**（scripts/、clipboard/ 都不是脚本的）。
 *    越界写会被沙箱在 API 层挡住，但脚本自己有分寸更省事。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const workspace = process.env.RAVEN_WORKSPACE
if (!workspace) {
  console.error('缺少 RAVEN_WORKSPACE —— 这个脚本要在 raven 里运行。')
  process.exit(2)
}

const urls = process.argv.slice(2).filter((item) => item.trim() !== '')
if (urls.length === 0) {
  console.error('用法：node bilibili-download.mjs <哔哩哔哩链接> [更多链接...]')
  process.exit(2)
}

async function hasYtDlp() {
  try {
    await run('yt-dlp', ['--version'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

if (!(await hasYtDlp())) {
  console.error('找不到 yt-dlp。请先安装：')
  console.error('  容器：apt-get update && apt-get install -y yt-dlp ffmpeg')
  console.error('  macOS：brew install yt-dlp ffmpeg')
  process.exit(3)
}

// 下载目录固定在工作目录下的 downloads/ —— 固定下来才好在文件管理器里一眼找到。
const outDir = path.join(workspace, 'downloads')
fs.mkdirSync(outDir, { recursive: true })

// 临时目录：yt-dlp 的分片与中间文件都落在这里，跑完由 raven 清掉。
const tmpDir = process.env.RAVEN_TMPDIR ?? outDir
fs.mkdirSync(tmpDir, { recursive: true })

const quality = process.env.BILI_QUALITY ?? '1080p'
// 画质上限从环境变量来，配置在 raven 的 scripts.env 里改，不用动脚本。
const height = /^\d+$/.test(quality) ? quality : { '1080p': '1080', '720p': '720', '480p': '480', '360p': '360' }[quality] ?? '1080'

const args = [
  '--no-playlist',
  '--newline',
  // 已经是 mp4 就不重封装，省一次转码时间。
  '--merge-output-format',
  'mp4',
  '-f',
  `bv*[height<=${height}]+ba/b[height<=${height}]/b`,
  '-o',
  path.join(outDir, '%(title).120B [%(id)s].%(ext)s'),
  '--paths',
  `temp:${tmpDir}`,
  '--restrict-filenames',
  '--no-overwrites',
]

// 大会员/登录态：配置里给 BILI_COOKIES（cookie 文件绝对路径）时才带上。
const cookies = process.env.BILI_COOKIES
if (cookies && fs.existsSync(cookies)) {
  args.push('--cookies', cookies)
}

let failed = 0
for (const url of urls) {
  console.log(`==> ${url}`)
  try {
    // ⚠️ 不用 shell：链接是用户输入的，拼 shell 就等于把注入面开到最大。
    const { stdout, stderr } = await run('yt-dlp', [...args, url], {
      timeout: 30 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    })
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    console.log(`完成：${url}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`失败：${url}\n${message}`)
  }
}

console.log(`共 ${urls.length} 个链接，失败 ${failed} 个。输出目录：downloads/`)
process.exit(failed === 0 ? 0 : 1)
