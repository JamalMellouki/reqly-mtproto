import { describe, expect, it } from "vitest"
import { createFileResponse, parseByteRange, streamFileRange, type WorkerRangeOptions } from "../src/worker.ts"
import type { RemoteDocument, Reqly } from "../src/index.ts"

const document: RemoteDocument = {
  id: 42n,
  accessHash: 7n,
  fileReference: new Uint8Array([1, 2, 3]),
  size: 10000n,
}

function fakeClient(): Reqly {
  return {
    async getFile(_location: RemoteDocument, offset: number, limit: number): Promise<Uint8Array> {
      const end = Math.min(offset + limit, Number(document.size))
      const output = new Uint8Array(Math.max(0, end - offset))
      for (let index = 0; index < output.length; index += 1) output[index] = (offset + index) & 0xff
      return output
    },
    async getFilesParallel(
      location: RemoteDocument,
      ranges: ReadonlyArray<{ offset: number; limit: number }>,
      options: {
        fetch?: (range: { offset: number; limit: number }) => Promise<Uint8Array>
        onChunk?: (index: number, bytes: Uint8Array) => void
      } = {},
    ): Promise<Uint8Array[]> {
      const output: Uint8Array[] = []
      for (const range of ranges) {
        const chunk = options.fetch ? await options.fetch(range) : await this.getFile(location, range.offset, range.limit)
        output.push(chunk)
        options.onChunk?.(output.length - 1, chunk)
      }
      return output
    },
  } as unknown as Reqly
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value!)
    total += value!.length
  }
  const output = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    output.set(part, cursor)
    cursor += part.length
  }
  return output
}

describe("Workers range integration", () => {
  it("parses byte ranges", () => {
    expect(parseByteRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199 })
    expect(parseByteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 })
    expect(parseByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 })
    expect(parseByteRange("bytes=100-5000", 1000)).toEqual({ start: 100, end: 999 })
    expect(parseByteRange("bytes=0-1,3-4", 1000)).toBeUndefined()
    expect(parseByteRange("bytes=1000-", 1000)).toBeUndefined()
  })

  it("streams ordered blocks in 8-block batches", async () => {
    const options: WorkerRangeOptions = { blockSize: 1024, batchChunks: 8, cache: false, maxWorkers: 4 }
    const bytes = await collect(streamFileRange(fakeClient(), document, 100, 2500, options))
    expect(bytes).toHaveLength(2500)
    for (let index = 0; index < bytes.length; index += 1) expect(bytes[index]).toBe((100 + index) & 0xff)
  })

  it("closes when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = streamFileRange(fakeClient(), document, 0, 1000, {
      cache: false,
      signal: controller.signal,
    })
    const bytes = await Promise.race([
      collect(stream),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("stream did not close after abort")), 1000)
      }),
    ])
    expect(bytes).toHaveLength(0)
  })

  it("returns a 206 response with Content-Range and Accept-Ranges", async () => {
    const request = new Request("https://example.test/file", { headers: { Range: "bytes=100-199" } })
    const response = await createFileResponse(fakeClient(), document, request, {
      blockSize: 1024,
      batchChunks: 2,
      cache: false,
    })
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 100-199/10000")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("content-length")).toBe("100")
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(100)
  })

  it("returns 416 for an unsatisfiable range", async () => {
    const request = new Request("https://example.test/file", { headers: { Range: "bytes=99999-" } })
    const response = await createFileResponse(fakeClient(), document, request, { cache: false })
    expect(response.status).toBe(416)
    expect(response.headers.get("content-range")).toBe("bytes */10000")
  })

  it("returns headers only for HEAD", async () => {
    const request = new Request("https://example.test/file", { method: "HEAD", headers: { Range: "bytes=0-99" } })
    const response = await createFileResponse(fakeClient(), document, request, { cache: false })
    expect(response.status).toBe(206)
    expect(response.headers.get("content-length")).toBe("100")
  })
})
// Mellouki Jamal — Asynctric
