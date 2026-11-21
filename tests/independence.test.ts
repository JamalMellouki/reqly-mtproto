import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

/**
 * reqly must remain self-contained: no runtime dependency on any other
 * MTProto library. Scripts may use other tools only during one-time setup,
 * but the shipped library and its generated sessions must not.
 */
describe("library independence", () => {
  it("has no runtime dependencies", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(packageJson.dependencies ?? {}).toEqual({})
  })

  it("never imports teleproto in shipped source", async () => {
    const { readdir } = await import("node:fs/promises")
    const files = (await readdir(new URL("../src", import.meta.url))).filter((name) => name.endsWith(".ts"))
    for (const file of files) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8")
      expect(source.toLowerCase()).not.toContain("teleproto")
    }
  })
})
// Mellouki Jamal — Asynctric
