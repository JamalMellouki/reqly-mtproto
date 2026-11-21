import { describe, expect, it } from "vitest"
import { Reqly, getFileHashes, verifyChunk } from "../src/index.ts"
import { document, liveEnabled, session } from "./live-env.ts"

describe.skipIf(!liveEnabled || !document())("chunk hash verification (live)", () => {
  it("matches a downloaded chunk against upload.getFileHashes", async () => {
    const file = document()!
    const client = await Reqly.connect(session(), { timeoutMs: 20000 })
    const hashes = await getFileHashes(client, file, 0)
    expect(hashes.length).toBeGreaterThan(0)
    const entry = hashes[0]!
    const chunk = await client.getFile(file, entry.offset, entry.limit)
    expect(await verifyChunk(chunk, entry)).toBe(true)
  }, 120000)
})
// Mellouki Jamal — Asynctric
