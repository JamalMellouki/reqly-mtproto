/**
 * High-level reqly client.
 *
 * The client is the main entry point for all MTProto operations. It manages
 * sessions, connections to Telegram data centers, and exposes typed helpers
 * for downloading files. Two transport modes are supported:
 *
 * - **freshSocket** (one socket per RPC): maximum isolation, useful for
 *   parallel bursts and cold-start Workers.
 * - **reuse** (one connection per DC): a persistent WebSocket per data center
 *   multiplexes all RPCs, removing the per-request handshake cost.
 *
 * @example
 * ```ts
 * const client = await Reqly.connect(sessionString)
 * const docs = await client.getMessages(channelId, accessHash, [messageId])
 * const bytes = await client.getFile(docs[0], 0, 1024 * 1024)
 * client.close()
 * ```
 */

import { INIT_CONNECTION, INVOKE_WITH_LAYER, TL_LAYER, DEFAULT_TIMEOUT_MS } from "./protocol"
import { TlWriter, IDs, decodeFileOrRedirect, extractDocuments, type RemoteDocument } from "./tl"
import { Connection, call, MessageIds, type CallResult } from "./transport"
import { parseSession, type Session } from "./session"
import { SessionStore } from "./sessions"
import { rpcError, FileReferenceExpiredError, FileMigrateError, FloodWaitError, CdnRedirectError } from "./errors"
import { decodeFileHashes, encodeGetFileHashes, type FileHashEntry } from "./hashes"

/**
 * Options for parallel chunk downloads.
 */
export interface ParallelOptions {
  /** Starting number of concurrent chunk requests. Defaults to 2. */
  minWorkers?: number
  /** Concurrency ceiling. Defaults to 4 (Telegram throttles above this). */
  maxWorkers?: number
  /** Retries per failed chunk before surfacing the error. Defaults to 3. */
  retries?: number
  /** Custom chunk fetcher (e.g. one that reads from a cache). Defaults to getFile. */
  fetch?: (range: { offset: number; limit: number }, index: number) => Promise<Uint8Array>
  /** Refresh an expired `file_reference`; forwarded to `getFile` per block. */
  refresh?: () => Promise<RemoteDocument>
  /** Called as soon as an individual range resolves, before the whole pool finishes. */
  onChunk?: (index: number, bytes: Uint8Array) => void
}

/**
 * Construction options for {@link Reqly}.
 */
export interface ReqlyOptions {
  /** Default RPC timeout in milliseconds. */
  timeoutMs?: number
  /** Override the Telegram data center address. */
  address?: string
  /** Override the Telegram data center port. */
  port?: number
  /** Telegram API ID (defaults to 1, valid for read-only calls). */
  apiId?: number
  /** Additional data center sessions keyed by DC ID. */
  dcSessions?: Record<number, string>
  /** Use one socket per RPC instead of a reusable connection. Defaults to false. */
  freshSocket?: boolean
  /** Ask the master DC for `upload.fileCdnRedirect` (CDN files only). */
  cdnSupported?: boolean
}

/**
 * Type guard for Telegram protocol errors returned by the transport.
 *
 * @internal
 */
function isProtocolError(error: unknown): error is Error & { code: number; telegramMessage: string } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "number" &&
    typeof (error as { telegramMessage?: unknown }).telegramMessage === "string"
  )
}

/**
 * Returns true for transient wire failures that are safe to retry.
 * Protocol (RPC) errors are never retried.
 *
 * @internal
 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error) || isProtocolError(error)) return false
  return [
    "reqly: RPC timed out",
    "reqly: connection closed",
    "reqly: websocket failed",
    "reqly: unexpected auth key id",
    "reqly: message key mismatch",
    "reqly: session mismatch",
    "reqly: invalid abridged frame",
    "reqly: Telegram rejected the request",
  ].includes(error.message)
}

/**
 * reqly client — manages MTProto sessions and file downloads.
 *
 * A single Reqly instance owns one session and lazily opens a connection per
 * data center. All state is per-instance, so concurrent Workers never collide
 * on msg_id or authorization keys.
 */
export class Reqly {
  private readonly initializedDcs = new Set<number>()
  private readonly connecting = new Map<number, Promise<Connection>>()
  private openedConnections = 0
  private readonly connections = new Map<number, Connection>()
  private readonly dcStore: SessionStore
  private readonly timeoutMs: number | undefined
  private readonly apiId: number
  private readonly freshSocket: boolean
  private readonly cdnSupported: boolean

