import { describe, expect, it } from "vitest"
import { AbridgedReader } from "../src/transport.ts"

const decrypt = async (data: Uint8Array): Promise<Uint8Array> => data

function frame(payload: Uint8Array): Uint8Array {
  const words = payload.length / 4
  if (words < 127) return new Uint8Array([words, ...payload])
  return new Uint8Array([0x7f, words & 0xff, (words >>> 8) & 0xff, (words >>> 16) & 0xff, ...payload])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

describe("abridged frame reader", () => {
  it("parses a normal frame", async () => {
    const reader = new AbridgedReader(decrypt)
    const payload = new Uint8Array([1, 2, 3, 4])
    expect(await reader.push(frame(payload))).toEqual([payload])
  })

  it("ignores zero-length keepalive frames", async () => {
    const reader = new AbridgedReader(decrypt)
    const payload = new Uint8Array([9, 8, 7, 6])
    expect(await reader.push(concat(new Uint8Array([0]), frame(payload)))).toEqual([payload])
  })

  it("ignores four-byte quick ACK tokens", async () => {
    const reader = new AbridgedReader(decrypt)
    const payload = new Uint8Array([5, 5, 5, 5])
    const ack = new Uint8Array([0x81, 0x22, 0x33, 0x44])
    expect(await reader.push(concat(ack, frame(payload)))).toEqual([payload])
  })

  it("clears its buffer after an invalid frame so later frames still parse", async () => {
    const reader = new AbridgedReader(decrypt)
    const payload = new Uint8Array([7, 7, 7, 7])
    await expect(reader.push(new Uint8Array([0x7f, 0, 0, 0]))).rejects.toThrow("invalid abridged frame")
    expect(await reader.push(frame(payload))).toEqual([payload])
  })
})
// Mellouki Jamal — Asynctric
