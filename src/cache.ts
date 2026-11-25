/**
 * Byte caches for reqly ranges.
 *
 * The SDK deliberately keeps caching pluggable. Edge runtimes expose different
 * primitives (the Workers Cache API, a Durable Object, KV, Redis, an isolate
 * map), so reqly only defines the smallest interface it needs:
 *
 * ```ts
 * interface SdkCache {
 *   match(key: string): Uint8Array | undefined | Promise<...>
 *   put(key: string, bytes: Uint8Array, ttlSeconds?: number): void | Promise<void>
 * }
 * ```
 *
 * Two ready-to-use implementations ship with the package:
 *
 * - {@link MemoryCache} — an LRU with a byte budget and TTL, ideal for Node
 *   workers, tests and per-isolate reuse.
 * - {@link createCacheApiStore} — an adapter over the standard `Cache` API used
 *   by Cloudflare Workers and browsers.
 *
 * Copyright (c) 2026 Mellouki Jamal, Asynctric.
 * Licensed under ASYNCTRIC-3.0. Author and platform identity must be preserved.
 */

/** The minimum contract the SDK needs from a byte cache. */
export interface SdkCache {
  /** Returns cached bytes for `key`, or `undefined` on a miss. */
  match(key: string): Promise<Uint8Array | undefined> | Uint8Array | undefined
  /** Stores bytes under `key`; `ttlSeconds` overrides the cache default. */
  put(key: string, bytes: Uint8Array, ttlSeconds?: number): Promise<void> | void
}

/** Counters exposed by {@link MemoryCache}. */
export interface SdkCacheStats {
  /** Successful lookups. */
  hits: number
  /** Lookups that found nothing or had expired. */
  misses: number
  /** Entries removed to stay inside the byte budget. */
  evictions: number
  /** Number of live entries. */
  entries: number
  /** Bytes currently held. */
  bytes: number
}

/** Options for {@link MemoryCache}. */
export interface MemoryCacheOptions {
  /** Maximum retained bytes. Default 64 MiB. */
  maxBytes?: number
  /** Default entry lifetime in seconds. Default 24 hours; `0` disables expiry. */
  ttlSeconds?: number
}

interface CacheEntry {
  bytes: Uint8Array
  expiresAt: number
}

const MIB = 1024 * 1024

/**
 * A small LRU byte cache with a hard memory budget and per-entry TTL.
 *
 * The implementation is intentionally single-threaded: JavaScript runtimes run
 * synchronous `match`/`put` bodies on one thread, which is enough for an
 * isolate-local cache. Shared/distributed caches should use
 * {@link createCacheApiStore} or a custom {@link SdkCache}.
 *
 * ```ts
 * const cache = new MemoryCache({ maxBytes: 32 * 1024 * 1024 })
 * const sdk = await createReqlySdk({ session, cache })
 * ```
 */
export class MemoryCache implements SdkCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly maxBytes: number
  private readonly ttlMs: number
  private retainedBytes = 0
  private hitCount = 0
  private missCount = 0
  private evictionCount = 0

  constructor(options: MemoryCacheOptions = {}) {
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes ?? 64 * MIB))
    this.ttlMs = Math.max(0, Math.floor((options.ttlSeconds ?? 86_400) * 1000))
  }

  /** Current counters. */
  get stats(): SdkCacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      entries: this.entries.size,
      bytes: this.retainedBytes,
    }
  }

  /** Bytes currently retained. */
  get size(): number {
    return this.retainedBytes
  }

  match(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.missCount += 1
      return undefined
    }
    if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
      this.remove(key)
      this.missCount += 1
      return undefined
    }
    // Refresh recency: Map iteration order is insertion order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hitCount += 1
    // Hand out a copy: callers own the bytes they receive and must not be able
    // to mutate the cached payload in place.
    return entry.bytes.slice()
  }

  put(key: string, bytes: Uint8Array, ttlSeconds?: number): void {
    if (bytes.length === 0) return
    const ttl = ttlSeconds === undefined ? this.ttlMs : Math.max(0, Math.floor(ttlSeconds * 1000))
    if (this.maxBytes === 0) return
    this.remove(key)
    // A single object larger than the budget can never be retained. Dropping it
    // avoids evicting the whole cache for one oversized range.
    if (bytes.length > this.maxBytes) return
    const stored = bytes.slice()
    this.entries.set(key, {
      bytes: stored,
      expiresAt: ttl === 0 ? 0 : Date.now() + ttl,
    })
    this.retainedBytes += stored.length
    this.trim()
  }

  /** Removes one key. */
  delete(key: string): boolean {
    return this.remove(key)
  }

  /** Drops every entry but keeps hit/miss counters. */
  clear(): void {
    this.entries.clear()
    this.retainedBytes = 0
  }

  private remove(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.retainedBytes -= entry.bytes.length
    return true
  }

  private trim(): void {
    while (this.retainedBytes > this.maxBytes) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.remove(oldest.value)
      this.evictionCount += 1
    }
  }
}

/**
 * Adapts the standard `Cache` API to {@link SdkCache}.
 *
 * Keys must be absolute URLs. The adapter never inspects the payload; TTL is
 * expressed through `Cache-Control`, which the edge may clamp.
 *
 * ```ts
 * const cache = createCacheApiStore(caches.default, 3600)
 * await cache.put("https://cache.reqly.internal/blob/42/0/1048576", bytes)
 * ```
 */
export function createCacheApiStore(cache: Cache, defaultTtlSeconds = 86_400): SdkCache {
  const ttl = Math.max(0, Math.floor(defaultTtlSeconds))
  return {
    async match(key: string): Promise<Uint8Array | undefined> {
      const hit = await cache.match(new Request(key))
      if (!hit) return undefined
      return new Uint8Array(await hit.arrayBuffer())
    },
    async put(key: string, bytes: Uint8Array, ttlSeconds?: number): Promise<void> {
      const lifetime = Math.max(0, Math.floor(ttlSeconds ?? ttl))
      const body = bytes.slice().buffer as ArrayBuffer
      await cache.put(
        new Request(key),
        new Response(body, {
          headers: {
            "cache-control": `public, max-age=${lifetime}`,
            "content-type": "application/octet-stream",
          },
        }),
      )
    },
  }
}
// Mellouki Jamal — Asynctric
