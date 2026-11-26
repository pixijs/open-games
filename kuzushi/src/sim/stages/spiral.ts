import { Clock } from "@typeonce/ritmo"

import type { ArenaLayout, Pillar } from "../arena.ts"
import { radians } from "../geometry.ts"
import type { Stage } from "../stages.ts"
import { step } from "../time.ts"

/** The tall spire at the centre: it blocks movement and the beam sweeps from its surface. */
const SPIRE: Pillar = { x: 0, z: 0, radius: 2, height: 16 }

/**
 * "The Spiral": a round floor inside a ring wall, pillars on a spiral winding in toward the spire, each taller and
 * thinner than the last, and monoliths ringing the wall outside (low to the south, so they never block the camera).
 */
export const SPIRAL_ARENA = {
  name: "The Spiral",
  halfWidth: 15,
  halfDepth: 15,
  wall: 1.2,
  wallHeight: 0.9,
  tile: 2,
  blocks: [],
  pillars: [
    { x: -10.7, z: 6.2, radius: 0.95, height: 2.2 },
    { x: -10.3, z: -4.2, radius: 0.92, height: 3.0 },
    { x: -2.7, z: -9.5, radius: 0.88, height: 3.8 },
    { x: 5.1, z: -7.0, radius: 0.85, height: 4.6 },
    { x: 7.3, z: -0.3, radius: 0.82, height: 5.4 },
    { x: 3.9, z: 4.6, radius: 0.78, height: 6.2 },
    { x: -1.0, z: 4.7, radius: 0.75, height: 7.0 },
    SPIRE
  ],
  backdrop: [
    { x: 0, z: -21, halfWidth: 2, halfDepth: 2, height: 14 },
    { x: 14.8, z: -14.8, halfWidth: 2, halfDepth: 2, height: 12 },
    { x: 21, z: 0, halfWidth: 2, halfDepth: 2, height: 9 },
    { x: 14.8, z: 14.8, halfWidth: 2, halfDepth: 2, height: 4 },
    { x: 0, z: 22, halfWidth: 2, halfDepth: 2, height: 2.5 },
    { x: -14.8, z: 14.8, halfWidth: 2, halfDepth: 2, height: 4 },
    { x: -21, z: 0, halfWidth: 2, halfDepth: 2, height: 10 },
    { x: -14.8, z: -14.8, halfWidth: 2, halfDepth: 2, height: 13 }
  ],
  floor: { kind: "round", radius: 15 },
  start: { x: 0, z: 10 },
  spawnPoints: [
    { x: 0, z: -12.8 }, { x: 6.4, z: -11.1 }, { x: 11.1, z: -6.4 }, { x: 12.8, z: 0 }, { x: 11.1, z: 6.4 },
    { x: 6.4, z: 11.1 }, { x: -6.4, z: 11.1 }, { x: -12.8, z: 0 }, { x: -11.1, z: -6.4 }, { x: -6.4, z: -11.1 },
    { x: -5.3, z: -5.3 }, { x: 0, z: -7.5 }, { x: -5.3, z: 5.3 }, { x: 6.5, z: 3.7 }
  ],
  beacon: null,
  doors: []
} as const satisfies ArenaLayout

export const SPIRAL: Stage = {
  id: "spiral",
  layout: SPIRAL_ARENA,
  hazard: {
    kind: "beam",
    x: SPIRE.x,
    z: SPIRE.z,
    from: SPIRE.radius,
    halfWidth: 0.3,
    speed: radians(40),
    sweep: radians(270),
    rest: Clock.duration(step, 5),
    lead: Clock.duration(step, 1),
    first: Clock.duration(step, 3),
    startAngle: -Math.PI / 2
  },
  knockback: 1
}
