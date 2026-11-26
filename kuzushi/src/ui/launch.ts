import { gsap } from "gsap"
import { mulberry32 } from "math/random"
import { Container, Graphics, SmoothGraphics } from "pixi.js"

import { paletteOf } from "../art/palette.ts"
import { LAUNCH_SECONDS } from "../art/title-cues.ts"
import type { ZoneId } from "../sim/index.ts"
import { drawn, ON_TWOS } from "./motion.ts"
import type { Staged } from "./screen.ts"
import { quadratic, SLASH_PATH } from "./sweep.ts"

/** Seconds from the run starting (the flow leaving the title) until the cover has parted and play shows whole. */
export const COVER_LIFT_SECONDS = 0.58

/** Seconds the blot takes to burst out, and the halves' throw once the start room is under them. */
const BURST = 0.16
const THROW = 0.42

/** An ink blot on a 200 box: a ragged disc of spikes round the centre and drops flung past them. */
const blot = (() => {
  const random = mulberry32.create(0xb107)
  const next = () => mulberry32.sample(random)
  const spikes = 44
  const points = Array.from({ length: spikes * 2 }, (_, index) => {
    const angle = (index / (spikes * 2)) * Math.PI * 2
    const reach = index % 2 === 0 ? 74 + next() * 22 : 66 + next() * 5
    return [100 + Math.cos(angle) * reach, 100 + Math.sin(angle) * reach]
  }).flat()
  const drops = Array.from({ length: 16 }, () => {
    const angle = next() * Math.PI * 2
    const reach = 90 + next() * 9
    return { x: 100 + Math.cos(angle) * reach, y: 100 + Math.sin(angle) * reach, r: 0.8 + next() * 2 }
  })
  const shape = new SmoothGraphics().poly(points).fill(0xffffff)
  for (const { x, y, r } of drops) shape.circle(x, y, r).fill(0xffffff)
  shape.pivot.set(100, 100)
  return shape
})

type Share = readonly [x: number, y: number]

/** The slash's curve across the screen, as shares of it: 13 points from its left end to its right. */
const SEAM = Array.from({ length: 13 }, (_, index): Share => {
  const t = index / 12
  const { from, bow, to } = SLASH_PATH
  return [quadratic(from[0], bow[0], to[0], t), quadratic(from[1], bow[1], to[1], t)]
})
/** The ink either side of the seam, reaching 10% past the screen's edges. */
const ABOVE: ReadonlyArray<Share> = [[-0.1, -0.1], [1.1, -0.1], ...SEAM.toReversed()]
const BELOW: ReadonlyArray<Share> = [...SEAM, [1.1, 1.1], [-0.1, 1.1]]

export interface LaunchCover extends Staged {
  /** Covers the screen in `zone`'s ink by the time the run starts, `LAUNCH_SECONDS` from now. */
  close(zone: ZoneId): void
  /** Splits the ink along the slash and throws its halves apart, once the run's first room is on screen under it. */
  lift(): void
}

/**
 * The run's start under cover, drawn under the title. Choosing a zone sends the hero dashing at the lens; as it
 * strikes, an ink blot in the zone's ink bursts out from the middle of the screen on twos and covers it whole before
 * the run starts, so the title's courtyard swaps to the start room and the camera cuts to play out of sight. The
 * title's slash then cuts across, and the ink splits along it, its halves thrown apart to show the start room.
 */
export const createLaunchCover = (): LaunchCover => {
  const node = new Container({ label: "launch-cover" })
  const spot = blot()
  const above = new Graphics()
  const below = new Graphics()
  node.addChild(spot, above, below)
  node.visible = false

  let size = { width: 1, height: 1 }
  let closing: gsap.core.Timeline | null = null
  let lifting: gsap.core.Timeline | null = null
  let shut = false

  const scaleOf = () => (2.4 * Math.max(size.width, size.height)) / 200

  const rest = () => {
    for (const half of [above, below]) {
      half.visible = false
      half.position.set(size.width / 2, size.height / 2)
      half.angle = 0
    }
    spot.visible = false
  }

  return {
    node,
    close: (zone) => {
      closing?.kill()
      gsap.killTweensOf([above, below, spot, spot.scale])
      shut = true
      const ink = paletteOf(zone).ink
      for (const each of [spot, above, below]) each.tint = ink
      rest()
      node.visible = true
      const start = LAUNCH_SECONDS - 0.18
      closing = gsap.timeline()
        .set(spot, { visible: true }, start)
        .fromTo(spot.scale, { x: 0.08 * scaleOf(), y: 0.08 * scaleOf() }, { x: scaleOf(), y: scaleOf(), duration: BURST, ease: drawn(BURST, "power2.out", ON_TWOS), immediateRender: false }, start)
        .fromTo(spot, { angle: -8 }, { angle: 6, duration: BURST, ease: drawn(BURST, "power2.out", ON_TWOS), immediateRender: false }, start)
        .set([above, below], { visible: true }, start + BURST)
        .set(spot, { visible: false }, start + BURST)
    },
    lift: () => {
      if (!shut) return
      shut = false
      const after = closing !== null && closing.isActive() ? closing.duration() - closing.time() : 0
      const { width, height } = size
      lifting = gsap.timeline({ delay: after + 0.16, onComplete: () => {
        node.visible = false
        rest()
      } })
        .to(above, { x: width / 2 - 0.14 * width, y: height / 2 - 0.62 * height, angle: -4, duration: THROW, ease: drawn(THROW, "power2.in", ON_TWOS) }, 0)
        .to(below, { x: width / 2 + 0.14 * width, y: height / 2 + 0.62 * height, angle: 4, duration: THROW, ease: drawn(THROW, "power2.in", ON_TWOS) }, 0)
    },
    layout: (viewport) => {
      size = { width: viewport.width, height: viewport.height }
      const { width, height } = size
      const draw = (half: Graphics, points: ReadonlyArray<Share>) => {
        half.clear().poly(points.flatMap(([x, y]) => [x * width, y * height])).fill(0xffffff)
        half.pivot.set(width / 2, height / 2)
      }
      draw(above, ABOVE)
      draw(below, BELOW)
      spot.position.set(width / 2, height / 2)
      if (!node.visible) rest()
    },
    dispose: () => {
      closing?.kill()
      lifting?.kill()
      node.destroy({ children: true, context: true })
    }
  }
}
