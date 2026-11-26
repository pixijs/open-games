import type { Block, Pillar } from "../sim/index.ts"

/** The solids a world draws that can stand between the camera and an actor: boxes and upright columns from the floor. */
export interface Occluders {
  readonly blocks: ReadonlyArray<Block>
  readonly pillars: ReadonlyArray<Pillar>
}

interface Point {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** The part [enter, exit] of the segment's 0 to 1 span inside the slab low to high along one axis, or null. */
const slab = (from: number, delta: number, low: number, high: number, span: readonly [number, number]): readonly [number, number] | null => {
  if (Math.abs(delta) < 1e-9) return from < low || from > high ? null : span
  const a = (low - from) / delta
  const b = (high - from) / delta
  const enter = Math.max(span[0], Math.min(a, b))
  const exit = Math.min(span[1], Math.max(a, b))
  return enter <= exit ? [enter, exit] : null
}

const throughBox = (from: Point, to: Point, box: Block): boolean => {
  const inX = slab(from.x, to.x - from.x, box.x - box.halfWidth, box.x + box.halfWidth, [0, 1])
  const inZ = inX && slab(from.z, to.z - from.z, box.z - box.halfDepth, box.z + box.halfDepth, inX)
  return (inZ && slab(from.y, to.y - from.y, 0, box.height, inZ)) !== null
}

const throughPillar = (from: Point, to: Point, pillar: Pillar): boolean => {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const fx = from.x - pillar.x
  const fz = from.z - pillar.z
  const a = dx * dx + dz * dz
  const b = 2 * (fx * dx + fz * dz)
  const c = fx * fx + fz * fz - pillar.radius * pillar.radius
  const disc = b * b - 4 * a * c
  if (a < 1e-9 || disc < 0) return false
  const root = Math.sqrt(disc)
  const enter = Math.max(0, (-b - root) / (2 * a))
  const exit = Math.min(1, (-b + root) / (2 * a))
  return enter <= exit && slab(from.y, to.y - from.y, 0, pillar.height, [enter, exit]) !== null
}

/** Whether one of the world's solids stands between `eye` and `target`. */
export const propBetween = (occluders: Occluders, eye: Point, target: Point): boolean =>
  occluders.pillars.some((pillar) => throughPillar(eye, target, pillar)) || occluders.blocks.some((block) => throughBox(eye, target, block))
