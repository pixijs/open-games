import { expect, test, vi } from "vitest"

import { SFX, TRACKS } from "../src/art/sounds.ts"

// @pixi/sound needs a browser; these tests read only the lists.
vi.mock("@pixi/sound", () => ({ sound: {} }))

/** The names in `paths`, sorted: each file's name less `suffix`. */
const names = (paths: Record<string, unknown>, suffix: string) => Object.keys(paths).map((path) => path.slice(path.lastIndexOf("/") + 1, -suffix.length)).sort()

test("every sound effect has a file, and every file is a sound effect", () => {
  expect(names(import.meta.glob("../src/audio/sfx/*.wav", { query: "?url" }), ".wav")).toEqual([...SFX].sort())
})

test("every track has a file, and every file is a track", () => {
  expect(names(import.meta.glob("../src/audio/music/*.mp3", { query: "?url" }), ".mp3")).toEqual([...TRACKS].sort())
})
