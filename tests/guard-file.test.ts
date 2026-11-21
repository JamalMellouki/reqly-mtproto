import { describe, expect, it } from "vitest"
import { decodeFile, TlWriter, IDs } from "../src/index.ts"

describe("file path guards", () => {
  it("decodes a minimal upload.file response", () => {
    const payload = new TlWriter().uint(IDs.uploadFile).uint(0xb3cea0e4).int(123).bytes(new Uint8Array([0, 1, 2, 3])).result()
    expect(decodeFile(payload)).toEqual(new Uint8Array([0, 1, 2, 3]))
  })

  it("writes inputDocumentFileLocation with the verified constructor", () => {
    const bytes = new TlWriter().uint(IDs.inputDocumentFileLocation).long(1n).long(2n).bytes(new Uint8Array()).string("").result()
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0xbad07584)
  })
})
// Mellouki Jamal — Asynctric
