/**
 * Structured Telegram RPC errors.
 *
 * The named codes come from core.telegram.org/api/errors and the file download
 * section of core.telegram.org/api/files. Keeping them typed lets callers react
 * without string matching on English messages.
 *
 * @example
 * ```ts
 * try {
 *   await client.getFile(doc, 0, 1024)
 * } catch (error) {
 *   if (error instanceof FileReferenceExpiredError) {
 *     await refreshSession()
 *   } else if (error instanceof FileMigrateError) {
 *     await switchToDC(error.dcId)
 *   } else if (error instanceof FloodWaitError) {
 *     await sleep(error.seconds * 1000)
 *   }
 * }
 * ```
 */

/**
 * Base class for all Telegram RPC errors returned by reqly.
 */
export class RpcError extends Error {
  constructor(
    /** The numeric error code returned by Telegram. */
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = "RpcError"
  }
}

/**
 * The file reference used in `upload.getFile` has expired.
 * Callers should refresh the file reference and retry.
 */
export class FileReferenceExpiredError extends RpcError {
  constructor() {
    super(400, "FILE_REFERENCE_EXPIRED")
    this.name = "FileReferenceExpiredError"
  }
}

/**
 * The file is stored on a different data center.
 * Callers should switch their session to the target DC and retry.
 */
export class FileMigrateError extends RpcError {
  /**
   * @param dcId - The target data center ID to migrate to.
   */
  constructor(readonly dcId: number) {
    super(400, `FILE_MIGRATE_${dcId}`)
    this.name = "FileMigrateError"
  }
}

/**
 * The file is served from a Telegram CDN. The caller can use the token and
 * key material to download with `upload.getCdnFile` + AES-256-CTR, or fall back
 * to the master DC by retrying with `cdnSupported` disabled.
 */
export class CdnRedirectError extends RpcError {
  constructor(readonly redirect: {
    dcId: number
    fileToken: Uint8Array
    encryptionKey: Uint8Array
    encryptionIv: Uint8Array
  }) {
    super(200, "FILE_CDN_REDIRECT")
    this.name = "CdnRedirectError"
  }
}

/**
 * Telegram rate-limit error; callers should wait `seconds` before retrying.
 */
export class FloodWaitError extends RpcError {
  /**
   * @param seconds - Number of seconds to wait before retrying.
   */
  constructor(readonly seconds: number) {
    super(420, `FLOOD_WAIT_${seconds}`)
    this.name = "FloodWaitError"
  }
}

/**
 * Parses a raw Telegram error response into a structured error instance.
 *
 * Maps known error message patterns (`FILE_REFERENCE_EXPIRED`,
 * `FILE_MIGRATE_*`, `FLOOD_WAIT_*`) to their typed classes. All other errors
 * are returned as a generic {@link RpcError}.
 *
 * @param code - The numeric error code from Telegram.
 * @param message - The error message string from Telegram.
 * @returns A structured error instance.
 */
export function rpcError(code: number, message: string): Error {
  if (message === "FILE_REFERENCE_EXPIRED" || message === "FILE_REFERENCE_INVALID") return new FileReferenceExpiredError()
  const migrate = /^(?:FILE|USER)_MIGRATE_(\d+)$/.exec(message)
  if (migrate) return new FileMigrateError(Number(migrate[1]))
  const flood = /^FLOOD(?:_PREMIUM)?_WAIT_(\d+)$/.exec(message)
  if (flood) return new FloodWaitError(Number(flood[1]))
  return new RpcError(code, message)
}
