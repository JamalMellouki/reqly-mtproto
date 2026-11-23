/**
 * Embedded AES-256-IGE WebAssembly engine.
 *
 * The binary is generated at build time from scripts/aes-ige.wat and stored in
 * src/embedded-wasm.ts. Nothing is loaded from disk, the network, or the host
 * application at runtime. Cloudflare Workers can compile this 1.6 KB module
 * synchronously, so the public encrypt/decrypt API stays synchronous.
 */

import { EMBEDDED_WASM_BASE64 } from "./embedded-wasm"
import { internalTables } from "./crypto"

const DATA = 0x0a00

function decodeBase64(value: string): Uint8Array {
  const binary = typeof atob === "function" ? atob(value) : Buffer.from(value, "base64").toString("binary")
  const output = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index) & 0xff
  return output
}

let instance: WebAssembly.Instance | undefined
let memory: WebAssembly.Memory | undefined
let igeFn: ((ptr: number, len: number, decrypt: number) => void) | undefined
let installedModule: WebAssembly.Module | undefined
let tableReference: ReturnType<typeof internalTables> | undefined

/**
 * Installs a precompiled module. Cloudflare Workers forbid compiling Wasm from
 * bytes at runtime, so the Worker build passes Wrangler's bundled `.wasm`
 * import here. Node keeps using the embedded base64 fallback.
 */
export function installWasmModule(module: WebAssembly.Module): void {
  installedModule = module
  instance = undefined
  memory = undefined
  igeFn = undefined
}

function ensureInstance(): { memory: WebAssembly.Memory; ige: (ptr: number, len: number, decrypt: number) => void } {
  if (instance && memory && igeFn) return { memory, ige: igeFn }
  if (!installedModule) {
    const binary = decodeBase64(EMBEDDED_WASM_BASE64)
    installedModule = new WebAssembly.Module(binary as unknown as BufferSource)
  }
  instance = new WebAssembly.Instance(installedModule, {})
  memory = instance.exports.memory as WebAssembly.Memory
  igeFn = instance.exports.ige as (ptr: number, len: number, decrypt: number) => void

  const tables = internalTables()
  tableReference = tables
  const view = new Uint8Array(memory.buffer)
  view.set(tables.forward, 0x0000)
  view.set(tables.inverse, 0x0100)
  view.set(tables.gf2, 0x0200)
  view.set(tables.gf3, 0x0300)
  view.set(tables.gf9, 0x0400)
  view.set(tables.gf11, 0x0500)
  view.set(tables.gf13, 0x0600)
  view.set(tables.gf14, 0x0700)
  return { memory, ige: igeFn }
}

/** In-place AES-256-IGE using the embedded WASM module. */
export function wasmIge(data: Uint8Array, key: Uint8Array, iv: Uint8Array, decrypting: boolean): Uint8Array {
  if (data.length % 16 !== 0) throw new Error("reqly: IGE input must be block aligned")
  if (key.length !== 32 || iv.length !== 32) throw new Error("reqly: invalid IGE key/iv length")

  const { memory: mem, ige } = ensureInstance()
  const neededPages = Math.ceil((DATA + data.length) / 65536)
  const currentPages = mem.buffer.byteLength / 65536
  if (neededPages > currentPages) mem.grow(neededPages - currentPages)

  const view = new Uint8Array(mem.buffer)
  const words = (tableReference ?? internalTables()).expandKey(key)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? 0
    const offset = 0x0800 + index * 4
    view[offset] = (word >>> 24) & 0xff
    view[offset + 1] = (word >>> 16) & 0xff
    view[offset + 2] = (word >>> 8) & 0xff
    view[offset + 3] = word & 0xff
  }
  view.set(iv.subarray(0, 16), 0x0920)
  view.set(iv.subarray(16, 32), 0x0930)
  view.set(data, DATA)
  ige(DATA, data.length, decrypting ? 1 : 0)
  return view.slice(DATA, DATA + data.length)
}
