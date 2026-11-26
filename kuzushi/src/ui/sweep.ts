import { gsap } from "gsap"
import { mulberry32 } from "math/random"
import { AlphaFilter, BlurFilter, Container, Graphics, GraphicsContext, SmoothGraphics } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { settings } from "../art/settings.ts"
import type { FlashLevel } from "../art/settings.ts"
import type { Accent } from "./accent.ts"
import { brushStroke } from "./brush.ts"
import type { Point } from "./brush.ts"
import { inkContext, spineReveal } from "./kit/ink.ts"
import { drawn, ON_ONES } from "./motion.ts"
import type { Staged } from "./screen.ts"

/** How bright the cut's one white frame is for each impact-flash setting. */
const FLASH = { full: 0.7, reduced: 0.18, off: 0 } as const satisfies Record<FlashLevel, number>

/** The slash's curve as shares of the screen: a quadratic from its start through its bow to its end. */
export const SLASH_PATH = { from: [-0.06, 0.92], bow: [0.56, 0.6], to: [1.06, 0.06] } as const

/** One axis of the quadratic Bézier from `a` through control `b` to `c`, at `t`. */
export const quadratic = (a: number, b: number, c: number, t: number): number => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c

export interface Sweep extends Staged {
  /** Cuts across the screen in `accent`; `seed` picks the brush. Cuts may overlap; each takes itself down when done. */
  cut(seed: number, accent: Accent): gsap.core.Timeline
  /** Recolours the cuts on screen, as the zone's accent changes under them. */
  tint(accent: Accent): void
}

/**
 * The cut between screens: a screen-wide crescent slash from bottom-left to top-right, a white-hot core in accent
 * edges with shard lines riding beside it and a glow, drawn on along its spine, one impact frame, then torn away
 * along its own path.
 */
export const createSweep = (): Sweep => {
  const node = new Container({ label: "sweep" })
  let size = { width: 1, height: 1 }
  /** The accent pieces of each cut on screen. */
  const live = new Set<{ readonly red: SmoothGraphics; readonly glow: SmoothGraphics }>()
  const running = new Set<gsap.core.Timeline>()

  const cut = (seed: number, accent: Accent) => {
    const { width, height } = size
    const thick = Math.max(22, Math.min(width, height) * 0.06)
    const from: Point = [width * SLASH_PATH.from[0], height * SLASH_PATH.from[1]]
    const to: Point = [width * SLASH_PATH.to[0], height * SLASH_PATH.to[1]]
    const bow: Point = [width * SLASH_PATH.bow[0], height * SLASH_PATH.bow[1]]
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    const along = (t: number, side: number): Point => {
      const x = quadratic(from[0], bow[0], to[0], t)
      const y = quadratic(from[1], bow[1], to[1], t)
      return [x + ((to[1] - from[1]) / length) * side, y - ((to[0] - from[0]) / length) * side]
    }
    const curve = [0, 0.25, 0.5, 0.75, 1].map((t) => along(t, 0))
    const red = brushStroke(curve, { width: thick, seed, start: 0.04, attack: 0.5, release: 0.45, dry: 0.32, bristles: 11, rough: 0.08, streaks: 4 })
    const core = brushStroke(curve.slice(1, 4), { width: thick * 0.3, seed: seed + 1, start: 0.05, attack: 0.5, release: 0.5, dry: 0 })
    const random = mulberry32.create(seed)
    const next = () => mulberry32.sample(random)
    const shards = Array.from({ length: 6 }, (_, i) => {
      const side = (i % 2 === 0 ? 1 : -1) * thick * (0.9 + next() * 0.9)
      const start = 0.08 + next() * 0.55
      const span = 0.12 + next() * 0.2
      return brushStroke([along(start, side), along(start + span / 2, side), along(start + span, side)], { width: 2 + next() * 3, seed: seed + 3 + i, start: 0.1, attack: 0.3, release: 0.6, dry: 0 })
    })

    const layer = new Container({ label: `sweep ${seed}` })
    const flash = new Graphics().rect(0, 0, width, height).fill(PALETTE.paper)
    flash.alpha = 0
    const slash = new Container()
    /** Fades the cut as one: the container's own alpha would fade each piece, doubling where they overlap. */
    const fade = new AlphaFilter()
    slash.filters = [fade]
    const shardShapes = new GraphicsContext()
    for (const shard of shards) inkContext(shard.shapes, 0xffffff, shardShapes)
    const shardLines = new SmoothGraphics(shardShapes)
    shardLines.tint = PALETTE.paper
    const body = new SmoothGraphics(inkContext(red.shapes))
    /** A glow round the whole cut: its red and shards, blurred behind them. */
    const glowShape = inkContext(red.shapes)
    for (const shard of shards) inkContext(shard.shapes, 0xffffff, glowShape)
    const glow = new SmoothGraphics(glowShape)
    glow.alpha = 0.8
    glow.filters = [new BlurFilter({ strength: 10, quality: 3, resolution: 0.5 })]
    const white = new SmoothGraphics(inkContext(core.shapes))
    white.tint = PALETTE.paper
    const reveal = spineReveal(red.points, thick * 5, "round")
    slash.addChild(glow, shardLines, body, white, reveal.mask)
    slash.mask = reveal.mask
    layer.addChild(flash, slash)
    node.addChild(layer)

    const pieces = { red: body, glow }
    for (const piece of [body, glow]) piece.tint = accent.accent
    live.add(pieces)
    const done = () => {
      live.delete(pieces)
      running.delete(timeline)
      for (const filter of [...glow.filters, fade]) filter.destroy()
      layer.destroy({ children: true, context: true })
    }
    const timeline = gsap.timeline({ onComplete: done, onInterrupt: done })
      .to(reveal, { head: 1, duration: 0.14, ease: drawn(0.14, "power3.in", ON_ONES) })
      .set(flash, { alpha: FLASH[settings.get().flashes] })
      .set(flash, { alpha: 0 }, "+=0.042")
      .to(reveal, { tail: 1, duration: 0.3, ease: drawn(0.3, "power2.in", ON_ONES) }, "+=0.1")
      .to(fade, { alpha: 0, duration: 0.3, ease: drawn(0.3, "power1.in") }, "<")
    running.add(timeline)
    return timeline
  }

  return {
    node,
    cut,
    tint: (accent) => {
      for (const { red, glow } of live) {
        red.tint = accent.accent
        glow.tint = accent.accent
      }
    },
    layout: (viewport) => {
      size = { width: viewport.width, height: viewport.height }
    },
    dispose: () => {
      for (const timeline of running) timeline.kill()
      node.destroy({ children: true })
    }
  }
}
