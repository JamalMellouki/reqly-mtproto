/**
 * Minimal Type Language codec.
 *
 * Only the constructors required for Telegram file access are modelled. The
 * writer is generic, the reader exposes primitives and a small structural
 * parser for Message/Document responses.
 */

export const IDs = {
  vector: 0x1cb5c415,
  gzipPacked: 0x3072cfa1,
  rpcResult: 0xf35c6d01,
  rpcError: 0x2144ca19,
  uploadFile: 0x096a18d5,
  messagesMessages: 0x8c718e87,
  messageMediaDocument: 0x52d8ccd9,
  document: 0x8fd4c4d8,
  peerChannel: 0xf35aec28,
  inputMessageID: 0xa676a322,
  inputDocumentFileLocation: 0xbad07584,
  channelsGetMessages: 0xad8c9a23,
  uploadGetFile: 0xbe5335be,
  exportAuthorization: 0xe5bfffcd,
  importedAuthorization: 0xb434e2b8,
  importAuthorization: 0xa57a7dad,
} as const

export class TlWriter {
  private readonly chunks: Uint8Array[] = []

  uint(value: number): this {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true)
    this.chunks.push(bytes)
    return this
  }

  int(value: number): this {
    return this.uint(value | 0)
  }

  long(value: bigint): this {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigInt64(0, value, true)
    this.chunks.push(bytes)
    return this
  }

  bytes(value: Uint8Array): this {
    let headerLength: number
    if (value.length < 254) {
      this.chunks.push(new Uint8Array([value.length]))
      headerLength = 1
    } else {
      this.chunks.push(new Uint8Array([0xfe, value.length & 0xff, (value.length >>> 8) & 0xff, (value.length >>> 16) & 0xff]))
      headerLength = 4
    }
    this.chunks.push(value)
    const padding = (4 - ((headerLength + value.length) % 4)) % 4
    if (padding > 0) this.chunks.push(new Uint8Array(padding))
    return this
  }

  string(value: string): this {
    return this.bytes(new TextEncoder().encode(value))
  }

  raw(value: Uint8Array): this {
    this.chunks.push(value)
    return this
  }

  vector(values: readonly number[], write: (writer: TlWriter, value: number) => void): this {
    this.uint(IDs.vector)
    this.uint(values.length)
    for (const value of values) write(this, value)
    return this
  }

  result(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const output = new Uint8Array(total)
    let cursor = 0
    for (const chunk of this.chunks) {
      output.set(chunk, cursor)
      cursor += chunk.length
    }
    return output
  }
}

export class TlReader {
  private offset = 0

  constructor(private readonly source: Uint8Array) {}

  get position(): number {
    return this.offset
  }

  remaining(): number {
    return this.source.length - this.offset
  }

  uint(): number {
    if (this.offset + 4 > this.source.length) throw new Error("reqly: TL read past end")
    const value = new DataView(this.source.buffer, this.source.byteOffset + this.offset, 4).getUint32(0, true)
    this.offset += 4
    return value
  }

  int(): number {
    return this.uint() | 0
  }

  long(): bigint {
    if (this.offset + 8 > this.source.length) throw new Error("reqly: TL read past end")
    const value = new DataView(this.source.buffer, this.source.byteOffset + this.offset, 8).getBigInt64(0, true)
    this.offset += 8
    return value
  }

  bytes(): Uint8Array {
    if (this.offset >= this.source.length) throw new Error("reqly: TL read past end")
    let length = this.source[this.offset]!
    this.offset += 1
    let headerLength = 1
    if (length === 0xfe) {
      if (this.offset + 3 > this.source.length) throw new Error("reqly: TL read past end")
      const low = this.source[this.offset]!
      const middle = this.source[this.offset + 1]!
      const high = this.source[this.offset + 2]!
      this.offset += 3
      length = low | (middle << 8) | (high << 16)
      headerLength = 4
    }
    // A declared length larger than the remaining payload is corruption, not a
    // short value. Returning a truncated slice hides wire bugs and can poison
    // document references, so fail loudly like uint/long/raw do.
    if (this.offset + length > this.source.length) throw new Error("reqly: TL read past end")
    const value = this.source.slice(this.offset, this.offset + length)
    this.offset += length + ((4 - ((headerLength + length) % 4)) % 4)
    return value
  }

