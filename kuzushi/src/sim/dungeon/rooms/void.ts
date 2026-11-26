import { Clock } from "@typeonce/ritmo"

import { slab } from "../../arena.ts"
import type { Point, Slab } from "../../arena.ts"
import type { StageHazard } from "../../stages.ts"
import { step } from "../../time.ts"
import { room } from "../plan.ts"
import type { RoomTemplate, TemplateRole } from "../plan.ts"

/**
 * The Void's rooms: slabs over nothing, no walls. Every doorway is a gate at the end of a landing (added per door),
 * and a path of slabs that never falls joins each edge's centre to the core. Slabs crack and fall after the wave they
 * name; in the boss room, after the phase (docs/DESIGN.md, Void rooms).
 */

/** A slab and its mirror image across x = 0. */
const pair = (x0: number, x1: number, z0: number, z1: number, fallsAfter: number | null = null): ReadonlyArray<Slab> =>
  [slab(x0, x1, z0, z1, fallsAfter), slab(-x1, -x0, z0, z1, fallsAfter)]

const COLLAPSE: StageHazard = { kind: "collapse", crack: Clock.duration(step, 2.6) }

interface Islands {
  readonly role: TemplateRole
  readonly name: string
  readonly halfWidth: number
  readonly halfDepth: number
  readonly slabs: ReadonlyArray<Slab>
  readonly altars?: ReadonlyArray<Point>
  readonly spring?: Point
  readonly bossOffset?: number
}

const islands = (plan: Islands): RoomTemplate => room({
  zone: "void",
  role: plan.role,
  name: plan.name,
  halfWidth: plan.halfWidth,
  halfDepth: plan.halfDepth,
  wall: 0,
  wallHeight: 0,
  tile: 1,
  floor: { kind: "slabs", slabs: plan.slabs },
  blocks: [],
  pillars: [],
  altars: plan.altars ?? [],
  spring: plan.spring ?? null,
  bossOffset: plan.bossOffset ?? 0,
  hazard: plan.slabs.some((each) => each.fallsAfter !== null) ? COLLAPSE : { kind: "none" }
})

export const VOID_ROOMS = {
  "void.threshold": islands({
    role: "start",
    name: "Threshold",
    halfWidth: 7,
    halfDepth: 6,
    slabs: [slab(-7, 7, -6, 6)],
    altars: [{ x: -4.2, z: -3.9 }, { x: 0, z: -0.2 }, { x: 4.2, z: -3.9 }]
  }),
  "void.shrine": islands({
    role: "shrine",
    name: "Shrine",
    halfWidth: 7,
    halfDepth: 6,
    slabs: [slab(-7, 7, -6, 6)],
    altars: [{ x: -4.2, z: -3.9 }, { x: 4.2, z: -3.9 }],
    spring: { x: 0, z: 0 }
  }),
  "void.islet": islands({
    role: "small",
    name: "Islet",
    halfWidth: 11,
    halfDepth: 5,
    slabs: [slab(-7, 7, -5, 5), ...pair(7, 11, -3, 3)]
  }),
  "void.causeway": islands({
    role: "medium",
    name: "Causeway",
    halfWidth: 12.5,
    halfDepth: 6.5,
    slabs: [
      slab(-3.5, 3.5, -3.5, 3.5),
      ...pair(5.5, 12.5, -3.5, 3.5),
      ...pair(3.5, 5.5, -1.5, 1.5),
      slab(-1.5, 1.5, -6.5, -3.5),
      slab(-1.5, 1.5, 3.5, 6.5),
      ...pair(9.5, 12.5, -6.5, -3.5, 1),
      ...pair(9.5, 12.5, 3.5, 6.5, 1)
    ]
  }),
  "void.shards": islands({
    role: "medium",
    name: "Shards",
    halfWidth: 10,
    halfDepth: 5.5,
    slabs: [
      slab(-3, 3, -5.5, -0.5),
      slab(-3, 3, 0.5, 5.5),
      ...pair(4, 10, -5.5, -0.5),
      ...pair(4, 10, 0.5, 5.5),
      ...pair(3, 4, -4, -2),
      ...pair(3, 4, 2, 4),
      slab(-1, 1, -0.5, 0.5),
      ...pair(6, 8, -0.5, 0.5),
      ...pair(8, 10, -1.5, 1.5)
    ]
  }),
  "void.collapse": islands({
    role: "large",
    name: "Collapse",
    halfWidth: 12,
    halfDepth: 9,
    slabs: [
      slab(-6, 6, -4, 4),
      slab(-6, 0, 4, 7),
      slab(2, 8, -7, -4, 2),
      slab(-11, -6, -3, 3),
      slab(6, 11, -4, 2),
      slab(-9, -6, -8, -3, 1),
      slab(8, 12, 2, 6, 1),
      slab(-2, 2, -9, -4),
      slab(0, 5, 4, 6, 2),
      slab(-1.5, 1.5, 4, 9),
      slab(11, 12, -1.5, 1.5),
      slab(-12, -11, -1.5, 1.5)
    ]
  }),
  "void.abyss": islands({
    role: "boss",
    name: "Abyss",
    halfWidth: 14,
    halfDepth: 7,
    slabs: [
      slab(-6, 6, -4, 4),
      slab(-1.5, 1.5, -7, -4),
      slab(-1.5, 1.5, 4, 7),
      ...pair(6, 14, -1.5, 1.5),
      ...pair(1.5, 9, -7, -4, 2),
      ...pair(1.5, 9, 4, 7, 2),
      ...pair(6, 9, -4, -1.5, 2),
      ...pair(6, 9, 1.5, 4, 2),
      ...pair(10, 14, -6.5, -1.5, 1),
      ...pair(10, 14, 1.5, 6.5, 1)
    ],
    bossOffset: 3
  })
} as const satisfies Record<`void.${string}`, RoomTemplate>
