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

## `backstage/services/auth.service.ts`
`SESSION_COOKIE`, `hashPassword`, `verifyPasswordHash`, `clientIp(request)`,
`assertNotRateLimited(ip)`, `recordLoginFailure(ip)`, `recordLoginSuccess(ip)`,
`createSessionToken()`, `verifySessionToken(token)`, `login(username, password, ip)`,
`requireSession()`, `currentSession()`, `sessionCookieOptions(expiresAt)`,
`tokenMatches(provided, expected)`, `configFingerprint()`, `resetRateLimits()`.

`requireSession()` throws `ApiError('unauthorized', ..., 401)`.
Every mutating API route except `/api/ingest/*` and `/api/auth/login` is already
covered by `proxy.ts`; a route that needs the session object should still call
`requireSession()`.

## `proxy.ts`
Public paths: `/login`, `/healthz`, `/api/auth/login`, `/api/ingest/*`.
Unauthenticated API requests get `401 {ok:false,code:'unauthorized'}`.
Unauthenticated page requests redirect to `/login`.
