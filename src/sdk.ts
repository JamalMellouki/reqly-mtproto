/**
 * reqly SDK — a small, opinionated high-level layer over the core client.
 *
 * The core package intentionally exposes protocol primitives. Most applications
 * only need a comfortable way to download a document, stream a byte range,
 * verify hashes and hand a stream to a Worker. `ReqlySdk` provides exactly that
 * without hiding the primitives: `sdk.client` always remains available.
 *
 * Copyright (c) 2026 Mellouki Jamal, Asynctric.
 * Licensed under ASYNCTRIC-3.0. Author and platform identity must be preserved.
 */

import { Reqly, type ReqlyOptions } from "./client"
import type { SdkCache } from "./cache"
import type { FileHashEntry } from "./hashes"
import type { RemoteDocument } from "./tl"
import { createStreamToken, verifyStreamToken, type StreamTokenPayload } from "./token"
import { createWorkerHandler, type WorkerHandlerOptions } from "./worker"
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from "./retry"

/** Default size of one SDK streaming block: Telegram's `upload.getFile` hard limit. */
export const SDK_BLOCK_BYTES = 1024 * 1024

function referenceHex(bytes: Uint8Array): string {
  let output = ""
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0")
  return output
}

/** Options accepted by {@link createReqlySdk}. */
export interface ReqlySdkOptions extends ReqlyOptions {
  /** gramJS v1 StringSession for the home data center. */
  session: string
  /** Secret used to sign short-lived stream tokens. Never log or commit it. */
  tokenSecret?: string
  /** Default concurrency for parallel block downloads (2–4 recommended). */
  maxWorkers?: number
  /** Default byte cache used by `download`, `range` and `stream`. */
  cache?: SdkCache
  /** Default retry policy for cache-aware block reads and helper calls. */
  retry?: Partial<RetryPolicy>
}

/** Options for {@link ReqlySdk.download}. */
export interface SdkDownloadOptions {
  /** Refresh a stale `file_reference` (called automatically on expiry). */
  refresh?: () => Promise<RemoteDocument>
  /** Download byte length; defaults to the whole document. */
  length?: number
  /** Receive progress after every completed block. */
  onProgress?: (done: number, total: number) => void
  /** Override the per-request block size (must stay ≤ 1 MB). */
  blockSize?: number
  /** Per-call byte cache; falls back to the SDK default. */
  cache?: SdkCache
  /** Per-call retry policy; falls back to the SDK default. */
  retry?: Partial<RetryPolicy>
}

/** Options for {@link ReqlySdk.range}. */
export interface SdkRangeOptions {
  /** Refresh a stale `file_reference`. */
  refresh?: () => Promise<RemoteDocument>
  /** Per-call byte cache; falls back to the SDK default. */
  cache?: SdkCache
  /** Per-call retry policy; falls back to the SDK default. */
  retry?: Partial<RetryPolicy>
}

/** Options for {@link ReqlySdk.stream}. */
export interface SdkStreamOptions {
  /** Bytes per yielded chunk. Defaults to {@link SDK_BLOCK_BYTES}. */
  chunkSize?: number
  /** Refresh a stale `file_reference`. */
  refresh?: () => Promise<RemoteDocument>
  /** Called with the number of bytes emitted so far. */
  onProgress?: (bytes: number) => void
  /** Abort the stream. */
  signal?: AbortSignal
  /** Per-call byte cache; falls back to the SDK default. */
  cache?: SdkCache
  /** Per-call retry policy; falls back to the SDK default. */
  retry?: Partial<RetryPolicy>
}

/** Small cache contract used by the SDK; see `./cache` for implementations. */
export type { SdkCache } from "./cache"

/**
 * High-level reqly SDK.
 *
 * ```ts
 * import { createReqlySdk } from "reqlyproto"
 *
 * const sdk = await createReqlySdk({ session: MT_SESSION, dcSessions: DC_SESSIONS })
 * const bytes = await sdk.download(document)
 * const stream = sdk.stream(document, { chunkSize: 512 * 1024 })
 * sdk.close()
 * ```
 */
