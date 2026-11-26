import { defineConfig } from "vitest/config"

/** The generator and determinism tests take a second or two alone; a loaded machine can take several times that. */
export default defineConfig({ test: { testTimeout: 20_000 } })
