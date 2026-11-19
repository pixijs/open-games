import { defineConfig } from "vite";
import { colyseus } from "colyseus/vite";

export default defineConfig(({ mode }) => ({
  // the standalone client (Wavedash) may not be served from the domain root
  base: mode === "client" ? "./" : "/",
  build: { outDir: "dist/client" },
  plugins: [
    // The plugin declares a second build environment (dist/server), so every
    // `vite build` builds both halves. `--mode client` drops it when you only
    // want the static client — e.g. deploying it separately from the server.
    // That mode also swaps which .env.* file Vite loads: .env.client, not
    // .env.production. Only matters once you add a VITE_-prefixed var.
    ...(mode === "client" ? [] : [colyseus({ serverEntry: "/src/app.config.ts" })]),
  ],
}));
