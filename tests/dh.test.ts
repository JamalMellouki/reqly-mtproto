import { describe, expect, it } from "vitest"
import { DH_CONST, reqPqEnvelope, parseResPq, factorPq, modPow } from "../src/dh"
import { TlWriter, IDs } from "../src/tl"

describe("DH handshake wire format", () => {
  it("builds a plaintext req_pq_multi envelope", () => {
    const nonce = new Uint8Array(16).fill(7)
    const frame = reqPqEnvelope(nonce, 123n)
    const view = new DataView(frame.buffer)
    expect(view.getBigInt64(0, true)).toBe(0n)
    expect(view.getBigInt64(8, true)).toBe(123n)
    expect(view.getInt32(16, true)).toBe(20)
    expect(view.getUint32(20, true)).toBe(DH_CONST.reqPqMulti)
    expect([...frame.slice(24, 40)]).toEqual([...nonce])
  })

  it("parses a resPQ reply with its nonce echo and fingerprints", () => {
    const nonce = new Uint8Array(16).fill(1)
    const serverNonce = new Uint8Array(16).fill(2)
    const body = new TlWriter()
      .uint(DH_CONST.resPq)
      .raw(nonce)
      .raw(serverNonce)
      .bytes(new Uint8Array([0x2e, 0x9c, 0xdb, 0x98, 0xc8, 0x0c, 0xda, 0x4b]))
      .uint(IDs.vector)
      .uint(1)
      .long(0x85fd64de851d9dd0n)
      .result()
    const frame = new Uint8Array(20 + body.length)
    const view = new DataView(frame.buffer)
    view.setBigInt64(8, 456n, true)
    view.setInt32(16, body.length, true)
    frame.set(body, 20)
    const parsed = parseResPq(frame)
    expect([...parsed.nonce]).toEqual([...nonce])
    expect([...parsed.serverNonce]).toEqual([...serverNonce])
    const unsigned = 0x85fd64de851d9dd0n
    const signed = unsigned > 0x7fffffffffffffffn ? unsigned - 0x10000000000000000n : unsigned
    expect(parsed.fingerprints).toEqual([signed])
    expect(parsed.pq).toBe(3358800871349344843n)
  })

  it("factors the documented sample pq into two primes", () => {
    expect(factorPq(3358800871349344843n)).toEqual({ p: 1786331737n, q: 1880278339n })
  })

  it("computes modular exponentiation", () => {
    expect(modPow(2n, 10n, 1000n)).toBe(24n)
  })
})
// Mellouki Jamal — Asynctric
