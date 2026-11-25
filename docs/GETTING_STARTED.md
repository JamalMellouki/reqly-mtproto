# Getting started with reqly 2.1.0

This guide takes you from an empty project to a range-capable Cloudflare Worker
that streams a Telegram file. Every command is copy-paste friendly.

> **Security first.** A `StringSession` contains a 2048-bit authorization key.
> Treat it as a password. Never commit it, paste it into an issue, or put it in
> a URL. Store it as a Worker secret or a local `.env` file that is git-ignored.

## 1. Prerequisites

| Requirement | Why |
| --- | --- |
| Node.js **20+** | the package targets ES2022 and Web Crypto |
| A Telegram account or bot | authorization |
| `api_id` / `api_hash` from [my.telegram.org](https://my.telegram.org) | Telegram API credentials |
| A Telegram channel with the file | the document must be reachable by the session |
| Wrangler (for Workers) | deployment only; the library itself needs no build step |

```sh
npm init -y
npm install reqlyproto
```

## 2. Create an authorized session

### Option A — gramJS (simplest)

reqly reads **gramJS `StringSession` v1** strings. Install gramJS once and save
the session:

```ts
import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions"
import input from "input"

const apiId = Number(process.env.TELEGRAM_API_ID)
const apiHash = process.env.TELEGRAM_API_HASH!
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
})

// User account:
await client.start({
  phoneNumber: async () => input.text("Phone number: "),
  password: async () => input.text("2FA password (if any): "),
  phoneCode: async () => input.text("Login code: "),
  onError: (error) => console.error(error),
})

// Or a bot account:
// await client.start({ botAuthToken: process.env.BOT_TOKEN! })

console.log(client.session.save())   // 1AQAA... — store this as a secret
await client.disconnect()
```

### Option B — reqly's own handshake

`scripts/bot-login.ts` performs the full MTProto handshake with reqly only and
writes bot sessions. It expects a local secrets file and is intended for the
maintainer workflow; adapt the paths before running it:

```sh
tsx scripts/bot-login.ts
```

For most applications, Option A is faster and less error-prone.

## 3. First download

```ts
import { Reqly } from "reqlyproto"

const session = process.env.REQLY_SESSION!
const client = await Reqly.connect(session, { timeoutMs: 30_000 })

try {
  // 1. Resolve the document from a channel message.
  //    `accessHash` is the channel's access hash for THIS session.
  const documents = await client.getMessages(channelId, channelAccessHash, [messageId])
  const document = documents[0]
  if (!document) throw new Error("message does not contain a document")

  // 2. Read a 1 MB block (Telegram's protocol limit per call).
  const bytes = await client.getFile(document, 0, 1024 * 1024)
  console.log("received", bytes.length, "bytes")
} finally {
  client.close()
}
```

`getFile` aligns requests to 4 KB, clamps reads to the declared document size,
handles `FILE_REFERENCE_EXPIRED` when you pass a refresh callback, and retries
on the correct DC when the session is available in `dcSessions`.

## 4. Download with the SDK

```ts
import { createReqlySdk } from "reqlyproto"

const sdk = await createReqlySdk({
  session: process.env.REQLY_SESSION!,
  maxWorkers: 4,
})

const document = { id, accessHash, fileReference, size }
const bytes = await sdk.download(document, {
  onProgress: (done, total) => console.log(`${done}/${total}`),
})

sdk.close()
```

For video-like access, use `sdk.stream()` and let the consumer control flow:

```ts
const stream = sdk.stream(document, { chunkSize: 512 * 1024 })
return new Response(stream, {
  headers: { "content-type": "video/mp4", "accept-ranges": "bytes" },
})
```

## 5. Cache and retry

```ts
import { createReqlySdk, MemoryCache, withRetry } from "reqlyproto"

const sdk = await createReqlySdk({
  session: process.env.REQLY_SESSION!,
  cache: new MemoryCache({ maxBytes: 64 * 1024 * 1024 }),
})

const bytes = await sdk.download(document)          // fills the cache
const again = await sdk.download(document)          // served from memory

const hashes = await withRetry(() => sdk.hashes(document), { retries: 3 })
```

On Workers, replace `MemoryCache` with `createCacheApiStore(caches.default)`.

## 6. Deploy a Worker

`wrangler.toml`:

```toml
name = "reqly-file"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[vars]
# Never put secrets in [vars]. Use `wrangler secret put`.
```

`src/index.ts`:

```ts
import { createWorkerHandler } from "reqlyproto"

export interface Env {
  MT_SESSION: string
  DC_SESSIONS?: Record<number, string>
}

const document = {
  id: 123456789n,
  accessHash: 987654321n,
  fileReference: new Uint8Array([/* ... */]),
  size: 104857600n,
}

export default {
  fetch(request: Request, env: Env) {
    const handler = createWorkerHandler({
      session: env.MT_SESSION,
      connectOptions: { dcSessions: env.DC_SESSIONS },
      resolveDocument: () => document,
      maxWorkers: 4,
      maxInFlight: 8,
    })
    return handler.fetch(request)
  },
}
```

Set the secret and deploy:

```sh
npx wrangler secret put MT_SESSION
npx wrangler deploy
```

Test the range semantics:

```sh
curl -I https://<worker>/file
curl -H "Range: bytes=0-1048575" https://<worker>/file -o first.bin
```

The response should be `206` with `Content-Range`, `Accept-Ranges` and `ETag`.

## 7. Cross-DC sessions

When Telegram answers `FILE_MIGRATE_X`, the file lives on another DC and the
current `auth_key` cannot be reused. Generate one authorized session per DC in
Node (never in the Worker):

```sh
REQLY_SESSION="<home session>" tsx scripts/gen-dc-sessions.ts
```

Copy the printed `DCn_SESSION=...` values into your secret store and pass them:

```ts
const sdk = await createReqlySdk({
  session: DC1_SESSION,
  dcSessions: { 2: DC2_SESSION, 3: DC3_SESSION, 4: DC4_SESSION, 5: DC5_SESSION },
})
```

The SDK follows the migration automatically for `download`, `range`, `stream`
and `hashes`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `LOCATION_INVALID` | wrong DC or stale reference | provide `dcSessions`, pass a refresh callback |
| `FILE_REFERENCE_EXPIRED` | the reference expired | refresh via `getMessages` and retry |
| `FLOOD_WAIT_X` | too many RPCs | let `withRetry` absorb small waits; lower `maxWorkers` |
| `AUTH_KEY_UNREGISTERED` | session revoked or copied incorrectly | create a new session |
| empty `getMessages` result | wrong channel hash or message id | resolve the channel hash for this session |
| 416 from the Worker | range starts past EOF | check the document `size` |
| slow first byte | cold isolate + handshake | reuse one client per isolate when possible |

## Where next

- [`SDK.md`](./SDK.md) — full SDK guide
- [`COOKBOOK.md`](./COOKBOOK.md) — recipes for ranges, caching, retries and WebSockets
- [`API.md`](./API.md) — every export
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — diagrams and trust boundaries
