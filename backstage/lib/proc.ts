import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * 子进程纪律 —— ** raven 里执行外部代码的所有出口都必须走这里**。
 *
 * 脚本运行器（`runner.service.ts`）与 shell 工具（`backstage/tools/shell.ts`）
 * 都需要同样三件事，而**抄一遍就等于放弃它们**：
 *
 * 1. **杀进程组**（`detached: true` + 负 pid）。只杀直接子进程的话，
 *    ffmpeg / yt-dlp 这类会留下孙子进程继续往磁盘写—— 那既绕过配额统计，
 *    也让「超时」变成一个假动作。
 * 2. **按字节封顶，且封顶后继续读管道**（`OutputSink`）。超了上限只是不再保存，
 *    绝不能停止消费：管道满了子进程会被 write 阻塞，表现是「脚本卡死」，
 *    而其实它在等我们读。
 * 3. **SIGTERM 给3 秒宽限再 SIGKILL**。收到 SIGTERM 的进程要收尾
 *    （写 moov、关字幕），立刻 SIGKILL 会留下损坏的输出文件。
 *    宽限不是「再等等看」，到点就杀。
 */

/** 一路输出的采集器。 */
export class OutputSink {
  private readonly chunks: Buffer[] = []
  private readonly decoder = new StringDecoder('utf8')
  private bytes = 0
  private truncated = false

  constructor(private readonly limit: number, private readonly onChunk?: (chunk: string) => void) {}

  push(chunk: Buffer): void {
    if (this.truncated) return
    const room = this.limit - this.bytes
    if (chunk.length <= room) {
      this.chunks.push(chunk)
      this.bytes += chunk.length
      this.onChunk?.(this.decoder.write(chunk))
      return
    }
    if (room > 0) {
      const head = chunk.subarray(0, room)
      this.chunks.push(head)
      this.bytes += room
      this.onChunk?.(this.decoder.write(head))
    }
    this.truncated = true
  }

  finish(): void {
    if (this.truncated) return
    const tail = this.decoder.end()
    if (tail !== '') this.onChunk?.(tail)
  }

  get isTruncated(): boolean {
    return this.truncated
  }

  text(): string {
    // 权威文本按字节拼完再解码，不依赖回调路径。
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** 杀整个进程组；组没了或没有进程组时退回杀直接子进程。 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    // 负 pid = 整个进程组。孙子进程就在这里被一起收掉。
    process.kill(-pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return // 组已经没了，正常收尾
    // 没有权限或没有进程组（比如已经 setsid 走了）：退回杀直接子进程。
    try {
      child.kill(signal)
    } catch {
      // 已经退出了。
    }
  }
}

/** SIGTERM → 宽限 → SIGKILL 的两段式收尾。返回取消定时器的函数。 */
export function armGracefulKill(
  child: ChildProcess,
  graceMs = 3000,
  onGrace?: () => void
): () => void {
  onGrace?.()
  killProcessGroup(child, 'SIGTERM')
  const timer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), graceMs)
  // 定时器不该拖住进程退出：这条命令已经结束了，没必要再等 3 秒。
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearTimeout(timer)
}