import { describe, expect, it } from "vitest"
import { TELEGRAM_RSA_KEYS, findTelegramKey, rsaKeyFromBytes } from "../src/index.ts"
import { TlWriter } from "../src/tl.ts"

/**
 * Production telegram rejects req_DH_params when a modulus is truncated or a
 * fingerprint is mislabelled. These guards make a corrupted key fail in CI.
 */
describe("embedded Telegram RSA keys", () => {
  it("contains the keys advertised by production DCs", () => {
    const fingerprints = TELEGRAM_RSA_KEYS.map((key) => key.fingerprint)
    expect(fingerprints).toContain(-3414540481677951611n) // 0xD09D1D85DE64FD85
    expect(fingerprints).toContain(847625836280919973n) // 0x0BC35F3509F7B7A5
    expect(fingerprints).toContain(-4344800451088585951n) // 0xC3B42B026CE86B21
  })

  it("every key has a full 256-byte modulus and exponent 65537", () => {
    for (const key of TELEGRAM_RSA_KEYS) {
      expect(key.n.length).toBe(256)
      expect([...key.e]).toEqual([0x01, 0x00, 0x01])
    }
  })

  it("recomputes every fingerprint from the TL-serialized n and e", async () => {
    for (const material of TELEGRAM_RSA_KEYS) {
      const key = await rsaKeyFromBytes(material.n, material.e)
      expect(key.fingerprint).toBe(material.fingerprint)
      expect(key.exponent).toBe(65537n)
    }
  })

  it("resolves a key from an advertised fingerprint and rejects unknown ones", async () => {
    const key = await findTelegramKey(-3414540481677951611n)
    expect(key?.fingerprint).toBe(-3414540481677951611n)
    expect(await findTelegramKey(12345n)).toBeUndefined()
  })

  it("TL-serializes a 256-byte string with a 4-byte header and no padding", () => {
    const value = new Uint8Array(256).fill(7)
    const encoded = new TlWriter().bytes(value).result()
    expect(encoded.length).toBe(260)
    expect([...encoded.slice(0, 4)]).toEqual([0xfe, 0x00, 0x01, 0x00])
  })
})
// Mellouki Jamal — Asynctric
