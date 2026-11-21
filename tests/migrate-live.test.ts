import { describe, expect, it } from "vitest"
import { Reqly, type RemoteDocument } from "../src/index.ts"
import { dcSessions, liveEnabled, session } from "./live-env.ts"

/** Set REQLY_MIGRATED_DOCUMENTS to a JSON array of document objects. */
function migratedDocuments(): RemoteDocument[] {
  const raw = process.env.REQLY_MIGRATED_DOCUMENTS
  if (!raw) return []
  try {
    return (JSON.parse(raw) as Array<{ id: string; accessHash: string; fileReference: string; size: string }>).map((item) => ({
      id: BigInt(item.id),
      accessHash: BigInt(item.accessHash),
      fileReference: Buffer.from(item.fileReference, "hex"),
      size: BigInt(item.size),
    }))
  } catch {
    return []
  }
}

const documents = migratedDocuments()

describe.skipIf(!liveEnabled || documents.length === 0)("cross-DC download guard", () => {
  it("downloads from migrated data centers using injected DC sessions", async () => {
    const dcs = dcSessions()
    expect(Object.keys(dcs).length).toBeGreaterThan(0)
    const client = await Reqly.connect(session(), { timeoutMs: 25000, dcSessions: dcs })
    for (const file of documents) {
      const bytes = await client.getFile(file, 0, 4096)
      expect(bytes.length).toBe(4096)
    }
    client.close()
  }, 240000)
})
// Mellouki Jamal — Asynctric
