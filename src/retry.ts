/**
 * Retry helpers for reqly RPC calls.
 *
 * The core client already retries transport failures inside its connection
 * loop, and the parallel reader retries individual blocks. Applications still
 * need a consistent policy around higher-level operations such as
 * `sdk.hashes()` or a custom TL call. This module provides one small,
 * dependency-free implementation.
 *
 * ```ts
 * import { withRetry } from "reqlyproto"
 *
 * const reply = await withRetry(() => client.invoke(bytes), { retries: 3 })
 * ```
 *
 * Copyright (c) 2026 Mellouki Jamal, Asynctric.
 * Licensed under ASYNCTRIC-3.0. Author and platform identity must be preserved.
 */

import { FloodWaitError, RpcError } from "./errors"

/** Tunable retry behaviour. All fields are optional in public APIs. */
export interface RetryPolicy {
  /** Additional attempts after the first failure. Default 2. */
  retries: number
  /** Base delay for exponential backoff, in milliseconds. Default 150. */
  baseDelayMs: number
  /** Upper bound for one backoff delay, in milliseconds. Default 4000. */
  maxDelayMs: number
  /** Random ±ratio applied to a backoff delay. Default 0.2 (±20%). */
  jitter: number
  /** Wait out small `FLOOD_WAIT_X` errors instead of failing. Default true. */
  respectFloodWait: boolean
  /** Longest flood wait, in seconds, that will be absorbed. Default 60. */
  maxFloodWaitSeconds: number
  /** Cancels pending waits and stops further attempts. */
  signal?: AbortSignal
}

/** Balanced defaults for read-only MTProto work. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 2,
  baseDelayMs: 150,
  maxDelayMs: 4_000,
  jitter: 0.2,
  respectFloodWait: true,
  maxFloodWaitSeconds: 60,
}

/**
 * Wire failures the client already treats as transient. Kept in sync with the
 * transport messages in `client.ts`; matching is prefix-based so a wrapped
 * message still qualifies.
 */
const TRANSIENT_MESSAGES = [
  "reqly: RPC timed out",
  "reqly: connection closed",
  "reqly: websocket failed",
  "reqly: unexpected auth key id",
  "reqly: message key mismatch",
  "reqly: session mismatch",
  "reqly: invalid abridged frame",
  "reqly: Telegram rejected the request",
]

/**
 * Returns `true` when repeating the same call can plausibly succeed.
 *
 * File-specific errors (`FILE_REFERENCE_EXPIRED`, `FILE_MIGRATE_X`) are not
 * blindly retryable: they need a refreshed reference or a different DC, and
 * the client handles both with explicit flows.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof FloodWaitError) return true
  if (error instanceof RpcError) return error.code === 429 || error.code >= 500
  if (!(error instanceof Error)) return false
  return TRANSIENT_MESSAGES.some((message) => error.message.startsWith(message))
}

/** Computes the delay before the next attempt. `attempt` starts at 0. */
export function retryDelayMs(error: unknown, attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  if (error instanceof FloodWaitError && policy.respectFloodWait) {
    return Math.min(policy.maxFloodWaitSeconds, Math.max(0, error.seconds) + 1) * 1_000
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt))
  const spread = exponential * Math.max(0, policy.jitter)
  const jitter = spread === 0 ? 0 : (Math.random() * 2 - 1) * spread
  return Math.max(0, Math.round(exponential + jitter))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("reqly: retry aborted"))
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("reqly: retry aborted"))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Runs `task`, retrying only errors classified as transient.
 *
 * The policy is resolved once, so callers can pass a partial object:
 *
 * ```ts
 * await withRetry(() => sdk.hashes(document), { retries: 4 })
 * ```
 *
 * @param task - Function invoked on every attempt.
 * @param policy - Overrides for {@link DEFAULT_RETRY_POLICY}.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
): Promise<T> {
  const resolved: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy }
  const retries = Math.max(0, Math.floor(resolved.retries))
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (resolved.signal?.aborted) throw resolved.signal.reason ?? new Error("reqly: retry aborted")
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      if (!isRetryableError(error)) throw error
      await sleep(retryDelayMs(error, attempt, resolved), resolved.signal)
    }
  }
  throw lastError ?? new Error("reqly: retry failed")
}
// Mellouki Jamal — Asynctric
