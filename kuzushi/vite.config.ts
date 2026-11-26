import { defineConfig } from "vite"

export default defineConfig({
  // Relative, so the build runs from any folder on any static host.
  base: "./",
  server: { port: 5352, strictPort: true, allowedHosts: [".trycloudflare.com"] },
  preview: { port: 5353, strictPort: true },
  build: { sourcemap: false },
})
