/**
 * raven 的浏览器侧 HTTP 客户端。
 *
 * ⚠️ **这个文件必须保持客户端安全**：不许 import `node:*`、不许 import
 * `@/backstage/**`（那里全都是 `server-only`），也不许 import `next/headers`。
 * 任何一处漏进来，打包时整条客户端链路直接失败，而且报错点常常指向别处。
 *
 * 三条纪律（契约 §2 / §9）：
 *
 * 1. 统一信封 `{ ok: true, ... }` / `{ ok: false, code, error }`，失败一律抛
 *    `ApiClientError`，**永远带上服务端那句 `error`**。界面靠它说话，客户端
 *    自己编一句「请求失败」等于把后端已经解释清楚的原因丢掉。
 * 2. HTTP 500 是 Next 的 HTML 错误页，不是 JSON。直接 `response.json()` 会抛
 *    `SyntaxError: Unexpected token '<'`，界面上就成了「网络错误」—— 那是假的。
 *    所以先读文本再解析，非 JSON 统一变成 `bad_response` + HTTP 状态码。
 * 3. `AbortSignal` 一路透传：页面卸载后还挂在 fetch 上的请求要在 `finally`
 *    里能识别为「主动取消」，而不是当成错误弹一个红条。
 */

/** 服务端返回的信封（形状固定，字段全部可选 —— 出于防御，不假设 payload）。 */
export type ApiEnvelope<T> = { ok: boolean; code?: string; error?: string } & Partial<T>

export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  /**
   * 服务端在失败信封里带的机读附加数据（见 `backstage/lib/http.ts` 的 `ApiError.details`）。
   * 登录用它拿字段级错误 `{ pin: ['PIN 不正确'] }`，好把提示贴在对应输入框旁边。
   */
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** 从失败信封里取出字段级错误，形如 `{ pin: ['PIN 不正确'] }`。 */
export function fieldErrors(error: unknown): Record<string, string[]> {
  if (!(error instanceof ApiClientError)) return {}
  const raw = error.details?.['errors']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === 'string')
  }
  return out
}

/** 请求被主动取消（AbortController / 组件卸载）。界面应当**静默忽略**这类失败。 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return false
}

/** 判断是不是「需要重新登录」。401 在界面上要给一个明确的去登录页的出口。 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 401 || error.code === 'unauthorized')
}

export type QueryValue = string | number | boolean | null | undefined

/**
 * 构造查询串。
 *
 * ⚠️ 一律 `encodeURIComponent`：raven 的路径/搜索词基本都是中文，漏编码时
 * `fetch` 会容忍（自动转义），但**已经编码过的值会被二次编码**，
 * 于是服务端解出来是乱码。所以规则是：调用方给原文，这里负责编码。
 */
export function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** 拼 API 地址（含查询串）。`<img src>` / `window.open` 这类「不能走 fetch」的地方用它。 */
export function apiUrl(path: string, params: Record<string, QueryValue> = {}): string {
  return `${path}${queryString(params)}`
}

/** `{ok:false}` 时按信封里的字段构造错误；缺字段时按 HTTP 状态兜一句人话。 */
function errorFromEnvelope(
  envelope: { code?: unknown; error?: unknown; details?: unknown },
  status: number,
  context: string
): ApiClientError {
  const code = typeof envelope.code === 'string' && envelope.code !== '' ? envelope.code : 'error'
  const message =
    typeof envelope.error === 'string' && envelope.error !== ''
      ? envelope.error
      : `请求失败（HTTP ${status}，code=${code}），服务端没有给出说明。${context}`
  const details =
    envelope.details !== null && typeof envelope.details === 'object' && !Array.isArray(envelope.details)
      ? (envelope.details as Record<string, unknown>)
      : undefined
  return new ApiClientError(code, message, status, details)
}

/** 响应体解析结果。用可辨识联合，避免在 `never` 上取属性。 */
type ParsedBody =
  | { kind: 'empty' }
  | { kind: 'json'; json: unknown }
  | { kind: 'text'; text: string }

