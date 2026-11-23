/**
 * Cloudflare Workers integration for reqly.
 *
 * This module uses only Web Platform APIs (Request, Response, ReadableStream,
 * Web Crypto, Cache) — no Node APIs and no external runtime dependencies. It
 * turns reqly's 1 MB Telegram reads into a range-capable HTTP response that a
 * Worker can stream back with `Accept-Ranges`, `Content-Range` and an ETag.
 */

import "./wasm-worker"
import { Reqly, type ReqlyOptions } from "./client"
import type { RemoteDocument } from "./tl"

const MB = 1024 * 1024

export interface WorkerRangeOptions {
  /**
   * Optional delay after `yieldEveryBytes` have been emitted. Default 0: a
   * stream must never sacrifice throughput for an artificial timer. Use this
   * only when measurements show the Worker needs a coarse CPU-span break.
   */
  yieldMs?: number
  /**
   * Emit this many bytes between optional `yieldMs` pauses. Default 0
   * (disabled). A sensible measured value is 2–4 MB, never one timer per block.
   */
  yieldEveryBytes?: number
  /** Optional client pool; blocks are distributed round-robin to avoid per-session floods. */
  clients?: readonly Reqly[]
  /** Documents resolved per client (same file, different references). */
  documents?: readonly RemoteDocument[]
  /** Size of one Telegram `upload.getFile` block. Default 1 MB (protocol max). */
  blockSize?: number
  /** @deprecated Use `maxInFlight`. Kept for source compatibility. */
  batchChunks?: number
  /** Parallel Telegram `getFile` calls. Default 4. */
  maxWorkers?: number
  /** @deprecated The scheduler keeps all workers busy; retained for compatibility. */
  minWorkers?: number
  /** Maximum blocks fetched ahead of the consumer. Default max(maxWorkers, 8). */
  maxInFlight?: number
  /** Cache instance. Disabled by default: Cache API calls are subrequests. */
  cache?: Cache | false | undefined
  /** Cache TTL in seconds. Default 86400. */
  cacheTtl?: number
  /** MIME type of the response. Default `application/octet-stream`. */
  contentType?: string
  /** Extra response headers. */
  headers?: Record<string, string>
  /** Called after every emitted block with (bytes delivered, bytes total). */
  onProgress?: (delivered: number, total: number) => void
  /** Called after every emitted block with (wall milliseconds, bytes in the block). */
  onBatch?: (ms: number, bytes: number) => void
  /** Called when a block fetch fails, before the stream is errored. */
  onError?: (error: unknown) => void
  /** Called exactly once when the stream finishes, errors, or is cancelled. */
  onDone?: () => void
  /** Cancels the producer and all pending waits. */
  signal?: AbortSignal
  /** Ignore an incoming `Range` header and return the complete file (200). */
  ignoreRange?: boolean
  /**
   * @deprecated Retained for source compatibility. The continuous scheduler
   * does not use a per-batch CPU budget; set `maxWorkers` instead.
   */
  cpuBudgetMs?: number
}

interface ResolvedOptions {
  yieldMs: number
  yieldEveryBytes: number
  clients: readonly Reqly[]
  documents: readonly RemoteDocument[]
  blockSize: number
  maxWorkers: number
  maxInFlight: number
  cache: Cache | undefined
  cacheTtl: number
  contentType: string
  headers: Record<string, string>
  ignoreRange: boolean
  onProgress?: (delivered: number, total: number) => void
  onBatch?: (ms: number, bytes: number) => void
  onError?: (error: unknown) => void
  onDone?: () => void
  signal?: AbortSignal
}

