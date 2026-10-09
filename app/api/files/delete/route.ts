import type { NextResponse } from 'next/server'
import { ApiError, handle, ok, readJson } from '@/backstage/lib/http'
import { remove } from '@/backstage/services/file.service'

/**
 * POST /api/files/delete —— `{paths:[...]}` 删除（契约 §8）。
 *
 * 用 POST 而不是 DELETE 带 body：契约这么定的，而且这次调用要回一份回执
 * （`removed` 里每条递归统计出的字节数 + `count` 总文件数），前端要拿它
 * 说清「刚删掉了 37 个文件 / 1.2 GiB」。超过 `MAX_DELETE_FILES` 由服务层拒绝。
 */

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const body = await readJson(request)
    const paths = body.paths
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new ApiError('invalid_body', 'paths 必须是非空数组。', 400)
    }
    if (paths.some((item) => typeof item !== 'string')) {
      // 只判类型：空串（= 工作目录本身）交给服务层拒，那里的文案更准确
      // （「不能删除工作目录本身」比「paths 里有空串」有用得多）。
      throw new ApiError('invalid_body', 'paths 里每一项都必须是字符串。', 400)
    }
    const result = await remove({ paths: paths as string[] })
    return ok({ removed: result.removed, count: result.count })
  })
}