async function readBody(response: Response): Promise<ParsedBody> {
  const text = await response.text()
  if (text.trim() === '') return { kind: 'empty' }
  try {
    return { kind: 'json', json: JSON.parse(text) as unknown }
  } catch {
    return { kind: 'text', text }
  }
}

function badResponse(status: number, path: string): ApiClientError {
  return new ApiClientError(
    'bad_response',
    `服务器返回了非 JSON 响应（HTTP ${status}）：${path}。多半是服务端未捕获的异常或反向代理的错误页。`,
    status
  )
}

/**
 * 解析一次响应：非 2xx 或 `ok:false` 都抛 `ApiClientError`。
 *
 * `allowMissingEnvelope` 给流式/裸响应（如 SSE）用 —— 那些响应体不是信封，
 * 但状态码仍然要判。
 */
export async function readEnvelope<T>(
  response: Response,
  path: string,
  options: { allowMissingEnvelope?: boolean } = {}
): Promise<T> {
  const body = await readBody(response)

  if (body.kind === 'text') {
    // 有正文但不是 JSON。哪怕状态码是 200 也不能当成成功：那是后端漏了 handle()。
    throw badResponse(response.status, path)
  }

  if (body.kind === 'empty') {
    if (!response.ok) throw new ApiClientError('http_error', `请求失败（HTTP ${response.status}）：${path}`, response.status)
    // 空体 + 200：只有明确允许缺信封的调用方才接受（其它情况是后端违约）。
    if (options.allowMissingEnvelope) return {} as T
    throw new ApiClientError('malformed_response', `响应是空的（HTTP ${response.status}）：${path}`, response.status)
  }

  // ⚠️ 这里用 `ApiEnvelope<Record<string, unknown>>` 而不是 `ApiEnvelope<T>`：
  // 后者里的 `Partial<T>` 在 T 是泛型时会参与类型收窄，`envelope.code` 这样的
  // 字段在某些实例化下会被推成 `never`，报出「Property 'code' does not exist
  // on type 'never'」这种看起来毫无道理的错。信封字段是运行时数据，按
  // unknown 读、逐个判类型即可。
  const envelope = body.json as ApiEnvelope<Record<string, unknown>>
  if (envelope === null || typeof envelope !== 'object') {
    if (!response.ok) throw new ApiClientError('http_error', `请求失败（HTTP ${response.status}）：${path}`, response.status)
    if (options.allowMissingEnvelope) return {} as T
    throw badResponse(response.status, path)
  }

  if (envelope.ok === false) throw errorFromEnvelope(envelope, response.status, `路径：${path}`)

  if (envelope.ok !== true) {
    // 信封里没有 ok 字段。状态码是判断依据，但要把这件事说清楚 ——
    // 契约要求每个响应都带 ok，缺了就是后端违约，不该静默接受。
    if (!response.ok) throw errorFromEnvelope(envelope, response.status, `路径：${path}`)
    if (!options.allowMissingEnvelope) {
      throw new ApiClientError('malformed_response', `响应缺少 ok 字段（HTTP ${response.status}）：${path}`, response.status)
    }
  }

  return envelope as T
}

type RequestOptions = {
  signal?: AbortSignal
  /** 只在 fetch 层面失败（断网、DNS）时用；服务端的说明永远优先。 */
  networkHint?: string
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions & { allowMissingEnvelope?: boolean } = {}
): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store' }
  if (options.signal) init.signal = options.signal
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ApiClientError('network_error', options.networkHint ?? `连不上服务器：${path}`, 0)
  }
  return readEnvelope<T>(response, path, { allowMissingEnvelope: options.allowMissingEnvelope })
}

export function apiGet<T>(path: string, params: Record<string, QueryValue> = {}, options: RequestOptions = {}): Promise<T> {
  return request<T>('GET', apiUrl(path, params), undefined, options)
}

export function apiPost<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>('POST', path, body ?? {}, options)
}

export function apiPatch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>('PATCH', path, body ?? {}, options)
}

