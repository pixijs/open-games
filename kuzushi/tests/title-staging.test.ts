import { describe, expect, test } from "vitest"

import { clashShot, DASH, dashAngle, FRAMING, HERO, heroShot, outOfShot, RING, ringPlace, wideShot } from "../src/title/staging.ts"
import type { Shot } from "../src/title/staging.ts"

const SHAPES = 7
/** A wide 2.1:1 window and a 16:9 one. */
const ASPECTS = [1680 / 800, 1280 / 720]

/** How many of the ring's shapes, at `radius`, `shot` keeps in frame `time` seconds in. */
const shown = (shot: Shot, radius: number, aspect: number, time = 0.2) =>
  Array.from({ length: SHAPES }, (_, index) => ringPlace(index, SHAPES)).filter(({ angle, lean }) =>
    !outOfShot(shot, time, FRAMING.menu, aspect, HERO.x + Math.cos(angle) * (radius + lean), HERO.z + Math.sin(angle) * (radius + lean))).length

describe("title shots", () => {
  test("the low hero shot leaves out every shape of the ring, which it would see edge-on as slabs", () => {
    for (const aspect of ASPECTS) {
      expect(shown(heroShot(), RING.wide, aspect)).toBe(0)
      expect(shown(heroShot(), RING.close, aspect)).toBe(0)
    }
  })

  test("the wide shot shows the whole ring closing", () => {
    for (const aspect of ASPECTS) expect(shown(wideShot(), RING.close, aspect)).toBe(SHAPES)
  })

  test("the clash shot keeps at least three shapes clear of the menu, on either side of the loop", () => {
    for (const side of [1, -1] as const) {
      for (const aspect of ASPECTS) expect(shown(clashShot(side), RING.close, aspect)).toBeGreaterThanOrEqual(3)
    }
  })

  test("the clash shot looks down on the dash's end from at least 25°, so the arrowhead reads as a shape", () => {
    for (const side of [1, -1] as const) {
      const shot = clashShot(side)
      const angle = dashAngle(side)
      const x = HERO.x + Math.cos(angle) * DASH - shot.to[0]
      const z = HERO.z + Math.sin(angle) * DASH - shot.to[2]
      expect((Math.atan2(shot.to[1], Math.hypot(x, z)) * 180) / Math.PI).toBeGreaterThan(25)
    }
  })
})
