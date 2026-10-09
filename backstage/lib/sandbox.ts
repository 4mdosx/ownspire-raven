import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 路径沙箱 —— raven 唯一允许碰文件系统的地方。
 *
 * 三条规矩，任何调用点都不得绕过：
 *
 * 1. **相对路径**：所有 API 收到的路径都是相对受管根目录的 POSIX 风格路径
 *    （`docs/a/b.txt`），不用绝对路径。反斜杠、NUL、`..` 段在这里就被拒。
 * 2. **realpath 判定**：只做字符串前缀比较是不够的 —— `<root>/link` 可以是指向
 *    `/etc` 的软链。所以判定「在不在里面」一律先 `realpath`，再比前缀，
 *    并且要求命中段是完整路径段（`/a/bc` 不算在 `/a/b` 里）。
 * 3. **配额**：写之前先问 `assertRoomFor()`。并发上传用进程内预留量兜住
 *    「两个上传各自看到还有空间」这种竞态。
 */

export class SandboxError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
    this.status = status
  }
}

export function isSandboxError(error: unknown): error is SandboxError {
  return error instanceof SandboxError
}

/** 把任意输入转成规范化的相对 POSIX 路径段数组。 */
export function parseRelativePath(input: unknown, options: { allowEmpty?: boolean } = {}): string[] {
  if (input === null || input === undefined || input === '') {
    if (options.allowEmpty) return []
    throw new SandboxError('invalid_path', '缺少路径参数。')
  }
  if (typeof input !== 'string') {
    throw new SandboxError('invalid_path', '路径必须是字符串。')
  }
  let value = input
  if (value.includes('\0')) throw new SandboxError('invalid_path', '路径里不能有 NUL 字节。')
  // Windows 风格分隔符与 URL 编码的 `%5C` 都当成 `/`，但绝不接受盘符。
  value = value.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(value)) throw new SandboxError('invalid_path', '不接受盘符路径。')
  if (value.startsWith('/')) throw new SandboxError('invalid_path', '不接受绝对路径，请用相对受管根目录的路径。')

  const segments: string[] = []
  for (const raw of value.split('/')) {
    const segment = raw.trim()
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new SandboxError('invalid_path', '路径里不能出现 `..`。')
    }
    segments.push(segment)
  }
  if (segments.length === 0 && !options.allowEmpty) {
    throw new SandboxError('invalid_path', '路径不能是根目录本身。')
  }
  return segments
}

export function joinRelative(segments: string[]): string {
  return segments.join('/')
}

/** 归一化一个绝对路径，用于前缀比较（不做 realpath）。 */
function normalizeAbsolute(target: string): string {
  const resolved = path.resolve(target)
  return stripPrivatePrefix(resolved)
}

/**
 * macOS 上 `/var` 与 `/tmp` 是指向 `/private/var`、`/private/tmp` 的**符号链接**。
 *
 * 于是同一个目录会有两个名字：调用方给的 `rootPath`（`/var/folders/...`，未解析）
 * 与 `realpath()` 之后的结果（`/private/var/folders/...`，已解析）。
 * `path.relative('/var/x', '/private/var/x/y')` 会返回 `../../private/var/x/y` ——
 * 看起来像越界，实际是同一个地方。
 *
 * 统一抹掉 `/private` 前缀是 mac 上处理这类比较的常规做法：两边都抹，
 * 比较关系不变，而输出的相对路径重新变成人可读的 `a/b.txt`。
 * 验证脚本最初那 6 条「相对路径变成 ../../..」的失败就是这个原因。
 */
function stripPrivatePrefix(resolved: string): string {
  if (process.platform !== 'darwin') return resolved
  return resolved.startsWith('/private/') ? resolved.slice('/private'.length) : resolved
}

/** `child` 是否在 `root` 之内（含相等）。按完整路径段比较，`/a/bc` 不算在 `/a/b`。 */
export function isInside(root: string, child: string): boolean {
  const normalizedRoot = normalizeAbsolute(root)
  const normalizedChild = normalizeAbsolute(child)
  if (normalizedChild === normalizedRoot) return true
  return normalizedChild.startsWith(`${normalizedRoot}${path.sep}`)
}

