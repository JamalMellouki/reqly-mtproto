/** Short-lived HMAC-signed stream tokens shared between reqly workers. */

export interface StreamTokenPayload {
  /** Telegram message id in the archive channel. */
  m: number
  /** Internal work id from the catalog. */
  w: string
  /** Expiry as epoch seconds. */
  e: number
  /** "stream" or "download". */
  k: "stream" | "download"
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const output = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index)
  return output
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))
}

/** Creates `<payload>.<signature>` with a 6-hour default lifetime. */
export async function createStreamToken(
  secret: string,
  payload: Omit<StreamTokenPayload, "e">,
  ttlSeconds = 21600,
): Promise<string> {
  const full: StreamTokenPayload = { ...payload, e: Math.floor(Date.now() / 1000) + ttlSeconds }
  const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(full)))
  const signature = await hmac(secret, body)
  return `${body}.${encodeBase64Url(signature)}`
}

/** Verifies signature and expiry; returns the payload or null. */
export async function verifyStreamToken(secret: string, token: string): Promise<StreamTokenPayload | null> {
  const parts = token.split(".")
  if (parts.length !== 2) return null
  let expected: Uint8Array
  let actual: Uint8Array
  try {
    expected = await hmac(secret, parts[0]!)
    actual = decodeBase64Url(parts[1]!)
  } catch {
    // Malformed base64, an invalid secret, or a Web Crypto failure must be a
    // verification failure, never an unhandled exception in the request path.
    return null
  }
  if (expected.length !== actual.length) return null
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ actual[index]!
  if (difference !== 0) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]!))) as StreamTokenPayload
    if (payload.e < Math.floor(Date.now() / 1000)) return null
    if (!Number.isInteger(payload.m) || payload.m <= 0) return null
    if (payload.k !== "stream" && payload.k !== "download") return null
    return payload
  } catch {
    return null
  }
}
