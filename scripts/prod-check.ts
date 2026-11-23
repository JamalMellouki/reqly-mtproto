import { readFile } from "node:fs/promises"
import { Reqly } from "../src/index.ts"
const envPath = process.env.REQLY_ENV_FILE ?? "/public/stream bots/.env"
const env = await readFile(envPath, "utf8")
const v = (k: string) => new RegExp(`^${k}=(.+)$`, "m").exec(env)?.[1]?.trim() ?? ""
const client = await Reqly.connect(v("MTPROTO_SESSION"), { timeoutMs: 25000 })
try {
  const docs = await client.getMessages(4481677417n, 6182339367879685909n, [1950])
  console.log("docs", docs.length, docs[0]?.id?.toString())
} catch (e) {
  console.log("ERR", e instanceof Error ? e.message : e)
}
client.close()
process.exit(0)
