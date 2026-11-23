/**
 * Verification of downloaded file chunks.
 *
 * Telegram recommends checking each part against the SHA-256 values returned
 * by upload.getFileHashes (core.telegram.org/method/upload.getFileHashes).
 */

import { TlReader, TlWriter, IDs } from "./tl"
import type { RemoteDocument } from "./tl"
import type { Reqly } from "./client"
import { FileReferenceExpiredError } from "./errors"

export interface FileHashEntry {
  offset: number
  limit: number
  hash: Uint8Array
}

/** Parses a vector<fileHash> reply from upload.getFileHashes. */
export function decodeFileHashes(payload: Uint8Array): FileHashEntry[] {
  const reader = new TlReader(payload)
  if (reader.uint() !== IDs.vector) throw new Error("reqly: expected vector<fileHash>")
  const count = reader.uint()
  const entries: FileHashEntry[] = []
  for (let index = 0; index < count; index += 1) {
    const ctor = reader.uint()
    if (ctor !== 0xf39b035c) throw new Error(`reqly: unexpected fileHash constructor 0x${ctor.toString(16)} at index ${index} pos ${reader.position}`)
    const offset = Number(reader.long())
    const limit = reader.int()
    entries.push({ offset, limit, hash: reader.bytes() })
  }
  return entries
}

/**
 * Serializes `upload.getFileHashes`. The `offset` field is a TL `long`, not an
 * `int`; encoding it as int shifted every following byte and produced
 * LOCATION_INVALID on the wire.
 */
export function encodeGetFileHashes(
  location: RemoteDocument,
  offset: number,
  fileReference: Uint8Array = location.fileReference,
): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("reqly: getFileHashes offset must be a non-negative integer")
  }
  const locationBytes = new TlWriter()
    .uint(IDs.inputDocumentFileLocation)
    .long(location.id)
    .long(location.accessHash)
    .bytes(fileReference)
    .string("")
    .result()
  return new TlWriter().uint(0x9156982a).raw(locationBytes).long(BigInt(offset)).result()
}

/**
 * Returns the hashes covering the given byte range, or an empty list.
 *
 * This standalone helper always calls the client's primary session. Telegram
 * answers LOCATION_INVALID when the document lives on another DC, so use
 * {@link Reqly.getFileHashes} for migration-aware verification.
 *
 * @param client - Connected Reqly client.
 * @param location - Document to verify.
 * @param offset - Byte offset to start from.
 * @param refresh - Optional callback returning a fresh file reference.
 */
export async function getFileHashes(
  client: Reqly,
  location: RemoteDocument,
  offset = 0,
  refresh?: () => Promise<RemoteDocument>,
): Promise<FileHashEntry[]> {
  let reference = location.fileReference
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return decodeFileHashes(await client.invoke(encodeGetFileHashes(location, offset, reference)))
    } catch (error) {
      if (error instanceof FileReferenceExpiredError && refresh && attempt === 0) {
        reference = (await refresh()).fileReference
        continue
      }
      throw error
    }
  }
  throw new Error("reqly: getFileHashes failed")
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as BufferSource))
}

/** Verifies a downloaded chunk against a hash entry. Returns true on match. */
export async function verifyChunk(data: Uint8Array, entry: FileHashEntry): Promise<boolean> {
  if (entry.limit !== data.length) return false
  const digest = await sha256(data)
  if (digest.length !== entry.hash.length) return false
  let difference = 0
  for (let index = 0; index < digest.length; index += 1) difference |= digest[index]! ^ entry.hash[index]!
  return difference === 0
}
// Mellouki Jamal — Asynctric
