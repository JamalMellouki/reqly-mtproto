# reqly cookbook

Short, copy-paste recipes for common workloads. All examples assume:

```ts
import { ... } from "reqlyproto"
```

Secrets always come from environment bindings. Never paste a session string into
source code, an issue or a URL.

## 1. One reusable client in Node

```ts
import { Reqly } from "reqlyproto"

let client: Reqly | undefined

export async function getClient(): Promise<Reqly> {
  if (!client) client = await Reqly.connect(process.env.REQLY_SESSION!, { timeoutMs: 30_000 })
  return client
}

process.on("SIGTERM", () => {
  client?.close()
  process.exit(0)
})
```

## 2. Authenticated range proxy

```ts
import { createWorkerHandler } from "reqlyproto"

export interface Env {
  MT_SESSION: string
  RANGE_TOKEN: string
}

export default {
  fetch(request: Request, env: Env) {
    const handler = createWorkerHandler({
      session: env.MT_SESSION,
      authorize: (req) => req.headers.get("x-range-token") === env.RANGE_TOKEN,
      resolveDocument: async () => resolveDocument(request),
      maxWorkers: 4,
      maxInFlight: 8,
    })
    return handler.fetch(request)
  }
}
```

The handler answers `405`, `401`, `206`, `304`, `416`, `HEAD` and `GET` without
application code.

## 3. Cache API with validators

```ts
import { createCacheApiStore, createReqlySdk } from "reqlyproto"

const cache = createCacheApiStore(caches.default, 3600)
const sdk = await createReqlySdk({ session: env.MT_SESSION, cache })

return sdk.worker({
  resolveDocument: () => document,
  cache: caches.default,   // HTTP response cache, separate from the byte cache
})
```

- The **byte cache** stores 1 MB blocks and serves `download`, `range` and
  `stream` without Telegram RPCs.
- The **HTTP cache** stores the assembled response for repeated browser
  requests.
- `ETag` and `If-None-Match` produce `304` responses for unchanged documents.

## 4. Cache-first SDK download

```ts
import { MemoryCache, createReqlySdk } from "reqlyproto"

const sdk = await createReqlySdk({
  session: env.MT_SESSION,
  cache: new MemoryCache({ maxBytes: 32 * 1024 * 1024, ttlSeconds: 1800 }),
})

const bytes = await sdk.download(document, {
  onProgress: (done, total) => console.log(`${Math.round(done / total * 100)}%`),
})
```

Only complete blocks are cached. A short read in the middle of a file is
discarded, so a later seek cannot be served truncated bytes.

## 5. Retry a hash lookup

```ts
import { withRetry } from "reqlyproto"

const entries = await withRetry(() => sdk.hashes(document), {
  retries: 3,
  baseDelayMs: 150,
  maxDelayMs: 4_000,
  jitter: 0.2,
  respectFloodWait: true,
  signal: request.signal,
})
```

`withRetry` repeats transport failures, `429`, `5xx` and `FLOOD_WAIT` only. It
never blindly repeats `FILE_REFERENCE_EXPIRED` or `FILE_MIGRATE_X`; those need
a refresh or a different DC.

## 6. Verify every downloaded block

```ts
import { verifyChunk } from "reqlyproto"

const entries = await sdk.hashes(document)
for (const entry of entries) {
  const bytes = await sdk.range(document, entry.offset, entry.offset + entry.limit - 1)
  if (!(await verifyChunk(bytes, entry))) {
    throw new Error(`hash mismatch at ${entry.offset}`)
  }
}
```

Do not verify inside the streaming hot path on a tight CPU budget. Hash once,
cache the result, and verify out of band.

## 7. Stream to a `Response` with backpressure

```ts
const stream = sdk.stream(document, {
  chunkSize: 512 * 1024,
  signal: request.signal,
  onProgress: (bytes) => console.log("emitted", bytes),
})

return new Response(stream, {
  headers: {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
  },
})
```

`ReadableStream.pull` fetches one block at a time. Aborting the signal stops the
next pull with an error, which closes the response.

## 8. Multi-bot pool over D1

Schema:

```sql
CREATE TABLE bot_sessions (
  bot_id       INTEGER PRIMARY KEY,
  session      TEXT NOT NULL,
  channel_hash TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1
);
```

Worker:

```ts
import { attachStreamSocket, createBotPool, createWorkerWebSocketHandler } from "reqlyproto"

export default {
  async fetch(request: Request, env: Env) {
    const pool = await createBotPool({
      d1: env.DB,
      channelId: 4481677417n,
      messageId: 1956,
      limit: 4,
      apiId: Number(env.TELEGRAM_API_ID),
    })
    if (pool.clients.length === 0) {
      return new Response("no bot sessions", { status: 503 })
    }
    const handler = createWorkerWebSocketHandler({
      ...pool,
      maxWorkers: 1,
      maxInFlight: 4,
      maxBufferedBytes: 8 * 1024 * 1024,
    })
    return handler.fetch(request)
  }
}
```

Each accepted socket owns its pool copy; closing one socket never closes a
session that another socket is still streaming from.

## 9. Abort a long download

```ts
const controller = new AbortController()
const stream = sdk.stream(document, { signal: controller.signal })

// Later, for example when the browser tab closes:
controller.abort(new Error("client disconnected"))
```

For `withRetry`, pass the same signal in the policy; pending waits reject
immediately.

## 10. Resolve a channel hash for a bot

Some bots can use a zero channel hash in `inputChannel`, but file locations need
the real one:

```ts
const hash = await client.getChannelAccessHash(channelId)
const documents = await client.getMessages(channelId, hash, [messageId])
```

## 11. Synthetic tests without Telegram

`Reqly` is a class, but the helpers only need `getFile` and
`getFilesParallel`. In tests, pass a small object with those two methods, or use
`MemoryCache` and `withRetry` directly:

```ts
import { MemoryCache, withRetry } from "reqlyproto"

const cache = new MemoryCache({ maxBytes: 1024, ttlSeconds: 0 })
let calls = 0
const value = await withRetry(async () => {
  calls += 1
  if (calls < 2) throw new Error("reqly: RPC timed out")
  return cache.match("k") ?? new Uint8Array([1, 2, 3])
}, { retries: 2, baseDelayMs: 1, jitter: 0 })
```

The repository's own tests use this pattern, so they run offline.

## 12. Choose `maxWorkers` and `maxInFlight`

| Workload | `maxWorkers` | `maxInFlight` | Note |
| --- | ---: | ---: | --- |
| Phone browser stream | 1 | 4 | minimal Telegram concurrency |
| Desktop video | 2–4 | 8 | smoother seeks |
| Batch download in Node | 4 | 8 | Telegram throttles above 4 |
| Strict CPU budget | 1–2 | 2–4 | smaller batches, more requests |

Measure on your own runtime. These are starting points, not guarantees.
