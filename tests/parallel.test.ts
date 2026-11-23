import { describe, expect, it } from "vitest"
import { Reqly } from "../src/client.ts"
import type { RemoteDocument } from "../src/tl.ts"

const document: RemoteDocument = {
  id: 42n,
  accessHash: 7n,
  fileReference: new Uint8Array([1, 2, 3]),
  size: 1024n * 1024n,
}

describe("getFilesParallel cancellation", () => {
  it("stops scheduling new ranges after a fatal peer error", async () => {
    let calls = 0
    const ranges = Array.from({ length: 8 }, (_, index) => ({
      offset: index * 4096,
      limit: 4096,
    }))
    const fetch = async (range: { offset: number; limit: number }, index: number): Promise<Uint8Array> => {
      calls += 1
      if (index === 0) throw new Error("fatal")
      await new Promise((resolve) => setTimeout(resolve, 20))
      return new Uint8Array(range.limit)
    }

    await expect(
      Reqly.prototype.getFilesParallel.call({} as Reqly, document, ranges, {
        fetch,
        minWorkers: 2,
        maxWorkers: 2,
      }),
    ).rejects.toThrow("fatal")

    // Worker 0 fails immediately; worker 1 may finish its one in-flight range,
    // but it must not pick up the six ranges still waiting in the queue.
    expect(calls).toBe(2)
  })
})