export type ResolveMode = 'read' | 'write'

export type WorkspaceStats = {
  /** 受管根目录。 */
  rootPath: string
  /** 文件管理器能看到的子树。 */
  filesRoot: string
  /** 脚本目录。 */
  scriptsRoot: string
  /** 临时脚本目录。 */
  tempRoot: string
  /** 剪切板附件目录。 */
  clipboardRoot: string
}

export class PathSandbox {
  readonly root: string
  readonly filesRoot: string
  readonly scriptsRoot: string
  readonly tempRoot: string
  readonly clipboardRoot: string
  readonly quotaBytes: number | null

  /** 进程内已预留但尚未落盘的字节数，用于并发上传时的配额判定。 */
  private reserved = 0
  private useCache: { at: number; bytes: number; files: number; dirs: number } | null = null

  constructor(options: {
    rootPath: string
    workspaceName: string
    scriptsDir: string
    tempDir: string
    quotaBytes: number | null
  }) {
    this.root = path.resolve(options.rootPath)
    this.filesRoot = path.join(this.root, options.workspaceName)
    this.scriptsRoot = path.join(this.root, options.scriptsDir)
    this.tempRoot = path.join(this.root, options.tempDir)
    this.clipboardRoot = path.join(this.root, 'clipboard')
    this.quotaBytes = options.quotaBytes
  }

  get stats(): WorkspaceStats {
    return {
      rootPath: this.root,
      filesRoot: this.filesRoot,
      scriptsRoot: this.scriptsRoot,
      tempRoot: this.tempRoot,
      clipboardRoot: this.clipboardRoot,
    }
  }

  /** 确认所有受管目录存在。首次启动时调用。 */
  async ensureRoots(): Promise<void> {
    for (const dir of [this.root, this.filesRoot, this.scriptsRoot, this.tempRoot, this.clipboardRoot]) {
      await fsp.mkdir(dir, { recursive: true })
    }
  }

  /**
   * 把沙箱内的绝对路径转成相对 root 的 POSIX 路径。
   *
   * ⚠️ 两边都要过 `stripPrivatePrefix()`：`rootPath` 可能是调用方给的
   * `/var/folders/...`（未解析），而传入的绝对路径通常来自 `realpath()`
   * （`/private/var/folders/...`）。不抹掉 `/private` 的话，
   * `path.relative` 会算出 `../../../private/var/...` —— 界面上看到的是
   * 一串 `..`，而它其实就在根目录里。
   */
  toRelative(absolute: string): string {
    const relative = path.relative(stripPrivatePrefix(this.root), stripPrivatePrefix(absolute))
    return relative.split(path.sep).join('/')
  }

  /** 只做字符串层面的归一化，不碰磁盘。适合「构造目标路径」的场景。 */
  lexicalAbsolute(relative: string | string[]): string {
    const segments = Array.isArray(relative) ? relative : parseRelativePath(relative, { allowEmpty: true })
    const absolute = path.resolve(this.root, ...segments)
    if (!isInside(this.root, absolute)) {
      throw new SandboxError('outside_root', '路径越过了受管根目录。', 403)
    }
    return absolute
  }

  /**
   * 解析一个已存在的路径，返回 realpath 后的绝对路径。
   * 这是唯一可信的「这个文件在哪」的答案。
   */
  async resolveExisting(relative: string | string[], mode: ResolveMode = 'read'): Promise<string> {
    const absolute = this.lexicalAbsolute(relative)
    let real: string
    try {
      real = await fsp.realpath(absolute)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new SandboxError('not_found', '路径不存在。', 404)
      if (code === 'ENOTDIR') throw new SandboxError('not_a_directory', '路径中间有一段不是目录。', 400)
      if (code === 'EACCES') throw new SandboxError('permission_denied', '没有权限访问这个路径。', 403)
      if (code === 'ELOOP') throw new SandboxError('symlink_loop', '符号链接成环。', 400)
      throw error
    }
    if (!isInside(this.root, real)) {
      throw new SandboxError('outside_root', '这个符号链接指向受管根目录之外，已拒绝。', 403)
    }
    void mode
    return real
  }

