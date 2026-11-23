import { describe, expect, it } from "vitest"
import { TlReader, TlWriter, decodeFile } from "../src/tl.ts"

describe("TL codec", () => {
  it("writes primitive values in little-endian order", () => {
    const bytes = new TlWriter().uint(0x01020304).long(1n).bytes(new Uint8Array([1, 2, 3])).result()
    const reader = new TlReader(bytes)
    expect(reader.uint()).toBe(0x01020304)
    expect(reader.long()).toBe(1n)
    expect(reader.bytes()).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("decodes an upload.file response", () => {
    const payload = new TlWriter().uint(0x96a18d5).uint(0x105).int(123).bytes(new Uint8Array([0, 1, 2, 3])).result()
    expect(decodeFile(payload)).toEqual(new Uint8Array([0, 1, 2, 3]))
  })

  it("rejects a truncated bytes value instead of returning a short slice", () => {
    expect(() => new TlReader(new Uint8Array([5, 1, 2])).bytes()).toThrow("past end")
    expect(() => new TlReader(new Uint8Array([0xfe, 5, 0, 0, 1])).bytes()).toThrow("past end")
  })

  it("rejects a bytes header that is cut off", () => {
    expect(() => new TlReader(new Uint8Array([0xfe, 1])).bytes()).toThrow("past end")
    expect(() => new TlReader(new Uint8Array([])).bytes()).toThrow("past end")
  })
})
// Mellouki Jamal — Asynctric
