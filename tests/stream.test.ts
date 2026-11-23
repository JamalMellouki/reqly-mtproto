import { describe, expect, it } from "vitest"
import { ChunkReader, type Reqly, type RemoteDocument } from "../src/index.ts"

function document(overrides: Partial<RemoteDocument> = {}): RemoteDocument {
  return {
    id: 10n,
    accessHash: 20n,
    fileReference: new Uint8Array([1, 2, 3]),
    size: 1_000_000n,
    ...overrides,
  }
}

function fakeClient(bytes: Uint8Array, calls: Array<{ offset: number; limit: number }>): Reqly {
  return {
    async getFile(_location: RemoteDocument, offset: number, limit: number): Promise<Uint8Array> {
      calls.push({ offset, limit })
      return bytes.slice(offset, offset + limit)
    },
    async getFilesParallel(
      _location: RemoteDocument,
      ranges: ReadonlyArray<{ offset: number; limit: number }>,
      options: { fetch?: (range: { offset: number; limit: number }) => Promise<Uint8Array> } = {},
    ): Promise<Uint8Array[]> {
      const output: Uint8Array[] = []
      for (const range of ranges) {
        output.push(options.fetch ? await options.fetch(range) : await this.getFile(_location, range.offset, range.limit))
      }
      return output
    },
  } as unknown as Reqly
}

interface CacheLog {
  matched: string[]
  stored: string[]
}

function fakeCache(log: CacheLog): Cache {
  return {
    async match(request: Request): Promise<Response | undefined> {
      log.matched.push(request.url)
      return undefined
    },
    async put(request: Request): Promise<void> {
      log.stored.push(request.url)
    },
  } as unknown as Cache
}

describe("ChunkReader range semantics", () => {
  it("returns exactly the requested range", async () => {
    const calls: Array<{ offset: number; limit: number }> = []
    const bytes = new Uint8Array(262144)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index & 0xff
    const reader = new ChunkReader(fakeClient(bytes, calls), document(), {
      chunkSize: 262144,
      cache: fakeCache({ matched: [], stored: [] }),
    })

    const aligned = await reader.readRange(0, 1023)
    expect(aligned).toHaveLength(1024)

    const unaligned = await reader.readRange(123, 4567)
    expect(unaligned).toHaveLength(4445)
    expect(unaligned).toEqual(bytes.slice(123, 4568))
  })

  it("returns fewer bytes at end-of-file", async () => {
    const bytes = new Uint8Array(100)
    const reader = new ChunkReader(fakeClient(bytes, []), document({ size: 100n }), {
      chunkSize: 262144,
      cache: fakeCache({ matched: [], stored: [] }),
    })
    expect(await reader.readRange(0, 1023)).toHaveLength(100)
  })

  it("rejects invalid bounds", async () => {
    const reader = new ChunkReader(fakeClient(new Uint8Array(10), []), document(), {
      chunkSize: 4096,
      cache: fakeCache({ matched: [], stored: [] }),
    })
    await expect(reader.readRange(10, 9)).rejects.toThrow("end must be >= start")
    await expect(reader.readRange(-1, 10)).rejects.toThrow("non-negative integer")
    await expect(reader.readRange(1.5, 10)).rejects.toThrow("non-negative integer")
  })
})

describe("ChunkReader prefetch guards", () => {
  it("does not request a negative offset for an empty document", async () => {
    const calls: Array<{ offset: number; limit: number }> = []
    const reader = new ChunkReader(fakeClient(new Uint8Array(0), calls), document({ size: 0n }), {
      chunkSize: 262144,
      cache: fakeCache({ matched: [], stored: [] }),
    })
    await reader.prefetchTail(0)
    expect(calls).toEqual([])
  })

  it("clamps a negative prefetchAhead position to zero", async () => {
    const calls: Array<{ offset: number; limit: number }> = []
    const reader = new ChunkReader(fakeClient(new Uint8Array(4096), calls), document({ size: 4096n }), {
      chunkSize: 4096,
      cache: fakeCache({ matched: [], stored: [] }),
    })
    await reader.prefetchAhead(-100, 1)
    expect(calls[0]?.offset).toBe(0)
  })
})

describe("ChunkReader cache key", () => {
  it("separates documents that share an id but not an access hash", async () => {
    const log: CacheLog = { matched: [], stored: [] }
    const cache = fakeCache(log)
    const first = new ChunkReader(fakeClient(new Uint8Array(1024), []), document({ accessHash: 20n }), {
      chunkSize: 1024,
      cache,
    })
    const second = new ChunkReader(fakeClient(new Uint8Array(1024), []), document({ accessHash: 999n }), {
      chunkSize: 1024,
      cache,
    })
    await first.readChunk(0)
    await second.readChunk(0)
    expect(log.matched).toHaveLength(2)
    expect(log.matched[0]).not.toBe(log.matched[1])
  })

  it("does not cache a short response from the middle of a file", async () => {
    const log: CacheLog = { matched: [], stored: [] }
    const reader = new ChunkReader(fakeClient(new Uint8Array(100), []), document({ size: 1_000_000n }), {
      chunkSize: 262144,
      cache: fakeCache(log),
    })
    await reader.readChunk(0)
    expect(log.stored).toHaveLength(0)
  })

  it("caches a short response that reaches end-of-file", async () => {
    const log: CacheLog = { matched: [], stored: [] }
    const reader = new ChunkReader(fakeClient(new Uint8Array(100), []), document({ size: 100n }), {
      chunkSize: 262144,
      cache: fakeCache(log),
    })
    await reader.readChunk(0)
    expect(log.stored).toHaveLength(1)
  })
})
// Mellouki Jamal — Asynctric
