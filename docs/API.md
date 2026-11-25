# reqly API reference (2.1.0)

Every public export of `reqlyproto`, grouped by purpose. Types are shown in
TypeScript shorthand; the generated declarations in `dist/*.d.ts` are the
authoritative source.

```ts
import { ... } from "reqlyproto"
```

## Package metadata

| Export | Type | Value |
| --- | --- | --- |
| `version` | `string` | `"2.1.0"` |
| `author` | `string` | `"Mellouki Jamal"` |
| `platform` | `string` | `"Asynctric"` |

## Client

### `Reqly.connect(session, options?)`

```ts
static connect(encodedSession: string, options?: ReqlyOptions): Promise<Reqly>
```

Parses a gramJS v1 `StringSession` and returns a client. No socket is opened
until the first call.

### `ReqlyOptions`

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `timeoutMs` | `number` | protocol default | RPC timeout |
| `address` | `string` | from session | override the DC host |
| `port` | `number` | from session | override the DC port |
| `apiId` | `number` | `1` | Telegram API id |
| `dcSessions` | `Record<number, string>` | `{}` | sessions per DC for migration |
| `freshSocket` | `boolean` | `false` | one socket per RPC |
| `cdnSupported` | `boolean` | `false` | request `upload.fileCdnRedirect` |

### `client` methods

| Method | Returns | Notes |
| --- | --- | --- |
| `invoke(method, session?)` | `Promise<Uint8Array>` | raw TL method |
| `getMessages(channelId, accessHash, ids)` | `Promise<RemoteDocument[]>` | resolves documents |
| `getFile(location, offset, limit, refresh?)` | `Promise<Uint8Array>` | aligned, EOF-safe |
| `getFilesParallel(location, ranges, options?)` | `Promise<Uint8Array[]>` | adaptive 2→4 pool |
| `getFileHashes(location, offset?, refresh?)` | `Promise<FileHashEntry[]>` | migration-aware |
| `getChannelAccessHash(channelId)` | `Promise<bigint>` | `channels.getChannels` |
| `getDcIds()` | `number[]` | known DCs |
| `getOpenedConnectionCount()` | `number` | diagnostics |
| `close()` | `void` | closes reusable sockets |

### `ParallelOptions`

| Field | Type | Purpose |
| --- | --- | --- |
| `minWorkers` | `number` | starting concurrency (default 2) |
| `maxWorkers` | `number` | ceiling (default 4) |
| `retries` | `number` | retries per block (default 3) |
| `fetch` | `(range, index) => Promise<Uint8Array>` | custom block source (cache) |
| `refresh` | `() => Promise<RemoteDocument>` | reference refresh per block |
| `onChunk` | `(index, bytes) => void` | resolves as ranges finish |

## SDK

### `createReqlySdk(options)` / `new ReqlySdk`

```ts
createReqlySdk(options: ReqlySdkOptions): Promise<ReqlySdk>
```

`ReqlySdkOptions` extends `ReqlyOptions` with:

| Field | Type | Purpose |
| --- | --- | --- |
| `session` | `string` | required home session |
| `tokenSecret` | `string` | enables `issueToken` / `verifyToken` |
| `maxWorkers` | `number` | SDK default concurrency |
| `cache` | `SdkCache` | default byte cache |
| `retry` | `Partial<RetryPolicy>` | default retry policy |

### SDK methods

| Method | Returns | Notes |
| --- | --- | --- |
| `download(document, options?)` | `Promise<Uint8Array>` | whole file or leading slice |
| `range(document, start, end, options?)` | `Promise<Uint8Array>` | inclusive bytes |
| `stream(document, options?)` | `ReadableStream<Uint8Array>` | pull-based |
| `hashes(document, refresh?)` | `Promise<FileHashEntry[]>` | migration-aware |
| `issueToken(payload, ttlSeconds?)` | `Promise<string>` | HMAC-SHA256 |
| `verifyToken(token)` | `Promise<StreamTokenPayload \| null>` | signature + expiry |
| `worker(options)` | `{ fetch(request): Promise<Response> }` | per-request client |
| `close()` | `void` | closes all connections |
| `sdk.client` | `Reqly` | raw client |

### `ReqlySdk.cacheKey(document, offset, length)`

