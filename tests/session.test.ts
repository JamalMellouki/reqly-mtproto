import { describe, expect, it } from "vitest"
import { parseSession } from "../src/session.ts"
import { liveEnabled, session } from "./live-env.ts"

describe.skipIf(!liveEnabled || !session())("StringSession", () => {
  it("parses a gramJS-compatible session string", async () => {
    const parsed = await parseSession(session())
    expect(parsed.dcId).toBeGreaterThan(0)
    expect(parsed.address).toContain("telegram.org")
    expect(parsed.port).toBe(443)
    expect(parsed.authKey).toHaveLength(256)
    expect(parsed.authKeyId).not.toBe(0n)
  })
})
// Mellouki Jamal — Asynctric