  private constructor(
    private readonly session: Session,
    options: ReqlyOptions,
  ) {
    this.timeoutMs = options.timeoutMs
    // Telegram does not validate api_id for read-only calls; set your own
    // from my.telegram.org for full compatibility with API methods.
    this.apiId = options.apiId ?? 1
    // Matches README: false (default) reuses a connection per DC; true opens one socket per RPC.
    this.freshSocket = options.freshSocket ?? false
    this.cdnSupported = options.cdnSupported ?? false
    this.dcStore = new SessionStore(session)
  }

  /**
   * Creates and connects a Reqly client from a Telegram StringSession.
   *
   * @param encodedSession - A version-1 StringSession (base64-encoded, prefixed with "1").
   * @param options - Optional construction options.
   * @returns A connected Reqly instance.
   *
   * @example
   * ```ts
   * const client = await Reqly.connect("1AQAA...", { timeoutMs: 25000 })
   * ```
   */
  static async connect(encodedSession: string, options: ReqlyOptions = {}): Promise<Reqly> {
    const session = await parseSession(encodedSession)
    if (options.address !== undefined) session.address = options.address
    if (options.port !== undefined) session.port = options.port
    const client = new Reqly(session, options)
    for (const encoded of Object.values(options.dcSessions ?? {})) await client.dcStore.add(encoded)
    return client
  }

  /** Returns the list of data center IDs known to this client. */
  getDcIds(): number[] {
    return this.dcStore.list()
  }