```ts
static cacheKey(document: RemoteDocument, offset: number, length: number): string
```

Format:

```
reqly:<id>:<accessHash>:<fileReferenceHex>:<offset>:<length>
```

The file-reference fingerprint makes the key safe across reference refreshes.

### `SdkDownloadOptions`

| Field | Type | Purpose |
| --- | --- | --- |
| `length` | `number` | leading slice length |
| `blockSize` | `number` | ≤ 1 MB, default 1 MB |
| `refresh` | `() => Promise<RemoteDocument>` | refresh expired reference |
| `onProgress` | `(done, total) => void` | monotonic progress |
| `cache` | `SdkCache` | per-call cache |
| `retry` | `Partial<RetryPolicy>` | per-call retry |

### `SdkRangeOptions` and `SdkStreamOptions`

Both accept `refresh`, `cache` and `retry`. `SdkStreamOptions` adds `chunkSize`,
`onProgress(bytes)` and `signal`.

## Caches

### `SdkCache`

```ts
interface SdkCache {
  match(key: string): Uint8Array | undefined | Promise<Uint8Array | undefined>
  put(key: string, bytes: Uint8Array, ttlSeconds?: number): void | Promise<void>
}
```

### `MemoryCache`

```ts
new MemoryCache({ maxBytes?: number, ttlSeconds?: number })
```

| Member | Type | Purpose |
| --- | --- | --- |
| `match(key)` | `Uint8Array \| undefined` | refreshes LRU recency |
| `put(key, bytes, ttlSeconds?)` | `void` | copies the input |
| `delete(key)` | `boolean` | removes one entry |
| `clear()` | `void` | drops all entries |
| `size` | `number` | retained bytes |
| `stats` | `SdkCacheStats` | hits, misses, evictions, entries, bytes |

Defaults: 64 MiB, 24 hours. `ttlSeconds: 0` disables expiry.

### `createCacheApiStore(cache, defaultTtlSeconds?)`

Adapts a standard `Cache` to `SdkCache`. Keys must be absolute URLs. TTL is
encoded in `Cache-Control`; the platform may clamp it.

## Retry

### `withRetry(task, policy?)`

```ts
withRetry<T>(task: () => Promise<T>, policy?: Partial<RetryPolicy>): Promise<T>
```

Retries only errors accepted by `isRetryableError`. Resolves with the first
successful value; rejects with the last error.

### `RetryPolicy`

| Field | Type | Default |
| --- | --- | --- |
| `retries` | `number` | `2` |
| `baseDelayMs` | `number` | `150` |
| `maxDelayMs` | `number` | `4000` |
| `jitter` | `number` | `0.2` |
| `respectFloodWait` | `boolean` | `true` |
| `maxFloodWaitSeconds` | `number` | `60` |
| `signal` | `AbortSignal` | `undefined` |

### `isRetryableError(error)` / `retryDelayMs(error, attempt, policy?)`

`isRetryableError` returns `true` for `FloodWaitError`, `RpcError` with
`code === 429` or `>= 500`, and the transport messages reqly already treats as
transient. `retryDelayMs` returns a bounded delay with jitter.

`DEFAULT_RETRY_POLICY` is the resolved policy object.

## Sessions and TL

| Export | Purpose |
| --- | --- |
| `parseSession(encoded)` | parse gramJS v1 `StringSession` |
| `SessionStore` | per-DC session registry |
| `TlWriter` | write TL primitives: `uint`, `int`, `long`, `bytes`, `string`, `raw`, `vector`, `result()` |
| `TlReader` | read TL primitives: `uint`, `int`, `long`, `bytes`, `raw`, `skip`, `seek`, `remaining` |
| `IDs` | constructor ids used by the library |
| `decodeFile(payload)` | decode `upload.file` |
| `decodeFileOrRedirect(payload)` | decode `upload.file` or `upload.fileCdnRedirect` |
| `extractDocuments(payload)` | find documents in a reply |
| `RemoteDocument` | `{ id, accessHash, fileReference, size }` |
| `CdnRedirect` | redirect payload |

## Streaming and Workers