function resolveOptions(options: WorkerRangeOptions): ResolvedOptions {
  const maxWorkers = Math.max(1, options.maxWorkers ?? 4)
  const legacyInFlight = options.batchChunks ?? 8
  return {
    yieldMs: Math.max(0, options.yieldMs ?? 0),
    yieldEveryBytes: Math.max(0, options.yieldEveryBytes ?? 0),
    clients: options.clients ?? [],
    documents: options.documents ?? [],
    blockSize: Math.max(4096, Math.floor((options.blockSize ?? MB) / 4096) * 4096),
    maxWorkers,
    // Keep a bounded lookahead. It must cover all workers plus one ready block
    // so the next Telegram RPC starts before the consumer drains the current one.
    maxInFlight: Math.max(maxWorkers + 1, options.maxInFlight ?? legacyInFlight),
    // Cache API operations count against the Workers subrequest limit. A full
    // movie must not spend 2 subrequests per MB, so caching is opt-in only.
    cache: options.cache === false ? undefined : options.cache,
    cacheTtl: options.cacheTtl ?? 86400,
    contentType: options.contentType ?? "application/octet-stream",
    headers: options.headers ?? {},
    ignoreRange: options.ignoreRange === true,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.onBatch ? { onBatch: options.onBatch } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onDone ? { onDone: options.onDone } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
}

function cacheKey(document: RemoteDocument, offset: number, limit: number): Request {
  let reference = ""
  for (const byte of document.fileReference) reference += byte.toString(16).padStart(2, "0")
  return new Request(`https://reqly-worker-v1.internal/${document.id}/${document.accessHash}/${reference}/${offset}/${limit}`)
}

/**
 * Streams a byte range as an ordered, continuous sequence of blocks.
 *
 * Unlike the old batch-barrier implementation, this scheduler never waits for
 * a whole batch: as soon as the next expected block arrives it is enqueued,
 * while up to `maxWorkers` Telegram reads and `maxInFlight` blocks remain in
 * flight. Bytes are always emitted in file order; at most `maxInFlight *
 * blockSize` bytes are buffered, which keeps a slow consumer from draining
 * memory or Telegram quota.
 *
 * There are deliberately no per-block timers. `await`ing the network RPCs
 * already yields to the runtime; an artificial `setTimeout(0)` only adds
 * latency and does not reduce total CPU.
 */
export function streamFileRange(
  client: Reqly,
  document: RemoteDocument,
  offset: number,
  length: number,
  options: WorkerRangeOptions = {},
): ReadableStream<Uint8Array> {
  const config = resolveOptions(options)
  const size = Number(document.size)
  if (!Number.isInteger(offset) || offset < 0) throw new Error("reqly: offset must be a non-negative integer")
  if (!Number.isInteger(length) || length < 0) throw new Error("reqly: length must be a non-negative integer")
  if (offset > size) throw new RangeError("reqly: offset is past end-of-file")

  const total = Math.min(length, size - offset)
  const blockCount = total === 0 ? 0 : Math.ceil(total / config.blockSize)
  const clients = config.clients.length > 0 ? config.clients : [client]
  const documents = config.documents.length > 0 ? config.documents : [document]
  // Clients and their per-session documents are aligned by slot. If the
  // caller supplied only one document, every client may still read it; if it
  // supplied multiple, each slot uses its own reference.
  const poolSize = Math.max(1, Math.min(clients.length, documents.length))

  let cancelled = false
  let finished = false
  const abort = new AbortController()
  const externalSignal = config.signal

  const onAbort = (): void => {
    cancelled = true
    abort.abort()
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    externalSignal?.removeEventListener("abort", onAbort)
    try {
      config.onDone?.()
    } catch { /* a cleanup callback must not mask the stream outcome */ }
  }
  if (externalSignal) {
    if (externalSignal.aborted) onAbort()
    else externalSignal.addEventListener("abort", onAbort, { once: true })
  }

  const readBlock = async (start: number, limit: number, index: number): Promise<Uint8Array> => {
    const slot = index % poolSize
    const active = clients[slot] ?? client
    const location = documents[slot] ?? document
    const key = cacheKey(location, start, limit)
    try {
      const hit = await config.cache?.match(key)
      if (hit) return new Uint8Array(await hit.arrayBuffer())
    } catch { /* cache unavailable */ }
    const bytes = await active.getFile(location, start, limit)
    const expected = Math.min(limit, Math.max(0, size - start))
    if (bytes.length === expected && expected > 0) {
      try {
        await config.cache?.put(key, new Response(bytes.slice().buffer as ArrayBuffer, {
          headers: { "cache-control": `public, max-age=${config.cacheTtl}`, "content-type": "application/octet-stream" },
        }))
      } catch { /* cache full or unavailable */ }
    }
    return bytes
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let nextToFetch = 0
      let nextToEmit = 0
      let delivered = 0
      let lastYieldAt = 0
      let failure: unknown
      const arrived = new Map<number, Uint8Array>()
      const tasks = new Map<number, Promise<void>>()
      const active = (): boolean => cancelled || abort.signal.aborted

      const startTask = (index: number): void => {
        const start = offset + index * config.blockSize
        const limit = Math.min(config.blockSize, offset + total - start)
        const startedAt = performance.now()
        const task = readBlock(start, limit, index)
          .then((bytes) => {
            if (active()) return
            arrived.set(index, bytes)
            try {
              config.onBatch?.(performance.now() - startedAt, bytes.length)
            } catch { /* observability must not break the stream */ }
          })
          .catch((error: unknown) => {
            if (failure === undefined) failure = error
            cancelled = true
            abort.abort()
          })
          .finally(() => {
            tasks.delete(index)
          })
        tasks.set(index, task)
      }

      const fill = (): void => {
        while (
          !active() &&
          tasks.size < config.maxWorkers &&
          nextToFetch < blockCount &&
          nextToFetch - nextToEmit < config.maxInFlight
        ) {
          startTask(nextToFetch)
          nextToFetch += 1
        }
      }

      const drain = (): void => {
        while (arrived.has(nextToEmit)) {
          const bytes = arrived.get(nextToEmit)!
          arrived.delete(nextToEmit)
          nextToEmit += 1
          if (bytes.length === 0) continue
          controller.enqueue(bytes)
          delivered += bytes.length
          try {
            config.onProgress?.(delivered, total)
          } catch { /* observability must not break the stream */ }
        }
      }

      const maybeYield = async (): Promise<void> => {
        if (config.yieldEveryBytes <= 0) return
        if (delivered - lastYieldAt < config.yieldEveryBytes) return
        lastYieldAt = delivered
        // Coarse, measured CPU-span break. This is deliberately not per block.
        await new Promise<void>((resolve) => setTimeout(resolve, config.yieldMs))
      }

      const run = async (): Promise<void> => {
        try {
          if (blockCount === 0) {
            controller.close()
            finish()
            return
          }
          while (nextToEmit < blockCount && !cancelled) {
            fill()
            drain()
            await maybeYield()
            if (failure !== undefined) throw failure
            if (nextToEmit >= blockCount) break
            if (tasks.size === 0) {
              // The window is full only behind an unarrived block; with no
              // tasks left the stream cannot make progress. Never truncate.
              if (nextToFetch >= blockCount) {
                throw new Error(`reqly: stream stalled at block ${nextToEmit} of ${blockCount}`)
              }
              await Promise.resolve()
              continue
            }
            await Promise.race(tasks.values())
          }
          if (failure !== undefined) throw failure
          if (cancelled) {
            // An external abort can happen before the stream ever starts. The
            // consumer still needs a terminal state, otherwise the reader waits
            // forever and the Worker invocation stays alive.
            try {
              controller.close()
            } catch { /* already closed or cancelled */ }
            finish()
            return
          }
          drain()
          await maybeYield()
          if (nextToEmit < blockCount) {
            throw new Error(`reqly: stream ended after ${nextToEmit} of ${blockCount} blocks`)
          }
          controller.close()
          finish()
        } catch (error) {
          try {
            config.onError?.(error)
          } catch { /* observability must not mask the stream error */ }
          try {
            controller.error(error)
          } catch { /* already closed or cancelled */ }
          finish()
        }
      }

      void run()
    },
    cancel() {
      cancelled = true
      abort.abort()
      finish()
    },
  })
}

