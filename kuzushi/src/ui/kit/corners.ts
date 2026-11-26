import { gsap } from "gsap"
import { Container, SmoothGraphics } from "pixi.js"

import { drawn, ON_ONES } from "../motion.ts"

/**
 * Four L-shaped corners round a box: a screen's or a sheet's ticks, a menu's brackets. Each corner is a slot placed on
 * its corner point holding a body that animations move, scale and fade, so a body scales about its corner.
 */
export interface Corners {
  readonly node: Container
  /** tl, tr, bl, br. */
  readonly bodies: ReadonlyArray<Container>
  /** Puts the corners on a box, pushed out from it by `outX` and `outY`. */
  place(x: number, y: number, width: number, height: number, outX?: number, outY?: number): void
  /** The bodies fly in from `spread` out along their diagonals and snap onto their corners. */
  snap(spreadX: number, spreadY: number, duration: number, stagger: number): gsap.core.Timeline
  /** The bodies shrink from `from` times their size onto their corners as they fade in, `stagger` apart. */
  pop(from: number, duration: number, ease: gsap.EaseFunction, stagger: number): gsap.core.Timeline
  /** The bodies are thrown `dx` and `dy` out along their diagonals and spring back onto their corners. */
  kick(dx: number, dy: number): gsap.core.Tween
  tint(color: number): void
}

export interface CornerOptions {
  /** Length of each arm, px. */
  readonly arm: number
  /** Line weight, px. */
  readonly weight: number
  readonly color: number
  readonly alpha: number
  /** A faint 6 px stroke under each L. */
  readonly glow?: boolean
}

/** Which way each corner sits from the box's middle: tl, tr, bl, br. */
const SIDES = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const

export const createCorners = (options: CornerOptions): Corners => {
  const node = new Container({ label: "corners" })
  const half = options.weight / 2
  const corners = SIDES.map(([sx, sy]) => {
    const slot = new Container()
    const body = new SmoothGraphics()
    const line = [-sx * options.arm, -sy * half, -sx * half, -sy * half, -sx * half, -sy * options.arm]
    if (options.glow === true) body.poly(line, false).stroke({ width: 6, color: 0xffffff, alpha: 0.2, cap: "round", join: "round" })
    body.poly(line, false).stroke({ width: options.weight, color: 0xffffff, alpha: options.alpha })
    body.tint = options.color
    slot.addChild(body)
    node.addChild(slot)
    return { sx, sy, slot, body }
  })
  const bodies = corners.map((corner) => corner.body)

  return {
    node,
    bodies,
    place: (x, y, width, height, outX = 0, outY = 0) => {
      for (const { sx, sy, slot } of corners) slot.position.set(Math.round(sx < 0 ? x - outX : x + width + outX), Math.round(sy < 0 ? y - outY : y + height + outY))
    },
    snap: (spreadX, spreadY, duration, stagger) => gsap.timeline().fromTo(bodies,
      { x: (index: number) => (corners[index]?.sx ?? 0) * spreadX, y: (index: number) => (corners[index]?.sy ?? 0) * spreadY, alpha: 0 },
      { x: 0, y: 0, alpha: 1, duration, ease: drawn(duration, "expo.out", ON_ONES), stagger }),
    pop: (from, duration, ease, stagger) => gsap.timeline()
      .fromTo(bodies.map((body) => body.scale), { x: from, y: from }, { x: 1, y: 1, duration, ease, stagger }, 0)
      .fromTo(bodies, { alpha: 0 }, { alpha: 1, duration, ease, stagger }, 0),
    kick: (dx, dy) => gsap.fromTo(bodies,
      { x: (index: number) => (corners[index]?.sx ?? 0) * dx, y: (index: number) => (corners[index]?.sy ?? 0) * dy },
      { x: 0, y: 0, duration: 0.3, ease: drawn(0.3, "elastic.out(1, 0.5)") }),
    tint: (color) => {
      for (const body of bodies) body.tint = color
    }
  }
}
