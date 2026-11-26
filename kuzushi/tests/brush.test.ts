import { describe, expect, it } from "vitest"

import { brushStroke } from "../src/ui/brush.ts"

describe("brushStroke", () => {
  it("draws the same stroke for the same seed, with one outline per bristle after the body", () => {
    const options = { width: 12, seed: 4, dry: 0.4, bristles: 5 }
    const stroke = brushStroke([[0, 0], [50, 10], [100, 0]], options)
    expect(stroke.shapes).toHaveLength(6)
    expect(brushStroke([[0, 0], [50, 10], [100, 0]], options)).toEqual(stroke)
    expect(stroke.shapes.every((d) => d.startsWith("M") && d.endsWith("Z") && !d.includes("NaN"))).toBe(true)
  })

  it("draws a wet stroke as a single outline", () => {
    expect(brushStroke([[0, 0], [100, 0]], { width: 4, seed: 1, dry: 0 }).shapes).toHaveLength(1)
  })

  it("winds every outline the same way, so its ink fills where the bristles overlap the body once, not as a hole", () => {
    const signedArea = (d: string) => {
      const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
      let area = 0
      for (let i = 0; i < numbers.length; i += 2) {
        const j = (i + 2) % numbers.length
        area += (numbers[i] ?? 0) * (numbers[j + 1] ?? 0) - (numbers[j] ?? 0) * (numbers[i + 1] ?? 0)
      }
      return area
    }
    const stroke = brushStroke([[0, 20], [150, 18], [300, 20]], { width: 38, seed: 7, start: 0.97, dry: 0.42, bristles: 12, rough: 0.035 })
    expect(stroke.ink).toBe(stroke.shapes.join(""))
    expect(new Set(stroke.shapes.map((d) => Math.sign(signedArea(d)))).size).toBe(1)
  })
})
