import type { ArenaLayout } from "../arena.ts"
import type { Stage } from "../stages.ts"
import { PLAYER } from "../tuning.ts"

/** "The Courtyard": a walled stone yard with blocks and pillars for cover, and monoliths beyond the walls. */
export const ARENA = {
  name: "The Courtyard",
  halfWidth: 18,
  halfDepth: 12,
  wall: 2,
  wallHeight: 1.1,
  tile: 2,
  blocks: [
    { x: -12.5, z: -7, halfWidth: 1.6, halfDepth: 1.6, height: 3.0 },
    { x: 12, z: 6.5, halfWidth: 2.0, halfDepth: 1.4, height: 2.2 },
    { x: -14, z: 6.5, halfWidth: 1.2, halfDepth: 2.2, height: 4.5 },
    { x: 13.5, z: -7.5, halfWidth: 1.4, halfDepth: 1.4, height: 5.0 },
    { x: -3, z: -10, halfWidth: 2.5, halfDepth: 0.7, height: 1.4 },
    { x: 4.5, z: 9.8, halfWidth: 2.0, halfDepth: 0.8, height: 1.2 },
    { x: 8, z: 1.5, halfWidth: 1.0, halfDepth: 1.0, height: 1.8 }
  ],
  pillars: [
    { x: -6.5, z: -4.5, radius: 0.85, height: 5.5 },
    { x: 5.5, z: -5.5, radius: 0.7, height: 4.0 },
    { x: -5.5, z: 6, radius: 0.7, height: 3.5 },
    { x: 16, z: 0, radius: 1.0, height: 6.5 },
    { x: -16.5, z: -1, radius: 1.0, height: 6.5 }
  ],
  backdrop: [
    { x: -23, z: -15, halfWidth: 2.5, halfDepth: 2.0, height: 9 },
    { x: -9, z: -17, halfWidth: 3.0, halfDepth: 1.5, height: 12 },
    { x: 6, z: -17.5, halfWidth: 2.0, halfDepth: 2.0, height: 8 },
    { x: 22, z: -14, halfWidth: 2.5, halfDepth: 3.0, height: 11 },
    { x: 24, z: 4, halfWidth: 2.0, halfDepth: 2.5, height: 7 },
    { x: -24, z: 6, halfWidth: 2.0, halfDepth: 3.0, height: 10 },
    { x: -14, z: 17, halfWidth: 3.0, halfDepth: 1.5, height: 6 },
    { x: 14, z: 17, halfWidth: 2.5, halfDepth: 1.5, height: 7 }
  ],
  floor: { kind: "rect" },
  start: PLAYER.start,
  spawnPoints: [
    { x: -16, z: -10 }, { x: -8.5, z: -10.5 }, { x: 2.5, z: -10.5 }, { x: 9, z: -10.5 }, { x: 16, z: -10.5 },
    { x: -16.5, z: 10.5 }, { x: -9, z: 10.5 }, { x: -1, z: 10.5 }, { x: 9.5, z: 10.5 }, { x: 16.5, z: 10.5 },
    { x: -16.5, z: 3 }, { x: 16.5, z: -4 }, { x: -10, z: 0 }, { x: 11, z: -2 }, { x: 0, z: -6.5 }, { x: 1, z: 6.5 }
  ],
  beacon: null,
  doors: []
} as const satisfies ArenaLayout

export const COURTYARD: Stage = {
  id: "courtyard",
  layout: ARENA,
  hazard: { kind: "none" },
  knockback: 1
}
