'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/raven/feedback'
import { apiGet, apiPut, ApiClientError } from '@/lib/api'

/**
 * token 预算与用量（agent 契约 §六「token 预算」，2026-10-09）。
 *
 * 口径提醒（契约原文）：**全程不出现钱** —— 这里显示的只有 token 数。
 * 按厂商/模型分组的账目一眼看清谁在烧，「换算成人民币」这件事刻意留在库外。
 *
 * 预算上限是实例级一个数；检查点在 run 启动前 —— 超了发消息会拿到
 * 409 `budget_exhausted`，UI 据此提示来这页调整。
 */

type Usage = {
  totals: { inputTokens: number; outputTokens: number }
  byModel: { provider: string; model: string; inputTokens: number; outputTokens: number }[]
  budget: { limit: number | null; used: number }
}

export function AgentBudget() {
  const toast = useToast()
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setUsage(await apiGet<Usage>('/api/agent/usage'))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveLimit = useCallback(
    async (limit: number | null): Promise<void> => {
      setBusy(true)
      try {
        await apiPut('/api/agent/config/budget', { limit })
        toast.ok(limit === null ? '已取消预算上限。' : `预算上限已设为 ${limit.toLocaleString()} token。`)
        await refresh()
      } catch (err) {
        toast.error('保存失败。', err instanceof ApiClientError ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refresh, toast]
  )

  const applyDraft = (): void => {
    const trimmed = draft.trim()
    if (trimmed === '') {
      void saveLimit(null)
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error('预算上限必须是非负数字，留空 = 不设防。')
      return
    }
    void saveLimit(parsed)
  }

  const fmt = (n: number): string => n.toLocaleString()

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">token 预算与用量</h2>
        <span className="text-[11px] text-muted-foreground">全程按 token 记账，不换算成钱</span>
      </div>

      {error !== null ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : usage === null ? (
        <p className="text-xs text-muted-foreground">加载中…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4 text-sm">
            <div>
              <div className="text-[11px] text-muted-foreground">累计输入</div>
              <div className="font-mono">{fmt(usage.totals.inputTokens)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">累计输出</div>
              <div className="font-mono">{fmt(usage.totals.outputTokens)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">预算</div>
              <div className="font-mono">
                {usage.budget.limit === null
                  ? '不设防'
                  : `${fmt(usage.budget.used)} / ${fmt(usage.budget.limit)}`}
              </div>
            </div>
          </div>

          {usage.byModel.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">厂商</th>
                    <th className="px-2 py-1.5 font-medium">模型</th>
                    <th className="px-2 py-1.5 text-right font-medium">输入</th>
                    <th className="px-2 py-1.5 text-right font-medium">输出</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map((row) => (
                    <tr key={`${row.provider}-${row.model}`} className="border-t">
                      <td className="px-2 py-1.5">{row.provider}</td>
                      <td className="px-2 py-1.5 font-mono">{row.model}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmt(row.inputTokens)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmt(row.outputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                usage.budget.limit === null
                  ? '输入新的上限（token 数），留空保存 = 不设防'
                  : `当前 ${fmt(usage.budget.limit)}，清空保存 = 不设防`
              }
              className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
              inputMode="numeric"
            />
            <Button size="sm" disabled={busy} onClick={applyDraft}>
              保存上限
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            检查点在每一轮启动前：超限的轮次会被拒绝（409 budget_exhausted），不会烧起来之后才被掐断。
          </p>
        </>
      )}
    </div>
  )
}
