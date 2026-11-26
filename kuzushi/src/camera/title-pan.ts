import { clamp, vec3 } from "math"
import type { Vec3 } from "math"

import type { TitleShot } from "./rig.ts"

/**
 * Where a title shot's lens and aim stand `time` seconds into it, written to `lens` and `look`: an ease-out from
 * `from` to `to` (and `lookFrom` to `lookTo`) over `seconds`, then held.
 */
export const titleShotAt = (shot: TitleShot, time: number, lens: Vec3, look: Vec3): void => {
  const t = Math.min(1, time / Math.max(0.001, shot.seconds))
  const eased = 1 - (1 - t) * (1 - t)
  vec3.lerp(lens, shot.from, shot.to, eased)
  vec3.lerp(look, shot.lookFrom, shot.lookTo, eased)
}

/**
 * How far (radians, about the vertical) to turn a title shot's aim about its lens at `lens`, looking at `target`, so
 * the target shows `side` of the half-width right of centre on a screen `aspect` wide with a vertical `fov`
 * (degrees). A lens looking down turns further than one looking level: turning about the vertical moves the target
 * across the frame by less the steeper it looks, so a high shot keeps its subject where a low one does.
 */
export const titlePan = (side: number, fov: number, aspect: number, lens: Vec3, target: Vec3): number => {
  const k = side * Math.tan((fov * Math.PI) / 360) * aspect
  const pitch = Math.atan2(lens[1] - target[1], Math.hypot(target[0] - lens[0], target[2] - lens[2]))
  const cos = Math.cos(pitch)
  const sin = Math.sin(pitch)
  const b = -k * cos * cos
  return Math.asin(clamp((k * sin * sin) / Math.hypot(cos, b), -1, 1)) - Math.atan2(b, cos)
}
