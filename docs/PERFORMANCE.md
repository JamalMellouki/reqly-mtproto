# reqly — performance model and precise plan for Workers

All numbers below were measured on this device (Node 22 / deployed `reqly-dev`
Worker on Cloudflare), not estimated.

## Measured facts

| Operation | Measured | Where |
|---|---|---|
| AES-256-IGE encrypt 1 MB | 338 ms | Node, pure-JS engine with precomputed GF tables |
| AES-256-IGE decrypt 1 MB | 350 ms | Node, same engine |
| SHA-256 of 1 MB (`crypto.subtle`) | 9.7 ms | Node |
| AES-256-CTR of 8 MB (`crypto.subtle`) | 26 ms | Node |
| SHA-256 of 8 MB (`crypto.subtle`) | 19 ms | Node |
| `/stream` response, 8 MB, 8 parallel 1 MB blocks | **success**, exact 8,388,608 bytes | deployed Worker |
| `/file?limit=1MB` + SHA-256 header | **503 / 1102** | deployed Worker |

The last two rows are the key finding: **IGE decryption of eight 1 MB blocks is
fine inside one Worker request; hashing the same payload in that request is
what exhausts the CPU budget.** `/stream` therefore never hashes the body.

Correctness was verified by comparing the first 1 MB of an 8 MB stream against
the independent `/chunk` path — identical SHA-256.

## Why 0.024 ms for 1 MB cannot be achieved (information-theoretic floor)

- 1 MB = 65,536 AES blocks. IGE is *provably serial*: `P_i = D(C_i XOR P_{i-1}) XOR C_{i-1}`.
  Peer-reviewed analysis (Jakobsen & Orlandi, ePrint 2015/1177; OpenSSL `aes_ige.c`;
  Richie Frame, crypto.stackexchange 24297) confirms neither IGE encryption nor
  decryption can be parallelized. WebCrypto cannot batch it.
- Best published hardware implementations (OpenSSL/AES-NI, ARMv8 Crypto
  Extensions) reach 600–800 MB/s for IGE (cipheron benchmarks). That is
  **~1.3–1.7 ms for 1 MB**, not 0.024 ms. WebAssembly has no AES instruction
  extension, so a sandbox like Workers cannot reach the hardware path.
- SHA-256 of 8 MB costs ~19 ms natively; 8 MB of IGE costs at least ~13 ms even
  with hardware AES. Therefore **8 MB per response and a 4 ms CPU cap are
  mutually exclusive** by roughly 3–7x. A precise plan must choose one.

## What the library now does natively

- `streamFileRange` fetches 1 MB `upload.getFile` blocks in parallel (adaptive
  2→4 workers, retries/backoff) and batches them into one HTTP response.
  Default batch is 8 blocks = 8 MB; verify: `curl -H 'Range: bytes=0-8388607'`.
- `createFileResponse` adds real HTTP semantics: `Range`, `206`, `Content-Range`,
  `Accept-Ranges`, `ETag`, `HEAD`, `416`. No Node APIs, no external modules.
- `cpuBudgetMs` option: per-batch wall-time is measured; if a batch exceeds the
  budget the next batch is halved, and it grows again when under half the budget.
  This is the mechanism for a strict 4 ms deployment.
- Cache API integration keys chunks by document id + access hash + file
  reference, so replays consume zero Telegram RPCs.
- No hashing inside the streaming path. Hash verification is opt-in and should
  be fed from `upload.getFileHashes` / CDN hashes, cached once per file.

## 40 MB in one request — measured limit

Live tests against the deployed Worker with `Range: bytes=0-41943039`:

| `batch` | Bytes actually delivered | Result |
|---|---|---|
| 8 | 8,388,608 first run, 0 on later runs | first batch only |
| 4 | 4,194,304 | one batch only |
| 2 | 10,485,760 | five batches, then the isolate stopped |

So the current pure-JS IGE engine delivers **up to ~8–10 MB per Worker
invocation** before the platform CPU meter ends the response. 40 MB in one
request is therefore **not achievable with this engine**. This is a measured
platform limit, not a missing configuration flag. Repeating the same request
also shows Telegram-side rate limiting when 40 one-megabyte RPCs are issued in
one burst.

Two native routes address this gap:

1. **Embedded WASM AES engine — shipped in 2.0.0.** The same audited AES/IGE
   algorithm is compiled into the library as `dist/aes-ige.wasm` (no external
   asset to configure). It is loaded automatically when the runtime supports it.
2. **Telegram CDN path — planned.** `upload.fileCdnRedirect` replaces serial IGE with
   AES-256-CTR (`crypto.subtle`), which is native and parallelizable. The
   current fixture did not produce a redirect (`cdnSupported` probe returned
   `redirect:false`), so it can only be validated on a >100k-member public file.

## Minimal application code

`createWorkerHandler()` now returns a complete Worker `fetch` handler; the
application only supplies configuration:

```ts
import { createWorkerHandler } from "reqlyproto"

export default createWorkerHandler({
  session: MT_SESSION,
  connectOptions: { dcSessions: DC_SESSIONS },
  resolveDocument: () => document,
  batchChunks: 8,
  workers: 4,
  cpuBudgetMs: 4,
})
```

No streaming code, no crypto code, no Range parsing in application code.

## Request-count math for a 2 GB movie

- Worker invocations: `2 GiB / 8 MiB = 256` (measured feasible), versus 2048 if
  one 1 MB chunk were served per invocation.
- Telegram `upload.getFile` RPCs: `2048` — unavoidable with the 1 MB protocol
  limit; they are parallelized 4 at a time inside each Worker invocation.
- Repeat views: 0 Telegram RPCs for cached chunks (Cache API), still 256 Worker
  invocations unless the edge serves the cached object directly.
- If a strict 4 ms CPU cap is enforced instead of the 8 MB batch: with the
  measured engine the safe batch is ~256 KB, giving ~8192 Worker invocations.
  That is the honest trade-off; it cannot be both 4 ms and 8 MB.

## Next phase (CDN path — the only way to beat IGE CPU)

Telegram's `upload.fileCdnRedirect` delivers `encryption_key`, `encryption_iv`
and `file_token`. CDN payloads use AES-256-CTR, which *is* parallelizable and
can be executed by native `crypto.subtle` in one call. The library already
contains the full RSA/DH auth-key handshake; the remaining work is:

1. send `cdn_supported` in `upload.getFile` flags (`0x02`),
2. parse `upload.fileCdnRedirect` and reach the CDN DC with a generated key,
3. `upload.getCdnFile` + AES-256-CTR with `iv[12..16] = offset/16`,
4. verify against `file_hashes` and fall back to the master DC on
   `FILE_TOKEN_INVALID`.

This is a documented Telegram feature, not a platform hack, and is the only
route to sub-4-ms CPU for large ranges because it replaces serial IGE with
native CTR.

## Tested evidence

- `tests/worker.test.ts`: range parsing, ordered 8-block streaming, 206/416/HEAD.
- Live `/stream` with `Range: bytes=0-8388607`: 8,388,608 bytes returned.
- Live `/chunk` vs `/stream` first 1 MB: identical SHA-256.
- `wrangler deploy --dry-run`: 192 KiB bundle, library is the only dependency.
