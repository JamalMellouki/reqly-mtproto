/**
 * reqly interactive Worker streaming.
 *
 * One WebSocket Upgrade = one Worker request. Every later message (`range`,
 * `cancel`, `flow`, `ping`) is handled inside this module and does not create
 * another Worker invocation. Telegram blocks are fetched with 1 MB RPCs over
 * a small pool of bot sessions and framed to the client as soon as they are
 * decrypted.
 *
 * Protocol v2
 * -----------
 * Client -> server:
 *   {type:"hello", protocol:2}
 *   {type:"range", id, offset, length}   // length 0/omitted = to EOF
 *   {type:"cancel", id}                  // omit id to cancel every range
 *   {type:"flow", id, paused}            // stop/resume the producer
 *   {type:"ping", at}
 *   {type:"meta", messageId}             // switch document (optional)
 *
 * Server -> client:
 *   {type:"info", size, protocol:2, blockSize, maxRanges, heartbeatMs}
 *   {type:"hello", protocol:2, framing:"id", ...}
 *   {type:"range-start", id, offset, length}
 *   binary frame: [id:uint32 big-endian][payload...]
 *   {type:"range-end", id}
 *   {type:"range-error", id, message}
 *   {type:"range-canceled", id, reason}
 *   {type:"ping", at} / {type:"pong", at}
 *
 * Binary frames are always prefixed with the range id in v2. This lets a
 * Service Worker multiplex several browser `Range` requests (the player's
 * current position, a tail `moov` probe, a seek) over a single socket.
 */

declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket }

import { Reqly } from "./client"
import type { RemoteDocument } from "./tl"
import { streamFileRange } from "./worker"

const MB = 1024 * 1024

/** Minimal D1 binding shape (no Cloudflare type dependency). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { all(): Promise<{ results: Array<Record<string, unknown>> }> }
    all(): Promise<{ results: Array<Record<string, unknown>> }>
  }
}

export interface BotPoolOptions {
  /** Maximum number of bot sessions to load (fewer = lower cold-start CPU). */
  limit?: number
  d1: D1Like
  channelId: bigint
  messageId: number
  apiId?: number
  apiHash?: string
  /** Per-RPC timeout; a long-lived stream deserves more than the default. */
  timeoutMs?: number
}

export interface StreamPool {
  clients: Reqly[]
  documents: RemoteDocument[]
}

/**
 * Reads bot sessions + per-bot channel hashes from D1 and resolves documents.
 *
 * A failed bot is skipped and its socket is closed immediately; one bad
 * session must not leak a WebSocket or prevent the remaining pool from
 * serving the request.
 */
export async function createBotPool(options: BotPoolOptions): Promise<StreamPool> {
  const result = await options.d1
    .prepare("SELECT bot_id, session, channel_hash FROM bot_sessions WHERE active = 1 ORDER BY bot_id LIMIT ?1")
    .bind(options.limit ?? 4)
    .all()
  const rows = result.results
  const clients: Reqly[] = []
  const documents: RemoteDocument[] = []
  for (const row of rows) {
    const session = typeof row.session === "string" ? row.session : ""
    const hashRaw = typeof row.channel_hash === "string" ? row.channel_hash : ""
    if (!session || !hashRaw) continue
    let client: Reqly | undefined
    try {
      client = await Reqly.connect(session, {
        timeoutMs: options.timeoutMs ?? 60000,
        ...(options.apiId ? { apiId: options.apiId } : {}),
      })
      const documentsForBot = await client.getMessages(options.channelId, BigInt(hashRaw), [options.messageId])
      if (documentsForBot.length === 0) {
        client.close()
        continue
      }
      clients.push(client)
      documents.push(documentsForBot[0]!)
    } catch {
      client?.close()
    }
  }
  return { clients, documents }
}

export interface WsControl {
  type:
    | "play"
    | "pause"
    | "seek"
    | "resume"
    | "stop"
    | "init"
    | "meta"
    | "hello"
    | "range"
    | "cancel"
    | "flow"
    | "ping"
    | "pong"
  offset?: number
  length?: number
  messageId?: number
  id?: number
  protocol?: number
  paused?: boolean
}