export function apiPut<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  // ⚠️ 与 apiGet/apiPost/apiPatch 保持同一形态：`request(method, path, body, options)`。
  // 原写法 `request(path, { ...options, method: 'PUT' })` 把 options 塞到了第二个
  // 参数（body 的位置），而且自己 JSON.stringify 了一遍 body ——
  // 那样会绕过 request 里统一设置 Content-Type 与 undefined body 的判断。
  return request<T>('PUT', path, body ?? {}, options)
}

export function apiDelete<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  // DELETE 允许带 body：契约里 `POST /api/files/delete` 用的是 POST，但
  // `DELETE /api/clipboard/[id]` 不带体，两种都要能发。
  return request<T>('DELETE', path, body, options)
}

export type UploadHandle = { abort: () => void }

export type UploadCallbacks = {
  onProgress?: (sent: number, total: number) => void
  onDone?: (entry: unknown, response: Response) => void
  /** 已确认是信封错误（4xx/5xx 且 body 是 JSON）时回调，界面直接显示 `message`。 */
  onError?: (error: ApiClientError) => void
}

/**
 * 裸流上传。
 *
 * ⚠️ 这里**必须**用 `XMLHttpRequest`：`fetch` 至今没有可用的上传进度
 * （`ReadableStream` 上传请求体在 Safari/Firefox 上不支持），而文件管理器
 * 的进度条是本页的硬需求。
 *
 * ⚠️ **不设 `Content-Type`**：契约要求 body 是裸流，服务端按裸流落盘。
 * 让浏览器自己带 `multipart/form-data` 会改变 body 形状。
 * 是否覆盖由 `?overwrite=1` 查询参数表达，不靠请求头。
 *
 * 返回一个可 `abort()` 的句柄 —— 上传大文件时用户要能取消，否则只能刷新页面。
 */
export function apiUpload(
  path: string,
  file: Blob,
  params: Record<string, QueryValue> = {},
  callbacks: UploadCallbacks = {}
): UploadHandle {
  const xhr = new XMLHttpRequest()
  const url = apiUrl(path, params)

  xhr.open('PUT', url, true)
  xhr.withCredentials = true
  xhr.responseType = 'text'

  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return
    callbacks.onProgress?.(event.loaded, event.total)
  }

  xhr.onload = () => {
    let json: unknown = null
    try {
      json = xhr.responseText.trim() === '' ? null : JSON.parse(xhr.responseText)
    } catch {
      json = null
    }
    const httpOk = xhr.status >= 200 && xhr.status < 300

    if (json === null || typeof json !== 'object') {
      callbacks.onError?.(badResponse(xhr.status, url))
      return
    }
    const envelope = json as ApiEnvelope<Record<string, unknown>>
    if (envelope.ok === false) {
      callbacks.onError?.(errorFromEnvelope(envelope, xhr.status, `上传目标：${url}`))
      return
    }
    if (!httpOk) {
      callbacks.onError?.(new ApiClientError('http_error', `上传失败（HTTP ${xhr.status}）：${url}`, xhr.status))
      return
    }
    callbacks.onDone?.(envelope, xhr.response as unknown as Response)
  }

  xhr.onerror = () => {
    callbacks.onError?.(new ApiClientError('network_error', `上传中断，连接不上服务器：${url}`, 0))
  }
  xhr.ontimeout = () => {
    callbacks.onError?.(new ApiClientError('timeout', `上传超时：${url}`, 0))
  }
  xhr.onabort = () => {
    callbacks.onError?.(new ApiClientError('aborted', '上传已取消。', 0))
  }

  xhr.send(file)

  return {
    abort: () => xhr.abort(),
  }
}

export type SseEvent = { event: string; data: string }

