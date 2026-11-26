import { Ops } from "@typeonce/ritmo"
import { Angle } from "@typeonce/ritmo-math"

import type { Point } from "./arena.ts"

export interface Dir {
  readonly x: number
  readonly z: number
}

export const radians = (degrees: number): number => (degrees * Math.PI) / 180

export const angleOf = (dx: number, dz: number): number => Ops.atan2(dz + 0, dx + 0)

export const dirOf = (angle: number): Dir => ({ x: Ops.cos(angle), z: Ops.sin(angle) })

export const lengthOf = (dx: number, dz: number): number => Math.sqrt(dx * dx + dz * dz)

/** The unit vector along (dx, dz), or `fallback` when it has no length. */
export const normalize = (dx: number, dz: number, fallback: Dir): Dir => {
  const length = lengthOf(dx, dz)
  return length > 1e-6 ? { x: dx / length, z: dz / length } : fallback
}

/** The point on the segment from (x, z) along `dir` for `length` nearest (px, pz). */
export const nearestOnLine = (x: number, z: number, dir: Dir, length: number, px: number, pz: number): Point => {
  const along = Math.min(length, Math.max(0, (px - x) * dir.x + (pz - z) * dir.z))
  return { x: x + dir.x * along, z: z + dir.z * along }
}

/** Whether a circle of `radius` at (x, z) touches the arc of `range` and half angle `halfAngle` around `facing` from (ox, oz). */
export const inArc = (
  ox: number,
  oz: number,
  facing: number,
  range: number,
  halfAngle: number,
  x: number,
  z: number,
  radius: number
): boolean => {
  const dx = x - ox
  const dz = z - oz
  const distance = lengthOf(dx, dz)
  if (distance > range + radius) return false
  if (halfAngle >= Math.PI || distance <= radius) return true
  const slack = Ops.asin(Math.min(1, radius / distance))
  return Math.abs(Angle.wrap(angleOf(dx, dz) - facing)) <= halfAngle + slack
}

export const within = (ax: number, az: number, bx: number, bz: number, distance: number): boolean => {
  const dx = ax - bx
  const dz = az - bz
  return dx * dx + dz * dz <= distance * distance
}