  /**
   * Resolves the channel access_hash for THIS session (bots may use a zero
   * hash in `inputChannel`; `channels.getChannels` replies with the full one).
   */
  async getChannelAccessHash(channelId: bigint): Promise<bigint> {
    const method = new TlWriter()
      .uint(0xa7f6bbb)
      .uint(IDs.vector)
      .uint(1)
      .uint(0xf35aec28)
      .long(channelId)
      .long(0n)
      .result()
    const reply = await this.invoke(method)
    const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength)
    for (let offset = 0; offset + 16 <= reply.length; offset += 4) {
      if (view.getBigInt64(offset, true) !== channelId) continue
      return view.getBigInt64(offset + 8, true)
    }
    throw new Error(`reqly: channel ${channelId} not found in getChannels reply`)
  }

  /** Diagnostic: how many WebSockets this client has opened. */
  getOpenedConnectionCount(): number {
    return this.openedConnections
  }

  /**
   * Returns a reusable connection for the given session's data center.
   * Concurrent callers share one in-flight open so a parallel chunk burst
   * cannot create a new WebSocket (subrequest) per RPC — that would exhaust
   * Workers' 50-subrequest limit on the very first batch.
   */
  private async connectionFor(session: Session): Promise<Connection> {
    let connection = this.connections.get(session.dcId)
    if (connection && !connection.isClosed()) return connection

    let opening = this.connecting.get(session.dcId)
    if (!opening) {
      opening = Connection.open(session, this.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        .then((created) => {
          this.openedConnections += 1
          this.connections.set(session.dcId, created)
          return created
        })
        .finally(() => {
          this.connecting.delete(session.dcId)
        })
      this.connecting.set(session.dcId, opening)
    }
    return opening
  }

  /**
   * Sends a raw MTProto method and returns the response body.
   *
   * Automatically wraps the call in `initWithLayer` on first use per data
   * center, handles salt corrections, retries, and DC migration.
   *
   * @param method - The serialized TL method body.
   * @param session - Optional session override (defaults to the client's session).
   * @returns The raw response body bytes.
   */
  async invoke(method: Uint8Array, session: Session = this.session): Promise<Uint8Array> {
    if (this.freshSocket) {
      return this.invokeFreshSocket(method, session)
    }
    return this.invokeReusable(method, session)
  }

  /** Fresh-socket path: one WebSocket per RPC, initConnection sent per DC. */
  private async invokeFreshSocket(method: Uint8Array, session: Session): Promise<Uint8Array> {
    let needsInit = !this.initializedDcs.has(session.dcId)
    let result: CallResult | undefined
    let lastError: unknown

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        let outgoing = method
        if (needsInit) {
          outgoing = this.buildInitWithLayer(method)
        }
        result = await call(session, outgoing, { timeoutMs: this.timeoutMs, ids: new MessageIds() })
        this.initializedDcs.add(session.dcId)
        break
      } catch (error) {
        if (isProtocolError(error)) throw rpcError(error.code, error.telegramMessage)
        lastError = error
        if (!isTransportError(error)) throw error
        this.initializedDcs.delete(session.dcId)
        needsInit = true
      }
    }
    if (!result) throw lastError
    return result.body
  }

  /** Reusable-connection path: one WebSocket per DC, multiplexed RPCs. */
  private async invokeReusable(method: Uint8Array, session: Session): Promise<Uint8Array> {
    let needsInit = !this.initializedDcs.has(session.dcId)
    let result: Uint8Array | undefined
    let lastError: unknown

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const connection = await this.connectionFor(session)
        let outgoing = method
        if (needsInit) {
          outgoing = this.buildInitWithLayer(method)
        }
        result = await connection.call(outgoing, this.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        this.initializedDcs.add(session.dcId)
        break
      } catch (error) {
        if (isProtocolError(error)) {
          const structured = rpcError(error.code, error.telegramMessage)
          // Wall time is not limited on Workers, only CPU time, so waiting out
          // a Telegram flood wait is cheap and avoids surfacing a failed range.
          if (structured instanceof FloodWaitError && structured.seconds <= 120) {
            lastError = structured
            await new Promise((resolve) => setTimeout(resolve, (structured.seconds + 1) * 1000))
            continue
          }
          throw structured
        }
        lastError = error
        if (!isTransportError(error)) throw error
        if (error instanceof Error && error.message === "reqly: connection closed") {
          this.connections.delete(session.dcId)
          needsInit = true
          this.initializedDcs.delete(session.dcId)
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
    if (!result) throw lastError
    return result
  }

  /** Builds an `invokeWithLayer(initConnection(method))` payload. */
  private buildInitWithLayer(method: Uint8Array): Uint8Array {
    const init = new TlWriter()
      .uint(INIT_CONNECTION)
      .uint(0)
      .int(this.apiId)
      .string("reqly")
      .string("2.1.0")
      .string("2.1.0")
      .string("en")
      .string("")
      .string("en")
      .raw(method)
      .result()
    return new TlWriter().uint(INVOKE_WITH_LAYER).int(TL_LAYER).raw(init).result()
  }

  /** Closes all reusable sockets. Call at the end of a Worker request. */
  close(): void {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
    // The next invoke() must send initWithLayer again: a new socket has not
    // been initialized even though this client already talked to that DC.
    this.initializedDcs.clear()
  }

  /**
   * Resolves document references from a `channels.getMessages` response.
   *
   * @param channelId - The channel identifier.
   * @param accessHash - The channel access hash.
   * @param messageIds - The message IDs to fetch.
   * @returns The remote documents found in the response.
   */
  async getMessages(
    channelId: bigint,
    accessHash: bigint,
    messageIds: readonly number[],
  ): Promise<RemoteDocument[]> {
    if (messageIds.length === 0) return []
    for (const id of messageIds) {
      if (!Number.isInteger(id) || id <= 0) throw new Error(`reqly: invalid message id ${id}`)
    }
    const peer = new TlWriter().uint(IDs.peerChannel).long(channelId).long(accessHash).result()
    const writer = new TlWriter()
      .uint(IDs.channelsGetMessages)
      .raw(peer)
      .uint(IDs.vector)
      .uint(messageIds.length)
    for (const id of messageIds) writer.uint(IDs.inputMessageID).int(id)
    let activeSession = this.session
    let migrated = false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return extractDocuments(await this.invoke(writer.result(), activeSession))
      } catch (error) {
        if (error instanceof FileMigrateError && !migrated) {
          const target = this.dcStore.get(error.dcId)
          if (target) {
            activeSession = target
            migrated = true
            continue
          }
        }
        throw error
      }
    }
    throw new Error("reqly: getMessages failed")
  }

  /**
   * Downloads a byte range from a Telegram file.
   *
   * Requests are split at 1 MB block boundaries and 4 KB aligned to satisfy
   * Telegram's `upload.getFile` requirements. Handles `FILE_REFERENCE_EXPIRED`
   * via an optional refresh callback and `FILE_MIGRATE_X` by switching to the
   * target data center.
   *
   * @param location - The remote document location.
   * @param offset - Start byte offset.
   * @param limit - Number of bytes to read.
   * @param refresh - Optional callback to obtain a fresh file reference on expiry.
   * @returns The requested bytes.
   */
  async getFile(
    location: RemoteDocument,
    offset: number,
    limit: number,
    refresh?: () => Promise<RemoteDocument>,
  ): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("reqly: getFile offset must be a non-negative integer")
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("reqly: getFile limit must be a non-negative integer")
    }
    if (limit === 0 || location.size <= 0n) return new Uint8Array()

    let reference = location.fileReference
    let activeSession = this.session
    let migrated = false

    const BLOCK = 1024 * 1024
    const ALIGN = 4096
    const alignedStart = Math.floor(offset / ALIGN) * ALIGN
    const skip = offset - alignedStart
    let cursor = alignedStart
    // `location.size` is the document metadata; never read beyond it even if
    // the caller passes a larger limit or the server returns a full 4 KB block.
    let remaining = skip + Math.min(limit, Math.max(0, Number(location.size) - offset))
    let first = true
    const parts: Uint8Array[] = []

    while (remaining > 0 && cursor < location.size) {
      const blockEnd = Math.floor(cursor / BLOCK) * BLOCK + BLOCK
      const inBlock = blockEnd - cursor
      const wanted = Math.min(remaining, inBlock)
      const chunkLimit = Math.max(ALIGN, Math.ceil(wanted / ALIGN) * ALIGN)

      let bytes: Uint8Array | undefined
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const writer = new TlWriter()
          .uint(IDs.uploadGetFile)
          .int(0x01 | (this.cdnSupported ? 0x02 : 0))
          .uint(IDs.inputDocumentFileLocation)
          .long(location.id)
          .long(location.accessHash)
          .bytes(reference)
          .string("")
          .long(BigInt(cursor))
          .int(chunkLimit)
        try {
          const reply = await this.invoke(writer.result(), activeSession)
          const decoded = decodeFileOrRedirect(reply)
          if (decoded.kind === "redirect") throw new CdnRedirectError(decoded.redirect)
          bytes = decoded.bytes
          break
        } catch (error) {
          if (error instanceof FileReferenceExpiredError && refresh && attempt === 0) {
            reference = (await refresh()).fileReference
            continue
          }
          if (error instanceof FileMigrateError && !migrated) {
            const target = this.dcStore.get(error.dcId)
            if (!target) throw error
            activeSession = target
            migrated = true
            continue
          }
          // upload.fileCdnRedirect is not handled: if a DC chooses CDN redirection,
          // getFile will surface the raw RPC error. Callers should implement an
          // application-level fallback (e.g. follow the redirect URL).
          throw error
        }
      }
      if (!bytes || bytes.length === 0) break

      const from = first ? skip : 0
      const take = Math.min(remaining - from, bytes.length - from)
      if (take > 0) parts.push(bytes.subarray(from, from + take))
      remaining -= from + take
      cursor += bytes.length
      // A short read means the server reached end-of-file; do not request past it.
      if (bytes.length < chunkLimit) remaining = 0
      first = false
    }

    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const output = new Uint8Array(total)
    let position = 0
    for (const part of parts) {
      output.set(part, position)
      position += part.length
    }
    return output
  }

  /**
   * Fetches `upload.getFileHashes` entries for a document.
   *
   * Unlike the standalone helper, this method follows `FILE_MIGRATE_X` when a
   * session for the target DC was supplied through {@link ReqlyOptions.dcSessions}
   * and refreshes an expired file reference when a callback is provided.
   *
   * @param location - The remote document location.
   * @param offset - Byte offset to start hashing from. Defaults to 0.
   * @param refresh - Optional callback returning a fresh document reference.
   * @returns Hash entries covering the document from `offset`.
   */
  async getFileHashes(
    location: RemoteDocument,
    offset = 0,
    refresh?: () => Promise<RemoteDocument>,
  ): Promise<FileHashEntry[]> {
    let reference = location.fileReference
    let activeSession = this.session
    let migrated = false

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return decodeFileHashes(await this.invoke(encodeGetFileHashes(location, offset, reference), activeSession))
      } catch (error) {
        if (error instanceof FileReferenceExpiredError && refresh && attempt === 0) {
          reference = (await refresh()).fileReference
          continue
        }
        if (error instanceof FileMigrateError && !migrated) {
          const target = this.dcStore.get(error.dcId)
          if (!target) throw error
          activeSession = target
          migrated = true
          continue
        }
        throw error
      }
    }
    throw new Error("reqly: getFileHashes failed")
  }

  /**
   * Downloads many byte ranges with an adaptive worker pool.
   *
   * Telegram rate-limits parallel downloads and answers excess concurrency
   * with an error rather than a slower response. This pool starts conservatively
   * (2 workers), grows after a clean streak, and halves itself on any
   * transport failure. Backoff includes jitter to avoid thundering herds.
   *
   * @param location - The remote document location.
   * @param ranges - Byte ranges to download, each with offset and limit.
   * @param options - Parallel download options.
   * @returns An array of byte chunks, one per input range, in the same order.
   */
  async getFilesParallel(
    location: RemoteDocument,
    ranges: readonly { offset: number; limit: number }[],
    options: ParallelOptions = {},
  ): Promise<Uint8Array[]> {
    const minWorkers = Math.max(1, options.minWorkers ?? 2)
    const maxWorkers = Math.max(minWorkers, options.maxWorkers ?? 4)
    const retries = Math.max(0, options.retries ?? 3)
    const results = new Array<Uint8Array | undefined>(ranges.length)
    const failures = new Array<number>(ranges.length).fill(0)
    const pending = ranges.map((_, index) => index)
    let workers = minWorkers
    let cleanStreak = 0
    let cursor = 0
    let lastError: unknown
    let fatal: unknown
    let hasFatal = false
    const stop = new AbortController()

    // A fatal peer failure must wake every worker that is sleeping in backoff
    // instead of letting it keep scheduling new Telegram reads.
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
      if (stop.signal.aborted) {
        resolve()
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        stop.signal.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      stop.signal.addEventListener("abort", onAbort, { once: true })
    })
    // Yielding to the event loop ends the current synchronous CPU span. Workers
    // measure CPU per span, so a burst of 1 MB IGE decryptions stays legal when
    // separated by `setTimeout(0)` awaits even though total work is unchanged.
    const yieldToRuntime = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    let active = 0
    const fail = (error: unknown): void => {
      if (hasFatal) return
      hasFatal = true
      fatal = error
      stop.abort()
    }
    const worker = async (): Promise<void> => {
      for (;;) {
        if (hasFatal) return
        while (active >= workers) {
          if (hasFatal) return
          await sleep(10)
        }
        if (hasFatal || cursor >= pending.length) return
        active += 1
        const index = pending[cursor++]!
        const range = ranges[index]!
        try {
          results[index] = options.fetch
            ? await options.fetch(range, index)
            : await this.getFile(location, range.offset, range.limit, options.refresh)
          if (hasFatal) return
          options.onChunk?.(index, results[index]!)
          await yieldToRuntime()
          cleanStreak += 1
          if (cleanStreak >= 4 && workers < maxWorkers) {
            workers += 1
            cleanStreak = 0
          }
        } catch (error) {
          if (hasFatal) return
          lastError = error
          if (error instanceof FloodWaitError && error.seconds <= 120) {
            await sleep((error.seconds + 1) * 1000)
            if (hasFatal) return
            failures[index] = (failures[index] ?? 0) + 1
            if (failures[index]! > retries) {
              fail(error)
              return
            }
            pending.push(index)
            continue
          }
          if (!isTransportError(error)) {
            fail(error)
            return
          }
          workers = Math.max(1, Math.floor(workers / 2))
          cleanStreak = 0
          failures[index] = (failures[index] ?? 0) + 1
          if (failures[index]! > retries) {
            fail(error)
            return
          }
          // Linear backoff with jitter to avoid thundering herds on shared failure.
          const jitter = Math.floor(Math.random() * 60)
          await sleep(80 * failures[index]! + jitter)
          if (hasFatal) return
          pending.push(index)
        } finally {
          active -= 1
        }
      }
    }

    // Settle every peer before surfacing the first fatal error: `Promise.all`
    // would reject immediately and leave the other workers running.
    await Promise.allSettled(Array.from({ length: maxWorkers }, () => worker()))
    if (hasFatal) throw fatal ?? new Error("reqly: parallel download failed")
    if (results.some((result) => result === undefined)) {
      throw lastError ?? new Error("reqly: parallel download incomplete")
    }
    return results as Uint8Array[]
  }
}