/**
 * 极简 SSE 解析器。
 *
 * ⚠️ 三个必须做对的地方（踩过）：
 * 1. **按块解码**：`TextDecoder` 必须带 `{ stream: true }`，否则一个 UTF-8
 *    汉字被切在两个 chunk 之间时会解出 U+FFFD。中文日志每几行就会遇到。
 * 2. **事件分隔是空行**：`data:` 可以出现多行，按 `\n` 累加，遇到空行才 dispatch。
 * 3. **`\r\n` 也要认**：某些代理会改写换行。
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 用空行分隔事件；先归一化 CRLF，再按 \n\n 切。
      buffer = buffer.replace(/\r\n/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseSseBlock(raw)
        if (parsed) yield parsed
        boundary = buffer.indexOf('\n\n')
      }
    }
    // 收尾：没有以空行结束的最后一帧（服务端被掐断）也要发出来，
    // 否则 `done` 事件会凭空消失，界面永远停在「运行中」。
    const tail = `${buffer}${decoder.decode()}`
    const parsed = parseSseBlock(tail)
    if (parsed) yield parsed
  } finally {
    // ⚠️ 只 `releaseLock()`，**不** `cancel()`：`cancel` 会连带把还没读完的
    // 网络流关掉。如果这个生成器是因为消费方提前 `break` 而退出的，
    // cancel 是合理的；但正常跑完（done）时 cancel 会给服务端一个多余的
    // 中断信号（在某些反向代理下会写一行 error 日志）。用 releaseLock 让
    // GC 自己处理，同时保证锁不会泄漏。
    reader.releaseLock()
  }
}

function parseSseBlock(raw: string): SseEvent | null {
  if (raw.trim() === '') return null
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // 规范：冒号后**一个**空格要去掉，之后的空格是数据的一部分。
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

export type StreamOptions = {
  /** 事件回调。回调里抛错不会中断流 —— 一个事件渲染失败不该让整次运行的结果丢掉。 */
  onEvent: (event: string, data: unknown) => void
  /** 网络层失败（连不上、非 JSON 错误页）。SSE 里的 `error` 事件走 onEvent。 */
  onTransportError?: (error: ApiClientError) => void
  signal?: AbortSignal
  body?: unknown
  /** 显示用的路径，进错误消息。 */
  label?: string
}

/** 上传进度回调，`apiStreamForm` 用。 */
export type StreamFormOptions = Omit<StreamOptions, 'body'> & {
  onProgress?: (sent: number, total: number) => void
}

/**
 * 发起一次 SSE 请求并逐事件回调。
 *
 * 内部走 `runStream`。⚠️ `body` 是 JSON；multipart 的流式接口用
 * `apiStreamForm`（同样能看到上传进度，因为 fetch 拿不到上传进度，
 * 那个函数用 XHR 读 `responseText` 的增量）。
 */
export async function apiStream(path: string, options: StreamOptions): Promise<void> {
  const { body, ...rest } = options
  return runStream(
    path,
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    rest
  )
}

/**
 * GET 版的事件流（agent 契约 §六「断线重连」）：回放 + 续流是只读的，
 * 走 GET 才对。`?after=seq` 由调用方自己拼进 path。
 */
export async function apiStreamGet(path: string, options: Omit<StreamOptions, 'body'>): Promise<void> {
  return runStream(
    path,
    {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    },
    options
  )
}

/**
 * multipart 的流式请求（`POST /api/scripts/run-temp`）。
 *
 * ⚠️ 这里**故意不用 fetch**。要同时满足「上传进度」和「读响应事件流」，
 * fetch 缺一半能力：
 * - `fetch` 没有上传进度（请求体流在所有主流浏览器上都不给进度事件）；
 * - `XMLHttpRequest` 的 `responseType === 'text'` 在**流结束前拿不到**
 *   `responseText` 的增量（规范如此），中途去读会抛 InvalidStateError。
 *
 * 所以用 XHR + `onprogress`（读 `responseText` 增量）+ 手工按 SSE 帧切分。
 * 代价：这段解析逻辑和 `parseSseStream` 有一处重复，但两者的数据源不同
 * （一个来自 `ReadableStream`，一个来自不断变长的字符串），合并反而要造一个
 * 更绕的抽象。**重复的是 20 行状态机，不是业务逻辑。**
 */
