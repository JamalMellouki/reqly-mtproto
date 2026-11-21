import { describe, expect, it } from "vitest"
import { TlReader, TlWriter, IDs } from "../src/tl"

/** Guards the wire layout of auth.exportedAuthorization. */
describe("authorization transfer wire format", () => {
  it("parses the live exportedAuthorization reply (id:long, bytes:bytes)", () => {
    const bytes = new Uint8Array([
      0xb8, 0xe2, 0x34, 0xb4,
      0x6a, 0x70, 0x81, 0x24, 0x02, 0x00, 0x00, 0x00,
      0x80,
      ...new Uint8Array(128).fill(7),
      0, 0, 0,
    ])
    const reader = new TlReader(bytes)
    expect(reader.uint()).toBe(IDs.importedAuthorization)
    expect(reader.long()).toBe(0x000000022481706an)
    expect(reader.bytes().length).toBe(128)
  })

  it("writes authentication transfer methods with verified ids", () => {
    expect(new TlWriter().uint(IDs.exportAuthorization).int(1).result().length).toBe(8)
    expect(IDs.importAuthorization).toBe(0xa57a7dad)
  })
})
// Mellouki Jamal — Asynctric
