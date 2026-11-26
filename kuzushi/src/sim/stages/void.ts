import { Clock } from "@typeonce/ritmo"

import { slab } from "../arena.ts"
import type { ArenaLayout } from "../arena.ts"
import type { Stage } from "../stages.ts"
import { step } from "../time.ts"

/**
 * "The Void": pale slabs floating in black with no walls. The core never falls; the rest crack and fall after the
 * waves listed, so the floor shrinks over the stage. Index order is the slab's id in moments and the view (A to I).
 */
const VOID_ARENA = {
  name: "The Void",
  halfWidth: 12,
  halfDepth: 9,
  wall: 0,
  wallHeight: 0,
  tile: 1,
  blocks: [],
  pillars: [],
  backdrop: [],
  floor: {
    kind: "slabs",
    slabs: [
      slab(-6, 6, -4, 4, null),
      slab(-6, 0, 4, 7, 4),
      slab(2, 8, -7, -4, 5),
      slab(-11, -6, -3, 3, 3),
      slab(6, 11, -4, 2, 3),
      slab(-9, -6, -8, -3, 2),
      slab(8, 12, 2, 6, 2),
      slab(-2, 2, -9, -4, 2),
      slab(0, 5, 4, 6, 4)
    ]
  },
  start: { x: 0, z: 1 },
  spawnPoints: [
    { x: -4.5, z: -2.5 }, { x: 4.5, z: -2.5 }, { x: -4.5, z: 2.5 }, { x: 4.5, z: 2.5 },
    { x: -4.5, z: 5.5 }, { x: -1.5, z: 5.5 }, { x: 3, z: 5 }, { x: 5, z: -5.5 },
    { x: -9.5, z: -1.5 }, { x: -9.5, z: 1.5 }, { x: 9.5, z: -2.5 }, { x: 8, z: 0.5 },
    { x: -7.5, z: -6.5 }, { x: 10.5, z: 4 }, { x: 0, z: -7.5 }
  ],
  beacon: { x: 2, z: -15 },
  doors: []
} as const satisfies ArenaLayout

export const VOID: Stage = {
  id: "void",
  layout: VOID_ARENA,
  hazard: { kind: "collapse", crack: Clock.duration(step, 2.6) },
  knockback: 1.8
}