export interface ParsedRange {
  start: number
  end: number
}

/** Parses a single HTTP byte range. Multi-range requests are not supported. */
export function parseByteRange(header: string | null, size: number): ParsedRange | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const first = match[1] ?? ""
  const last = match[2] ?? ""
  if (first === "" && last === "") return undefined
  let start: number
  let end: number
  if (first === "") {
    const suffix = Number(last)
    if (!Number.isInteger(suffix) || suffix <= 0) return undefined
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(first)
    end = last === "" ? size - 1 : Number(last)
    if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined
  }
  if (start < 0 || end < start || start >= size) return undefined
  return { start, end: Math.min(end, size - 1) }
}

/** ETag derived from immutable document metadata, safe to expose. */
export function documentETag(document: RemoteDocument): string {
  return `"reqly-${document.id}-${document.size}"`
}

/**
 * Builds a 200/206 Response for an HTTP request, honouring Range and HEAD.
 */
export async function createFileResponse(
  client: Reqly,
  document: RemoteDocument,
  request: Request,
  options: WorkerRangeOptions = {},
): Promise<Response> {
  const config = resolveOptions(options)
  // The request signal is the edge's cancellation channel: when the browser
  // seeks, closes the tab, or the Worker is evicted, the producer must stop.
  const signal = options.signal ?? request.signal
  const size = Number(document.size)
  const etag = documentETag(document)

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } })
  }

  // A one-request player deliberately ignores Range: it wants the complete
  // movie in a single 200 response. `Accept-Ranges: none` tells the browser
  // not to issue a second request for the tail.
  if (config.ignoreRange) {
    return createFullResponse(client, document, request.method, config, etag, { ...options, signal })
  }

  const ifRange = request.headers.get("if-range")
  if (ifRange && ifRange !== etag && !/^\w{3}, /.test(ifRange)) {
    // A weak validator or mismatched ETag means the range must be ignored.
    return createFullResponse(client, document, request.method, config, etag, { ...options, signal })
  }
  const rangeHeader = request.headers.get("range")
  const range = parseByteRange(rangeHeader, size)
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes", ETag: etag },
    })
  }
  if (!range) return createFullResponse(client, document, request.method, config, etag, { ...options, signal })

  const length = range.end - range.start + 1
  const headers = new Headers(config.headers)
  headers.set("Accept-Ranges", "bytes")
  headers.set("Content-Type", config.contentType)
  headers.set("Content-Length", String(length))
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
  headers.set("ETag", etag)
  headers.set("Cache-Control", `public, max-age=${config.cacheTtl}`)
  if (request.method === "HEAD") return new Response(null, { status: 206, headers })
  const body = streamFileRange(client, document, range.start, length, {
    ...options,
    signal,
    cache: config.cache,
    ...(config.onDone ? { onDone: config.onDone } : {}),
  })
  return new Response(body as unknown as BodyInit, { status: 206, headers })
}

