import { describe, expect, it } from "vitest"
import { FloodWaitError, RpcError } from "../src/errors.ts"
import { DEFAULT_RETRY_POLICY, isRetryableError, retryDelayMs, withRetry } from "../src/retry.ts"

describe("retry policy", () => {
  it("classifies retryable and fatal errors", () => {
    expect(isRetryableError(new FloodWaitError(1))).toBe(true)
    expect(isRetryableError(new RpcError(500, "INTERNAL"))).toBe(true)
    expect(isRetryableError(new RpcError(429, "TOO_MANY_REQUESTS"))).toBe(true)
    expect(isRetryableError(new RpcError(400, "FILE_REFERENCE_EXPIRED"))).toBe(false)
    expect(isRetryableError(new Error("reqly: RPC timed out"))).toBe(true)
    expect(isRetryableError(new Error("fatal"))).toBe(false)
    expect(isRetryableError("not an error")).toBe(false)
  })

  it("retries transient failures and returns the eventual value", async () => {
    let calls = 0
    const value = await withRetry(async () => {
      calls += 1
      if (calls < 3) throw new Error("reqly: connection closed")
      return "ok"
    }, { retries: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 })
    expect(value).toBe("ok")
    expect(calls).toBe(3)
  })

  it("does not retry a fatal error", async () => {
    let calls = 0
    await expect(withRetry(async () => {
      calls += 1
      throw new Error("fatal")
    }, { retries: 5, baseDelayMs: 1 })).rejects.toThrow("fatal")
    expect(calls).toBe(1)
  })

  it("absorbs a flood wait when it is inside the cap", async () => {
    let calls = 0
    const value = await withRetry(async () => {
      calls += 1
      if (calls === 1) throw new FloodWaitError(2)
      return 42
    }, { retries: 1, baseDelayMs: 1, maxFloodWaitSeconds: 0 })
    expect(value).toBe(42)
    expect(calls).toBe(2)
  })

  it("stops before the first attempt when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    await expect(withRetry(async () => 1, { retries: 3, signal: controller.signal })).rejects.toThrow("stop")
  })

  it("bounds exponential delays and honours the flood cap", () => {
    expect(retryDelayMs(new Error("x"), 0, { ...DEFAULT_RETRY_POLICY, baseDelayMs: 100, jitter: 0 })).toBe(100)
    expect(retryDelayMs(new Error("x"), 10, {
      ...DEFAULT_RETRY_POLICY,
      baseDelayMs: 100,
      maxDelayMs: 500,
      jitter: 0,
    })).toBe(500)
    expect(retryDelayMs(new FloodWaitError(3), 0, {
      ...DEFAULT_RETRY_POLICY,
      respectFloodWait: true,
      maxFloodWaitSeconds: 60,
    })).toBe(4_000)
  })
})
// Mellouki Jamal — Asynctric
