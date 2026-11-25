# reqly SDK guide (2.1.0)

The SDK is a thin, opinionated layer over the core client. It ships inside
`reqlyproto` — there is no second package to install.

```sh
npm install reqlyproto
```

```ts
import { createReqlySdk } from "reqlyproto"
```

## Connect

```ts
const sdk = await createReqlySdk({
  session: MT_SESSION,                 // Worker secret, never source code
  dcSessions: DC_SESSIONS,             // optional: { 2: session2, 3: session3 }
  tokenSecret: STREAM_TOKEN_SECRET,    // optional: needed for issueToken()
  maxWorkers: 4,                       // optional: parallel block ceiling
  freshSocket: false,                  // optional: one socket per RPC
  cache: memoryCache,                  // optional: default byte cache
  retry: { retries: 3 },               // optional: default retry policy
})
```

All core `ReqlyOptions` are accepted. The underlying client is always available
as `sdk.client` for raw TL calls.

## Download a document

```ts
const bytes = await sdk.download(document, {
  refresh: async () => {
    const [fresh] = await sdk.client.getMessages(channelId, accessHash, [messageId])
    return fresh!
  },
  onProgress: (done, total) => console.log(`${done}/${total}`),
})
```

- Splits the document into 1 MB blocks (Telegram's hard limit).
- Uses the adaptive 2→4 worker pool with backoff.
- Forwards `refresh` to **every** `upload.getFile` call, so an expired
  `file_reference` is recovered inside the download instead of failing halfway.
- Reads through the configured cache; a repeated download costs zero Telegram
  RPCs for blocks that are still valid.
- Reports progress after each completed block. The counter is monotonic even
  though the pool resolves blocks out of order.
- `length` limits the download to a leading slice; `blockSize` overrides the
  1 MB block size (never above 1 MB).

Per-call `cache` and `retry` override the SDK defaults.

## Read an arbitrary range

```ts
const chunk = await sdk.range(document, 10_485_760, 15_728_640, {
  refresh: refreshDocument,
})
```

The range is inclusive. It is validated (`start >= 0`, `end >= start`, both
integers), served from cache when the exact range is present, and retried with
the configured policy on transient failures.

## Stream with backpressure

```ts
const stream = sdk.stream(document, {
  chunkSize: 512 * 1024,
  onProgress: (bytes) => console.log(bytes),
  signal: request.signal,
  refresh: refreshDocument,
})

return new Response(stream, {
  headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" },
})
```

`ReadableStream.pull` fetches one block at a time, so the consumer controls
flow. Each pull goes through the byte cache and the retry policy. Aborting the
signal stops the next pull with an error.

## Byte cache

The SDK needs only two methods, so any storage can participate:

```ts
interface SdkCache {
  match(key: string): Uint8Array | undefined | Promise<Uint8Array | undefined>
  put(key: string, bytes: Uint8Array, ttlSeconds?: number): void | Promise<void>
}
```

### `MemoryCache`

```ts
import { MemoryCache } from "reqlyproto"

const cache = new MemoryCache({
  maxBytes: 64 * 1024 * 1024,   // default 64 MiB
  ttlSeconds: 86_400,           // default 24 h; 0 disables expiry
})
```

- LRU eviction with a hard byte budget.
- TTL per cache and per `put()`.
- `match()` returns a copy, so a consumer cannot mutate cached bytes.
- `stats` exposes `hits`, `misses`, `evictions`, `entries` and `bytes`.
- `delete(key)`, `clear()` and `size` are available for housekeeping.

### Edge Cache API

```ts
import { createCacheApiStore } from "reqlyproto"

const cache = createCacheApiStore(caches.default, 3600)
const sdk = await createReqlySdk({ session: MT_SESSION, cache })
```

Keys must be absolute URLs. TTL is encoded in `Cache-Control`; the platform may
clamp it. Cache API calls count as subrequests, so opt in deliberately for large
files.

### Cache keys

```ts
const key = ReqlySdk.cacheKey(document, offset, length)
// reqly:<id>:<accessHash>:<fileReferenceHex>:<offset>:<length>
```

The `file_reference` fingerprint is part of the key. Telegram can re-issue the
same document id with a new reference, and bytes fetched under a stale reference
must never satisfy the refreshed document.

Only complete blocks are cached. A short read in the middle of a file is
discarded, so a later seek cannot be served truncated bytes.

## Retry policy

```ts
import { withRetry, isRetryableError, DEFAULT_RETRY_POLICY } from "reqlyproto"

const entries = await withRetry(() => sdk.hashes(document), {
  retries: 3,
  baseDelayMs: 150,
  maxDelayMs: 4_000,
  jitter: 0.2,
  respectFloodWait: true,
  maxFloodWaitSeconds: 60,
  signal: request.signal,
})
```

| Field | Default | Meaning |
| --- | ---: | --- |
| `retries` | `2` | additional attempts after the first failure |
| `baseDelayMs` | `150` | first backoff delay |
| `maxDelayMs` | `4000` | upper bound for one delay |
| `jitter` | `0.2` | ±20% randomisation |
| `respectFloodWait` | `true` | absorb small `FLOOD_WAIT_X` |
| `maxFloodWaitSeconds` | `60` | longer floods fail immediately |
| `signal` | — | cancels pending waits and further attempts |

`isRetryableError()` accepts `FloodWaitError`, `RpcError` with `429` or `5xx`,
and the transport messages reqly already treats as transient. File-specific
errors (`FILE_REFERENCE_EXPIRED`, `FILE_MIGRATE_X`) are **not** blindly repeated:
the client handles them with explicit refresh and DC-migration flows.

## Verify integrity

```ts
const entries = await sdk.hashes(document, refreshDocument)
// each entry: { offset, limit, hash }
```

Hashes come from `upload.getFileHashes`, follow `FILE_MIGRATE_X` when a target
DC session is registered, and accept a refresh callback. Do not hash inside a
tight Worker request — see [`BENCHMARKS.md`](./BENCHMARKS.md).

## Short-lived stream tokens

```ts
const token = await sdk.issueToken({ m: messageId, w: "work-1", k: "stream" }, 60)
const payload = await sdk.verifyToken(token)
// { m, w, e, k } or null when invalid/expired
```

| Field | Type | Meaning |
| --- | --- | --- |
| `m` | `number` | Telegram message id in the archive channel |
| `w` | `string` | internal work id from the catalog |
| `e` | `number` | expiry, epoch seconds (added automatically) |
| `k` | `"stream" \| "download"` | permitted action |

Tokens are `<base64url payload>.<base64url HMAC-SHA256 signature>`. Keep the
secret in a Worker secret; rotate it by changing the value in configuration.
Never place a token or the secret in a URL that gets logged.

## One-call Worker handler

```ts
export default sdk.worker({
  resolveDocument: () => document,
  maxWorkers: 4,
  maxInFlight: 8,
  cache: false,
})
```

`sdk.worker()` inherits the SDK session and connection options, so you do not
repeat secrets. An explicit `session` or `connectOptions` still wins.

The handler adds `Range`, `206`, `Content-Range`, `Accept-Ranges`, `ETag`,
`If-None-Match`/`304`, `If-Range`, `HEAD`, `416` and `405`. For lower-level
control use `createFileResponse`, `createFileRequestHandler` or
`streamFileRange`.

## Closing

```ts
sdk.close()
```

`close()` releases every reusable connection. In a Worker, call it at the end
of the request or rely on isolate teardown; in a long-running Node process,
close explicitly on shutdown.

## Design rules

1. **Secrets stay outside source control.** `session`, `dcSessions`,
   `tokenSecret` and bot tokens come from environment/secret bindings.
2. **One instance per request in Workers.** No shared mutable module state.
3. **Respect the 1 MB protocol limit.** Aggregate into 2–8 MB HTTP responses.
4. **Do not hash in the streaming hot path.** Verify out of band and cache.
5. **Use the SDK or the primitives — both are first-class.** Nothing here hides
   `TlWriter`, `Connection` or `igeEncrypt`.
6. **Cache by reference, not just by id.** `ReqlySdk.cacheKey()` already does.
