/**
 * High-level streaming helper built on top of Reqly.
 *
 * Telegram limits `upload.getFile` to 1 MB per call, and Workers have a 10 ms
 * CPU budget per invocation. Pure-JS AES-IGE cannot encrypt a full 1 MB inside
 * that budget, so the default chunk is 256 KB. Applications with a WASM crypto
 * provider can raise it to 1 MB.
 *
 * Chunks are cached individually in the runtime's Cache API when available,
 * so replays and backward seeks are served without contacting Telegram.
 *
 * @example
 * ```ts
 * const reader = createChunkReader(client, document, { chunkSize: 262144 })
 * const bytes = await reader.readRange(0, 1024 * 1024)
 * await reader.prefetchTail(document.size)
 * ```
 */

import type { Reqly } from "./client"
import type { RemoteDocument } from "./tl"

const ALIGN = 4096
const MB = 1024 * 1024

/**
 * Options for {@link ChunkReader}.
 */
export interface StreamOptions {
  /** Bytes per MTProto request. Default 256 KB (Workers CPU-safe). */
  chunkSize?: number
  /** Cache TTL in seconds. Default 86400. */
  cacheTtl?: number
  /** Cache instance. Defaults to `caches.default` when available. */
  cache?: Cache | undefined
  /** Adaptive parallel worker bounds. Defaults 2 → 4. */
  minWorkers?: number
  maxWorkers?: number
}

function aligned(value: number): number {
  return Math.floor(value / ALIGN) * ALIGN
}

function referenceHex(bytes: Uint8Array): string {
  let output = ""
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0")
  return output
}

function cacheKey(location: RemoteDocument, offset: number, chunkSize: number): Request {
  // Include the chunk size: a cached 64 KB body must never satisfy a 1 MB read.
  // Include access_hash and file_reference too: the same document id can be
  // re-issued with a different reference, and two peers can expose the same id
  // with different access hashes. Keying on id alone serves the wrong bytes.
  return new Request(
    `https://reqly-chunk-v6.internal/${location.id}/${location.accessHash}/${referenceHex(location.fileReference)}/${offset}/${chunkSize}`,
  )
}

/**
 * A cached, block-aligned chunk reader for one document.
 *
 * Reads chunks from the edge cache first, falling back to Telegram. Supports
 * adaptive parallel range reads and proactive prefetching for video playback.
 */
export class ChunkReader {
  private readonly chunkSize: number
  private readonly cacheTtl: number
  private readonly cache: Cache | undefined
  private readonly minWorkers: number
  private readonly maxWorkers: number

  constructor(
    private readonly client: Reqly,
    private readonly location: RemoteDocument,
    options: StreamOptions = {},
  ) {
    this.chunkSize = Math.max(ALIGN, Math.floor((options.chunkSize ?? 262144) / ALIGN) * ALIGN)
    this.cacheTtl = options.cacheTtl ?? 86400
    const runtimeCache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined
    this.cache = options.cache ?? runtimeCache
    this.minWorkers = Math.max(1, options.minWorkers ?? 2)
    this.maxWorkers = Math.max(this.minWorkers, options.maxWorkers ?? 4)
  }

  /**
   * Reads one chunk, first from the edge cache, then from Telegram.
   *
   * Never caches an empty or short response, as that would poison later seeks.
   *
   * @param offset - Block-aligned chunk offset.
   * @returns The chunk bytes.
   */
  async readChunk(offset: number): Promise<Uint8Array> {
    const key = cacheKey(this.location, offset, this.chunkSize)
    try {
      const hit = await this.cache?.match(key)
      if (hit) return new Uint8Array(await hit.arrayBuffer())
    } catch { /* cache unavailable */ }

    const bytes = await this.client.getFile(this.location, offset, this.chunkSize)
    // Never cache an empty or short response: it would poison later seeks.
    // A short read is only complete when it reaches the document's end.
    const expected = Math.min(this.chunkSize, Math.max(0, Number(this.location.size) - offset))
    const complete = bytes.length === this.chunkSize || (expected > 0 && bytes.length === expected)
    if (!complete) return bytes
    try {
      await this.cache?.put(key, new Response(bytes.slice().buffer as ArrayBuffer, {
        headers: { "cache-control": `public, max-age=${this.cacheTtl}`, "content-type": "application/octet-stream" },
      }))
    } catch { /* cache full or unavailable */ }
    return bytes
  }

  /**
   * Reads an arbitrary byte range with adaptive parallel chunk fetching.
   *
   * @param start - Start byte (inclusive).
   * @param end - End byte (inclusive).
   * @returns The requested bytes.
   */
  async readRange(start: number, end: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) {
      throw new Error("reqly: readRange requires non-negative integer bounds")
    }
    if (end < start) throw new Error("reqly: readRange end must be >= start")
    const length = end - start + 1
    const from = aligned(start)
    const skip = start - from
    const total = skip + length
    const ranges: Array<{ offset: number; limit: number }> = []
    for (let offset = from; offset < from + total; offset += this.chunkSize) {
      ranges.push({ offset, limit: this.chunkSize })
    }
    const parts = await this.client.getFilesParallel(this.location, ranges, {
      minWorkers: this.minWorkers,
      maxWorkers: this.maxWorkers,
      fetch: (range) => this.readChunk(range.offset),
    })
    const size = parts.reduce((sum, part) => sum + part.length, 0)
    const output = new Uint8Array(size)
    let position = 0
    for (const part of parts) {
      output.set(part, position)
      position += part.length
    }
    // The fetched chunks are block-aligned and usually longer than the request.
    // Trim both the leading skip and the trailing bytes so callers get exactly
    // `end - start + 1` bytes (or fewer at end-of-file).
    return output.subarray(skip, skip + length)
  }

  /**
   * Warms the final chunk (MP4 moov atom) so playback can start immediately.
   *
   * @param size - Total document size in bytes.
   */
  async prefetchTail(size: number): Promise<void> {
    if (!Number.isFinite(size) || size <= 0) return
    const tail = Math.floor((size - 1) / this.chunkSize) * this.chunkSize
    try {
      if (await this.cache?.match(cacheKey(this.location, tail, this.chunkSize))) return
      await this.readChunk(tail)
    } catch { /* best effort */ }
  }

  /**
   * Warms upcoming chunks from the current playback position.
   *
   * @param from - Start byte to begin prefetching from.
   * @param count - Number of chunks to prefetch. Defaults to 4.
   * @param size - Total document size. Defaults to MAX_SAFE_INTEGER.
   */
  async prefetchAhead(from: number, count = 4, size = Number.MAX_SAFE_INTEGER): Promise<void> {
    const start = aligned(Math.max(0, from))
    for (let index = 0; index < count; index += 1) {
      const offset = start + index * this.chunkSize
      if (offset >= size) break
      try {
        if (await this.cache?.match(cacheKey(this.location, offset, this.chunkSize))) continue
        await this.readChunk(offset)
      } catch { /* best effort */ }
    }
  }
}

/** Convenience factory for creating a {@link ChunkReader}. */
export function createChunkReader(client: Reqly, location: RemoteDocument, options?: StreamOptions): ChunkReader {
  return new ChunkReader(client, location, options)
}

export { MB as STREAM_MB }
// Mellouki Jamal — Asynctric
