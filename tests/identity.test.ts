import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { author, platform, version } from "../src/index.ts"

/** The open-source license requires preserving author and platform identity. */
describe("project identity", () => {
  it("keeps the verified identity and version", () => {
    expect(author).toBe("Mellouki Jamal")
    expect(platform).toBe("Asynctric")
    expect(version).toBe("1.0.0")
  })

  it("keeps the package name and short alias", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string
      displayName: string
      license: string
    }
    expect(packageJson.name).toBe("reqlyproto")
    expect(packageJson.displayName).toBe("reqly")
    expect(packageJson.license).toBe("ASYNCTRIC-1.0")
  })

  it("keeps third-party attribution", async () => {
    const notices = await readFile(new URL("../THIRD_PARTY_NOTICES", import.meta.url), "utf8")
    expect(notices).toContain("mtproto-workers")
    expect(notices).toContain("cifrante")
    expect(notices).toContain("Mellouki Jamal")
  })
})
// Mellouki Jamal — Asynctric
