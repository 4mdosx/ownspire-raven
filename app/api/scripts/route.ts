import type { NextResponse } from 'next/server'
import { getConfig, publicConfig } from '@/backstage/lib/config'
import { handle, ok } from '@/backstage/lib/http'
import { listRuns, listScripts } from '@/backstage/services/runner.service'

/**
 * GET /api/scripts —— 脚本列表 + 运行配置 + 最近运行（契约 §8）。
 *
 * 三块一起给是刻意的：脚本面板要同时回答「有哪些脚本」「并发/超时是多少」
 * 「刚才那次跑成什么样」。分三次请求会出现「列表里的 lastRun 是旧的」
 * 这种前后不一致，用户看到的就是「明明刚跑完却显示失败」。
 *
 * `config` 用 `publicConfig()` 的 scripts 段（不含任何宿主路径），另外补一个
 * `allowScriptExecution`：关掉执行时列表仍然能看，按钮要禁用。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return handle(async () => {
    const { config } = getConfig()
    const scripts = await listScripts()
    return ok({
      scripts,
      config: {
        ...publicConfig().scripts,
        allowScriptExecution: config.workspace.allowScriptExecution,
        tempDir: config.scripts.tempDir,
      },
      runs: await listRuns(20),
    })
  })
}
