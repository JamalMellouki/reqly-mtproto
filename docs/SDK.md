# reqly SDK guide (2.0.0)

The SDK is a thin, opinionated layer over the core client. It is included in
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
})
```

All options are the same `ReqlyOptions` the core client accepts, plus `session`
and `tokenSecret`. The underlying client is always available as `sdk.client` for
raw TL calls.

## Download a document

```ts
const bytes = await sdk.download(document, {
  onProgress: (done, total) => console.log(`${done}/${total}`),
})
```

- Splits the document into 1 MB blocks (Telegram's hard limit).
- Uses the adaptive 2→4 worker pool with retries and backoff.
- Refreshes expired `file_reference` values automatically when a refresh
  callback is supplied on the core client call.
- `length` limits the download to a leading slice.

## Read an arbitrary range

```ts
const chunk = await sdk.range(document, 10_485_760, 15_728_640)
```

The range is inclusive and clamped to the declared document size.

## Stream with backpressure

```ts
const stream = sdk.stream(document, {
  chunkSize: 512 * 1024,
  onProgress: (bytes) => console.log(bytes),
  signal: request.signal,
})

return new Response(stream, {
  headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" },
})
```

`ReadableStream.pull` fetches one block at a time, so the caller controls flow.
Aborting the signal stops the next pull with an error.

## Verify integrity

```ts
const entries = await sdk.hashes(document)
// each entry: { offset, limit, hash, ... }
```

Hashes come from `upload.getFileHashes`, follow `FILE_MIGRATE_X` when a target DC
session is registered, and can be cached per document. Do not hash inside a
tight Worker request — see [`BENCHMARKS.md`](./BENCHMARKS.md).

## Short-lived stream tokens

```ts
const token = await sdk.issueToken({ d: String(document.id), o: 0, l: 8 * 1024 * 1024 }, 60)
const payload = await sdk.verifyToken(token) // null when invalid/expired
```

Tokens are `<base64url payload>.<base64url HMAC-SHA256 signature>`. Keep the
secret in a Worker secret; rotate it by changing the value in configuration.
Never place a token or the secret in a URL that gets logged.

## One-call Worker handler

```ts
export default sdk.worker({
  resolveDocument: () => document,
  batchChunks: 8,
  maxWorkers: 4,
  cpuBudgetMs: 8,
})
```

The handler adds `Range`, `206`, `Content-Range`, `Accept-Ranges`, `ETag`,
`HEAD` and `416`. For lower-level control use `createFileResponse` or
`createFileRequestHandler` directly.

## Cache key helper

```ts
const key = ReqlySdk.cacheKey(document, offset, length)
// reqly:<id>:<accessHash>:<offset>:<length>
```

The key deliberately excludes `file_reference`, because refreshed references
must not reuse bytes fetched under a stale one. Include the current hash when
you validate cached payloads.

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
