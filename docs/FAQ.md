# reqly FAQ

Short answers to the questions that come up most often. For code, start with
[`GETTING_STARTED.md`](./GETTING_STARTED.md) and [`COOKBOOK.md`](./COOKBOOK.md).

## What is reqly?

A small MTProto 2.0 request/reply client for Cloudflare Workers, Node 20+ and
other Web-standard runtimes. It focuses on reading Telegram files: sessions,
message encryption, obfuscated WebSocket transport, a minimal TL codec, and an
HTTP range layer.

## Which version should I install?

`reqlyproto@2.1.0` is the current release. It adds the byte cache, retry policy
and SDK correctness fixes on top of 2.0.0. `1.0.0` remains available for the
original minimal client.

## Does it need gramJS or any other MTProto library?

No. Runtime dependencies are zero. reqly reads gramJS `StringSession` v1
strings, so you can create a session with gramJS once, but the package itself
does not import it.

## How do I create a session?

The fastest path is gramJS:

```ts
console.log(client.session.save())   // store as a Worker secret
```

See [`GETTING_STARTED.md`](./GETTING_STARTED.md) for a complete script and for
the in-house `scripts/bot-login.ts` alternative.

## Why does `FILE_REFERENCE_EXPIRED` happen?

Telegram file references are short-lived. When one expires, resolve the message
again with `channels.getMessages` and pass the refreshed document. On
`client.getFile()` pass a refresh callback; on the SDK use `refresh` in
`download`, `range` or `stream`:

```ts
await sdk.download(document, { refresh: refreshDocument })
```

## Why does `FILE_MIGRATE_X` happen?

The file lives on another data center. An `auth_key` is only valid for the DC
that issued it, so you need one authorized session per DC:

```ts
const sdk = await createReqlySdk({
  session: DC1_SESSION,
  dcSessions: { 2: DC2_SESSION, 3: DC3_SESSION, 4: DC4_SESSION, 5: DC5_SESSION },
})
```

Generate them in Node with `scripts/gen-dc-sessions.ts`, never inside a Worker.

## Is the byte cache shared between Worker isolates?

Not automatically. `MemoryCache` is per isolate. Use
`createCacheApiStore(caches.default)` when you need a cache shared across
isolates in the same colo, or implement `SdkCache` over Durable Objects, KV or
Redis.

## What does the cache key contain?

```text
reqly:<id>:<accessHash>:<fileReferenceHex>:<offset>:<length>
```

The reference fingerprint prevents stale bytes from satisfying a refreshed
document. Only complete blocks are stored.

## How many parallel Telegram reads should I use?

Start with `maxWorkers: 4` and `maxInFlight: 8`. Use fewer on a phone browser or
a strict CPU budget. Telegram throttles aggressive bursts; `withRetry` absorbs
small `FLOOD_WAIT_X` errors, but lowering concurrency is better than retrying
harder.

## Can I return a 40 MB file in one Worker request?

Not with the pure-ES engine; see the measured limit in
[`PERFORMANCE.md`](./PERFORMANCE.md). A practical response is 2–8 MB, and the
client can issue the next range request. CDN delivery with AES-256-CTR is
documented as future work, not a current feature.

## Does reqly support `HEAD`, `Range`, `ETag` and `304`?

Yes. `createFileResponse()` and `createWorkerHandler()` implement `GET`, `HEAD`,
`Range`, `206`, `Content-Range`, `Accept-Ranges`, `ETag`, `If-None-Match`/`304`,
`If-Range`, `416` and `405`.

## Are stream tokens JWTs?

No. They are a compact `<base64url payload>.<base64url HMAC-SHA256 signature>`
format, short-lived and verified in constant structure. They are not encrypted;
never put secrets in the payload.

## Does it work in Node?

Yes, Node 20+ with global `fetch`, `crypto.subtle`, `Request`/`Response` and
`ReadableStream`. The Node path uses WebSocket transport; no native modules.

## Why is the first byte slow?

The first RPC may open a socket, perform the MTProto handshake and initialize
the connection. Reuse a client across requests in long-running Node, or accept
the cold-isolate cost in Workers. Cache API hits bypass Telegram entirely.

## How do I report a security issue?

Use GitHub's private vulnerability reporting on the repository. Do not open a
public issue containing a session string, auth key, bot token or exploit
details. See [`SECURITY.md`](../SECURITY.md).