export function apiStreamForm(
  path: string,
  form: FormData,
  params: Record<string, QueryValue>,
  options: StreamFormOptions
): UploadHandle & { done: Promise<void> } {
  const xhr = new XMLHttpRequest()
  const url = apiUrl(path, params)
  xhr.open('POST', url, true)
  xhr.withCredentials = true

  /** 已经消费到的响应文本长度，用来做增量切片。 */
  let consumed = 0
  let buffer = ''
  let finished = false

  const drain = () => {
    // readyState 3（LOADING）时 responseText 才可能可读；其他状态读它会抛错。
    if (xhr.readyState < 3) return
    let text: string
    try {
      text = xhr.responseText
    } catch {
      return
    }
    buffer += text.slice(consumed).replace(/\r\n/g, '\n')
    consumed = text.length

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      emit(raw)
      boundary = buffer.indexOf('\n\n')
    }
  }

  const emit = (raw: string) => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') event = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length === 0) return
    let data: unknown = dataLines.join('\n')
    try {
      data = JSON.parse(data as string) as unknown
    } catch {
      // 保持原始文本，理由同 parseSseStream。
    }
    try {
      options.onEvent(event, data)
    } catch {
      // 回调自己炸了不连累后面的帧。
    }
  }

  /**
   * 收尾。
   *
   * ⚠️ 无论成功、失败还是取消，`resolveDone()` 都必须被调用 —— 调用方
   * （`runTemp`）是 `await` 这个 promise 来把「运行中」状态收回去的，
   * 漏掉任何一条路径都会让按钮永远停在 loading，用户只能刷新页面。
   */
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const finish = (error: string | null) => {
    if (finished) return
    finished = true
    drain()
    if (error !== null) {
      options.onTransportError?.(new ApiClientError('stream_error', error, 0))
      resolveDone()
      return
    }
    // 收尾：没有以空行结束的最后一帧也要发出去（服务端被掐断时 `done` 事件
    // 会以这种方式到达，丢掉它界面就永远停在「运行中」）。
    const tail = buffer.trim()
    if (tail !== '') emit(tail)
    resolveDone()
  }

  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return
    options.onProgress?.(event.loaded, event.total)
  }
  xhr.onprogress = () => drain()
  xhr.onreadystatechange = () => drain()
  xhr.onload = () => {
    const httpOk = xhr.status >= 200 && xhr.status < 300
    if (!httpOk) {
      // 头之前的失败走信封（`handle()` 包的），把服务端原话透出来：
      // 「脚本名不对」「并发满了」「临时目录建不出来」都是这一类。
      let error: ApiClientError
      try {
        const parsed = JSON.parse(xhr.responseText) as unknown
        if (parsed !== null && typeof parsed === 'object') {
          error = errorFromEnvelope(parsed as ApiEnvelope<Record<string, unknown>>, xhr.status, `路径：${url}`)
        } else {
          error = badResponse(xhr.status, url)
        }
      } catch {
        error = badResponse(xhr.status, url)
      }
      finish(error.message)
      return
    }
    finish(null)
  }
  xhr.onerror = () => finish(`连不上服务器：${url}`)
  xhr.ontimeout = () => finish(`请求超时：${url}`)
  xhr.onabort = () => {
    // 主动取消不是错误：调用方是因为卸载或用户点了中止。但**必须**收尾，
    // 否则 await done 的调用方永远醒不过来。
    finished = true
    resolveDone()
  }

  xhr.send(form)
  return { abort: () => xhr.abort(), done }
}

/**
 * 发起请求并逐事件读取 SSE。
 *
 * `fetch` + `response.body` 而不是 `EventSource`：契约里的流式接口都是
 * **POST + 请求体**，而 `EventSource` 只支持 GET、不能带请求体、也不能设
 * 自定义头。所以这里自己解析。
 *
 * ⚠️ 取消（`AbortController`）要在调用方 `useEffect` 的清理函数里触发，
 * 否则组件卸载后回调还在 `setState`（React 19 会警告）并且连接一直挂着。
 */
