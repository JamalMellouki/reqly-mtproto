import { describe, expect, it } from "vitest"
import { MemoryCache, createCacheApiStore } from "../src/cache.ts"
import { ReqlySdk } from "../src/sdk.ts"
import type { RemoteDocument } from "../src/tl.ts"

function document(reference: number[]): RemoteDocument {
  return { id: 1n, accessHash: 2n, fileReference: new Uint8Array(reference), size: 2048n }
}

describe("MemoryCache", () => {
  it("stores bytes and never hands out its internal buffer", () => {
    const cache = new MemoryCache({ maxBytes: 1024, ttlSeconds: 0 })
    cache.put("a", new Uint8Array([1, 2, 3]))
    const hit = cache.match("a")!
    expect(Array.from(hit)).toEqual([1, 2, 3])
    hit[0] = 9
    expect(cache.match("a")![0]).toBe(1)
  })

  it("evicts the least recently used entry to respect the byte budget", () => {
    const cache = new MemoryCache({ maxBytes: 8, ttlSeconds: 0 })
    cache.put("a", new Uint8Array(4))
    cache.put("b", new Uint8Array(4))
    cache.match("a")
    cache.put("c", new Uint8Array(4))
    expect(cache.match("b")).toBeUndefined()
    expect(cache.match("a")).toBeDefined()
    expect(cache.match("c")).toBeDefined()
    expect(cache.stats.evictions).toBe(1)
  })

  it("expires entries and counts misses", async () => {
    const cache = new MemoryCache({ maxBytes: 64, ttlSeconds: 0.01 })
    cache.put("a", new Uint8Array(2))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(cache.match("a")).toBeUndefined()
    expect(cache.stats.misses).toBe(1)
  })

  it("drops values larger than the whole budget", () => {
    const cache = new MemoryCache({ maxBytes: 8, ttlSeconds: 0 })
    cache.put("big", new Uint8Array(9))
    expect(cache.match("big")).toBeUndefined()
    expect(cache.size).toBe(0)
  })
})

describe("SDK cache keys", () => {
  it("changes when the file reference changes", () => {
    const first = ReqlySdk.cacheKey(document([1, 2]), 0, 100)
    const second = ReqlySdk.cacheKey(document([1, 3]), 0, 100)
    const repeat = ReqlySdk.cacheKey(document([1, 2]), 0, 100)
    expect(first).not.toBe(second)
    expect(first).toBe(repeat)
    expect(first).toContain(":0:100")
  })
})

describe("createCacheApiStore", () => {
  it("adapts the standard Cache API to the SDK contract", async () => {
    const store = new Map<string, Uint8Array>()
    const fake = {
      async match(request: Request): Promise<Response | undefined> {
        const value = store.get(request.url)
        return value ? new Response(value.slice().buffer as ArrayBuffer) : undefined
      },
      async put(request: Request, response: Response): Promise<void> {
        store.set(request.url, new Uint8Array(await response.arrayBuffer()))
      },
    } as unknown as Cache

    const cache = createCacheApiStore(fake, 60)
    await cache.put("https://cache.test/a", new Uint8Array([7, 8]))
    expect(Array.from((await cache.match("https://cache.test/a"))!)).toEqual([7, 8])
    expect(await cache.match("https://cache.test/missing")).toBeUndefined()
  })
})
// Mellouki Jamal — Asynctric
