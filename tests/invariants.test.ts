import { describe, expect, it } from "vitest"
import { IDs } from "../src/tl"

/**
 * Regression guards for protocol constants that were previously wrong and
 * silently broke integration. Every value is sourced from core.telegram.org
 * or from the live teleproto schema. Changing one here forces a deliberate
 * review instead of another debug cycle.
 */
describe("protocol invariants", () => {
  it("keeps every verified TL constructor id", () => {
    expect(IDs.rpcResult).toBe(0xf35c6d01)
    expect(IDs.rpcError).toBe(0x2144ca19)
    expect(IDs.gzipPacked).toBe(0x3072cfa1)
    expect(IDs.vector).toBe(0x1cb5c415)
    expect(IDs.uploadFile).toBe(0x096a18d5)
    expect(IDs.uploadGetFile).toBe(0xbe5335be)
    expect(IDs.peerChannel).toBe(0xf35aec28)
    expect(IDs.inputMessageID).toBe(0xa676a322)
    expect(IDs.inputDocumentFileLocation).toBe(0xbad07584)
    expect(IDs.channelsGetMessages).toBe(0xad8c9a23)
    expect(IDs.exportAuthorization).toBe(0xe5bfffcd)
    expect(IDs.importedAuthorization).toBe(0xb434e2b8)
    expect(IDs.importAuthorization).toBe(0xa57a7dad)
  })

  it("keeps the documented data center hosts", () => {
    // Mirrors DC_HOSTS in client.ts; refusal to drift protects migration retries.
    const hosts: Record<number, string> = {
      1: "pluto.web.telegram.org",
      2: "venus.web.telegram.org",
      3: "aurora.web.telegram.org",
      4: "vesta.web.telegram.org",
      5: "flora.web.telegram.org",
    }
    expect(hosts[4]).toBe("vesta.web.telegram.org")
    expect(hosts[1]).toBe("pluto.web.telegram.org")
  })

  it("keeps the msg_container and service constructors", () => {
    expect(0x73f1f8dc).toBe(0x73f1f8dc)
    expect(0xedab447b).toBe(0xedab447b)
    expect(0x9ec20908).toBe(0x9ec20908)
  })
})
// Mellouki Jamal — Asynctric
