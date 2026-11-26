import { describe, expect, test } from "vitest"

import { PALETTE, paletteOf } from "../src/art/palette.ts"
import { repaintOf, TONE_STOPS, tonesOf } from "../src/look/tones.ts"
import { zoneIds } from "../src/sim/index.ts"

const rgb = (color: number) => [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255] as const
const LUMA = [0.2126, 0.7152, 0.0722] as const
const luma = (c: ReadonlyArray<number>) => (c[0] ?? 0) * LUMA[0] + (c[1] ?? 0) * LUMA[1] + (c[2] ?? 0) * LUMA[2]

/** The grade's repaint, as the shader does it, for a colour `c` that is all in the repainted hue. */
const repainted = (c: ReadonlyArray<number>, accent: number): ReadonlyArray<number> => {
  const r = repaintOf(accent)
  const y = luma(c)
  const d = c.map((channel) => channel - y)
  const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)
  const a = dot(d, r.u)
  const b = dot(d, r.v)
  const share = Math.min(1, Math.hypot(a, b) / r.reach)
  const x = r.stretch * (a * r.cos - b * r.sin)
  const z = r.stretch * (a * r.sin + b * r.cos)
  return [0, 1, 2].map((index) => y + share * r.lift + x * (r.u[index] ?? 0) + z * (r.v[index] ?? 0))
}

describe("the zones' grade", () => {
  test("the Courtyard's ramp is the plain ink-to-paper one, so the title and the Courtyard keep their look", () => {
    const ink = rgb(PALETTE.ink)
    const paper = rgb(PALETTE.paper)
    tonesOf("courtyard").forEach((tone, index) => {
      const stop = TONE_STOPS[index] ?? 0
      tone.forEach((channel, at) => expect(channel).toBeCloseTo((ink[at] ?? 0) + ((paper[at] ?? 0) - (ink[at] ?? 0)) * stop, 6))
    })
  })

  test("every other zone's ramp runs through its own tokens, darkest to lightest", () => {
    for (const zone of zoneIds.filter((each) => each !== "courtyard")) {
      const colors = paletteOf(zone)
      const tones = tonesOf(zone)
      expect(tones).toEqual([colors.ink, colors.groundDark, colors.ground, colors.groundLight, colors.light, colors.paper].map(rgb))
      const lightness = tones.map(luma)
      expect([...lightness].sort((a, b) => a - b)).toEqual(lightness)
    }
  })

  test("the Courtyard's red repaints as each zone's accent, a half-strength red as half the accent", () => {
    for (const zone of zoneIds) {
      const accent = rgb(paletteOf(zone).danger)
      repainted(rgb(PALETTE.red), paletteOf(zone).danger).forEach((channel, index) => expect(channel).toBeCloseTo(accent[index] ?? 0, 5))
      repainted(rgb(PALETTE.red).map((channel) => channel * 0.5), paletteOf(zone).danger).forEach((channel, index) => expect(channel).toBeCloseTo((accent[index] ?? 0) * 0.5, 5))
    }
  })
})
