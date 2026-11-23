/** Vitest alias for the Workers-only .wasm import. Node compiles from base64. */
import { EMBEDDED_WASM_BASE64 } from "../src/embedded-wasm"

const binary = Uint8Array.from(atob(EMBEDDED_WASM_BASE64), (character) => character.charCodeAt(0))
const module = new WebAssembly.Module(binary as unknown as BufferSource)
export default module
