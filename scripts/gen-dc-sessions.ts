/**
 * Generates one fully-authorized MTProto session per data center using ONLY
 * reqly — no third-party MTProto library. The expensive RSA/DH arithmetic runs
 * here in Node, never in a Worker. Emits DCn_SESSION=... lines for the store.
 *
 * For each DC:
 *   1. plaintext DH handshake (req_pq_multi → req_DH_params → set_client_DH_params)
 *   2. serialize the fresh auth_key into a gramJS-compatible StringSession
 *   3. export the bot authorization from the home DC and import it on the new
 *      DC with the fresh key (a key is useless until it is authorized there)
 */

import { connect as netConnect, type Socket } from "node:net"
import { randomBytes } from "node:crypto"
import {
  reqPqEnvelope,
  parseResPq,
  factorPq,
  pqInnerDataDc,
  reqDhParamsEnvelope,
  parseServerDhParamsOk,
  parseServerDhInnerData,
  clientDhInnerData,
  setClientDhParamsEnvelope,
  parseDhGenResult,
  bigIntBytes,
  rsaPad,
  findTelegramKey,
  temporaryAes,
  decryptServerDh,
  encryptClientDh,
  computeAuthKey,
  modPow,
  Reqly,
  MessageIds,
  TlWriter,
  TlReader,
  IDs,
} from "../src/index.ts"

/**
 * Provide the home session via REQLY_SESSION (recommended) or as the first CLI
 * argument. Per-DC sessions are printed as KEY=VALUE lines on stderr.
 */
const homeSession = process.argv[2] ?? process.env.REQLY_SESSION ?? ""
if (!homeSession) {
  console.error("Usage: REQLY_SESSION=<session string> tsx scripts/gen-dc-sessions.ts")
  process.exit(1)
}

/** Hostnames the Worker's WebSocket connects to (session address). */
const DC_HOSTS: Record<number, string> = {
  1: "pluto.web.telegram.org",
  2: "venus.web.telegram.org",
  3: "aurora.web.telegram.org",
  4: "vesta.web.telegram.org",
  5: "flora.web.telegram.org",
}

/** Canonical raw-TCP DC addresses for the plaintext handshake in Node. */
const HANDSHAKE_HOSTS: Record<number, string> = {
  1: "149.154.175.50",
  2: "149.154.167.51",
  3: "149.154.175.100",
  4: "149.154.167.91",
  5: "91.108.56.100",
}

/** Abridged TCP framing: 0xef once, then [length/4] + frame for each packet. */
class AbridgedConnection {
  private buffer = Buffer.alloc(0)
  private first = true
  private waiting: Array<(frame: Buffer) => void> = []

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
  }

  static async open(host: string, port: number): Promise<AbridgedConnection> {
    const socket = netConnect(port, host)
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    return new AbridgedConnection(socket)
  }

  close(): void {
    this.socket.end()
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 1) return
      const head = this.buffer[0]!
      let headerLength: number
      let length: number
      if (head === 0x7f) {
        if (this.buffer.length < 4) return
        headerLength = 4
        length = this.buffer.readUIntLE(1, 3) * 4
      } else {
        headerLength = 1
        length = head * 4
      }
      if (this.buffer.length < headerLength + length) return
      const frame = Buffer.from(this.buffer.subarray(headerLength, headerLength + length))
      this.buffer = this.buffer.subarray(headerLength + length)
      this.waiting.shift()?.(frame)
    }
  }

  send(frame: Uint8Array): void {
    const words = Math.floor(frame.length / 4)
    if (frame.length % 4 !== 0) throw new Error("reqly: handshake frame is not word aligned")
    let header: Buffer
    if (this.first) {
      this.first = false
      header = Buffer.from([0xef, words])
    } else if (words < 127) {
      header = Buffer.from([words])
    } else {
      const extended = Buffer.alloc(4)
      extended[0] = 0x7f
      extended.writeUIntLE(words, 1, 3)
      header = extended
    }
    this.socket.write(Buffer.concat([header, Buffer.from(frame)]))
  }

  receive(timeoutMs = 20000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reqly: handshake step timed out")), timeoutMs)
      this.waiting.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
      this.drain()
    })
  }
}

async function request(connection: AbridgedConnection, frame: Uint8Array): Promise<Uint8Array> {
  const pending = connection.receive()
  connection.send(frame)
  return pending
}