export class ReqlySdk {
  /** The underlying client, exposed for advanced/raw MTProto access. */
  readonly client: Reqly

  private readonly session: string
  private readonly tokenSecret: string | undefined
  private readonly maxWorkers: number
  private readonly cache: SdkCache | undefined
  private readonly retry: Partial<RetryPolicy> | undefined
  private readonly connectOptions: ReqlyOptions

  private constructor(client: Reqly, options: ReqlySdkOptions) {
    this.client = client
    this.session = options.session
    this.tokenSecret = options.tokenSecret ?? undefined
    this.maxWorkers = Math.max(1, options.maxWorkers ?? 4)
    this.cache = options.cache
    this.retry = options.retry
    // Kept so `sdk.worker()` can rebuild a per-request client with the same
    // timeouts, DC sessions and transport mode.
    this.connectOptions = options
  }

  /** Connect and return a ready-to-use SDK instance. */
  static async connect(options: ReqlySdkOptions): Promise<ReqlySdk> {
    const client = await Reqly.connect(options.session, options)
    return new ReqlySdk(client, options)
  }

  /**
   * Stable cache key for a document range.
   *
   * The `file_reference` fingerprint is part of the key on purpose: Telegram
   * can re-issue the same document id with a different reference, and cached
   * bytes fetched under a stale reference must never satisfy the new one.
   */
  static cacheKey(document: RemoteDocument, offset: number, length: number): string {
    return `reqly:${document.id}:${document.accessHash}:${referenceHex(document.fileReference)}:${offset}:${length}`
  }

  /** Download a whole document, or a leading slice of it, with progress. */
  async download(document: RemoteDocument, options: SdkDownloadOptions = {}): Promise<Uint8Array> {
    const size = Number(document.size)
    const total = Math.min(Math.max(0, options.length ?? size), size)
    const block = Math.min(SDK_BLOCK_BYTES, Math.max(1, options.blockSize ?? SDK_BLOCK_BYTES))
    if (total === 0) return new Uint8Array()

    const cache = options.cache ?? this.cache
    const retry = options.retry ?? this.retry
    const ranges: { offset: number; limit: number }[] = []
    for (let offset = 0; offset < total; offset += block) {
      ranges.push({ offset, limit: Math.min(block, total - offset) })
    }

    // Progress is reported as the number of completed blocks, not the highest
    // index: the pool resolves ranges out of order, and a seek must not make
    // the counter jump backwards.
    const completed = new Map<number, number>()
    const chunks = await this.client.getFilesParallel(document, ranges, {
      maxWorkers: this.maxWorkers,
      // `readBlock` owns retries so a cache-aware read is not retried twice.
      retries: 0,
      fetch: (range) => this.readBlock(document, range.offset, range.limit, {
        ...(cache ? { cache } : {}),
        ...(retry ? { retry } : {}),
        ...(options.refresh ? { refresh: options.refresh } : {}),
      }),
      onChunk: (index, bytes) => {
        completed.set(index, bytes.length)
        let done = 0
        for (const length of completed.values()) done += length
        options.onProgress?.(Math.min(total, done), total)
      },
    })
    options.onProgress?.(total, total)

    const out = new Uint8Array(total)
    let cursor = 0
    for (const chunk of chunks) {
      out.set(chunk.subarray(0, Math.min(chunk.length, total - cursor)), cursor)
      cursor += Math.min(chunk.length, total - cursor)
    }
    return out
  }

