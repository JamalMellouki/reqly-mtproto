import { describe, expect, it } from "vitest"
import { createStreamToken, verifyStreamToken } from "../src/token.ts"

const secret = "test-secret"
const payload = { m: 42, w: "work-1", k: "stream" as const }

describe("stream tokens", () => {
  it("round-trips a signed payload", async () => {
    const token = await createStreamToken(secret, payload)
    expect(await verifyStreamToken(secret, token)).toMatchObject(payload)
  })

  it("rejects malformed signatures without throwing", async () => {
    const token = await createStreamToken(secret, payload)
    const body = token.split(".")[0]!
    await expect(verifyStreamToken(secret, `${body}.%%%`)).resolves.toBeNull()
    await expect(verifyStreamToken(secret, `${body}.`)).resolves.toBeNull()
    await expect(verifyStreamToken(secret, "not-a-token")).resolves.toBeNull()
  })

  it("rejects a tampered payload and the wrong secret", async () => {
    const token = await createStreamToken(secret, payload)
    const [body, signature] = token.split(".")
    const first = body![0] === "A" ? "B" : "A"
    const tampered = `${first}${body!.slice(1)}.${signature}`
    await expect(verifyStreamToken(secret, tampered)).resolves.toBeNull()
    await expect(verifyStreamToken("other-secret", token)).resolves.toBeNull()
  })
})