  /**
   * 解析一个**将要创建**的路径：向上找到最近的存在祖先并 realpath 之，
   * 确认它仍在 root 内，再把剩余段接回去。
   *
   * 这是软链逃逸最容易漏的一处 —— 目标文件还不存在，realpath 直接 ENOENT，
   * 于是有人就退化成字符串比较，而 `<root>/link/evil.txt`（link -> /etc）就过去了。
   */
  async resolveTarget(relative: string | string[]): Promise<string> {
    const absolute = this.lexicalAbsolute(relative)
    const missing: string[] = []
    let cursor = absolute
    for (;;) {
      try {
        const real = await fsp.realpath(cursor)
        if (!isInside(this.root, real)) {
          throw new SandboxError('outside_root', '目标的上层目录指向受管根目录之外，已拒绝。', 403)
        }
        return path.join(real, ...missing.reverse())
      } catch (error) {
        if (isSandboxError(error)) throw error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw error
        const parent = path.dirname(cursor)
        if (parent === cursor) {
          throw new SandboxError('outside_root', '路径越过了受管根目录。', 403)
        }
        missing.push(path.basename(cursor))
        cursor = parent
      }
    }
  }

  /** `resolveTarget` 的结果 + 最终位置仍在 root 内的复核。 */
  async resolveWrite(relative: string | string[]): Promise<string> {
    const target = await this.resolveTarget(relative)
    if (!isInside(this.root, target)) {
      throw new SandboxError('outside_root', '路径越过了受管根目录。', 403)
    }
    return target
  }

