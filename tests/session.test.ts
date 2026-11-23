import { describe, expect, it } from "vitest"
import { parseSession } from "../src/session.ts"
import { liveEnabled, session } from "./live-env.ts"

describe.skipIf(!liveEnabled || !session())("StringSession", () => {
  it("parses a gramJS-compatible session string", async () => {
    const parsed = await parseSession(session())
    expect(parsed.dcId).toBeGreaterThan(0)
    expect(parsed.address).toContain("telegram.org")
    expect(parsed.port).toBe(443)
    expect(parsed.authKey).toHaveLength(256)
    expect(parsed.authKeyId).not.toBe(0n)
  })
})

function syntheticSession(dcId: number, address: string, port: number): string {
  const addressBytes = new TextEncoder().encode(address)
  const raw = new Uint8Array(300)
  const view = new DataView(raw.buffer)
  raw[0] = dcId
  view.setUint16(1, addressBytes.length, false)
  raw.set(addressBytes, 3)
  view.setUint16(3 + addressBytes.length, port, false)
  for (let index = 0; index < 256; index += 1) raw[5 + addressBytes.length + index] = index & 0xff
  let binary = ""
  for (const byte of raw) binary += String.fromCharCode(byte)
  return `1${btoa(binary)}`
}

describe("StringSession validation", () => {
  it("rejects a data center outside 1..5", async () => {
    await expect(parseSession(syntheticSession(9, "venus.web.telegram.org", 443))).rejects.toThrow("invalid data center")
  })

  it("rejects an empty address", async () => {
    await expect(parseSession(syntheticSession(2, "", 443))).rejects.toThrow("empty address")
  })

  it("rejects port zero", async () => {
    await expect(parseSession(syntheticSession(2, "venus.web.telegram.org", 0))).rejects.toThrow("invalid port")
  })
})
// Mellouki Jamal — Asynctric