  /** Reads a fixed number of bytes without a TL length prefix (int128/int256). */
  raw(length: number): Uint8Array {
    if (this.offset + length > this.source.length) throw new Error("reqly: TL read past end")
    const value = this.source.slice(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  skip(count: number): void {
    this.offset += count
  }

  seek(offset: number): void {
    this.offset = offset
  }
}

/** `upload.fileCdnRedirect` — Telegram's CDN path for popular public files. */
export interface CdnRedirect {
  dcId: number
  fileToken: Uint8Array
  encryptionKey: Uint8Array
  encryptionIv: Uint8Array
}

/** Decodes either `upload.file` or `upload.fileCdnRedirect`. */
export function decodeFileOrRedirect(payload: Uint8Array): { kind: "file"; bytes: Uint8Array } | { kind: "redirect"; redirect: CdnRedirect } {
  const reader = new TlReader(payload)
  const constructor = reader.uint()
  if (constructor === IDs.uploadFile) {
    reader.uint()
    reader.int()
    return { kind: "file", bytes: reader.bytes() }
  }
  if (constructor === 0xf18cda44) {
    const dcId = reader.int()
    const fileToken = reader.bytes()
    const encryptionKey = reader.bytes()
    const encryptionIv = reader.bytes()
    if (reader.uint() !== IDs.vector) throw new Error("reqly: malformed fileCdnRedirect hashes")
    const count = reader.uint()
    for (let index = 0; index < count; index += 1) {
      if (reader.uint() !== 0xf39b035c) throw new Error("reqly: malformed fileCdnRedirect hash")
      reader.long()
      reader.int()
      reader.bytes()
    }
    return { kind: "redirect", redirect: { dcId, fileToken, encryptionKey, encryptionIv } }
  }
  throw new Error(`reqly: unexpected upload.file 0x${constructor.toString(16)} len=${payload.length} head=${toHex(payload.slice(0, 16))}`)
}

export interface RemoteDocument {
  id: bigint
  accessHash: bigint
  fileReference: Uint8Array
  size: bigint
}

function readDocument(reader: TlReader): RemoteDocument {
  const flags = reader.uint()
  const id = reader.long()
  const accessHash = reader.long()
  const fileReference = reader.bytes()
  reader.int()
  reader.bytes()
  const size = reader.long()
  void flags
  return { id, accessHash, fileReference, size }
}

/**
 * Finds document references inside an RPC result.
 *
 * `channels.getMessages` nests documents several levels deep behind optional
 * flags whose layout changes between TL layers. Scanning at 4-byte boundaries
 * for the stable `document#` constructor is more durable here than duplicating
 * the full Message schema, and every candidate is validated by parsing its
 * mandatory fields.
 */
export function extractDocuments(payload: Uint8Array): RemoteDocument[] {
  const documents: RemoteDocument[] = []
  const seen = new Set<string>()
  for (let offset = 0; offset + 4 <= payload.length; offset += 4) {
    if (new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, true) !== IDs.document) continue
    try {
      const reader = new TlReader(payload.subarray(offset))
      reader.uint()
      const document = readDocument(reader)
      // Reject candidates that cannot be a real document. This keeps the
      // 4-byte scan from mistaking opaque file_reference bytes for a second
      // document, and duplicate message ids from yielding duplicate entries.
      if (document.fileReference.length === 0 || document.fileReference.length > 1024) continue
      if (document.size < 0n) continue
      const key = document.id.toString()
      if (seen.has(key)) continue
      seen.add(key)
      documents.push(document)
    } catch {
      continue
    }
  }
  return documents
}

function toHex(bytes: Uint8Array): string {
  let result = ""
  for (let index = 0; index < bytes.length; index += 1) result += (bytes[index] ?? 0).toString(16).padStart(2, "0")
  return result
}

/** Decodes an `upload.file` response body. */
export function decodeFile(payload: Uint8Array): Uint8Array {
  const reader = new TlReader(payload)
  const constructor = reader.uint()
  if (constructor !== IDs.uploadFile) throw new Error(`reqly: unexpected upload.file 0x${constructor.toString(16)} len=${payload.length} head=${toHex(payload.slice(0, 16))}`)
  reader.uint()
  reader.int()
  return reader.bytes()
}
// Mellouki Jamal — Asynctric