  /** 解析脚本路径：只允许 `<root>/<scriptsDir>/` 下的**单个路径段**。 */
  async resolveScript(name: unknown): Promise<{ absolute: string; relative: string }> {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new SandboxError('invalid_script', '缺少脚本名。', 400)
    }
    const segments = parseRelativePath(name)
    if (segments.length !== 1) {
      throw new SandboxError('invalid_script', '脚本名不能包含目录，只能写 scripts/ 下的文件名。', 400)
    }
    if (!/^[A-Za-z0-9._-]+\.(mjs|js)$/.test(segments[0])) {
      throw new SandboxError('invalid_script', '脚本名只接受 .mjs / .js，且只含字母数字点下划线短横。', 400)
    }
    // ⚠️ 这里必须传**相对 root 的路径**再走 resolveExisting：
    // resolveExisting 内部是 lexicalAbsolute → parseRelativePath，而后者刻意
    // 拒绝任何以 `/` 开头的东西（那是对外 API 的输入契约）。
    // 早先这里直接传了 path.join(scriptsRoot, name) 这个绝对路径，于是
    // **每一个合法脚本名都会被拒**，报错还是「不接受绝对路径」——
    // 看起来像调用方写错了，实际是内部接口用错了。验证脚本按住了这一条。
    const relative = this.toRelative(path.join(this.scriptsRoot, segments[0]))
    const absolute = await this.resolveExisting(relative)
    if (!isInside(this.scriptsRoot, absolute)) {
      throw new SandboxError('outside_root', '脚本不在 scripts 目录里。', 403)
    }
    return { absolute, relative: this.toRelative(absolute) }
  }

  // ------------------------------------------------------------------
  // 配额
  // ------------------------------------------------------------------

  /**
   * 统计**整个受管根**（`rootPath`）的字节数与条目数，软链只计数、不解引用。
   *
   * ⚠️ 起点是 `this.root` 而不是 `this.filesRoot` —— 这是刻意的：
   * 配额说的是「这个目录总共能占多大」，而 `clipboard/`（附件）、`tmp/`（中间产物）、
   * `scripts/`（脚本本体）都在 `rootPath` 下面，都是真实磁盘占用。
   * 早先只统计 `workspace/`，于是「配额 10 GiB」实际可以吃到 10 GiB + 最多 6.4 GiB 附件
   * + 若干临时文件 —— 而界面上一直显示没超。
   *
   * ⚠️ 副作用必须知道：数据库与注册表文件如果也落在 `rootPath` 里面
   * （`RAVEN_DATA_DIR` 指到根目录下），它们会一起计入。默认布局刻意把 `dataDir`
   * 放在 `rootPath` 之外（容器里 `/data` vs `/data/raven`），所以不计入 ——
   * 那不只是省几 KB，而是避免「配额写得太小导致连自己建库都失败」这种死锁。
   *
   * 每次统计真遍历整棵树，结果缓存 2 秒（`ttlMs`）。文件越多、目录越大，
   * 单次判定越慢；上传路径不依赖它保证准确 —— 那条线是「边写边预留」。
   */
  async measure(options: { ttlMs?: number } = {}): Promise<{ bytes: number; files: number; dirs: number }> {
    const ttl = options.ttlMs ?? 2000
    const now = Date.now()
    if (this.useCache && now - this.useCache.at < ttl) {
      return { bytes: this.useCache.bytes, files: this.useCache.files, dirs: this.useCache.dirs }
    }
    let bytes = 0
    let files = 0
    let dirs = 0
    const stack: string[] = [this.root]
    while (stack.length > 0) {
      const current = stack.pop() as string
      try {
        const dir = await fsp.opendir(current)
        for await (const entry of dir) {
          const child = path.join(current, entry.name)
          if (entry.isSymbolicLink()) {
            files += 1
            continue
          }
          if (entry.isDirectory()) {
            dirs += 1
            stack.push(child)
            continue
          }
          if (entry.isFile()) {
            files += 1
            try {
              const stat = await fsp.stat(child)
              bytes += stat.size
            } catch {
              // 统计期间文件被删了 —— 忽略，下次采样会算对。
            }
          }
        }
      } catch {
        // 目录不可读（权限）时跳过，不让统计整体失败。
      }
    }
    this.useCache = { at: now, bytes, files, dirs }
    return { bytes, files, dirs }
  }

  invalidateMeasurement(): void {
    this.useCache = null
  }

  /** 当前可用空间（字节）；返 null 表示不限。 */
  async remainingBytes(): Promise<number | null> {
    if (this.quotaBytes === null) return null
    const used = (await this.measure()).bytes + this.reserved
    return Math.max(0, this.quotaBytes - used)
  }

  /**
   * 写之前先判定。`incomingBytes` 是这次要写的量；不确定就传 0，
   * 然后靠 `reserve()` 边写边收口。
   *
   * ⚠️ 统计口径是**整个 `rootPath`**（见 `measure()`），不只工作目录 ——
   * 所以文案说的「受管根」而不是「工作目录」：报错里说错了范围，
   * 人会去工作目录里找那几 GB 到底在哪。
   */
  async assertRoomFor(incomingBytes: number): Promise<void> {
    if (this.quotaBytes === null) return
    const used = (await this.measure()).bytes + this.reserved
    if (used + incomingBytes > this.quotaBytes) {
      throw new SandboxError(
        'quota_exceeded',
        `受管根目录已达到配额上限（${this.quotaBytes} 字节），本次写入需要 ${incomingBytes} 字节。` +
          '注意配额统计的是整个受管根（含剪切板附件与临时目录），不只是工作目录。',
        507
      )
    }
  }

  /** 预留配额（并发上传时先占住，避免两个请求同时通过判定）。 */
  reserve(bytes: number): void {
    this.reserved += Math.max(0, bytes)
  }

  /** 归还预留量。上传失败也必须调用。 */
  release(bytes: number): void {
    this.reserved = Math.max(0, this.reserved - Math.max(0, bytes))
    this.invalidateMeasurement()
  }
}
