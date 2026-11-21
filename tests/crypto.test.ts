import { describe, expect, it } from "vitest"
import { deriveKeys, igeDecrypt, igeEncrypt, messageKeyOf } from "../src/crypto.ts"

describe("AES-256", () => {
  it("matches the FIPS-197 AES-256 block vector", () => {
    const key = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index))
    const plain = Uint8Array.from(Buffer.from("00112233445566778899aabbccddeeff", "hex"))
    const cipher = igeEncrypt(plain, key, new Uint8Array(32))
    expect(Buffer.from(cipher.slice(0, 16)).toString("hex")).toBe("8ea2b7ca516745bfeafc49904b496089")
  })

  it("round-trips multiple IGE blocks", () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const iv = crypto.getRandomValues(new Uint8Array(32))
    const plain = crypto.getRandomValues(new Uint8Array(160))
    expect(igeDecrypt(igeEncrypt(plain, key, iv), key, iv)).toEqual(plain)
  })
})

describe("key derivation", () => {
  it("is deterministic and direction-dependent", async () => {
    const authKey = crypto.getRandomValues(new Uint8Array(256))
    const messageKey = crypto.getRandomValues(new Uint8Array(16))
    const client = await deriveKeys(authKey, messageKey, 0)
    const server = await deriveKeys(authKey, messageKey, 8)
    expect(client.key).toEqual((await deriveKeys(authKey, messageKey, 0)).key)
    expect(client.key).not.toEqual(server.key)
    expect((await messageKeyOf(authKey, new Uint8Array(64))).length).toBe(16)
  })
})
// Mellouki Jamal — Asynctric
