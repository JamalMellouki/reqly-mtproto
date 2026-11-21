import { describe, expect, it } from "vitest"
import { Reqly, type RemoteDocument } from "../src/index.ts"
import { document, liveEnabled, session } from "./live-env.ts"

const file = document()
const MB = 1024 * 1024

describe.skipIf(!liveEnabled || !file)("1 MB block boundaries", () => {
  it("reads a range that starts mid-block and crosses into the next block", async () => {
    const location = file as RemoteDocument
    const size = Number(location.size)
    const offset = Math.max(MB, Math.floor(size / 2 / MB) * MB + 4096)
    const client = await Reqly.connect(session(), { timeoutMs: 25000 })
    const bytes = await client.getFile(location, offset, MB)
    expect(bytes.length).toBe(MB)
    client.close()
  }, 90000)

  it("reads the final suffix range without requesting past end-of-file", async () => {
    const location = file as RemoteDocument
    const size = Number(location.size)
    const offset = Math.floor((size - 1) / MB) * MB
    const client = await Reqly.connect(session(), { timeoutMs: 25000 })
    const bytes = await client.getFile(location, offset, Math.min(2048, size - offset))
    expect(bytes.length).toBeGreaterThan(0)
    client.close()
  }, 90000)
})
// Mellouki Jamal — Asynctric
