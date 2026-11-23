# reqly 2.0.0 — measured benchmarks

These are **real measurements**, not estimates. They were produced by
[`scripts/bench.mjs`](../scripts/bench.mjs) against the shipped `dist/` build,
with no network calls and no credentials. Raw output is committed as
[`benchmark-results.json`](./benchmark-results.json) so every number below can
be reproduced:

```sh
npm run build
node --experimental-loader ./scripts/esm-resolve.mjs scripts/bench.mjs
```

Environment: **Node v26.4.0 · android/arm64 · median of 3 runs**.

![Measured operation latency](./assets/perf-chart.svg)

## Crypto and native primitives

| Operation | Median | Throughput | Note |
| --- | ---: | ---: | --- |
| AES-256-IGE encrypt 1 MB | 122.8 ms | 8.5 MB/s | pure TypeScript, serially dependent blocks |
| AES-256-IGE decrypt 1 MB | 132.3 ms | 7.9 MB/s | pure TypeScript, serially dependent blocks |
| SHA-256 1 MB (`crypto.subtle`) | 1.8 ms | 586.8 MB/s | native WebCrypto |
| SHA-256 8 MB (`crypto.subtle`) | 11.1 ms | 753.1 MB/s | native WebCrypto |
| AES-256-CTR 8 MB (`crypto.subtle`) | 14.7 ms | 571.3 MB/s | native, parallelizable (CDN path) |
| `sha256()` helper 1 MB | 2.1 ms | 500.6 MB/s | reqly wrapper over WebCrypto |

**Reading the numbers.** IGE is *provably serial*: each plaintext block depends
on the previous ciphertext block, so WebCrypto cannot batch it. That is why the
first two rows are ~70× slower than native hashing. The embedded WASM backend
(`dist/aes-ige.wasm`) closes part of this gap; the CDN path (AES-256-CTR) is the
only route to native-speed large ranges.

## Codec, tokens and range parsing

| Operation | Median |
| --- | ---: |
| TL encode one method call | 20.6 µs |
| TL decode one method call | 4.0 µs |
| `createStreamToken()` (HMAC-SHA256) | 629.2 µs |
| `verifyStreamToken()` | 653.2 µs |
| `parseByteRange("bytes=0-8388607")` | 1.2 µs |

Token and codec costs are negligible next to a 1 MB block read. Range parsing
is effectively free — it is a pure string operation.

## Worker budget model (from live deployment notes)

`docs/PERFORMANCE.md` records the deployed-Worker findings that complement this
local benchmark:

| Scenario | Observed |
| --- | --- |
| `/stream` 8 MB in 8 parallel 1 MB blocks | success, exactly 8,388,608 bytes |
| Same payload hashed inside the Worker | 503 / CPU budget exhausted (1102) |
| `Range: bytes=0-41943039` (40 MB) | not achievable with the pure-JS engine |

Consequence: streaming never hashes the body; hash verification is opt-in and
fed from `upload.getFileHashes`. A 2 GB file needs ~256 Worker invocations at
8 MB per response — about 0.25% of a 100,000 requests/day allowance.

## Reproducibility and honesty

- Run the benchmark on your own device; numbers will differ with CPU and runtime.
- The benchmark writes only `docs/benchmark-results.json` and prints to stdout.
- No session string, bot token, API hash or environment secret is read anywhere
  in the script.
- Deployment measurements in `PERFORMANCE.md` are labelled separately from
  local microbenchmarks; neither is presented as the other.
