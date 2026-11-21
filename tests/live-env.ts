/**
 * Shared configuration for optional live tests.
 *
 * Live tests are skipped automatically unless REQLY_SESSION is set, so the
 * suite is fully green on a fresh checkout with no credentials or fixtures.
 */

export const liveEnabled = process.env.REQLY_LIVE_TEST === "1"

export function session(): string {
  return process.env.REQLY_SESSION ?? ""
}

export function dcSessions(): Record<number, string> {
  const result: Record<number, string> = {}
  for (const dcId of [1, 2, 3, 4, 5]) {
    const value = process.env[`REQLY_DC${dcId}_SESSION`]
    if (value) result[dcId] = value
  }
  return result
}

export interface LiveDocument {
  id: bigint
  accessHash: bigint
  fileReference: Uint8Array
  size: bigint
}

/** Reads a live document fixture from REQLY_DOCUMENT (JSON). */
export function document(): LiveDocument | undefined {
  const raw = process.env.REQLY_DOCUMENT
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { id: string; accessHash: string; fileReference: string; size: string }
    return {
      id: BigInt(parsed.id),
      accessHash: BigInt(parsed.accessHash),
      fileReference: Buffer.from(parsed.fileReference, "hex"),
      size: BigInt(parsed.size),
    }
  } catch {
    return undefined
  }
}
// Mellouki Jamal — Asynctric
