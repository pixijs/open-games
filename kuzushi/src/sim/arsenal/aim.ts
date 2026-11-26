import { Collide2 } from "@typeonce/ritmo-math"

import { ground, standable } from "../arena.ts"
import type { Point, Terrain } from "../arena.ts"
import { lengthOf } from "../geometry.ts"
import type { Dir } from "../geometry.ts"
import type { AimValue } from "../schema.ts"
import { MOVE, PLAYER, SIGIL } from "../tuning.ts"

/** How far the cursor's spot is from the hero along `dir`, or null when the mouse isn't aiming. */
const cursorReach = (aim: AimValue, from: Point): number | null =>
  aim._tag === "Point" ? lengthOf(aim.x - from.x, aim.z - from.z) : null

/** How far back toward the hero a slam's mark steps at a time until the hero could stand there. */
const BACK_STEP = 0.25

/**
 * Where the breaker's slam lands: along `dir`, at the cursor's spot clamped to the slam's reach (its usual reach with
 * no cursor), stepped back toward the hero until the hero could stand there (clear of walls, on standing floor).
 */
export const slamTarget = (terrain: Terrain, from: Point, dir: Dir, aim: AimValue): Point => {
  const { reach } = MOVE.slam
  const wanted = Math.min(reach.max, Math.max(reach.min, cursorReach(aim, from) ?? reach.aim))
  for (let distance = wanted; distance > 0; distance -= BACK_STEP) {
    const x = from.x + dir.x * distance
    const z = from.z + dir.z * distance
    if (standable(terrain, x, z, PLAYER.radius)) return { x, z }
  }
  return { x: from.x, z: from.z }
}

/**
 * Where a sigil is cast: the cursor's spot clamped to `SIGIL.near`..`far` from the hero along `dir`, or `free` along
 * it with no cursor; pushed out of any wall or prop so its ring sits on open ground.
 */
export const castSpot = (terrain: Terrain, from: Point, dir: Dir, aim: AimValue, radius: number): Point => {
  const wanted = Math.min(SIGIL.far, Math.max(SIGIL.near, cursorReach(aim, from) ?? SIGIL.free))
  const spot = Collide2.pushOut(ground(from.x + dir.x * wanted, from.z + dir.z * wanted), Math.min(radius, 0.5), terrain.solid)
  return { x: spot.x, z: spot.y }
}