  /** Download an arbitrary byte range `[start, end]` (inclusive). */
  async range(
    document: RemoteDocument,
    start: number,
    end: number,
    options: SdkRangeOptions = {},
  ): Promise<Uint8Array> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new Error("reqly sdk: invalid range")
    }
    const length = end - start + 1
    const cache = options.cache ?? this.cache
    const key = ReqlySdk.cacheKey(document, start, length)
    if (cache) {
      try {
        const hit = await cache.match(key)
        if (hit && hit.length > 0) return hit
      } catch { /* cache unavailable */ }
    }
    const policy = { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? this.retry ?? {}) }
    const task = () => this.client.getFile(document, start, length, options.refresh)
    const bytes = await withRetry(task, policy)
    if (cache && bytes.length === length) {
      try {
        await cache.put(key, bytes)
      } catch { /* cache full or unavailable */ }
    }
    return bytes
  }

  /** Lazily pull blocks from Telegram as a `ReadableStream<Uint8Array>`. */
  stream(document: RemoteDocument, options: SdkStreamOptions = {}): ReadableStream<Uint8Array> {
    const chunkSize = Math.min(SDK_BLOCK_BYTES, Math.max(1, options.chunkSize ?? SDK_BLOCK_BYTES))
    const size = Number(document.size)
    const cache = options.cache ?? this.cache
    const retry = options.retry ?? this.retry
    let offset = 0
    let done = 0

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(options.signal.reason ?? new Error("reqly sdk: stream aborted"))
          return
        }
        if (offset >= size) {
          controller.close()
          return
        }
        const bytes = await this.readBlock(
          document,
          offset,
          Math.min(chunkSize, size - offset),
          {
            ...(cache ? { cache } : {}),
            ...(retry ? { retry } : {}),
            ...(options.refresh ? { refresh: options.refresh } : {}),
          },
        )
        if (options.signal?.aborted) {
          controller.error(options.signal.reason ?? new Error("reqly sdk: stream aborted"))
          return
        }
        offset += bytes.length
        done += bytes.length
        options.onProgress?.(done)
        controller.enqueue(bytes)
      },
    })
  }

  /** Fetch `upload.getFileHashes` entries, with reference refresh and DC migration. */
  hashes(document: RemoteDocument, refresh?: () => Promise<RemoteDocument>): Promise<FileHashEntry[]> {
    return this.client.getFileHashes(document, 0, refresh)
  }

  /**
   * Reads one block, consulting the cache first and applying the retry policy.
   * Only complete blocks are cached; short reads in the middle of a file are
   * discarded so a later seek cannot be served truncated bytes.
   */
  private async readBlock(
    document: RemoteDocument,
    offset: number,
    limit: number,
    options: {
      cache?: SdkCache
      retry?: Partial<RetryPolicy>
      refresh?: () => Promise<RemoteDocument>
    },
  ): Promise<Uint8Array> {
    const key = ReqlySdk.cacheKey(document, offset, limit)
    if (options.cache) {
      try {
        const hit = await options.cache.match(key)
        if (hit && hit.length > 0) return hit
      } catch { /* cache unavailable */ }
    }
    const policy = { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? {}) }
    const task = () => this.client.getFile(document, offset, limit, options.refresh)
    const bytes = await withRetry(task, policy)
    const expected = Math.min(limit, Math.max(0, Number(document.size) - offset))
    if (options.cache && expected > 0 && bytes.length === expected) {
      try {
        await options.cache.put(key, bytes)
      } catch { /* cache full or unavailable */ }
    }
    return bytes
  }

  /** Sign a short-lived token for a Worker-to-Worker stream request. */
  issueToken(payload: Omit<StreamTokenPayload, "e">, ttlSeconds = 60): Promise<string> {
    if (!this.tokenSecret) throw new Error("reqly sdk: tokenSecret is required to issue tokens")
    return createStreamToken(this.tokenSecret, payload, ttlSeconds)
  }

  /** Verify a token issued by {@link issueToken}. */
  verifyToken(token: string): Promise<StreamTokenPayload | null> {
    if (!this.tokenSecret) return Promise.resolve(null)
    return verifyStreamToken(this.tokenSecret, token)
  }

  /** Build a complete Cloudflare Worker `fetch` handler for this SDK. */
  worker(options: Omit<WorkerHandlerOptions, "session"> & { session?: string }): { fetch(request: Request): Promise<Response> } {
    return createWorkerHandler({
      ...options,
      session: options.session ?? this.session,
      connectOptions: options.connectOptions ?? this.connectOptions,
    })
  }

  /** Close every reusable connection owned by the underlying client. */
  close(): void {
    this.client.close()
  }
}

/** Convenience factory for {@link ReqlySdk.connect}. */
export function createReqlySdk(options: ReqlySdkOptions): Promise<ReqlySdk> {
  return ReqlySdk.connect(options)
}
