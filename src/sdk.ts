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
import type { FileHashEntry } from "./hashes"
import type { RemoteDocument } from "./tl"
import { createStreamToken, verifyStreamToken, type StreamTokenPayload } from "./token"
import { createWorkerHandler, type WorkerHandlerOptions } from "./worker"

/** Default size of one SDK streaming block: Telegram's `upload.getFile` hard limit. */
export const SDK_BLOCK_BYTES = 1024 * 1024

/** Options accepted by {@link createReqlySdk}. */
export interface ReqlySdkOptions extends ReqlyOptions {
  /** gramJS v1 StringSession for the home data center. */
  session: string
  /** Secret used to sign short-lived stream tokens. Never log or commit it. */
  tokenSecret?: string
  /** Default concurrency for parallel block downloads (2–4 recommended). */
  maxWorkers?: number
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
}

/** Small cache contract used by the SDK; compatible with the Cloudflare Cache API. */
export interface SdkCache {
  match(key: string): Promise<Uint8Array | undefined> | Uint8Array | undefined
  put(key: string, bytes: Uint8Array): Promise<void> | void
}

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

  private readonly tokenSecret: string | undefined
  private readonly maxWorkers: number

  private constructor(client: Reqly, options: ReqlySdkOptions) {
    this.client = client
    this.tokenSecret = options.tokenSecret ?? undefined
    this.maxWorkers = Math.max(1, options.maxWorkers ?? 4)
  }

  /** Connect and return a ready-to-use SDK instance. */
  static async connect(options: ReqlySdkOptions): Promise<ReqlySdk> {
    const client = await Reqly.connect(options.session, options)
    return new ReqlySdk(client, options)
  }

  /** Stable cache key for a document range (hash-independent, reference-safe). */
  static cacheKey(document: RemoteDocument, offset: number, length: number): string {
    return `reqly:${document.id}:${document.accessHash}:${offset}:${length}`
  }

  /** Download a whole document, or a leading slice of it, with progress. */
  async download(document: RemoteDocument, options: SdkDownloadOptions = {}): Promise<Uint8Array> {
    const size = Number(document.size)
    const total = Math.min(Math.max(0, options.length ?? size), size)
    const block = Math.min(SDK_BLOCK_BYTES, Math.max(1, options.blockSize ?? SDK_BLOCK_BYTES))
    if (total === 0) return new Uint8Array()

    const ranges: { offset: number; limit: number }[] = []
    for (let offset = 0; offset < total; offset += block) {
      ranges.push({ offset, limit: Math.min(block, total - offset) })
    }
    const chunks = await this.client.getFilesParallel(document, ranges, {
      maxWorkers: this.maxWorkers,
      onChunk: (index, bytes) => options.onProgress?.(
        Math.min(total, (index + 1) * block),
        total,
      ),
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
  async range(document: RemoteDocument, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new Error("reqly sdk: invalid range")
    }
    return this.client.getFile(document, start, end - start + 1)
  }

  /** Lazily pull blocks from Telegram as a `ReadableStream<Uint8Array>`. */
  stream(document: RemoteDocument, options: SdkStreamOptions = {}): ReadableStream<Uint8Array> {
    const chunkSize = Math.min(SDK_BLOCK_BYTES, Math.max(1, options.chunkSize ?? SDK_BLOCK_BYTES))
    const size = Number(document.size)
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
        const bytes = await this.client.getFile(
          document,
          offset,
          Math.min(chunkSize, size - offset),
          options.refresh,
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
  hashes(document: RemoteDocument): Promise<FileHashEntry[]> {
    return this.client.getFileHashes(document)
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
    return createWorkerHandler({ ...options, session: options.session ?? "" })
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
