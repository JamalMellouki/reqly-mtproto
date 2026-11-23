/**
 * Obfuscated abridged MTProto over a Workers outbound WebSocket.
 *
 * This transport follows the deployment-proven mtproto-workers design:
 * one socket per RPC, a 64-byte obfuscated header, AES-256-CTR keystreams
 * reused for every frame, and protocol events handled before the result is
 * returned. Author and platform are credited in THIRD_PARTY_NOTICES.
 */

import { deriveKeys, igeDecrypt, igeEncrypt } from "./crypto"
import { TlWriter } from "./tl"
import type { Session } from "./session"
import {
  ABRIDGED_TAG,
  FORBIDDEN_FIRST,
  MSG_CONTAINER,
  GZIP_PACKED,
  RPC_RESULT,
  BAD_SERVER_SALT,
  BAD_MSG_NOTIFICATION,
  NEW_SESSION_CREATED,
  MSGS_ACK,
  PING,
  PING_DELAY_DISCONNECT,
  RPC_ERROR,
  MAX_FRAME_PAYLOAD,
  DEFAULT_TIMEOUT_MS,
} from "./protocol"

/**
 * Decrypted MTProto envelope containing the response body and metadata.
 */
export interface Envelope {
  /** The message ID this envelope responds to. */
  requestId: bigint
  /** The message ID of this response. */
  msgId: bigint
  /** The server salt returned with this response. */
  serverSalt: bigint
  /** Message sequence number. */
  sequence: number
  /** Decrypted response body. */
  body: Uint8Array
}

/**
 * Options for a single RPC call via {@link call}.
 */
export interface CallOptions {
  /** Server salt to use for this request. Defaults to 0. */
  salt?: bigint
  /** Per-call timeout in milliseconds. Falls back to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number | undefined
  /** Callback invoked when a new server salt is received. */
  onSalt?: (salt: bigint) => void
  /** Message ID generator to use. Defaults to a new MessageIds instance. */
  ids?: MessageIds
}

/**
 * Result of a successful RPC call.
 */
export interface CallResult {
  /** Decrypted response body. */
  body: Uint8Array
  /** The server salt from this response. */
  serverSalt: bigint
  /** Number of request messages sent. */
  requestMessages: number
  /** Number of response bytes received. */
  responseBytes: number
}

/**
 * Generates monotonic msg_id values: unix time in 2^-32 seconds, divisible by four.
 * Each instance maintains its own counter, so concurrent clients never collide.
 */
export class MessageIds {
  private last = 0n

  next(): bigint {
    let value = ((BigInt(Date.now()) << 32n) / 1000n) & ~3n
    if (value <= this.last) value = this.last + 4n
    this.last = value
    return value
  }
}

function longBytes(value: bigint): Uint8Array {
  const output = new Uint8Array(8)
  new DataView(output.buffer).setBigInt64(0, value, true)
  return output
}

function intBytes(value: number): Uint8Array {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setInt32(0, value, true)
  return output
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

/** Stateful AES-256-CTR with partial-block carry, copied from the reference implementation. */
async function createStream(key: Uint8Array, counter: Uint8Array): Promise<{ apply(data: Uint8Array): Promise<Uint8Array> }> {
  const imported = await crypto.subtle.importKey("raw", key.slice().buffer as ArrayBuffer, { name: "AES-CTR" }, false, ["encrypt"])
  const state = counter.slice()
  let leftover = new Uint8Array()

  function increment(blocks: number): void {
    for (let block = 0; block < blocks; block += 1) {
      for (let index = state.length - 1; index >= 0; index -= 1) {
        state[index] = ((state[index] ?? 0) + 1) & 0xff
        if (state[index] !== 0) break
      }
    }
  }

  return {
    async apply(data: Uint8Array): Promise<Uint8Array> {
      const output = new Uint8Array(data.length)
      let offset = 0
      if (leftover.length > 0) {
        const length = Math.min(data.length, leftover.length)
        for (let index = 0; index < length; index += 1) output[index] = (data[index] ?? 0) ^ (leftover[index] ?? 0)
        leftover = leftover.subarray(length)
        offset = length
      }
      if (offset === data.length) return output
      const remaining = data.length - offset
      const blocks = Math.ceil(remaining / 16)
      const stream = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: state.slice() as unknown as BufferSource, length: 128 }, imported, new Uint8Array(blocks * 16).buffer))
      increment(blocks)
      for (let index = 0; index < remaining; index += 1) output[offset + index] = (data[offset + index] ?? 0) ^ (stream[index] ?? 0)
      leftover = stream.subarray(remaining)
      return output
    },
  }
}

