import { defineConfig } from 'vite';

import { colyseusShims } from './src/net/shims/plugin.ts';

export default defineConfig({
  // Relative, so the build runs from any folder on any static host.
  base: './',
  // The party's Colyseus room runs in the host's tab, so its Node imports need browser stand-ins.
  plugins: [colyseusShims()],
  server: {
    port: 5350,
    strictPort: true,
    // Cloudflare quick tunnels, for trying it on a phone over HTTPS.
    allowedHosts: ['.trycloudflare.com'],
  },
  preview: {
    port: 5351,
    strictPort: true,
  },
  // The bots' line workers are modules (`new Worker(url, { type: 'module' })`), so they build as modules too.
  worker: {
    format: 'es',
  },
  build: {
    sourcemap: false,
    // The language the engine is published in.
    target: 'es2022',
    assetsDir: 'assets',
  },
});
