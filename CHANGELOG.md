# Changelog

All notable changes to `reqlyproto` (short name `reqly`) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All releases remain available on the
[releases page](https://github.com/JamalMellouki/reqly-mtproto/releases):
choose `v1.0.0` for the original minimal client, `v2.0.0` for streaming + SDK,
or `v2.1.0` for cache, resilience and the expanded documentation set.

## [2.1.0] — 2026-11-25

**Cache, resilience and polished docs.** The protocol surface is unchanged;
this release makes repeated reads cheaper, failures recoverable and the SDK
behave the way its documentation always promised.

### Added

- **`MemoryCache`** (`src/cache.ts`): dependency-free LRU byte cache with a hard
  `maxBytes` budget, per-entry TTL, copy-safe reads and `hits`/`misses`/
  `evictions`/`entries`/`bytes` counters.
- **`createCacheApiStore(cache, ttl?)`**: adapts the standard `Cache` API used by
  Cloudflare Workers and browsers to the SDK cache contract.
- **`SdkCache`, `SdkCacheStats` and `MemoryCacheOptions`** types, exported from
  the package root.
- **Retry helpers** (`src/retry.ts`): `withRetry`, `isRetryableError`,
  `retryDelayMs`, `DEFAULT_RETRY_POLICY` and the `RetryPolicy` type. Backoff is
  exponential with bounded jitter, small `FLOOD_WAIT_X` errors are absorbed, and
  an `AbortSignal` cancels pending waits.
- **Cache and retry options on the SDK**: `cache`/`retry` defaults on
  `createReqlySdk`, plus per-call overrides on `download`, `range` and `stream`.
  `SdkRangeOptions` is a new named export.
- **Cache-aware downloads**: `sdk.download()`, `sdk.range()` and `sdk.stream()`
  read through the configured cache; only complete blocks are stored.
- **`If-None-Match` / `304 Not Modified`** support in `createFileResponse()` and
  the Worker handler, including a regression test.
- **Documentation set**: `docs/GETTING_STARTED.md`, `docs/COOKBOOK.md`,
  `docs/API.md`, `docs/FAQ.md`, `SECURITY.md`, a rebuilt `docs/SDK.md` and
  redesigned English/Arabic READMEs.
- **Identity assets**: `docs/assets/logo.svg` and
  `docs/assets/social-card.svg` for the README and release card.

### Changed

- `ParallelOptions` accepts a `refresh` callback and `getFilesParallel` forwards
  it to every block read.
- `sdk.hashes()` accepts an optional refresh callback and passes it to
  `client.getFileHashes()`.
- `sdk.download()` reports progress after each completed block; the counter is
  monotonic even when the parallel pool resolves blocks out of order.
- `sdk.worker()` now defaults to the SDK session **and** the SDK connection
  options, so secrets and DC sessions are not repeated in application code.
- `ReqlySdk.cacheKey()` now includes a hex fingerprint of `file_reference`.
- Package version, identity test, benchmark banner, telemetry strings and all
  documentation report **2.1.0**.
- The showcase page, badges, feature cards and README structure were rebuilt
  around the 2.1.0 story.
- `docs/SDK.md` now documents the real `StreamTokenPayload` shape
  (`{ m, w, e, k }`) instead of the obsolete `{ d, o, l }` example.

### Fixed

- **`sdk.download()` ignored its `refresh` option.** The callback is now passed
  through the block reader to `getFile`, so an expiring reference is recovered
  in the middle of a download.
- **`sdk.worker()` started from an empty session** instead of the SDK session.
  It now inherits both `session` and `connectOptions` unless overridden.
- **`ReqlySdk.cacheKey()` could collide across reference refreshes.** The
  reference fingerprint is now part of the key.
- `MemoryCache.match()` no longer exposes the internal buffer to callers.
- Documentation drift: the cache key format, token payload, option names and
  2.1.0 version strings are consistent across README, SDK guide and API
  reference.

### Security

- Session strings, auth keys, bot tokens and API hashes remain outside source
  control; no example or test contains a credential.
- `SECURITY.md` documents supported versions, private reporting, the secret
  inventory and the pre-deployment checklist.
- Cache keys are reference-scoped, so a refreshed document cannot be served
  bytes fetched under an expired reference.
- Stream tokens stay HMAC-SHA256 signed and short-lived; `304` responses carry
  no body.

## [2.0.0] — 2026-11-23

### Added

- **High-level SDK** (`src/sdk.ts`, exported as `ReqlySdk` / `createReqlySdk`):
  one-call document download, arbitrary byte ranges, lazy
  `ReadableStream` streaming, hash lookup, stream-token issue/verify, and a
  Worker `fetch` handler factory. The raw client stays reachable via `sdk.client`.
- **Embedded AES-256-IGE WebAssembly backend** (`src/aes-ige.wasm`, built into
  `dist/aes-ige.wasm`) with automatic loading and a `setIgeProvider` escape hatch
  for custom native implementations.
- **Adaptive parallel file reader** (`getFilesParallel`): 2→4 workers with
  backoff + jitter, per-chunk progress callbacks and fatal-error cancellation.
- **Cached block reader** (`ChunkReader` / `createChunkReader`): block-aligned
  range reads with prefetch, reference-aware cache keys and EOF-safe trimming.
- **Short-lived HMAC stream tokens** (`createStreamToken`, `verifyStreamToken`)
  for Worker-to-Worker authorization.
- **Typed streaming HTTP layer**: `streamFileRange`, `createFileResponse`,
  `createFileRequestHandler` and `createWorkerHandler` with `Range`, `206`,
  `Content-Range`, `Accept-Ranges`, `ETag`, `HEAD` and `416` semantics.
- **Cross-DC authorization transfer**: complete in-house RSA + DH auth-key
  handshake (`src/dh.ts`, `src/handshake.ts`, `src/rsa.ts`) and `dcSessions`
  routing for `FILE_MIGRATE_X` retries.
- **Interactive WebSocket streaming** (`createBotPool`, `attachStreamSocket`,
  `createWorkerWebSocketHandler`) with a small session pool and framed delivery.
- **Protocol primitives** exported for advanced users: `ID` constants,
  `decodeFileHashes`, `verifyChunk`, `parseByteRange` and `documentETag`.
- **Reproducible benchmark**: `scripts/bench.mjs` measures the shipped `dist/`
  build and writes `docs/benchmark-results.json`; real numbers, no credentials.
- **Documentation expansion**: `docs/SDK.md`, `docs/ARCHITECTURE.md`,
  `docs/BENCHMARKS.md`, an SVG performance chart, Mermaid diagrams and a
  standalone showcase page in `docs/showcase/`.
- **README redesign**: status/convenience badges, feature cards, a version
  table linking both releases, and SDK quick-start examples.
- `.gitignore` keeps dependencies, build output, agent notes, roadmaps and all
  local secret/environment files out of the repository.

### Changed

- Package version and all documentation now report **2.0.0**; the license is
  consistently **ASYNCTRIC-3.0** across `package.json`, README (EN/AR), source
  headers, notices and identity tests.
- `build` now emits `dist/aes-ige.wasm`; `lint` and `type-check` scripts added;
  TypeScript dev dependency pinned to `^5.7.2`.
- Underlying connection handling: per-instance `msg_id` counters, reusable
  connection reuse per DC and an optional `freshSocket` stateless mode.
- Telemetry strings reported in `initConnection` updated to `2.0.0`.

### Fixed

- `getFile` and `getFileHashes` reject negative/non-integer offsets and clamp
  reads to the declared document size.
- `parseSession` rejects out-of-range DC ids, empty addresses and port zero
  before opening a socket; `getMessages([])` returns immediately.
- Closed clients clear initialized-DC flags so a reopened connection repeats
  `initWithLayer`.
- Reference-refreshed documents no longer reuse stale cached bytes.
- Documentation drift: the old "no WASM binary is shipped" and `ASYNCTRIC-1.0`
  statements were corrected everywhere.

### Security

- Session strings, auth keys, bot tokens and API hashes are never logged,
  committed or exposed through the SDK. All examples use environment variables.
- Stream tokens are HMAC-SHA256 signed, short-lived and verified in constant
  structure; there is no shared mutable module-level state between requests.
- A credential-pattern scan over every committed file passes with zero hits.

## [1.0.0] — 2026-11-22

The original request/reply MTProto client: session parsing, MTProto 2.0 message
encryption, obfuscated WebSocket transport and a minimal TL codec. Kept as a
separate, immutable release for applications that only need read-only calls and
want the smallest possible surface.

[2.1.0]: https://github.com/JamalMellouki/reqly-mtproto/releases/tag/v2.1.0
[2.0.0]: https://github.com/JamalMellouki/reqly-mtproto/releases/tag/v2.0.0
[1.0.0]: https://github.com/JamalMellouki/reqly-mtproto/releases/tag/v1.0.0
