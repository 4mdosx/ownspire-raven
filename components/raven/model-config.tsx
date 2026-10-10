'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Spinner } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/input'
import { ErrorBar, StatusPill, useToast } from '@/components/raven/feedback'
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 模型与厂商（agent 契约 §三「配置目录」）。
 *
 * ## 为什么这个页面是三段而不是一张表
 *
 * 厂商 → 端点 → 模型是**层级**关系，而它们各自的字段完全不同：
 * 厂商管 key 与默认协议，端点管地址与协议覆盖，模型管推理档位。
 * 摊成一张表就要在每行塞一堆无关的列，而「填错地方」会变成一个静默的 bug ——
 * 比如把 baseUrl 填到模型那一行，用户看不出为什么没生效。
 *
 * ## 三条交互纪律
 *
 * ① **key 只写不读。** 输入框留空 = 不改（不是清空）。用户改个标签就丢 key，
 *    然后突然报「key 无效」而完全想不到是自己刚才那次保存干的。
 *    清空要走独立的按钮，且要确认。
 * ② **级联删除必须确认，且要说清连带删了什么。** 界面不显示「还有 2 个模型」，
 *    用户点下去之后才发现模型没了 —— 那比不给删除功能更糟。
 * ③ **失败时保留用户输入。** 写操作失败后表单内容还在，重试不用重打一遍 key。
 *
 * ⚠️ **2026-10-09：key 的环境变量名那一栏删了。** 服务端不再有 env 兜底，
 * 所以「填个变量名」在这里是一个**填了也不会生效**的输入框 ——
 * 而那比不提供更糟：用户会以为配好了，去查「为什么还是没生效」。
 */

type ProviderView = {
  id: string
  label: string
  apiKeySet: boolean
  apiKeySource: 'db' | 'none'
  apiKeyHint: string | null
  defaultProtocol: string
  updatedAt: number
}

type EndpointRow = {
  id: string
  providerId: string
  label: string
  protocol: string
  baseUrl: string | null
  extraBody: Record<string, unknown> | null
  enabled: number
  modelCount: number
}

type ModelRow = {
  id: string
  endpointId: string
  label: string
  reasoningEffort?: string
  enabled?: number
}

type ConfigResponse = {
  providers: ProviderView[]
  endpoints: EndpointRow[]
  models: ModelRow[]
  defaultModel: string | null
}

