import fs from 'node:fs'
import { NextResponse } from 'next/server'
import { RAVEN_VERSION } from '@/config/env'
import { getConfig } from '@/backstage/lib/config'
import { ensureSchema } from '@/backstage/db/database'

/**
 * 部署健康检查。
 *
 * ownspire 的部署脚本（与 creative-atlas / navi 同一套）靠这里判断「跑的是哪一版」，
 * 所以 `version` 必须在**任何**分支上都返回，包括失败分支 —— 否则「部署上去但
 * 健康检查 500」这件事会连版本号都问不出来，排障只能靠翻日志。
 *
 * ⚠️ **绝不返回文件系统路径、配置内容或任何密钥。**
 * 失败分支只给一个固定字符串，不返回 `ConfigError.message`：那条消息里会带上
 * 配置文件的绝对路径与校验细节。`/healthz` 是**未登录可访问**的公开路径
 * （proxy.ts 的 PUBLIC_PATHS），一个公开端点报出宿主机的目录结构等于给扫描器
 * 送情报。需要详细信息的人去看服务端日志。
 *
 * `root` / `quota` 两个布尔的意义：
 * - `root`：受管根目录是否真的在磁盘上。为 false 时所有文件/脚本接口都会失败，
 *   这是部署时「数据卷没挂上」最快的信号。
 * - `quota`：是否配置了配额。为 false 不是错误（不限量是合法配置），
 *   但巡检脚本要能区分「没配额」和「配额是 null 因为配置读不出来」。
 *
 * `getSandbox()` 也要调一次：沙箱是**唯一**做路径判定的地方，如果它能构造出来
 * 却和 rootPath 对不上（配置里 workspace.name 非法等），健康检查应该先炸，
 * 而不是等用户点开文件管理器才发现。
 *
 * `force-dynamic` 是必须的：Next 默认会把这个没有动态 API 依赖的 GET 静态化，
 * 于是健康检查会一直返回**构建时**的快照，部署后磁盘被删掉也照样说 ok。
 */
export const dynamic = 'force-dynamic'

/**
 * ⚠️ 这里顺带做一次「确保受管目录存在」，而不是只在 `npm run init` 里做。
 *
 * 容器里的数据卷第一次挂上时是空的：`workspace/` `scripts/` `tmp/` `clipboard/`
 * 一个都不在。如果只在 init 里创建，那么 `deploy` 之后第一次点上传就会撞
 * `ENOENT`，而那时人已经在浏览器里、手上是刚拖进去的文件 ——
 * 报错看起来像路径写错了，其实是「没人跑过 init」。
 *
 * 放在健康检查里是因为它**必然先被调用**：compose 的 healthcheck 与
 * `ownspire.mjs raven deploy` 都会在对外可用之前打它。顺带把表建了，
 * 这样「健康」这个词是真的（能读配置、能建目录、能开库）。
 *
 * `ensureSchema()` 是幂等的，重复调用没有代价，所以不做额外的「只跑一次」标记
 * —— 那个标记反而会在多进程/热重载下变成 bug 来源。
 */
export async function GET() {
  try {
    const { config, sandbox } = getConfig()
    await sandbox.ensureRoots()
    ensureSchema()
    // 只做 existsSync 判定，不读内容、不返回路径。
    const rootExists = config.rootPath !== '' && fs.existsSync(config.rootPath)
    return NextResponse.json({
      ok: true,
      version: RAVEN_VERSION,
      root: rootExists,
      quota: config.workspace.quotaBytes !== null,
    })
  } catch {
    return NextResponse.json(
      { ok: false, version: RAVEN_VERSION, error: '配置不可用，详情见服务端日志。' },
      { status: 500 }
    )
  }
}
