import type { View3D } from "@pixi/3d"
import { Graphics, Point as ScreenPoint } from "pixi.js"
import type { Container } from "pixi.js"

import { arrowheadPoints } from "../art/arrowhead.ts"
import { PALETTE } from "../art/palette.ts"
import type { Point } from "../sim/index.ts"

/** How a sketched shape is drawn: a palette colour, its line, and an optional fill. */
export interface Ink {
  readonly color: number
  readonly alpha: number
  readonly width?: number
  /** Fill opacity; no fill when left out. */
  readonly fill?: number
}

export const INK = {
  paper: { color: PALETTE.paper, alpha: 0.9, width: 1.5 },
  faint: { color: PALETTE.paper, alpha: 0.35, width: 1 },
  grey: { color: PALETTE.concrete300, alpha: 0.75, width: 1 },
  red: { color: PALETTE.red, alpha: 0.95, width: 1.5 },
  redFaint: { color: PALETTE.red, alpha: 0.45, width: 1 }
} as const satisfies Record<string, Ink>

/** Debug drawing on the ground plane, projected through the live camera onto a 2D layer over the 3D view. */
export interface Sketch {
  /** A line through ground points; `closed` joins the last to the first. */
  path(points: ReadonlyArray<Point>, ink: Ink, closed?: boolean): void
  circle(x: number, z: number, radius: number, ink: Ink): void
  /** A wedge from (x, z) along `facing` (radians), `range` long, `halfAngle` either side; a full circle at π. */
  wedge(x: number, z: number, facing: number, range: number, halfAngle: number, ink: Ink): void
  /** The ground a circle of `radius` sweeps moving `length` from (x, z) along (dirX, dirZ). */
  capsule(x: number, z: number, dirX: number, dirZ: number, length: number, radius: number, ink: Ink): void
  /** An arrowhead outline like the player's, `size` long, pointing along `facing`. */
  arrow(x: number, z: number, facing: number, size: number, ink: Ink): void
}

const arcPoints = (x: number, z: number, radius: number, from: number, to: number): Array<Point> => {
  const steps = Math.max(8, Math.ceil((Math.abs(to - from) / (Math.PI * 2)) * 48))
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = from + ((to - from) * index) / steps
    return { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius }
  })
}

/**
 * A sketch layer at the bottom of `parent`, so the screen effects drawn there (the special's cinema bars among them)
 * cover it: call `clear` at the start of each frame's drawing.
 */
export const createSketch = (view: View3D, parent: Container) => {
  const graphics = new Graphics({ label: "lab sketch" })
  parent.addChildAt(graphics, 0)
  const scratch = new ScreenPoint()
  const lifted = { x: 0, y: 0.03, z: 0 }

  /** Projects ground points; null when any is behind the camera. */
  const project = (points: ReadonlyArray<Point>): Array<number> | null => {
    const flat: Array<number> = []
    for (const point of points) {
      lifted.x = point.x
      lifted.z = point.z
      const screen = view.worldToScreen(lifted, scratch)
      if (screen === null) return null
      flat.push(screen.x, screen.y)
    }
    return flat
  }

  const shape = (points: ReadonlyArray<Point>, ink: Ink, closed: boolean) => {
    const flat = project(points)
    if (flat === null || flat.length < 4) return
    if (ink.fill !== undefined && closed) graphics.poly(flat, true).fill({ color: ink.color, alpha: ink.fill })
    graphics.poly(flat, closed).stroke({ color: ink.color, alpha: ink.alpha, width: ink.width ?? 1, join: "round" })
  }

  const sketch: Sketch = {
    path: (points, ink, closed = false) => shape(points, ink, closed),
    circle: (x, z, radius, ink) => shape(arcPoints(x, z, radius, 0, Math.PI * 2).slice(0, -1), ink, true),
    wedge: (x, z, facing, range, halfAngle, ink) => {
      if (halfAngle >= Math.PI - 1e-3) {
        sketch.circle(x, z, range, ink)
        return
      }
      shape([{ x, z }, ...arcPoints(x, z, range, facing - halfAngle, facing + halfAngle)], ink, true)
    },
    capsule: (x, z, dirX, dirZ, length, radius, ink) => {
      const facing = Math.atan2(dirZ, dirX)
      const endX = x + dirX * length
      const endZ = z + dirZ * length
      shape([
        ...arcPoints(endX, endZ, radius, facing - Math.PI / 2, facing + Math.PI / 2),
        ...arcPoints(x, z, radius, facing + Math.PI / 2, facing + (Math.PI * 3) / 2)
      ], ink, true)
    },
    arrow: (x, z, facing, size, ink) => {
      const cos = Math.cos(facing)
      const sin = Math.sin(facing)
      const at = (along: number, across: number): Point => ({ x: x + cos * along - sin * across, z: z + sin * along + cos * across })
      shape(arrowheadPoints(size * 0.6, -size * 0.4, size * 0.4).map(([along, across]) => at(along, across)), ink, true)
    }
  }

  return {
    sketch,
    clear: () => void graphics.clear(),
    destroy: () => graphics.destroy()
  }
}
