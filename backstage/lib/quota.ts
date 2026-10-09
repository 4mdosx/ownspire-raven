import type { TransformCallback } from 'node:stream'
import type { PathSandbox } from '@/backstage/lib/sandbox'

/**
 * 「边收字节、边向沙箱要配额」这一条逻辑，只写一次。
 *
 * ──────────────────────────────────────────────────────────────
 * ⚠️ 为什么必须共享（2026-10 这里我先写错过一次，验证脚本当场抓到）
 *
 * 配额判定有两个时机，缺一不可：
 *
 *   1. **收之前**：总量已知时（上传带 `expectedBytes`、复制已知源大小）先
 *      `assertRoomFor(总量)` —— 不落盘就能拒掉，省一次白写的 IO。
 *   2. **收之中**：总量未知时（裸流上传、剪切板附件）**按块**要配额。
 *      关键是粒度：必须按「已收到的量」实时预留。第一版按最坏情况
 *      （一整条 32 MiB 附件）预留，结果「可用 4 KiB 时粘贴 16 字节也会被拒」，
 *      而且预留量一直挂着、每次粘贴都永久吃掉一块额度。
 *
 * 三条必须同时成立的细节：
 *
 * - `need` 是**增量**（`已收 - 已预留 - 抵扣`），不是总字节数。用总量会重复
 *   计入已经预留过的部分，等于把额度少放一倍。
 * - 判定必须在预留**之前**且是 `await` 的：先 `reserve` 再判定等于在判定里
 *   把自己刚占的空间算成可用，超限永远拦不住。
 * - `credit` 是这次写入会**替换掉**的字节（覆盖上传的旧文件）：那部分空间
 *   本来就已经计入用量，再算一遍会凭空吃掉一个文件大小的额度。
 * - 任何失败路径都要 `abort()`，否则配额被永久吃掉 —— 而症状是
 *   「磁盘明明有空间，上传却一直报配额满」。
 *
 * 并发安全靠 `reserve()`：两个上传「各自看到还有空间」是真实场景，
 * 而各自 `assertRoomFor` 时对方的量还没落盘。预留量就是那个交集。
 * ──────────────────────────────────────────────────────────────
 */
export class QuotaMeter {
  private received = 0
  private reserved = 0

  constructor(
    private readonly sandbox: PathSandbox,
    /** 已经被这次写入替换掉、因此不必再占额度的字节数（覆盖上传的旧文件大小）。 */
    private readonly credit = 0
  ) {}

  get bytes(): number {
    return this.received
  }

  get reservedBytes(): number {
    return this.reserved
  }

  /** 已经收了多少字节，但还欠着多少字节的配额判定（用于流式路径）。 */
  private outstanding(): number {
    return Math.max(0, this.received - this.credit) - this.reserved
  }

  /**
   * 流式路径：收下一块之前调用。调用方**必须 await** 它再调 `callback(null, chunk)`。
   * 抛错就是应当中止这次写入。
   */
  async acceptChunk(chunkBytes: number): Promise<void> {
    this.received += chunkBytes
    const need = this.outstanding()
    if (need <= 0) return
    await this.sandbox.assertRoomFor(need)
    this.sandbox.reserve(need)
    this.reserved += need
  }

  /**
   * 一次性路径：总量已知时先要配额。
   * `totalBytes` 是这次的**完整**写入量（不是增量）。
   */
  async acceptTotal(totalBytes: number): Promise<void> {
    this.received = totalBytes
    const need = this.outstanding()
    if (need <= 0) return
    await this.sandbox.assertRoomFor(need)
    this.sandbox.reserve(need)
    this.reserved += need
  }

  /** 成功收完：把多预留的部分还回去，并让下一次统计重新走一遍。 */
  commit(): void {
    this.abort()
    this.sandbox.invalidateMeasurement()
  }

  /** 失败或中止：把预留全部还回去。可以在 `finally` 里无条件调用。 */
  abort(): void {
    if (this.reserved > 0) this.sandbox.release(this.reserved)
    this.reserved = 0
  }
}

/**
 * 把 `QuotaMeter.acceptChunk` 接成 `Transform` 的实现，省掉每个调用点各写一遍
 * 「同步签名的回调怎么接异步判定」。
 *
 * ⚠️ 别把它写成同步判定：`assertRoomFor` 是异步的（要先量一遍目录），
 * 而跳过那次判定直接 `reserve` 就等于不设配额。
 */
export function quotaTransform(meter: QuotaMeter): (
  chunk: Buffer,
  encoding: BufferEncoding,
  callback: TransformCallback
) => void {
  return (chunk, _encoding, callback) => {
    meter.acceptChunk(chunk.length).then(
      () => callback(null, chunk),
      (error: Error) => callback(error)
    )
  }
}
