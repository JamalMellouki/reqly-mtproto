import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Live tests hit Telegram; parallel sockets cause intermittent timeouts.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
// Mellouki Jamal — Asynctric