export interface WsHandlerOptions extends StreamPool {
  /** Rebuilds the bot pool when the client requests a different message. */
  poolFactory?: (messageId: number) => Promise<StreamPool>
  messageId?: number
  blockSize?: number
  /** Telegram reads per range. Default 1 (a phone never needs more). */
  maxWorkers?: number
  /** Blocks fetched ahead of the consumer per range. Default 4. */
  maxInFlight?: number
  /** @deprecated Use `yieldEveryBytes`; retained for source compatibility. */
  batchChunks?: number
  /** Optional timer length used after `yieldEveryBytes`. Default 0. */
  yieldMs?: number
  /** Emit this many bytes between CPU-span breaks. Default 1 MB. */
  yieldEveryBytes?: number
  /** Pause socket writes when `bufferedAmount` exceeds this many bytes. Default 8 MB. */
  maxBufferedBytes?: number
  /** Maximum simultaneous browser ranges per socket. Default 3. */
  maxRanges?: number
  /** @deprecated Use `maxWorkers`. */
  rangeMaxWorkers?: number
  /** @deprecated Use `maxInFlight`. */
  rangeMaxInFlight?: number
  /** Server heartbeat interval. 0 disables it. Default 25000 ms. */
  heartbeatMs?: number
  /** Close a socket that has sent nothing for this long. Default 300000 ms. */
  idleTimeoutMs?: number
  onError?: (error: unknown) => void
  /** Called exactly once when the socket closes or errors. */
  onClose?: () => void
  /** Releases sockets when a pool is replaced or the socket closes. */
  disposePool?: (pool: StreamPool) => void
}

interface RangeJob {
  id: number
  offset: number
  length: number
  controller: AbortController
  reader: ReadableStreamDefaultReader<Uint8Array>
  startedAt: number
  paused: boolean
  resume?: (() => void) | undefined
}

/**
 * Attaches reqly's streaming state machine to an accepted Worker WebSocket.
 */
