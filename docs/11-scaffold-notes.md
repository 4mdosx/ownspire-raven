# raven 骨架文件与既有工具（冻结）

Written before handing work to parallel workstreams. Do not rewrite these;
import them.

## `types/config.ts`
Full config type surface: `RavenConfig`, `ServiceDef`, `Probe`, `MetricProbe`,
`ActionDef`, `EntityDef`, `PublicConfig`.

## `config/env.ts`
`dataDir`, `configCandidates()`, `defaultRegistryFile()`, `resolveDbFile()`,
`RAVEN_VERSION`, `isProduction`.

## `backstage/lib/sandbox.ts`
- `class SandboxError extends Error` with `.code` and `.status`
- `class PathSandbox`:
  - fields: `root`, `filesRoot`, `scriptsRoot`, `tempRoot`, `clipboardRoot`, `quotaBytes`
  - `ensureRoots()`, `toRelative(abs)`, `lexicalAbsolute(rel)`
  - `resolveExisting(rel)` → realpath'd abs, throws `not_found`/`outside_root`
  - `resolveTarget(rel)` / `resolveWrite(rel)` → abs for paths that may not exist
  - `resolveScript(name)` → `{ absolute, relative }`, single segment only
  - `measure({ttlMs})` → `{bytes, files, dirs}` (cache, counts only `filesRoot`)
  - `remainingBytes()`, `assertRoomFor(bytes)`, `reserve(bytes)`, `release(bytes)`,
    `invalidateMeasurement()`
- `parseRelativePath(input, {allowEmpty})` → `string[]` (throws on `..`, `/`, NUL, drive letters)
- `joinRelative(segments)`, `isInside(root, child)`, `isSandboxError(e)`

## `backstage/lib/config.ts`
- `getConfig()` → `{ config: RavenConfig, sandbox: PathSandbox }` (mtime-cached)
- `loadConfigFrom(file)` → same, no cache
- `getSandbox()`, `publicConfig()`, `class ConfigError`, `stripJsonComments(text)`
- `config.services.registryFile` may be relative (resolved against `rootPath`)
  or absolute; `config.dataDir` is the data volume.

## `backstage/lib/http.ts`
- `class ApiError extends Error` (`.code`, `.status`)
- `ok(data)`, `fail(code, error, status)`, `handle(work)`, `readJson(request)`,
  `searchParam(request, key)`, `requireParam(request, key)`

## `backstage/db/database.ts` (all schema handling + queries live here)
`sqlite()`, `dbFile()`, `ensureSchema()`, `pingDatabase()`, `closeDatabase()`,
`all<T>(sql, params)`, `get<T>(sql, params)`, `run(sql, params)` and typed helpers:

- clipboard: `ClipboardRow`, `dbClipboardList(limit, offset?, query?)`,
  `dbClipboardCount()`, `dbClipboardGet(id)`, `dbClipboardByIdem(idemKey)`,
  `dbClipboardInsert(row)`, `dbClipboardDelete(id)`, `dbClipboardClear()`,
  `dbClipboardPrune(keep) → ClipboardRow[]` (deleted rows, oldest first)
- services: `ServiceSnapshotRow`, `dbSnapshotAll()`, `dbSnapshotPut(row)`,
  `dbSnapshotDelete(id)`, `dbSampleInsert(row)`, `dbSampleHistory(id, limit)`,
  `dbSamplePrune(keep)`, `dbMetricInsert(rows[])`, `dbMetricLatest(id)`,
  `dbMetricSeries(id, metric, limit)`, `dbMetricPrune(keep)`
- runs: `RunRow`, `dbRunInsert({script,origin,status,startedAt,triggeredBy}) → id`,
  `dbRunFinish(id, patch)`, `dbRunGet(id)`, `dbRunList(limit, script?)`,
  `dbRunPrune(keep)`

## `backstage/lib/ids.ts`
`ulid(now?)` — 26 chars, lexicographic == chronological. `runTempName(now?)`.

## `backstage/lib/format.ts`
`humanBytes(bytes)`, `toInt(value, fallback, min, max)`, `nowMs()`, `safeJoin(base, ...parts)`.

## `backstage/services/pin.service.ts`
`isPinConfigured()`, `getPinEpoch()`, `getPinStatus()`, `savePin(pin)` → 新 epoch,
`verifyStoredPin(pin)`, `clearStoredPin()`, `hashPin(pin)`, `verifyPinHash(pin, stored)`.
存储在 `settings` 表（`pin.hash` / `pin.epoch` / `pin.updatedAt`）。

⚠️ 散列格式是 `scrypt$N$r$p$salt$hash` 六段式，**不是** navi 的三段式。
参数范围必须显式判（`N` 是 2 的幂、`r`/`p` ≥ 1、内存 ≤ 1 GiB）——
`scrypt$1$2$3$4$5` 恰好也是六字段，而 N=1 会让 node 抛 `RangeError`，
把「PIN 不正确」变成 500。

## `backstage/services/auth.types.ts`
`PIN_LENGTH = 4`，zod schema：`SetupPinSchema` / `UnlockPinSchema` / `UpdatePinSchema`。

## `backstage/services/auth.service.ts`
`SESSION_COOKIE`, `clientIp(request)`, `assertNotRateLimited(ip)`,
`recordLoginFailure(ip)`, `recordLoginSuccess(ip)`, `resetRateLimits()`,
`createSessionToken()`, `verifySessionToken(token)`,
`setupPin(input, ip)`, `loginWithPin(input, ip)`, `updatePin(input, ip)`,
`requireSession()`, `currentSession()`, `sessionCookieOptions(expiresAt)`,
`tokenMatches(provided, expected)`.

三个登录动作都返回 `{ok:true, token, expiresAt}` 或 `{ok:false, errors}`，
`errors` 是字段级的（`{pin:['PIN 不正确']}`），由 route 挂在失败信封的 `details` 上。

`requireSession()` throws `ApiError('unauthorized', ..., 401)`.
⚠️ **已知缺口**：40 个 route 里只有 `/api/services/registry/[id]` 真的调了
`requireSession()`，其余全靠 `proxy.ts` 一道门。而 proxy 跑在 Edge runtime，
读不了 SQLite，所以**换 PIN / 换密钥后旧 cookie 仍能过 proxy 与页面级路由** ——
`pinEpoch` 校验只发生在真正调用了 `requireSession()` 的那条路径上。
要真正做到「换 PIN 立即作废所有会话」，需要给每个路由补 `requireSession()`。

## `proxy.ts`
Public paths: `/login`, `/healthz`, `/api/auth/login`, `/api/auth/setup`,
`/api/agent/gateway`, `/api/ingest/*`.
⚠️ `/api/auth/setup` 必须公开（首次部署没有 PIN 也没有会话），它安全是因为
service 层用 `isPinConfigured()` 把住了。⚠️ `/api/auth/pin` **绝不能公开**。
Unauthenticated API requests get `401 {ok:false,code:'unauthorized'}`.
Unauthenticated page requests redirect to `/login`.