async function runStream(path: string, init: RequestInit, options: Omit<StreamOptions, 'body'>): Promise<void> {
  const label = options.label ?? path
  let response: Response
  try {
    response = await fetch(path, { ...init, signal: options.signal })
  } catch (error) {
    if (isAbortError(error)) return
    options.onTransportError?.(new ApiClientError('network_error', `连不上服务器：${label}`, 0))
    return
  }

  // 错误发生在响应头之前时，服务端仍会走信封（`handle()` 包的）。所以先按
  // 普通响应解析一次，把服务端那句 error 原样透出来 —— 这正是「不能吞错」的场景：
  // 脚本名不对、并发满了、脚本不存在，全都在这里返回。
  //
  // ⚠️ 这里**不能**「解析成功就继续读流」：契约保证流式接口一定带
  // `text/event-stream`，不带就说明这次调用根本不是流（或者被代理改写了响应），
  // 按流去读只会把一句 JSON 当事件解析出一堆空帧，界面停在「运行中」。
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    try {
      await readEnvelope<Record<string, unknown>>(response.clone(), label, { allowMissingEnvelope: true })
      // 信封说 ok，但 content-type 不是事件流。这不是能靠猜继续下去的情况。
      options.onTransportError?.(
        new ApiClientError(
          'not_event_stream',
          `响应不是事件流（HTTP ${response.status}，content-type=${response.headers.get('content-type') ?? '无'}）：${label}`,
          response.status
        )
      )
    } catch (error) {
      options.onTransportError?.(
        error instanceof ApiClientError ? error : new ApiClientError('bad_response', `请求失败：${label}`, response.status)
      )
    }
    return
  }

  if (!response.body) {
    options.onTransportError?.(new ApiClientError('no_body', `响应没有可读取的流：${label}`, response.status))
    return
  }

  try {
    for await (const chunk of parseSseStream(response.body, options.signal)) {
      let data: unknown = chunk.data
      try {
        data = JSON.parse(chunk.data) as unknown
      } catch {
        // 不是 JSON 就按原文给出去 —— SSE 规范允许纯文本 data，
        // 服务端某天扩了一个纯文本事件时，界面不该整条丢掉。
      }
      try {
        options.onEvent(chunk.event, data)
      } catch {
        // 渲染回调自己炸了，不要连累后面的事件。
      }
    }
  } catch (error) {
    if (isAbortError(error)) return
    options.onTransportError?.(
      error instanceof ApiClientError
        ? error
        : new ApiClientError('stream_error', `读取事件流失败：${label}（${error instanceof Error ? error.message : '未知错误'}）`, 0)
    )
  }
}

/**
 * multipart 上传（剪切板附件、临时脚本）。**不走 apiUpload**：那两个接口是
 * `POST` + `multipart/form-data` + 文件字段名固定，裸流那套不适用。
 *
 * 用 XHR 是为了拿到上传进度（附件最大 32MiB，没有进度条用户会以为卡死）。
 */
export function apiUploadForm<T>(
  path: string,
  form: FormData,
  params: Record<string, QueryValue> = {},
  callbacks: Omit<UploadCallbacks, 'onDone'> & { onDone?: (body: T) => void } = {}
): UploadHandle {
  const xhr = new XMLHttpRequest()
  const url = apiUrl(path, params)
  xhr.open('POST', url, true)
  xhr.withCredentials = true

  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return
    callbacks.onProgress?.(event.loaded, event.total)
  }

  xhr.onload = () => {
    let json: unknown = null
    try {
      json = xhr.responseText.trim() === '' ? null : JSON.parse(xhr.responseText)
    } catch {
      json = null
    }
    const envelope = json as ApiEnvelope<T> | null
    if (envelope === null || typeof envelope !== 'object') {
      callbacks.onError?.(badResponse(xhr.status, url))
      return
    }
    if (envelope.ok === false) {
      const code = typeof envelope.code === 'string' ? envelope.code : 'error'
      const message = typeof envelope.error === 'string' ? envelope.error : `上传失败（HTTP ${xhr.status}）。`
      callbacks.onError?.(new ApiClientError(code, message, xhr.status))
      return
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      callbacks.onError?.(new ApiClientError('http_error', `上传失败（HTTP ${xhr.status}）：${url}`, xhr.status))
      return
    }
    callbacks.onDone?.(envelope as T)
  }
  xhr.onerror = () => callbacks.onError?.(new ApiClientError('network_error', `上传中断，连接不上服务器：${url}`, 0))
  xhr.onabort = () => callbacks.onError?.(new ApiClientError('aborted', '上传已取消。', 0))
  xhr.send(form)
  return { abort: () => xhr.abort() }
}