export function attachStreamSocket(socket: WebSocket, options: WsHandlerOptions): void {
  const blockSize = Math.max(4096, Math.floor((options.blockSize ?? MB) / 4096) * 4096)
  const maxRanges = Math.max(1, options.maxRanges ?? 3)
  const rangeMaxWorkers = Math.max(1, options.maxWorkers ?? options.rangeMaxWorkers ?? 1)
  const rangeMaxInFlight = Math.max(
    rangeMaxWorkers + 1,
    options.maxInFlight ?? options.rangeMaxInFlight ?? 4,
  )
  const heartbeatMs = Math.max(0, options.heartbeatMs ?? 25_000)
  const idleTimeoutMs = Math.max(30_000, options.idleTimeoutMs ?? 300_000)
  const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? blockSize)
  const yieldMs = Math.max(0, options.yieldMs ?? 0)
  const maxBufferedBytes = Math.max(0, options.maxBufferedBytes ?? 8 * MB)
  const dispose = options.disposePool ?? ((pool: StreamPool): void => {
    for (const client of pool.clients) {
      try {
        client.close()
      } catch { /* already closed */ }
    }
  })

  let cleaned = false
  let started = false
  let lastSeen = Date.now()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let framed = false
  let legacyRunning = false
  let activeAbort: AbortController | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const ranges = new Map<number, RangeJob>()

  const sendJSON = (value: unknown): void => {
    try {
      socket.send(JSON.stringify(value))
    } catch { /* socket already closed */ }
  }

  const sendBinary = (id: number, chunk: Uint8Array): void => {
    const frame = new Uint8Array(4 + chunk.length)
    new DataView(frame.buffer).setUint32(0, id, false)
    frame.set(chunk, 4)
    socket.send(frame as unknown as ArrayBuffer)
    lastSeen = Date.now()
  }

  const wakeRange = (job: RangeJob): void => {
    const resume = job.resume
    job.resume = undefined
    try {
      resume?.()
    } catch { /* waiter already gone */ }
  }

  const cancelRange = (id: number, reason?: string): void => {
    const job = ranges.get(id)
    if (!job) return
    ranges.delete(id)
    job.paused = false
    wakeRange(job)
    try {
      job.controller.abort()
    } catch { /* already aborted */ }
    void job.reader.cancel().catch(() => {})
    if (reason !== undefined) sendJSON({ type: "range-canceled", id, reason })
  }

  const cancelAllRanges = (reason?: string): void => {
    for (const id of [...ranges.keys()]) cancelRange(id, reason)
  }

  const closeLegacy = (): void => {
    legacyRunning = false
    generation += 1
    try {
      activeAbort?.abort()
    } catch { /* already aborted */ }
    activeAbort = undefined
    const reader = activeReader
    activeReader = undefined
    if (reader) void reader.cancel().catch(() => {})
  }

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    closeLegacy()
    cancelAllRanges()
    try {
      dispose({ clients: options.clients, documents: options.documents })
    } catch { /* cleanup must be best-effort */ }
    try {
      options.onClose?.()
    } catch { /* cleanup must be best-effort */ }
  }

  const replacePool = async (requested: number | undefined): Promise<void> => {
    const messageId = requested ?? options.messageId ?? 0
    if (!options.poolFactory || !messageId) return
    if (messageId === options.messageId && options.clients.length > 0) return
    // A different document invalidates every byte already queued.
    closeLegacy()
    cancelAllRanges("meta")
    const previous: StreamPool = { clients: options.clients, documents: options.documents }
    const pool = await options.poolFactory(messageId)
    options.clients = pool.clients
    options.documents = pool.documents
    options.messageId = messageId
    if (previous.clients !== pool.clients) {
      try {
        dispose(previous)
      } catch { /* cleanup must be best-effort */ }
    }
  }

  const waitForBuffer = async (active: () => boolean): Promise<void> => {
    if (maxBufferedBytes <= 0) return
    const buffered = socket as unknown as { bufferedAmount?: number }
    while (active() && (buffered.bufferedAmount ?? 0) > maxBufferedBytes) {
      // This timer is real backpressure (the consumer is slower than
      // Telegram), not a per-block CPU yield.
      await new Promise<void>((resolve) => setTimeout(resolve, 4))
    }
  }

  const waitWhilePaused = async (job: RangeJob): Promise<void> => {
    while (job.paused && !cleaned && !job.controller.signal.aborted) {
      await new Promise<void>((resolve) => {
        job.resume = resolve
      })
    }
  }

  const startRange = (id: number, offset: number, requestedLength: number): void => {
    if (cleaned) return
    if (ranges.has(id)) cancelRange(id)
    if (ranges.size >= maxRanges) {
      // A seek must never wait behind stale read-ahead. Preempt the oldest
      // range; the browser can retry it if it is still needed.
      let oldest: RangeJob | undefined
      for (const job of ranges.values()) {
        if (!oldest || job.startedAt < oldest.startedAt) oldest = job
      }
      if (oldest) cancelRange(oldest.id, "preempted")
    }
    const document = options.documents[0]
    const primary = options.clients[0]
    if (!document || !primary) {
      sendJSON({ type: "range-error", id, message: "document unavailable" })
      return
    }
    const size = Number(document.size)
    const at = Math.max(0, Math.min(Math.floor(offset), size))
    const total = requestedLength > 0
      ? Math.max(0, Math.min(requestedLength, size - at))
      : Math.max(0, size - at)
    const controller = new AbortController()
    let stream: ReadableStream<Uint8Array>
    try {
      stream = streamFileRange(primary, document, at, total, {
        blockSize,
        maxWorkers: rangeMaxWorkers,
        maxInFlight: rangeMaxInFlight,
        yieldEveryBytes,
        yieldMs,
        clients: options.clients,
        documents: options.documents,
        signal: controller.signal,
        ...(options.onError ? { onError: options.onError } : {}),
      })
    } catch (error) {
      sendJSON({
        type: "range-error",
        id,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const job: RangeJob = {
      id,
      offset: at,
      length: total,
      controller,
      reader: stream.getReader(),
      startedAt: Date.now(),
      paused: false,
      resume: undefined,
    }
    ranges.set(id, job)
    sendJSON({ type: "range-start", id, offset: at, length: total })
    const pump = async (): Promise<void> => {
      let completed = false
      try {
        for (;;) {
          if (cleaned || controller.signal.aborted) break
          await waitWhilePaused(job)
          if (cleaned || controller.signal.aborted) break
          const { done, value } = await job.reader.read()
          if (done) {
            completed = true
            break
          }
          await waitForBuffer(() => !cleaned && !controller.signal.aborted)
          if (cleaned || controller.signal.aborted) break
          sendBinary(id, value)
        }
        if (completed && !cleaned && !controller.signal.aborted) {
          sendJSON({ type: "range-end", id })
        }
      } catch (error) {
        if (!cleaned && !controller.signal.aborted) {
          try {
            options.onError?.(error)
          } catch { /* observability must not break cleanup */ }
          sendJSON({
            type: "range-error",
            id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        // Only delete the map entry if it still belongs to this job: a seek
        // may have restarted the same id while the old pump was unwinding.
        if (ranges.get(id) === job) ranges.delete(id)
      }
    }
    void pump()
  }

  const startLegacy = (offset: number, requestedLength?: number): void => {
    closeLegacy()
    const mine = generation
    const document = options.documents[0]
    const primary = options.clients[0]
    if (!document || !primary) {
      sendJSON({ type: "error", message: "document unavailable" })
      return
    }
    const size = Number(document.size)
    const at = Math.max(0, Math.min(Math.floor(offset), size))
    const length = requestedLength !== undefined && requestedLength > 0
      ? Math.max(0, Math.min(requestedLength, size - at))
      : Math.max(0, size - at)
    legacyRunning = true
    const controller = new AbortController()
    activeAbort = controller
    let stream: ReadableStream<Uint8Array>
    try {
      stream = streamFileRange(primary, document, at, length, {
        blockSize,
        maxWorkers: rangeMaxWorkers,
        maxInFlight: rangeMaxInFlight,
        yieldEveryBytes,
        yieldMs,
        clients: options.clients,
        documents: options.documents,
        signal: controller.signal,
        ...(options.onError ? { onError: options.onError } : {}),
      })
    } catch (error) {
      legacyRunning = false
      activeAbort = undefined
      sendJSON({ type: "error", message: error instanceof Error ? error.message : String(error) })
      return
    }
    const reader = stream.getReader()
    activeReader = reader
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          if (!legacyRunning || mine !== generation) break
          const { done, value } = await reader.read()
          if (done) break
          if (!legacyRunning || mine !== generation) break
          await waitForBuffer(() => legacyRunning && mine === generation)
          if (!legacyRunning || mine !== generation) break
          socket.send(value as unknown as ArrayBuffer)
          lastSeen = Date.now()
        }
        if (mine === generation) {
          legacyRunning = false
          activeReader = undefined
          activeAbort = undefined
          if (requestedLength !== undefined) sendJSON({ type: "init-done" })
        }
      } catch (error) {
        if (mine === generation) {
          legacyRunning = false
          activeReader = undefined
          activeAbort = undefined
          try {
            options.onError?.(error)
          } catch { /* observability must not break cleanup */ }
          sendJSON({ type: "error", message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    void pump()
  }

  const beginHeartbeat = (): void => {
    if (heartbeat !== undefined) return
    const interval = heartbeatMs > 0 ? Math.max(1000, heartbeatMs) : 30_000
    heartbeat = setInterval(() => {
      if (cleaned) return
      if (Date.now() - lastSeen > idleTimeoutMs) {
        sendJSON({ type: "error", message: "idle timeout" })
        cleanup()
        try {
          socket.close()
        } catch { /* already closed */ }
        return
      }
      if (heartbeatMs > 0) sendJSON({ type: "ping", at: Date.now() })
    }, interval)
  }

  // `server.accept()` already opens the Workers socket, so waiting for an
  // `open` event can stall the handshake forever. Start immediately when the
  // socket is open and keep `open` plus the first message as fallbacks.
  const begin = (): void => {
    if (started || cleaned) return
    started = true
    lastSeen = Date.now()
    beginHeartbeat()
    sendJSON({
      type: "info",
      size: Number(options.documents[0]?.size ?? 0),
      protocol: 2,
      blockSize,
      maxRanges,
      heartbeatMs,
    })
  }

  if (socket.readyState === 1) begin()
  else socket.addEventListener("open", begin, { once: true })

  socket.addEventListener("message", async (event: MessageEvent) => {
    begin()
    lastSeen = Date.now()
    let control: WsControl
    try {
      control = typeof event.data === "string"
        ? JSON.parse(event.data) as WsControl
        : JSON.parse(new TextDecoder().decode(event.data as ArrayBuffer)) as WsControl
    } catch {
      return
    }
    if (control.type === "pong") return
    if (control.type === "ping") {
      sendJSON({ type: "pong", at: Date.now() })
      return
    }
    if (control.type === "hello") {
      framed = (control.protocol ?? 1) >= 2
      sendJSON({
        type: "hello",
        protocol: 2,
        framing: "id",
        blockSize,
        maxRanges,
        heartbeatMs,
        size: Number(options.documents[0]?.size ?? 0),
      })
      return
    }
    if (control.type === "meta") {
      try {
        await replacePool(control.messageId)
      } catch (error) {
        sendJSON({ type: "error", message: error instanceof Error ? error.message : String(error) })
        return
      }
      sendJSON({
        type: "info",
        size: Number(options.documents[0]?.size ?? 0),
        protocol: 2,
        blockSize,
        maxRanges,
        heartbeatMs,
      })
      return
    }
    if (control.type === "range") {
      framed = true
      const id = control.id ?? 0
      startRange(id, control.offset ?? 0, control.length ?? 0)
      return
    }
    if (control.type === "cancel") {
      if (control.id !== undefined) cancelRange(control.id)
      else cancelAllRanges()
      return
    }
    if (control.type === "flow") {
      const job = control.id !== undefined ? ranges.get(control.id) : undefined
      if (job) {
        job.paused = control.paused === true
        if (!job.paused) wakeRange(job)
      }
      return
    }
    if (control.type === "pause" || control.type === "stop") {
      closeLegacy()
      cancelAllRanges(control.type === "stop" ? "stop" : undefined)
      return
    }
    if (control.type === "play" || control.type === "seek" || control.type === "resume" || control.type === "init") {
      try {
        await replacePool(control.messageId)
      } catch (error) {
        sendJSON({ type: "error", message: error instanceof Error ? error.message : String(error) })
        return
      }
      const offset = Math.max(0, control.offset ?? 0)
      if (framed) {
        startRange(control.id ?? 0, offset, control.length ?? 0)
      } else {
        startLegacy(offset, control.length)
      }
    }
  })

  socket.addEventListener("close", cleanup)
  socket.addEventListener("error", cleanup)
}

/**
 * Complete Worker fetch handler: WebSocket upgrades get one long-lived
 * interactive stream; other methods receive a short health response.
 */
export function createWorkerWebSocketHandler(options: WsHandlerOptions): {
  fetch(request: Request): Promise<Response>
} {
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("reqly-str1: WebSocket required", {
          status: 426,
          headers: { upgrade: "websocket", "content-type": "text/plain" },
        })
      }
      const pair = new WebSocketPair()
      const server = pair[1]
      ;(server as unknown as { accept(): void }).accept()
      // Each socket owns its pool: cleanup on one socket must never close
      // sessions that another socket is still streaming from.
      attachStreamSocket(server, {
        ...options,
        clients: [...options.clients],
        documents: [...options.documents],
      })
      return new Response(null, { status: 101, ...({ webSocket: pair[0] } as unknown as ResponseInit) })
    },
  }
}
