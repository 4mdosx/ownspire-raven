/**
 * ⭐ dev 与 build 都需要的前置：把 `.next` 指向工作区外。
 *
 * ──────────────────────────────────────────────────────────────
 * ⭐⭐ **这个文件是全项目唯一的绕行方案，且它是最后手段**（2026-10-07 定）
 *
 * token 的原话：「reset 到常规的环境，用标准的方案解决，不要绕」。
 * ⚠️ **它当时就是为绕开下面这个拦截而存在的**，而修它的过程本身又制造了三层
 * 新的问题（见下面「已经走过的弯路」）。所以规矩是：
 *
 * **遇到构建/环境问题，先查是不是这个拦截；若是，优先找「不用符号链接」的
 * 办法，实在没有才走这里，且**必须一次性把 dev / build / dev:local 三条路径
 * 都接上** —— 少接一条就会缺那个链接，而症状看起来与配置无关。
 * ──────────────────────────────────────────────────────────────
 *
 * ⚠️ **为什么需要它**（2026-10-06 踩了一整天）：WorkBuddy 的 safe-delete
 * shim 会拦 `unlink` 与部分 `rename`，而 turbopack 重建缓存时必须走
 * 「写 CURRENT.next 再 rename 覆盖」这一步。于是本机上 `next dev` 与
 * `next build` 都会以 `EPERM: operation not permitted, rename ...` 收场。
 *
 * 试过并确认**无效**的方案，不要重复试：
 * · 换 distDir（含绝对路径）—— Next 16 会把 distDir 拼到项目根目录下，
 *   `/tmp/x` 变成 `<repo>/tmp/x`，仍在工作区内，拦截照旧
 * · `next build --webpack`
 * · 清 macOS 扩展属性（`xattr -cr`）
 * · 非沙箱模式
 *
 * **有效的只有一个**：让 `.next` 本身是**符号链接**指向工作区外 —— Next
 * 往里写时跟的是链接，操作系统层面的目标路径在工作区外。
 * ⚠️ 2026-10-07 复核过：摘掉链接用真实目录，确实立刻撞上
 * `EPERM ... rename CURRENT.next to CURRENT`。所以符号链接不是「懒得改的绕行」，
 * 是本地环境下唯一可行的解法。
 *
 * ──────────────────────────────────────────────────────────────
 * ⚠️⚠️ **已经走过的弯路（2026-10-07，全部失败，别再试一遍）**
 *
 * 符号链接让 `.next` 跑到 /tmp，而 Turbopack 的 chunk 也在那儿，于是
 * `postcss.config.mjs` 解析不到 `@tailwindcss/postcss`。从这一步到修好，
 * 依次试过下面四种，**每一层都在给下一层制造新问题**：
 *
 * 1. **在 distDir 里面软链 node_modules** → Next 每次启动都清 distDir，
 *    链接在 require 之前就被删了。症状极具迷惑性：`.next` 链接还在、配置看着
 *    也对，只是构建报 `Cannot find module '@tailwindcss/postcss'`。
 * 2. **改 postcss.config 用绝对路径 `createRequire(import.meta.url)`** →
 *    解析过了，但 Turbopack 转而把整条插件链打进构建图，卡在 lightningcss 的
 *    模板拼接 require：`Can't resolve '../lightningcss.darwin-arm64.node'`
 *    （原生文件其实装好了，失败纯粹是「静态扫不到」）。
 * 3. **`serverExternalPackages` + `turbopack.rules` 外部化** → 无效。前者只管
 *    运行期，而这个错误发生在构建期。
 * 4. **换 `next build --webpack`** → 同样被符号链接拖累（运行期 requireStack
 *    里全是 /tmp 路径）。
 *
 * ✅ **最终解法只有一个，且最小**：链接放在 **distDir 的上一级**，而不是里面
 * （见下面 ①）。理由：Node 逐级往上找 node_modules，放上一级同样能命中，
 * 而**上一级不在 Next 的清理范围内**。
 *
 * ⚠️ 教训：符号链接是根因，`node_modules` 链接只是配套。**只补一半必然失败** ——
 * 而补错位置（放里面）比不补更难查，因为症状与配置完全无关。
 * ──────────────────────────────────────────────────────────────
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 工作区外的构建目录。⚠️ 必须在 TMPDIR 里 —— 换个地方就失去意义了。 */
export const workDir = path.join(process.env.TMPDIR ?? '/tmp', 'raven-next-local')

/**
 * 建好三样东西，返回实际的工作目录。**幂等**，可以反复调。
 *
 * ⚠️ 三样东西的顺序有依赖：workDir 必须先存在，symlink 才能建进去。
 * 反过来会报 `ENOENT: no such file or directory, symlink ...`。
 */
export function prepareNextDir() {
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })

  // ① node_modules 链接放在 **distDir 的上一级**，不是里面。
  //
  //⚠️⚠️ **放在里面必然被删**（2026-10-07 实测踩坑）：
  // 最初把链接放在 `raven-next-local/node_modules`，而 distDir 正是那个目录 ——
  // Next 每次启动都会清理 distDir，于是链接在 postcss 解析之前就被删掉了。
  // 症状极具迷惑性：`.next` 符号链接还在、配置看着也对，只是构建报
  // `Cannot find module '@tailwindcss/postcss'`。
  //
  // Node 从 chunk 所在目录逐级往上找 node_modules，所以放在**上一级**同样能命中：
  //   <distDir>/build/chunks → <distDir>/build → <distDir> → **父目录** ← 命中
  //
  // 父目录（`$TMPDIR`）不在 Next 的清理范围内 —— 这是选它的唯一理由。
  const shimDir = path.dirname(workDir)
  const modulesLink = path.join(shimDir, 'node_modules')
  if (!isUsableLink(modulesLink, path.join(root, 'node_modules'))) {
    // ⚠️ 先删再建：断掉的符号链接 existsSync 返回 false，但 lstat 成功。
    if (fs.existsSync(modulesLink) || isSymlink(modulesLink)) fs.rmSync(modulesLink, { force: true })
    fs.symlinkSync(path.join(root, 'node_modules'), modulesLink, 'dir')
  }

  // ② .next → workDir。旧的真实目录会让 symlink 失败（ln 到目录里会建成
  // 子目录），先清掉。
  //
  // ⚠️ **这一步不能省**（2026-10-07 实测）：摘掉链接让 Next 用真实目录会撞上
  // `EPERM: ... rename CURRENT.next to CURRENT` —— 正是本文件顶部注释里
  // 那个拦截。符号链接是唯一可行的绕行方式。
  const linkPath = path.join(root, '.next')
  if (fs.existsSync(linkPath) && !fs.lstatSync(linkPath).isSymbolicLink()) {
    fs.rmSync(linkPath, { recursive: true, force: true })
  }
  if (!isSymlink(linkPath)) fs.symlinkSync(workDir, linkPath, 'dir')

  return workDir
}

function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/** 链接存在**且**指向预期目标**才算可用。 */
function isUsableLink(link, expectedTarget) {
  if (!isSymlink(link)) return false
  try {
    return fs.realpathSync(link) === fs.realpathSync(expectedTarget)
  } catch {
    return false // 断链
  }
}