/** Runs the full plaintext auth-key exchange and returns the 256-byte key. */
async function handshake(dcId: number, host: string): Promise<Uint8Array> {
  const ids = new MessageIds()
  const connection = await AbridgedConnection.open(host, 443)
  try {
    const nonce = new Uint8Array(randomBytes(16))
    const resFrame = await request(connection, reqPqEnvelope(nonce, ids.next()))
    const res = parseResPq(resFrame)
    if (!equalBytes(res.nonce, nonce)) throw new Error("reqly: resPQ nonce mismatch")
    const { p, q } = factorPq(res.pq)

    let key
    for (const fingerprint of res.fingerprints) {
      key = await findTelegramKey(fingerprint)
      if (key) break
    }
    if (!key) throw new Error(`reqly: no known RSA key among ${res.fingerprints.map((f) => f.toString()).join(", ")}`)

    const newNonce = new Uint8Array(randomBytes(32))
    const inner = pqInnerDataDc(bigIntBytes(res.pq), bigIntBytes(p), bigIntBytes(q), res.nonce, res.serverNonce, newNonce, dcId)
    const encryptedData = await rsaPad(inner, key)
    const dhFrame = await request(
      connection,
      reqDhParamsEnvelope(res.nonce, res.serverNonce, bigIntBytes(p), bigIntBytes(q), key.fingerprint, encryptedData, ids.next()),
    )
    const ok = parseServerDhParamsOk(dhFrame)
    if (!equalBytes(ok.nonce, res.nonce) || !equalBytes(ok.serverNonce, res.serverNonce)) {
      throw new Error("reqly: server_DH_params_ok nonce mismatch")
    }

    const temporary = await temporaryAes(newNonce, res.serverNonce)
    const answer = await decryptServerDh(ok.encryptedAnswer, temporary.key, temporary.iv)
    const innerData = parseServerDhInnerData(answer)

    const b = bytesToBigInt(new Uint8Array(randomBytes(256)))
    if (b === 0n) throw new Error("reqly: invalid DH secret")
    const gB = modPow(BigInt(innerData.g), b, innerData.prime)
    const authKey = computeAuthKey(innerData.gA, b, innerData.prime)
    const clientInner = clientDhInnerData(res.nonce, res.serverNonce, 0n, gB)
    const encryptedClient = await encryptClientDh(clientInner, temporary.key, temporary.iv)
    const finalFrame = await request(connection, setClientDhParamsEnvelope(res.nonce, res.serverNonce, encryptedClient, ids.next()))
    const generated = parseDhGenResult(finalFrame)
    if (generated.kind !== "ok") throw new Error(`reqly: DH generation ${generated.kind}`)
    if (!equalBytes(generated.value.nonce, res.nonce)) throw new Error("reqly: dh_gen_ok nonce mismatch")
    return authKey
  } finally {
    connection.close()
  }
}

function encodeSession(dcId: number, address: string, port: number, authKey: Uint8Array): string {
  const addressBytes = new TextEncoder().encode(address)
  const raw = new Uint8Array(1 + 2 + addressBytes.length + 2 + 256)
  const view = new DataView(raw.buffer)
  raw[0] = dcId
  view.setUint16(1, addressBytes.length, false)
  raw.set(addressBytes, 3)
  view.setUint16(3 + addressBytes.length, port, false)
  raw.set(authKey, 5 + addressBytes.length)
  return `1${Buffer.from(raw).toString("base64")}`
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

/** Exports the home DC's authorization and imports it on the fresh DC key. */
async function authorize(dcId: number, sessionString: string): Promise<void> {
  const home = await Reqly.connect(homeSession, { timeoutMs: 30000 })
  const exportMethod = new TlWriter().uint(IDs.exportAuthorization).int(dcId).result()
  const exportedRaw = await home.invoke(exportMethod)
  const exported = new TlReader(exportedRaw)
  const constructor = exported.uint()
  if (constructor !== 0xdf969c2d && constructor !== IDs.importedAuthorization) {
    throw new Error(`reqly: unexpected exportAuthorization reply 0x${constructor.toString(16)}`)
  }
  const authId = exported.long()
  const authBytes = exported.bytes()

  const target = await Reqly.connect(sessionString, { timeoutMs: 30000 })
  const importMethod = new TlWriter().uint(IDs.importAuthorization).long(authId).bytes(authBytes).result()
  const importedRaw = await target.invoke(importMethod)
  const imported = new TlReader(importedRaw)
  const resultConstructor = imported.uint()
  if (resultConstructor === IDs.rpcError) throw new Error(`reqly: importAuthorization failed 0x${resultConstructor.toString(16)}`)
}

async function withRetry<T>(action: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError
}

const generated: Record<number, string> = {}
for (const dcId of [1, 2, 3]) {
  const rawHost = HANDSHAKE_HOSTS[dcId]!
  try {
    const authKey = await withRetry(() => handshake(dcId, rawHost))
    const sessionString = encodeSession(dcId, DC_HOSTS[dcId]!, 443, authKey)
    await withRetry(() => authorize(dcId, sessionString))
    generated[dcId] = sessionString
    console.error(`DC${dcId}_SESSION=${sessionString}`)
  } catch (error) {
    console.error(`DC${dcId}_ERROR=${error instanceof Error ? error.message : String(error)}`)
  }
}
