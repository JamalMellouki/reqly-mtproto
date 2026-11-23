/** Workers-only WASM bootstrap. Wrangler precompiles the .wasm import. */
import wasmModule from "./aes-ige.wasm"
import { installWasmModule } from "./wasm-engine"

installWasmModule(wasmModule)