const PROTOCOLS = [
  { value: 'openai-chat-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'sdk', label: '自家 SDK' },
] as const

const EFFORTS = [
  { value: '', label: '（厂商默认）' },
  { value: 'low', label: 'low · 最快最省' },
  { value: 'high', label: 'high · 编码与推理' },
  { value: 'max', label: 'max · 最贵' },
] as const

export function ModelConfig({ agentConfigured }: { agentConfigured: boolean }) {
  const toast = useToast()
  const [data, setData] = useState<ConfigResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<
    | { kind: 'provider'; id: string; label: string; endpoints: number; models: number }
    | { kind: 'endpoint'; id: string; label: string; models: number }
    | null
  >(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await apiGet<ConfigResponse>('/api/agent/config', {}, { signal })
      setData(body)
      setError(null)
    } catch (cause) {
      if (signal?.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const run = useCallback(
    async (work: () => Promise<void>, okMessage: string) => {
      setBusy(true)
      try {
        await work()
        await load()
        toast.ok(okMessage)
      } catch (cause) {
        toast.error('操作失败', cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [load, toast]
  )

  const modelsByEndpoint = useMemo(() => {
    const map = new Map<string, ModelRow[]>()
    for (const model of data?.models ?? []) {
      const list = map.get(model.endpointId) ?? []
      list.push(model)
      map.set(model.endpointId, list)
    }
    return map
  }, [data])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Spinner /> 正在读取配置…
      </div>
    )
  }

  if (!agentConfigured) {
    return (
      <ErrorBar
        message="没配置 AGENT_RUNTIME_TOKEN，连不上 Agent Runtime。"
        detail="这个页面需要它才能读写模型目录。"
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorBar message={error} />}

      <p className="text-xs text-muted-foreground">
        默认模型：
        {data?.defaultModel ? (
          <code className="font-mono text-foreground">{data.defaultModel}</code>
        ) : (
          <span className="text-muted-foreground">
            未设置 —— 在下面的「模型」里加一个，它就是默认的
          </span>
        )}
        。改目录后立即生效，不需要重启。
      </p>

      <ProvidersSection
        providers={data?.providers ?? []}
        busy={busy}
        onSave={(id, patch) =>
          run(
            () => apiPatch(`/api/agent/config/providers/${encodeURIComponent(id)}`, patch).then(() => undefined),
            '厂商已保存。'
          )
        }
        onDelete={(id) => {
          const provider = data?.providers.find((item) => item.id === id)
          const endpoints = (data?.endpoints ?? []).filter((item) => item.providerId === id).length
          const models = (data?.endpoints ?? [])
            .filter((item) => item.providerId === id)
            .reduce((sum, item) => sum + item.modelCount, 0)
          setConfirm({ kind: 'provider', id, label: provider?.label ?? id, endpoints, models })
        }}
      />

      <EndpointsSection
        endpoints={data?.endpoints ?? []}
        providers={data?.providers ?? []}
        modelsByEndpoint={modelsByEndpoint}
        busy={busy}
        onSave={(id, patch) =>
          run(
            () => apiPatch(`/api/agent/config/endpoints/${encodeURIComponent(id)}`, patch).then(() => undefined),
            '端点已保存。'
          )
        }
        onDelete={(id) => {
          const endpoint = data?.endpoints.find((item) => item.id === id)
          setConfirm({
            kind: 'endpoint',
            id,
            label: endpoint?.label ?? id,
            models: endpoint?.modelCount ?? 0,
          })
        }}
      />

      <ModelsSection
        models={data?.models ?? []}
        endpoints={data?.endpoints ?? []}
        busy={busy}
        onSave={(model) =>
          run(
            () => apiPost('/api/agent/config/models', model).then(() => undefined),
            '模型已保存。'
          )
        }
        onDelete={(endpointId, id) =>
          run(
            () =>
              apiDelete(
                `/api/agent/config/models/${encodeURIComponent(endpointId)}/${encodeURIComponent(id)}`
              ).then(() => undefined),
            '模型已删除。'
          )
        }
      />

      <ConfirmDialog
        open={confirm !== null}
        danger
        busy={busy}
        title={confirm?.kind === 'provider' ? '删除厂商' : '删除端点'}
        message={
          confirm === null ? '' : (
            <>
              确定删除「{confirm.label}」？
              <br />
              它是<b>不可逆</b>的。
            </>
          )
        }
        detail={
          confirm?.kind === 'provider' ? (
            <ul className="list-disc pl-5">
              <li>厂商本身</li>
              <li>{confirm.endpoints} 个端点</li>
              <li>{confirm.models} 个模型（挂在这些端点上）</li>
            </ul>
          ) : confirm !== null ? (
            <ul className="list-disc pl-5">
              <li>端点本身</li>
              <li>{confirm.models} 个模型</li>
            </ul>
          ) : null
        }
        confirmLabel="连带删除"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm
          setConfirm(null)
          if (!target) return
          void run(async () => {
            const path =
              target.kind === 'provider'
                ? `/api/agent/config/providers/${encodeURIComponent(target.id)}`
                : `/api/agent/config/endpoints/${encodeURIComponent(target.id)}`
            // ⚠️ `cascade=1` 是「我已经知道会连带删」的信号。
            // 不带它的话 agent 会返回 409，而这里表现为「删不掉」——
            // 确认框都点了却还是不行，是最让人困惑的一种失败。
            await apiDelete(`${path}?cascade=1`)
          }, '已删除。')
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 厂商
// ---------------------------------------------------------------------------

function ProvidersSection({
  providers,
  busy,
  onSave,
  onDelete,
}: {
  providers: ProviderView[]
  busy: boolean
  onSave: (id: string, patch: Record<string, unknown>) => void
  onDelete: (id: string) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">厂商</h2>
      <p className="text-xs text-muted-foreground">
        key 存在数据库里，但<b>永不回显</b>：这里只显示末四位。
        这是它<b>唯一的来源</b>—— 环境变量不再参与。
      </p>
      <div className="flex flex-col divide-y rounded-md border">
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            busy={busy}
            onSave={onSave}
            onDelete={onDelete}
          />
        ))}
        {providers.length === 0 && <EmptyRow text="还没有厂商。" />}
      </div>
    </section>
  )
}

function ProviderRow({
  provider,
  busy,
  onSave,
  onDelete,
}: {
  provider: ProviderView
  busy: boolean
  onSave: (id: string, patch: Record<string, unknown>) => void
  onDelete: (id: string) => void
}) {
  const [label, setLabel] = useState(provider.label)
  const [protocol, setProtocol] = useState(provider.defaultProtocol)
  // ⚠️ key 输入框**故意不预填**：服务端不会回显它，预填一个掩码进去，
  // 用户会以为那就是完整的 key，然后一保存就把真 key 换成 ****1234。
  const [apiKey, setApiKey] = useState('')

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-muted-foreground">{provider.id}</code>
        <StatusPill
          tone={provider.apiKeySet ? 'ok' : 'warn'}
          title={provider.apiKeySet ? 'key 已配置（存在数据库里）' : '未配置 key —— 调用会失败'}
        >
          {provider.apiKeySet ? `key ${provider.apiKeyHint}` : '未配置 key'}
        </StatusPill>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            disabled={busy || (label === provider.label && protocol === provider.defaultProtocol && apiKey === '')}
            onClick={() => onSave(provider.id, { label, defaultProtocol: protocol, ...(apiKey === '' ? {} : { apiKey }) })}
          >
            保存
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => onDelete(provider.id)}>
            删除
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="显示名">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="默认协议">
          <Select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
            {PROTOCOLS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="API key"
        hint={
          provider.apiKeySet
            ? '留空 = 不改。填新值会覆盖。'
            : '留空 = 不改（当前未配置）。'
        }
      >
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder={provider.apiKeySet ? `已配置（${provider.apiKeyHint}），留空不改` : '粘贴 API key'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="font-mono"
          />
          {provider.apiKeySet && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="清空数据库里的 key"
              onClick={() => onSave(provider.id, { clearApiKey: true })}
            >
              清空
            </Button>
          )}
        </div>
      </Field>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

function EndpointsSection({
  endpoints,
  providers,
  modelsByEndpoint,
  busy,
  onSave,
  onDelete,
}: {
  endpoints: EndpointRow[]
  providers: ProviderView[]
  modelsByEndpoint: Map<string, ModelRow[]>
  busy: boolean
  onSave: (id: string, patch: Record<string, unknown>) => void
  onDelete: (id: string) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">端点</h2>
      <p className="text-xs text-muted-foreground">
        协议留空则继承厂商默认。同一厂商可以有多个端点、多种协议。
      </p>
      <div className="flex flex-col divide-y rounded-md border">
        {endpoints.map((endpoint) => (
          <EndpointRow
            key={endpoint.id}
            endpoint={endpoint}
            providers={providers}
            models={modelsByEndpoint.get(endpoint.id) ?? []}
            busy={busy}
            onSave={onSave}
            onDelete={onDelete}
          />
        ))}
        {endpoints.length === 0 && <EmptyRow text="还没有端点。" />}
      </div>
    </section>
  )
}

function EndpointRow({
  endpoint,
  providers,
  models,
  busy,
  onSave,
  onDelete,
}: {
  endpoint: EndpointRow
  providers: ProviderView[]
  models: ModelRow[]
  busy: boolean
  onSave: (id: string, patch: Record<string, unknown>) => void
  onDelete: (id: string) => void
}) {
  const [providerId, setProviderId] = useState(endpoint.providerId)
  const [label, setLabel] = useState(endpoint.label)
  const [protocol, setProtocol] = useState(endpoint.protocol)
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl ?? '')

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-muted-foreground">{endpoint.id}</code>
        <StatusPill tone={endpoint.enabled === 1 ? 'ok' : 'warn'}>
          {endpoint.modelCount} 个模型
        </StatusPill>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onSave(endpoint.id, { providerId, label, protocol, baseUrl })}
          >
            保存
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => onDelete(endpoint.id)}>
            删除
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="厂商">
          <Select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="显示名">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="协议">
          <Select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
            {PROTOCOLS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="地址" hint="OpenAI 兼容端点通常以 /v1 结尾">
          <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="font-mono" />
        </Field>
      </div>

      {models.length > 0 && (
        <p className="text-xs text-muted-foreground">
          挂着 {models.map((model) => model.id).join('、')}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

function ModelsSection({
  models,
  endpoints,
  busy,
  onSave,
  onDelete,
}: {
  models: ModelRow[]
  endpoints: EndpointRow[]
  busy: boolean
  onSave: (model: { id: string; endpointId: string; label: string; reasoningEffort: string }) => void
  onDelete: (endpointId: string, id: string) => void
}) {
  const [endpointId, setEndpointId] = useState(endpoints[0]?.id ?? '')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [effort, setEffort] = useState('')

  const canAdd = endpointId !== '' && id.trim() !== ''

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">模型</h2>
      <div className="flex flex-col divide-y rounded-md border">
        {models.map((model) => (
          <div key={`${model.endpointId}/${model.id}`} className="flex items-center gap-2 px-3 py-2 text-sm">
            <code className="font-mono">{model.id}</code>
            <span className="text-xs text-muted-foreground">{model.label}</span>
            <span className="text-xs text-muted-foreground">· {model.endpointId}</span>
            {model.reasoningEffort && (
              <StatusPill tone="unknown" title="推理档位">
                {model.reasoningEffort}
              </StatusPill>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={busy}
              onClick={() => onDelete(model.endpointId, model.id)}
            >
              删除
            </Button>
          </div>
        ))}
        {models.length === 0 && <EmptyRow text="还没有模型。" />}
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
        <Field label="端点" className="w-40">
          <Select value={endpointId} onChange={(event) => setEndpointId(event.target.value)}>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="模型 id" className="w-40">
          <Input value={id} onChange={(event) => setId(event.target.value)} className="font-mono" placeholder="glm-5.3" />
        </Field>
        <Field label="显示名" className="w-40">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="GLM-5.3" />
        </Field>
        <Field label="推理档位" className="w-36">
          <Select value={effort} onChange={(event) => setEffort(event.target.value)}>
            {EFFORTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="primary"
          disabled={busy || !canAdd}
          onClick={() => {
            onSave({ id: id.trim(), endpointId, label: label.trim() || id.trim(), reasoningEffort: effort })
            setId('')
            setLabel('')
          }}
        >
          添加
        </Button>
      </div>
    </section>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <p className={cn('px-3 py-4 text-sm text-muted-foreground')}>{text}</p>
}
