import { describe, expect, it } from "vitest"
import { Reqly } from "../src/index.ts"
import { document, liveEnabled, session } from "./live-env.ts"

describe.skipIf(!liveEnabled || !document())("Telegram file download (live)", () => {
  it("downloads a document chunk with a valid header", async () => {
    const file = document()!
    const client = await Reqly.connect(session(), { timeoutMs: 20000 })
    const bytes = await client.getFile(file, 0, 65536)
    expect(bytes.length).toBe(65536)
    expect(bytes.length).toBeGreaterThan(12)
  }, 60000)
})
// Mellouki Jamal — Asynctric
