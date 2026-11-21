import { describe, expect, it } from "vitest"
import { Reqly, TlWriter } from "../src/index.ts"
import { liveEnabled, session } from "./live-env.ts"

describe.skipIf(!liveEnabled || !session())("Telegram transport", () => {
  it("performs a raw RPC against help.getConfig", async () => {
    const client = await Reqly.connect(session(), { timeoutMs: 15000 })
    const reply = await client.invoke(new TlWriter().uint(0xc4f9186b).result())
    expect(reply.length).toBeGreaterThan(100)
  }, 30000)
})
// Mellouki Jamal — Asynctric