| Export | Purpose |
| --- | --- |
| `ChunkReader` / `createChunkReader` | cached, block-aligned range reader |
| `STREAM_MB` | `1 MiB` constant |
| `streamFileRange(client, doc, offset, length, options?)` | ordered `ReadableStream` |
| `createFileResponse(client, doc, request, options?)` | 200/206/304/416 response |
| `createFileRequestHandler(getClient, resolveDocument, options?)` | simple handler |
| `createWorkerHandler(options)` | complete Worker handler |
| `parseByteRange(header, size)` | single-range parser |
| `documentETag(document)` | stable ETag |
| `WorkerRangeOptions` / `WorkerHandlerOptions` | options |
| `ParsedRange` | `{ start, end }` |

### `WorkerRangeOptions` (selected)

| Field | Default | Purpose |
| --- | --- | --- |
| `blockSize` | 1 MB | Telegram block size |
| `maxWorkers` | 4 | parallel RPCs |
| `maxInFlight` | `max(maxWorkers, 8)` | lookahead |
| `cache` | `undefined` | Cache API instance |
| `cacheTtl` | `86400` | response TTL |
| `ignoreRange` | `false` | always return the full file |
| `yieldEveryBytes` | 0 | optional CPU-span break |
| `signal` | request signal | cancellation |
| `onProgress` / `onBatch` / `onError` / `onDone` | — | observability |

## WebSocket streaming

| Export | Purpose |
| --- | --- |
| `createBotPool(options)` | load bot sessions from D1 and resolve documents |
| `attachStreamSocket(socket, options)` | attach the range multiplexer |
| `createWorkerWebSocketHandler(options)` | full Worker upgrade handler |
| `D1Like` | minimal D1 binding shape |
| `BotPoolOptions` / `WsHandlerOptions` / `StreamPool` / `WsControl` | option and control types |

Protocol v2 messages are documented at the top of `src/ws.ts`.

## Cryptography and protocol primitives

| Export | Purpose |
| --- | --- |
| `deriveKeys(authKey, messageKey, direction)` | MTProto 2.0 key/IV derivation |
| `messageKeyOf(authKey, plaintext)` | message key |
| `sha1(data)` / `sha256(data)` | Web Crypto digests |
| `igeEncrypt` / `igeDecrypt` | AES-256-IGE |
| `ctrTransform(data, key, iv)` | AES-256-CTR |
| `setIgeProvider(provider)` | replace the IGE backend |
| `enableWasmCrypto(module)` | register a WASM module |
| `ID` constants | protocol constructor ids |
| `decodeFileHashes(payload)` | parse `upload.getFileHashes` |
| `verifyChunk(bytes, entry)` | SHA-256 block verification |

## DH handshake

| Export | Purpose |
| --- | --- |
| `DH_CONST` | published DH constants |
| `reqPqEnvelope`, `parseResPq`, `factorPq` | `req_pq_multi` flow |
| `pqInnerDataDc`, `reqDhParamsEnvelope`, `parseServerDhParamsOk` | RSA/DH params |
| `parseServerDhInnerData`, `clientDhInnerData`, `setClientDhParamsEnvelope` | DH exchange |
| `parseDhGenResult` | `dh_gen_ok` / `dh_gen_retry` / `dh_gen_fail` |
| `modPow`, `bigIntBytes` | arithmetic helpers |
| `plainEnvelope` | plaintext MTProto envelope |

## RSA handshake

| Export | Purpose |
| --- | --- |
| `rsaKeyFromBytes` | parse a public key |
| `rsaPad` | RSA_PAD encryption |
| `temporaryAes` | temporary AES key/IV |
| `decryptServerDh`, `encryptClientDh` | encrypted DH payloads |
| `computeAuthKey` | shared 2048-bit key |
| `bytesToBigInt` | conversion helper |
| `TELEGRAM_RSA_KEYS`, `findTelegramKey` | production keys by fingerprint |

## Errors

| Class | Fields | Meaning |
| --- | --- | --- |
| `RpcError` | `code` | any Telegram RPC error |
| `FileReferenceExpiredError` | — | refresh the reference |
| `FileMigrateError` | `dcId` | use the target DC |
| `FloodWaitError` | `seconds` | wait before retrying |
| `CdnRedirectError` | `redirect` | CDN redirect payload |
| `rpcError(code, message)` | — | structured error factory |

---

Identity: **Mellouki Jamal** · **Asynctric** · ASYNCTRIC-3.0.