function obfuscationHeader(dcId: number): Uint8Array {
  let header: Uint8Array
  do {
    header = crypto.getRandomValues(new Uint8Array(64))
  } while (
    header[0] === 0xef ||
    FORBIDDEN_FIRST.has(new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false)) ||
    (header[4] === 0 && header[5] === 0 && header[6] === 0 && header[7] === 0)
  )
  header.set(ABRIDGED_TAG, 56)
  new DataView(header.buffer, header.byteOffset + 60, 2).setInt16(0, dcId, true)
  return header
}

function abridgedFrame(payload: Uint8Array): Uint8Array {
  const words = payload.length / 4
  if (words < 127) return concat(new Uint8Array([words]), payload)
  return concat(new Uint8Array([0x7f, words & 0xff, (words >>> 8) & 0xff, (words >>> 16) & 0xff]), payload)
}

/** @internal Exported for protocol regression tests; not part of the public API. */
export class AbridgedReader {
  private buffered: Uint8Array = new Uint8Array()

  constructor(private readonly decrypt: (data: Uint8Array) => Promise<Uint8Array>) {}

  async push(encrypted: Uint8Array): Promise<Uint8Array[]> {
    const plain = await this.decrypt(encrypted)
    this.buffered = concat(this.buffered, plain)
    const packets: Uint8Array[] = []
    for (;;) {
      const first = this.buffered[0]
      if (first === undefined) break
      // A zero-length abridged frame is a transport keepalive: ignore it.
      if (first === 0) {
        this.buffered = this.buffered.slice(1)
        continue
      }
      // Quick ACK tokens are standalone 4-byte packets with the MSB set in
      // their first byte (bswapped token). They have no length prefix.
      if ((first & 0x80) !== 0) {
        if (this.buffered.length < 4) break
        this.buffered = this.buffered.slice(4)
        continue
      }
      const prefix = first === 0x7f ? 4 : 1
      if (this.buffered.length < prefix) break
      const words = first === 0x7f
        ? (this.buffered[1] ?? 0) | ((this.buffered[2] ?? 0) << 8) | ((this.buffered[3] ?? 0) << 16)
        : first
      const length = words * 4
      if (length <= 0 || length > MAX_FRAME_PAYLOAD) {
        // Drop the poisoned prefix. Keeping it would make every later push
        // fail on the same bytes and stall every pending RPC.
        this.buffered = new Uint8Array()
        throw new Error("reqly: invalid abridged frame")
      }
      if (this.buffered.length < prefix + length) break
      packets.push(this.buffered.slice(prefix, prefix + length))
      this.buffered = this.buffered.slice(prefix + length)
    }
    return packets
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onOpen = (): void => finish()
    const onError = (): void => finish(new Error("reqly: websocket failed"))
    // A socket that closes before `open` would otherwise leave this promise
    // pending until the timeout (or forever when no timeout was supplied).
    const onClose = (): void => finish(new Error("reqly: websocket closed before open"))

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { socket.close() } catch { /* already closed */ }
        finish(new Error(`reqly: websocket open timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }
    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("close", onClose, { once: true })
  })
}

async function openSocket(address: string, timeoutMs?: number): Promise<WebSocket> {
  const url = `wss://${address}/apiws`
  const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : undefined
  if (typeof WebSocket !== "undefined") {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = deadline === undefined ? undefined : deadline - Date.now()
      if (remaining !== undefined && remaining <= 0) break
      const socket = new WebSocket(url, "binary")
      try {
        await waitForOpen(socket, remaining)
        return socket
      } catch (error) {
        lastError = error
        try { socket.close() } catch { /* already closed */ }
        const backoff = 120 * (attempt + 1)
        const left = deadline === undefined ? backoff : deadline - Date.now()
        if (left <= 0) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(backoff, left)))
      }
    }
    throw lastError ?? new Error(`reqly: websocket open timed out after ${timeoutMs}ms`)
  }
  const controller = deadline === undefined ? undefined : new AbortController()
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), Math.max(1, deadline! - Date.now()))
  try {
    const response = await fetch(`https://${address}/apiws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "binary" },
      ...(controller ? { signal: controller.signal } : {}),
    })
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket
    if (!socket) throw new Error(`reqly: websocket upgrade failed with ${response.status}`)
    ;(socket as WebSocket & { accept(): void }).accept()
    return socket
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function encryptMessage(input: {
  authKey: Uint8Array
  authKeyId: Uint8Array
  salt: bigint
  sessionId: bigint
  messageId: bigint
  sequence: number
  body: Uint8Array
}): Promise<Uint8Array> {
  const header = concat(
    longBytes(input.salt),
    longBytes(input.sessionId),
    longBytes(input.messageId),
    intBytes(input.sequence),
    intBytes(input.body.length),
    input.body,
  )
  const padding = 12 + ((16 - ((header.length + 12) % 16)) % 16)
  const inner = concat(header, crypto.getRandomValues(new Uint8Array(padding)))
  const messageKeySource = concat(input.authKey.slice(88, 120), inner)
  const messageKey = new Uint8Array(await crypto.subtle.digest("SHA-256", messageKeySource as unknown as BufferSource)).slice(8, 24)
  const { key, iv } = await deriveKeys(input.authKey, messageKey, 0)
  return concat(input.authKeyId, messageKey, igeEncrypt(inner, key, iv))
}

async function decryptMessage(packet: Uint8Array, authKey: Uint8Array, authKeyId: Uint8Array, sessionId: bigint): Promise<Envelope> {
  if (!equalBytes(packet.slice(0, 8), authKeyId)) throw new Error("reqly: unexpected auth key id")
  const messageKey = packet.slice(8, 24)
  const { key, iv } = await deriveKeys(authKey, messageKey, 8)
  const inner = igeDecrypt(packet.slice(24), key, iv)
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(authKey.slice(96, 128), inner) as unknown as BufferSource)).slice(8, 24)
  if (!equalBytes(messageKey, expected)) throw new Error("reqly: message key mismatch")
  const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength)
  const salt = view.getBigInt64(0, true)
  const returnedSessionId = view.getBigInt64(8, true)
  if (returnedSessionId !== sessionId) throw new Error("reqly: session mismatch")
  const msgId = view.getBigInt64(16, true)
  const sequence = view.getInt32(24, true)
  const length = view.getInt32(28, true)
  if (length <= 0 || length % 4 !== 0 || length > inner.length - 32) throw new Error("reqly: invalid response length")
  return { requestId: msgId, msgId, serverSalt: salt, sequence, body: inner.slice(32, 32 + length) }
}

async function decompress(value: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([value.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

type ProtocolEvent =
  | { type: "result"; body: Uint8Array }
  | { type: "retry"; salt?: bigint }
  | { type: "salt"; salt: bigint }
  | { type: "ignore" }

function readUint(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true)
}

function readInt(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, true)
}

function readLong(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigInt64(0, true)
}

function readTlBytes(data: Uint8Array, offset: number): Uint8Array {
  const first = data[offset] ?? 0
  const headerLength = first === 254 ? 4 : 1
  const length = first === 254
    ? (data[offset + 1] ?? 0) | ((data[offset + 2] ?? 0) << 8) | ((data[offset + 3] ?? 0) << 16)
    : first
  return data.slice(offset + headerLength, offset + headerLength + length)
}

async function readEvents(body: Uint8Array, requestId: bigint, ackIds: bigint[]): Promise<ProtocolEvent[]> {
  const constructor = readUint(body, 0)
  if (constructor === MSG_CONTAINER) {
    const count = readInt(body, 4)
    let offset = 8
    const events: ProtocolEvent[] = []
    for (let index = 0; index < count; index += 1) {
      const messageId = readLong(body, offset)
      const sequence = readInt(body, offset + 8)
      const length = readInt(body, offset + 12)
      offset += 16
      const inner = body.slice(offset, offset + length)
      offset += length
      if (sequence % 2 === 1) ackIds.push(messageId)
      events.push(...await readEvents(inner, requestId, ackIds))
    }
    return events
  }
  if (constructor === RPC_RESULT) {
    if (readLong(body, 4) !== requestId) return [{ type: "ignore" }]
    const result = body.slice(12)
    if (readUint(result, 0) === RPC_ERROR) {
      const code = readInt(result, 4)
      const message = new TextDecoder().decode(readTlBytes(result, 8))
      throw Object.assign(new Error(`reqly: Telegram error ${code}: ${message}`), { code, telegramMessage: message })
    }
    if (readUint(result, 0) === GZIP_PACKED) return [{ type: "result", body: await decompress(readTlBytes(result, 4)) }]
    return [{ type: "result", body: result }]
  }
  if (constructor === BAD_SERVER_SALT) return [{ type: "retry", salt: readLong(body, 20) }]
  if (constructor === BAD_MSG_NOTIFICATION) {
    const code = readInt(body, 12)
    if (code === 16 || code === 17) return [{ type: "retry" }]
    return [{ type: "ignore" }]
  }
  if (constructor === NEW_SESSION_CREATED) return [{ type: "salt", salt: readLong(body, 20) }]
  if (constructor === GZIP_PACKED) return readEvents(await decompress(readTlBytes(body, 4)), requestId, ackIds)
  return [{ type: "ignore" }]
}

/**
 * Performs a single MTProto RPC over a fresh WebSocket connection.
 *
 * Opens a socket to the data center, performs the obfuscated handshake,
 * encrypts and sends the method, then reads and decrypts the response.
 * Handles salt corrections, retries, and MTProto protocol events internally.
 *
 * @param session - The Telegram session (auth key, DC address, etc.).
 * @param method - The serialized TL method body to send.
 * @param options - Optional call options (salt, timeout, message IDs).
 * @returns The decrypted response body and call metadata.
 */
export async function call(session: Session, method: Uint8Array, options: CallOptions = {}): Promise<CallResult> {
  const authKeyId = new Uint8Array(await crypto.subtle.digest("SHA-1", session.authKey as unknown as BufferSource)).slice(-8)
  const sessionId = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigInt64(0, true)
  const ids = options.ids ?? new MessageIds()
  let salt = options.salt ?? 0n
  let contentCount = 0
  let requestMessages = 0
  let responseBytes = 0
  const ackIds: bigint[] = []

  const header = obfuscationHeader(session.dcId)
  const reversed = header.slice(8, 56).reverse()
  const outbound = await createStream(header.slice(8, 40), header.slice(40, 56))
  const inbound = await createStream(reversed.slice(0, 32), reversed.slice(32, 48))
  const encryptedHeader = await outbound.apply(header)
  header.set(encryptedHeader.slice(56), 56)

  const socket = await openSocket(session.address, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  socket.binaryType = "arraybuffer"
  const reader = new AbridgedReader((data) => inbound.apply(data))
  const queue: Uint8Array[] = []
  const listeners: Array<(packet: Uint8Array) => void> = []
  socket.addEventListener("message", (event: MessageEvent) => {
    void reader.push(new Uint8Array(event.data as ArrayBuffer)).then((packets) => {
      for (const packet of packets) {
        const listener = listeners.shift()
        if (listener) listener(packet)
        else queue.push(packet)
      }
    }).catch(() => {
      // Malformed frames are dropped by AbridgedReader; the pending call times
      // out normally instead of surfacing an unhandled promise rejection.
    })
  })
  let closed = false
  socket.addEventListener("close", () => { closed = true })

  const receive = (timeout: number): Promise<Uint8Array> => {
    const queued = queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reqly: RPC timed out")), timeout)
      listeners.push((packet) => {
        clearTimeout(timer)
        resolve(packet)
      })
    })
  }

  const send = async (body: Uint8Array, messageId: bigint, sequence: number): Promise<void> => {
    const packet = await encryptMessage({ authKey: session.authKey, authKeyId, salt, sessionId, messageId, sequence, body })
    socket.send(await outbound.apply(abridgedFrame(packet)) as unknown as ArrayBuffer)
  }

  try {
    socket.send(header as unknown as ArrayBuffer)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestId = ids.next()
      const sequence = contentCount * 2 + 1
      contentCount += 1
      requestMessages += 1
      await send(method, requestId, sequence)

      let retry = false
      let received = false
      while (!retry && !received) {
        const encryptedResponse = await receive(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        responseBytes += encryptedResponse.length
        // Transport errors and quick-acks are standalone short frames, not MTProto envelopes.
        if (encryptedResponse.length < 28) continue
        const envelope = await decryptMessage(encryptedResponse, session.authKey, authKeyId, sessionId)
        salt = envelope.serverSalt
        options.onSalt?.(salt)
        if (envelope.sequence % 2 === 1) ackIds.push(envelope.msgId)
        const events = await readEvents(envelope.body, requestId, ackIds)
        for (const event of events) {
          if (event.type === "salt") {
            salt = event.salt
            options.onSalt?.(salt)
          } else if (event.type === "retry") {
            if (event.salt !== undefined) {
              salt = event.salt
              options.onSalt?.(salt)
            }
            retry = true
          } else if (event.type === "result") {
            if (ackIds.length > 0) {
              const ackMessageId = ids.next()
              const body = new TlWriter().uint(MSGS_ACK).uint(0x1cb5c415).uint(ackIds.length)
              for (const id of new Set(ackIds)) body.long(id)
              await send(body.result(), ackMessageId, contentCount * 2)
            }
            received = true
            return { body: event.body, serverSalt: salt, requestMessages, responseBytes }
          }
        }
      }
    }
    throw new Error("reqly: Telegram rejected the request")
  } finally {
    if (!closed) socket.close()
  }
}
type ParsedEvent =
  | { type: "result"; requestId: bigint; body: Uint8Array }
  | { type: "error"; requestId: bigint; code: number; message: string }
  | { type: "salt"; salt: bigint; requestId?: bigint }
  | { type: "retry"; requestId?: bigint }

/** Parses protocol events without filtering them to one request id. */
async function parseEvents(body: Uint8Array, ackIds: bigint[]): Promise<ParsedEvent[]> {
  const constructor = readUint(body, 0)
  if (constructor === MSG_CONTAINER) {
    const count = readInt(body, 4)
    let offset = 8
    const events: ParsedEvent[] = []
    for (let index = 0; index < count; index += 1) {
      const messageId = readLong(body, offset)
      const sequence = readInt(body, offset + 8)
      const length = readInt(body, offset + 12)
      offset += 16
      const inner = body.slice(offset, offset + length)
      offset += length
      if (sequence % 2 === 1) ackIds.push(messageId)
      events.push(...await parseEvents(inner, ackIds))
    }
    return events
  }
  if (constructor === RPC_RESULT) {
    const requestId = readLong(body, 4)
    const result = body.slice(12)
    if (readUint(result, 0) === RPC_ERROR) {
      const code = readInt(result, 4)
      const message = new TextDecoder().decode(readTlBytes(result, 8))
      return [{ type: "error", requestId, code, message }]
    }
    if (readUint(result, 0) === GZIP_PACKED) return [{ type: "result", requestId, body: await decompress(readTlBytes(result, 4)) }]
    return [{ type: "result", requestId, body: result }]
  }
  if (constructor === BAD_SERVER_SALT) return [{ type: "salt", salt: readLong(body, 20), requestId: readLong(body, 4) }]
  if (constructor === BAD_MSG_NOTIFICATION) {
    const code = readInt(body, 12)
    return code === 16 || code === 17 ? [{ type: "retry", requestId: readLong(body, 4) }] : []
  }
  if (constructor === NEW_SESSION_CREATED) return [{ type: "salt", salt: readLong(body, 20) }]
  return []
}

interface PendingCall {
  resolve: (body: Uint8Array) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
  method: Uint8Array
  sequence: number
}

/**
 * A reusable MTProto connection over a single WebSocket.
 *
 * One WebSocket is opened per Worker request and every RPC (including parallel
 * chunk downloads) is multiplexed over it, removing the costly socket
 * handshake from each individual getFile call. A keep-alive ping is sent
 * every 30 seconds to prevent idle server disconnects.
 */
export class Connection {
  private readonly socket: WebSocket
  private readonly authKey: Uint8Array
  private readonly authKeyId: Uint8Array
  private readonly sessionId: bigint
  private readonly outbound: Awaited<ReturnType<typeof createStream>>
  private readonly inbound: Awaited<ReturnType<typeof createStream>>
  private readonly reader: AbridgedReader
  private readonly ids = new MessageIds()
  private readonly pending = new Map<bigint, PendingCall>()
  private readonly ackIds: bigint[] = []
  private salt = 0n
  private count = 0
  private closed = false
  private readonly saltSignal: Promise<void>
  private resolveSalt: (() => void) | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined

  private constructor(
    socket: WebSocket,
    authKey: Uint8Array,
    authKeyId: Uint8Array,
    sessionId: bigint,
    outbound: Awaited<ReturnType<typeof createStream>>,
    inbound: Awaited<ReturnType<typeof createStream>>,
  ) {
    this.socket = socket
    this.authKey = authKey
    this.authKeyId = authKeyId
    this.sessionId = sessionId
    this.outbound = outbound
    this.inbound = inbound
    this.reader = new AbridgedReader((data) => inbound.apply(data))
    this.saltSignal = new Promise<void>((resolve) => { this.resolveSalt = resolve })
    socket.addEventListener("message", (event: MessageEvent) => { void this.onMessage(event) })
    socket.addEventListener("close", () => {
      this.close()
    })
    // A Worker WebSocket can stay open for hours while a movie is paused.
    // `ping_delay_disconnect` is the MTProto keepalive clients use for exactly
    // that case; it also sets how long Telegram keeps the socket idle.
    this.startPing()
  }

  /** Starts the MTProto keepalive that keeps an idle reusable socket open. */
  private startPing(): void {
    if (this.pingTimer !== undefined) return
    this.pingTimer = setInterval(() => {
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
        this.stopPing()
        return
      }
      // Workers' WebSocket API has no control-frame ping(). Use the MTProto
      // keepalive RPC. Skip before the first salt is known: Telegram rejects
      // encrypted messages without a server salt.
      if (this.salt === 0n) return
      try {
        const body = new TlWriter()
          .uint(PING_DELAY_DISCONNECT)
          .long(BigInt(Date.now()))
          .int(75)
          .result()
        // `call` uses a content-related sequence number and consumes the Pong
        // reply. An ignored standalone `ping`/`msgs_ack` frame made Telegram
        // close the socket in earlier tests.
        void this.call(body, 20_000).catch(() => {})
      } catch { /* best effort; the next interval retries */ }
    }, 30_000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = undefined
    }
  }

  /**
   * Opens a new WebSocket connection to a Telegram data center.
   *
   * Performs the obfuscated MTProto handshake and returns a Connection
   * ready to multiplex RPCs. If timeoutMs is provided, the socket open
   * is aborted after that duration.
   *
   * @param session - The Telegram session to connect with.
   * @param timeoutMs - Socket open timeout in milliseconds. Defaults to DEFAULT_TIMEOUT_MS.
   */
  static async open(session: Session, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Connection> {
    const authKeyId = new Uint8Array(await crypto.subtle.digest("SHA-1", session.authKey as unknown as BufferSource)).slice(-8)
    const sessionId = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigInt64(0, true)
    const header = obfuscationHeader(session.dcId)
    const reversed = header.slice(8, 56).reverse()
    const outbound = await createStream(header.slice(8, 40), header.slice(40, 56))
    const inbound = await createStream(reversed.slice(0, 32), reversed.slice(32, 48))
    const encryptedHeader = await outbound.apply(header)
    header.set(encryptedHeader.slice(56), 56)

    const socket = await openSocket(session.address, timeoutMs)

    socket.binaryType = "arraybuffer"
    const connection = new Connection(socket, session.authKey, authKeyId, sessionId, outbound, inbound)
    try {
      socket.send(header as unknown as ArrayBuffer)
    } catch (error) {
      connection.close()
      throw error
    }
    return connection
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    if (this.closed) return
    try {
      const packets = await this.reader.push(new Uint8Array(event.data as ArrayBuffer))
      for (const packet of packets) {
        if (packet.length < 28) continue
        let envelope: Envelope
        try {
          envelope = await decryptMessage(packet, this.authKey, this.authKeyId, this.sessionId)
        } catch (error) {
          continue
        }
        this.salt = envelope.serverSalt
        if (envelope.sequence % 2 === 1) this.ackIds.push(envelope.msgId)
        const events = await parseEvents(envelope.body, this.ackIds)
        for (const item of events) {
          if (item.type === "result" || item.type === "error") {
            const pending = this.pending.get(item.requestId)
            if (!pending) continue
            clearTimeout(pending.timer)
            this.pending.delete(item.requestId)
            if (item.type === "error") {
              pending.reject(Object.assign(new Error(`reqly: Telegram error ${item.code}: ${item.message}`), { code: item.code, telegramMessage: item.message }))
            } else {
              pending.resolve(item.body)
            }
          } else if (item.type === "salt") {
            this.salt = item.salt
            if (item.requestId === undefined) this.resolveSalt?.()
            if (item.requestId !== undefined) {
              const pending = this.pending.get(item.requestId)
              if (pending) this.resend(item.requestId, pending)
            }
          } else if (item.type === "retry") {
            if (item.requestId !== undefined) {
              const pending = this.pending.get(item.requestId)
              if (pending) this.resend(item.requestId, pending)
            } else {
              for (const [requestId, pending] of [...this.pending]) this.resend(requestId, pending)
            }
          }
        }
      }
      // Standalone msgs_ack made Telegram close the socket (1006), forcing a
      // fresh WebSocket per RPC and exhausting the 50-subrequest limit. Acks
      // must be batched into the next request body instead; skipped here.
    } catch (error) {
      // malformed frames are ignored; the request will time out.
      // Log in debug so operators can diagnose transport-level corruption.
      if (typeof console !== "undefined") console.warn("[reqly] transport onMessage error:", error)
    }
  }

  /** Explicitly acknowledges server messages (required by MTProto). */
  private async sendAcks(): Promise<void> {
    if (this.ackIds.length === 0 || this.closed) return
    const ids = [...new Set(this.ackIds)]
    this.ackIds.length = 0
    const body = new TlWriter().uint(MSGS_ACK).uint(0x1cb5c415).uint(ids.length)
    for (const id of ids) body.long(id)
    const messageId = this.ids.next()
    const sequence = this.count * 2
    this.count += 1
    try {
      await this.sendRaw(body.result(), messageId, sequence)
    } catch { /* the next message will carry fresh acks */ }
  }

  private resend(requestId: bigint, pending: PendingCall): void {
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    const newId = this.ids.next()
    const sequence = this.count * 2 + 1
    this.count += 1
    const timer = setTimeout(() => {
      this.pending.delete(newId)
      pending.reject(new Error("reqly: RPC timed out"))
    }, 20000)
    this.pending.set(newId, { ...pending, timer, sequence })
    this.sendRaw(pending.method, newId, sequence).catch(() => {
      clearTimeout(timer)
      this.pending.delete(newId)
      pending.reject(new Error("reqly: request resend failed"))
    })
  }

  private async sendRaw(method: Uint8Array, messageId: bigint, sequence: number): Promise<void> {
    const packet = await encryptMessage({
      authKey: this.authKey,
      authKeyId: this.authKeyId,
      salt: this.salt,
      sessionId: this.sessionId,
      messageId,
      sequence,
      body: method,
    })
    const payload = await this.outbound.apply(abridgedFrame(packet))
    this.socket.send(payload as unknown as ArrayBuffer)
  }

  isClosed(): boolean {
    return this.closed
  }

  /**
   * Sends a raw TL method and resolves with its result body.
   *
   * The call is multiplexed over this connection's WebSocket. If the
   * connection is closed, the returned promise rejects immediately.
   *
   * @param method - The serialized TL method body to send.
   * @param timeoutMs - RPC timeout in milliseconds. Defaults to DEFAULT_TIMEOUT_MS.
   * @returns The decrypted response body.
   */
  call(method: Uint8Array, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("reqly: connection closed"))
    const requestId = this.ids.next()
    const sequence = this.count * 2 + 1
    this.count += 1
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error("reqly: RPC timed out"))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer, method, sequence })
      this.sendRaw(method, requestId, sequence).catch((error: unknown) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  /**
   * Closes the WebSocket and rejects all pending calls.
   *
   * Safe to call multiple times. After closing, all subsequent calls
   * will reject with "reqly: connection closed".
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.stopPing()
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("reqly: connection closed"))
    }
    this.pending.clear()
    try { this.socket.close() } catch { /* already closed */ }
  }
}
// Mellouki Jamal — Asynctric