function createFullResponse(
  client: Reqly,
  document: RemoteDocument,
  method: string,
  config: ResolvedOptions,
  etag: string,
  options: WorkerRangeOptions,
): Response {
  const size = Number(document.size)
  const headers = new Headers(config.headers)
  headers.set("Accept-Ranges", config.ignoreRange ? "none" : "bytes")
  headers.set("Content-Type", config.contentType)
  headers.set("Content-Length", String(size))
  headers.set("ETag", etag)
  headers.set("Cache-Control", `public, max-age=${config.cacheTtl}`)
  if (method === "HEAD") return new Response(null, { status: 200, headers })
  const body = streamFileRange(client, document, 0, size, {
    ...options,
    cache: config.cache,
    ...(config.onDone ? { onDone: config.onDone } : {}),
    ...(config.signal ? { signal: config.signal } : {}),
  })
  return new Response(body as unknown as BodyInit, { status: 200, headers })
}

/** Everything a Worker needs, so the application code stays tiny. */
export interface WorkerHandlerOptions extends WorkerRangeOptions {
  /** Session string, or a function returning one per request. */
  session: string | ((request: Request) => string | Promise<string>)
  /** Options forwarded to `Reqly.connect`. */
  connectOptions?: ReqlyOptions
  /** Maps the incoming request to a Telegram document. */
  resolveDocument: (request: Request, client: Reqly) => RemoteDocument | Promise<RemoteDocument>
  /** Optional authorization gate. */
  authorize?: (request: Request) => boolean | Promise<boolean>
}

/**
 * Creates a complete Worker `fetch` handler in one call. Example:
 *
 * ```ts
 * export default createWorkerHandler({
 *   session: env.MT_SESSION,
 *   resolveDocument: () => document,
 * })
 * ```
 */
export function createWorkerHandler(options: WorkerHandlerOptions): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      if (options.authorize && !(await options.authorize(request))) {
        return new Response("Unauthorized", { status: 401 })
      }
      const session = typeof options.session === "function" ? await options.session(request) : options.session
      const client = await Reqly.connect(session, options.connectOptions)
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        client.close()
      }
      const userOnDone = options.onDone
      const streamOptions: WorkerHandlerOptions = {
        ...options,
        onDone: () => {
          try {
            userOnDone?.()
          } finally {
            close()
          }
        },
      }
      try {
        const document = await options.resolveDocument(request, client)
        const response = await createFileResponse(client, document, request, streamOptions)
        // Only a 200/206 GET owns a streaming body. HEAD, 416, 405 and other
        // short responses have no one to call `onDone`, so close right away.
        const streamed = (response.status === 200 || response.status === 206) &&
          request.method !== "HEAD" &&
          response.body !== null
        if (!streamed) close()
        return response
      } catch (error) {
        close()
        throw error
      }
    },
  }
}

/**
 * Convenience fetch handler. `resolveDocument` is called with the incoming
 * request so applications can map URLs to Telegram documents themselves.
 */
export function createFileRequestHandler(
  getClient: () => Reqly | Promise<Reqly>,
  resolveDocument: (request: Request) => RemoteDocument | Promise<RemoteDocument>,
  options: WorkerRangeOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const [client, document] = await Promise.all([getClient(), resolveDocument(request)])
    return createFileResponse(client, document, request, options)
  }
}
