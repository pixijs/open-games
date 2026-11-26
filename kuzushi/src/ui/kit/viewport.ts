import { clamp } from "math"

import { NARROW_WIDTH } from "../../art/title-cues.ts"

/** The screen as Pixi screens lay out on it, in CSS pixels. */
export interface Viewport {
  readonly width: number
  readonly height: number
  /** Where every edge sits: 2.8% of the width, from 16 to 48 px. */
  readonly margin: number
  /** The type scale against the 1680x800 window, from 0.75 to 1.35 in steps of 0.05. */
  readonly scale: number
  /** Too narrow for a screen's side-by-side layout: it stacks. */
  readonly narrow: boolean
  /** Canvas pixels per CSS pixel. */
  readonly resolution: number
}

export const viewportOf = (width: number, height: number, resolution: number): Viewport => ({
  width,
  height,
  margin: clamp(0.028 * width, 16, 48),
  scale: Math.round(clamp(Math.min(width / 1680, height / 800), 0.75, 1.35) * 20) / 20,
  narrow: width < NARROW_WIDTH,
  resolution
})
