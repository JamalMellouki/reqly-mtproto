/**
 * reqly — reproducible local benchmark.
 *
 * Run after `npm run build`:
 *   node scripts/bench.mjs
 *
 * It measures the shipped `dist/` build with Node's built-in WebCrypto and
 * writes the exact numbers to `docs/benchmark-results.json`. No network calls,
 * no Telegram credentials, no secrets — safe to commit and reproduce.
 *
 * Copyright (c) 2026 Mellouki Jamal, Asynctric. ASYNCTRIC-3.0.
 */

import { writeFile } from "node:fs/promises"
import { webcrypto } from "node:crypto"
import { performance } from "node:perf_hooks"
import { igeDecrypt, igeEncrypt } from "../dist/crypto.js"
import { sha256 } from "../dist/hashes.js"
import { createStreamToken, verifyStreamToken } from "../dist/token.js"
import { TlReader, TlWriter } from "../dist/tl.js"
import { parseByteRange } from "../dist/worker.js"
import { MemoryCache } from "../dist/cache.js"
import { withRetry } from "../dist/retry.js"

const crypto = webcrypto
const MB = 1024 * 1024

function now() { return performance.now() }
function median(values) {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}
function format(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
function rate(ms, bytes) {
  return `${(bytes / ms / 1000).toFixed(1)} MB/s`
}

async function timed(label, bytes, fn, runs = 3) {
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const t = now()
    await fn()
    samples.push(now() - t)
  }
  const ms = median(samples)
  const result = { label, ms: Number(ms.toFixed(3)), display: format(ms) }
  if (bytes) result.throughput = rate(ms, bytes)
  console.log(`  ${label.padEnd(34)} ${result.display.padStart(10)}${bytes ? `  (${result.throughput})` : ""}`)
  return result
}

console.log("reqly 2.1.0 — local benchmark (dist build, Node " + process.version + ")")
console.log("")

const key = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff)
const iv = new Uint8Array(32).map((_, i) => (i * 53 + 7) & 0xff)
const block1m = new Uint8Array(MB)
for (let i = 0; i < block1m.length; i += 4096) {
  crypto.getRandomValues(block1m.subarray(i, i + 4096))
}
const block8m = new Uint8Array(8 * MB)
for (let i = 0; i < 8; i += 1) block8m.set(block1m, i * MB)

const results = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  note: "Measured on the development device with the shipped dist/ build. Median of 3 runs.",
  entries: [],
}
const add = (entry) => results.entries.push(entry)

console.log("Crypto — AES-256-IGE (pure TypeScript, serial by design)")
add(await timed("IGE encrypt 1 MB", MB, () => { igeEncrypt(block1m, key, iv) }))
add(await timed("IGE decrypt 1 MB", MB, () => { igeDecrypt(block1m, key, iv) }))

console.log("")
console.log("WebCrypto — native primitives")
add(await timed("SHA-256 1 MB", MB, () => crypto.subtle.digest("SHA-256", block1m)))
add(await timed("SHA-256 8 MB", 8 * MB, () => crypto.subtle.digest("SHA-256", block8m)))
const ctrKey = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"])
add(await timed("AES-256-CTR 8 MB", 8 * MB, () =>
  crypto.subtle.encrypt({ name: "AES-CTR", counter: iv.slice(0, 16), length: 64 }, ctrKey, block8m)))
add(await timed("reqly sha256 helper 1 MB", MB, () => sha256(block1m)))

console.log("")
console.log("TL codec + stream tokens + range parsing")
const payload = new TlWriter().uint(0xc4f9186b).long(123456789n).bytes(block1m.subarray(0, 64)).bytes(new TextEncoder().encode("reqly")).result()

add(await timed("TL encode 1 method", payload.length, () => { new TlWriter().uint(0xc4f9186b).long(123456789n).bytes(block1m.subarray(0, 64)).bytes(new TextEncoder().encode("reqly")).result() }, 50))
add(await timed("TL decode 1 method", payload.length, () => { const r = new TlReader(payload); r.uint(); r.long(); r.bytes(); r.bytes() }, 50))
const token = await createStreamToken("bench-only-not-a-secret", { m: 123, w: "bench", k: "stream" })
add(await timed("createStreamToken", 0, () => createStreamToken("bench-only-not-a-secret", { m: 123, w: "bench", k: "stream" }), 20))
add(await timed("verifyStreamToken", 0, () => verifyStreamToken("bench-only-not-a-secret", token), 20))
add(await timed("parseByteRange", 0, () => parseByteRange("bytes=0-8388607", 100 * MB), 100))

console.log("")
console.log("Cache + retry (2.1.0)")
const benchCache = new MemoryCache({ maxBytes: 64 * MB, ttlSeconds: 0 })
benchCache.put("bench", block1m)
add(await timed("MemoryCache put 1 MB", MB, () => { benchCache.put("bench", block1m) }, 20))
add(await timed("MemoryCache match 1 MB", MB, () => { benchCache.match("bench") }, 50))
add(await timed("withRetry immediate success", 0, () => withRetry(async () => 1, { retries: 0 }), 200))

await writeFile(new URL("../docs/benchmark-results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n")
console.log("")
console.log("Saved: docs/benchmark-results.json")
