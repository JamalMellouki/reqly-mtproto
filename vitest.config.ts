import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: [{ find: "./aes-ige.wasm", replacement: new URL("./tests/wasm-stub.ts", import.meta.url).pathname }],
  },
  test: {
    // Live tests hit Telegram; parallel sockets cause intermittent timeouts.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
// Mellouki Jamal — Asynctric
