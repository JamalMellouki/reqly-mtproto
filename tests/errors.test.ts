import { describe, expect, it } from "vitest"
import { FileMigrateError, FileReferenceExpiredError, RpcError, rpcError } from "../src/errors"

describe("structured RPC errors", () => {
  it("maps documented file errors to typed errors", () => {
    expect(rpcError(400, "FILE_REFERENCE_EXPIRED")).toBeInstanceOf(FileReferenceExpiredError)
    expect(rpcError(400, "FILE_REFERENCE_INVALID")).toBeInstanceOf(FileReferenceExpiredError)
    expect(rpcError(400, "FILE_MIGRATE_4")).toBeInstanceOf(FileMigrateError)
  })

  it("exposes the target datacenter for FILE_MIGRATE", () => {
    const error = rpcError(400, "FILE_MIGRATE_2") as FileMigrateError
    expect(error.dcId).toBe(2)
  })

  it("keeps unknown errors as generic RpcError", () => {
    const error = rpcError(420, "FLOOD_WAIT_10") as RpcError
    expect(error.code).toBe(420)
    expect(error.message).toBe("FLOOD_WAIT_10")
  })
})
// Mellouki Jamal — Asynctric
