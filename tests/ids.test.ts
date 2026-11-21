import { describe, expect, it } from "vitest"
import { IDs } from "../src/tl"

// Values taken from the official Telegram TL schema (core.telegram.org/schema/mtproto).
describe("TL constructor ids", () => {
  it("uses the documented ids", () => {
    expect(IDs.rpcResult).toBe(0xf35c6d01)
    expect(IDs.rpcError).toBe(0x2144ca19)
    expect(IDs.gzipPacked).toBe(0x3072cfa1)
    expect(IDs.uploadFile).toBe(0x096a18d5)
    expect(IDs.uploadGetFile).toBe(0xbe5335be)
    expect(IDs.peerChannel).toBe(0xf35aec28)
    expect(IDs.messageMediaDocument).toBe(0x52d8ccd9)
    expect(IDs.document).toBe(0x8fd4c4d8)
    expect(IDs.inputDocumentFileLocation).toBe(0xbad07584)
    expect(IDs.channelsGetMessages).toBe(0xad8c9a23)
  })
})
// Mellouki Jamal — Asynctric
