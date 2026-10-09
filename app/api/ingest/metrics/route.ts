import type { NextResponse } from 'next/server'
import { dbMetricInsert, dbMetricPrune, dbRunMetricCalls } from '@/backstage/db/database'
import { getConfig } from '@/backstage/lib/config'
import { ApiError, handle, ok, readJson, searchParam } from '@/backstage/lib/http'
import { tokenMatches } from '@/backstage/services/auth.service'
import { parseMetricOutput } from '@/backstage/services/dashboard.service'
import { findService } from '@/backstage/services/registry.service'
import { consumeRunToken } from '@/backstage/services/runner.service'

/**
 * 外部推指标（契约 §8）。
 *
 * 两种凭据（`x-ownspire-token`）：
 *
 * 1. `services.registrationToken` —— 服务自注册之后长期上报用；
 * 2. **本次运行的一次性令牌**（runner 注入的 `RAVEN_TOKEN`）—— 指标脚本在
 *    运行期回调这里用。`consumeRunToken()` 校验有效期并返回 `{runId, script}`
 *    （有效期内可重复使用：一个脚本可能分多批推指标），鉴权靠的就是它。
 *
 * `run_records.metricCalls` 由数据库层的 `dbRunMetricCalls(runId, n)` 增量累加：
 * 用运行令牌上报时，在对应那条运行记录上记一笔，这样
 * 「脚本说它推了 3 条」和「库里真的多了 3 条」之间有一条可对账的痕迹。
 * 增量而不是赋值 —— 一个脚本可能分多批推。
 *
 * body 形状刻意与脚本 stdout 的约定一致：`{"metrics":[{"name","value","unit"}]}`
 * 或扁平对象。脚本「打印」和「上报」因此是同一份 JSON，不用维护两种格式。
 * `services.collect === false` 不影响这个端点：总开关管的是「raven 去问上游」，
 * 不是「上游把数据推进来」。
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { config } = getConfig()
    const provided = request.headers.get('x-ownspire-token')
    const expected = config.services.registrationToken
    const registrationOk = expected !== undefined && expected !== '' && tokenMatches(provided, expected)

    let consumed: { runId: number; script: string } | null = null
    if (!registrationOk) {
      // 先鉴权再读 body：没通过校验的请求不该有机会让我们解析或分配任何东西。
      consumed = consumeRunToken(provided)
      if (consumed === null) {
        throw new ApiError('unauthorized', '指标上报需要 x-ownspire-token（注册令牌，或本次运行的一次性令牌）。', 401)
      }
    }

    const body = await readJson(request)
    const serviceId =
      typeof body.serviceId === 'string' && body.serviceId !== '' ? body.serviceId : (searchParam(request, 'serviceId') ?? '')
    if (serviceId === '') {
      throw new ApiError('missing_param', '缺少 serviceId（请求体或查询串）。', 400)
    }
    // 只收注册表里有的服务：一个拼错的 id 会在库里堆出一串永远没人读的指标，
    // 而「上报成功」的假信号会让调用方以为配置是对的。
    await findService(serviceId)

    const parsed = parseMetricOutput(JSON.stringify(body))
    if (parsed.metrics.length === 0) {
      throw new ApiError('no_metrics', parsed.message === '' ? '上报内容里没有可解析的指标。' : parsed.message, 400)
    }

    const at = Date.now()
    dbMetricInsert(
      parsed.metrics.map((metric) => ({ serviceId, metric: metric.metric, value: metric.value, unit: metric.unit, at }))
    )
    dbMetricPrune(config.services.metricHistoryLimit)
    if (consumed !== null) dbRunMetricCalls(consumed.runId, parsed.metrics.length)
    // runId 回给调用方（脚本可以据此自查这次上报被算到了哪条运行记录上）。
    return ok({ serviceId, accepted: parsed.metrics.length, metrics: parsed.metrics, runId: consumed === null ? null : consumed.runId })
  })
}
