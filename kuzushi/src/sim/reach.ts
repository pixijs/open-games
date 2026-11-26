import { Ops } from "@typeonce/ritmo"
import { Angle, Collide2 } from "@typeonce/ritmo-math"

import { ground } from "./arena.ts"
import type { ArenaLayout, Pillar, Point, Terrain } from "./arena.ts"
import { angleOf, dirOf, lengthOf, nearestOnLine, normalize } from "./geometry.ts"
import type { Dir } from "./geometry.ts"
import { layoutOf, OPEN_FLOOR } from "./ground.ts"
import type { Ground } from "./ground.ts"
import { PLAYER } from "./tuning.ts"

/**
 * Where the enemies' shaped attacks reach the player: an arm sweeping an arc, a ring wave with a gap, a line that
 * strikes along its length. Each answers with the point of the attack nearest the player when it touches them, so a
 * strike can be centred there; the combat system resolves it like any other blow.
 */

/** A point of contact and the way it pushes the player. */
export interface Contact {
  readonly x: number
  readonly z: number
  readonly dir: Dir
}

/** How far a straight run from (x, z) along `dir` gets before the first wall or edge, up to `max`. */
export const clearReach = (terrain: Terrain, x: number, z: number, dir: Dir, max: number): number => {
  const hit = Collide2.sweepCircle(ground(x, z), ground(dir.x * max, dir.z * max), 0.05, terrain.bounded)
  return hit === undefined ? max : Math.max(0, max * hit.time)
}

/** A line strike: touches the player when they stand within `halfWidth` of the segment. */
export const lineContact = (x: number, z: number, dir: Dir, length: number, halfWidth: number, player: Point): Contact | null => {
  const near = nearestOnLine(x, z, dir, length, player.x, player.z)
  if (lengthOf(player.x - near.x, player.z - near.z) > halfWidth + PLAYER.radius) return null
  return { ...near, dir: normalize(player.x - near.x, player.z - near.z, { x: -dir.z, z: dir.x }) }
}

/**
 * An arm of `radius` turning round (x, z) from angle `from` to angle `to` (`turn` 1 turns clockwise on screen): touches the
 * player when its sweep this step passes them, from `inner` out to its tip. The push runs along the swing.
 */
export const sweepContact = (x: number, z: number, from: number, to: number, turn: 1 | -1, radius: number, inner: number, player: Point): Contact | null => {
  const dx = player.x - x
  const dz = player.z - z
  const distance = lengthOf(dx, dz)
  if (distance > radius + PLAYER.radius || distance < inner - PLAYER.radius) return null
  const slack = distance <= PLAYER.radius ? Math.PI : Ops.asin(Math.min(1, PLAYER.radius / distance))
  const swept = (to - from) * turn
  const at = Angle.wrap((angleOf(dx, dz) - from) * turn)
  const into = at < -slack ? at + Math.PI * 2 : at
  if (into < -slack || into > swept + slack) return null
  const reach = Math.min(distance, radius)
  const angle = angleOf(dx, dz)
  const out = dirOf(angle)
  return { x: x + out.x * reach, z: z + out.z * reach, dir: dirOf(angle + turn * Math.PI / 2) }
}

/** Whether `angle` lies within `half` of `centre`. */
const withinAngle = (angle: number, centre: number, half: number): boolean => Math.abs(Angle.wrap(angle - centre)) <= half

/** Whether a pillar stands between (x, z) and the player's whole body: the cover a ring wave and the beam respect. */
export const covered = (pillars: ReadonlyArray<Pillar>, x: number, z: number, player: Point): boolean => {
  const dir = normalize(player.x - x, player.z - z, { x: 1, z: 0 })
  const distance = lengthOf(player.x - x, player.z - z)
  return pillars.some((pillar) => {
    const along = (pillar.x - x) * dir.x + (pillar.z - z) * dir.z
    if (along <= 0 || along >= distance) return false
    const off = Math.abs((pillar.x - x) * -dir.z + (pillar.z - z) * dir.x)
    return off <= pillar.radius - PLAYER.radius
  })
}

/**
 * A ring wave from (x, z) whose front stands at `front`, `halfWidth` thick, broken by a gap of `gap` centred on
 * `gapAngle`: touches the player where its front crosses them, unless they stand in the gap or behind a pillar.
 */
export const waveContact = (x: number, z: number, front: number, halfWidth: number, gapAngle: number, gap: number, pillars: ReadonlyArray<Pillar>, player: Point): Contact | null => {
  const dx = player.x - x
  const dz = player.z - z
  const distance = lengthOf(dx, dz)
  if (Math.abs(distance - front) > halfWidth + PLAYER.radius) return null
  const angle = angleOf(dx, dz)
  if (withinAngle(angle, gapAngle, gap / 2) || covered(pillars, x, z, player)) return null
  const out = dirOf(angle)
  return { x: x + out.x * front, z: z + out.z * front, dir: out }
}

/** Moves (x, z) toward (tx, tz) by at most `step`. */
export const chase = (x: number, z: number, tx: number, tz: number, step: number): Point => {
  const dx = tx - x
  const dz = tz - z
  const distance = lengthOf(dx, dz)
  if (distance <= step || distance < 1e-6) return { x: tx, z: tz }
  return { x: x + (dx / distance) * step, z: z + (dz / distance) * step }
}

/** The plan of the floor bodies move on now: the room's or classic arena's, or the debug open floor. */
export const floorPlanOf = (stage: Ground): ArenaLayout => stage.open ? OPEN_FLOOR : layoutOf(stage)

/** The pillars that stand on the floor bodies move on now. */
export const pillarsOf = (stage: Ground): ReadonlyArray<Pillar> => floorPlanOf(stage).pillars
