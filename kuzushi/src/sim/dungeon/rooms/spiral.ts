import { Clock, Ops } from "@typeonce/ritmo"

import type { Pillar, Point } from "../../arena.ts"
import { radians } from "../../geometry.ts"
import type { BeamHazard, StageHazard } from "../../stages.ts"
import { SPIRAL_ARENA } from "../../stages/spiral.ts"
import { seconds, step } from "../../time.ts"
import { BOSS, ORRERY } from "../../tuning.ts"
import { room } from "../plan.ts"
import type { RoomTemplate, TemplateRole } from "../plan.ts"

/**
 * The Spiral's rooms: round stone dials inside a ring wall 1.2 thick and 0.9 high, each doorway a 3-wide cut through
 * the ring at a compass point. The spire and its beam stand only in well and dial rooms (docs/DESIGN.md, Spiral rooms).
 */

/** A point `distance` from the centre at `degrees`, counted from east toward south. */
const polar = (degrees: number, distance: number): Point => ({ x: Ops.cos(radians(degrees)) * distance, z: Ops.sin(radians(degrees)) * distance })

const pillarAt = (degrees: number, distance: number, radius: number, height: number): Pillar => ({ ...polar(degrees, distance), radius, height })

const diagonals = (distance: number, radius: number, height: number): ReadonlyArray<Pillar> =>
  [45, 135, 225, 315].map((degrees) => pillarAt(degrees, distance, radius, height))

/** The beam from a spire of `radius` at the centre, sweeping 270° at `degreesPerSecond`, resting `rest` seconds between sweeps. */
const beam = (radius: number, degreesPerSecond: number, rest = 5): BeamHazard => ({
  kind: "beam",
  x: 0,
  z: 0,
  from: radius,
  halfWidth: 0.3,
  speed: radians(degreesPerSecond),
  sweep: radians(270),
  rest: seconds(rest),
  lead: Clock.duration(step, 1),
  first: Clock.duration(step, 3),
  startAngle: -Math.PI / 2
})

/** The Orrery's beam from its 50% shift: it is the spire, and the first telegraph shows as the shift ends. */
const ORRERY_BEAM: BeamHazard = { ...beam(ORRERY.beam.from, 40), speed: ORRERY.beam.speed, sweep: ORRERY.beam.sweep, rest: ORRERY.beam.rest, first: BOSS.shift }

interface Dial {
  readonly role: TemplateRole
  readonly name: string
  readonly radius: number
  readonly pillars?: ReadonlyArray<Pillar>
  readonly altars?: ReadonlyArray<Point>
  readonly spring?: Point
  readonly hazard?: StageHazard
  readonly bossHazard?: StageHazard
}

const dial = (plan: Dial): RoomTemplate => room({
  zone: "spiral",
  role: plan.role,
  name: plan.name,
  halfWidth: plan.radius,
  halfDepth: plan.radius,
  wall: 1.2,
  wallHeight: 0.9,
  tile: 2,
  floor: { kind: "round", radius: plan.radius },
  blocks: [],
  pillars: plan.pillars ?? [],
  altars: plan.altars ?? [],
  spring: plan.spring ?? null,
  bossOffset: 0,
  hazard: plan.hazard ?? { kind: "none" },
  ...(plan.bossHazard === undefined ? {} : { bossHazard: plan.bossHazard })
})

/** Seven pillars on a spiral from radius 9.5 at 22.5° in to radius 4 at 292.5°, thinner and taller as they wind in. */
const COLONNADE: ReadonlyArray<Pillar> = Array.from({ length: 7 }, (_, index) =>
  pillarAt(22.5 + index * 45, 9.5 - (index * 5.5) / 6, 0.9 - (index * 0.2) / 6, 2.4 + (index * 3.6) / 6))

const WELL_SPIRE: Pillar = { x: 0, z: 0, radius: 1.4, height: 9 }

export const SPIRAL_ROOMS = {
  "spiral.gnomon": dial({
    role: "start",
    name: "Gnomon",
    radius: 9,
    pillars: [{ x: 0, z: 0, radius: 1.2, height: 1.6 }],
    altars: [polar(210, 4.5), polar(270, 3.3), polar(330, 4.5)]
  }),
  "spiral.shrine": dial({
    role: "shrine",
    name: "Shrine",
    radius: 8,
    pillars: diagonals(5.5, 0.7, 3),
    altars: [{ x: -2.2, z: 0 }, { x: 2.2, z: 0 }],
    spring: { x: 0, z: 0 }
  }),
  "spiral.ring": dial({ role: "small", name: "Ring", radius: 10, pillars: diagonals(5.5, 0.8, 3.5) }),
  "spiral.colonnade": dial({ role: "medium", name: "Colonnade", radius: 12, pillars: COLONNADE }),
  "spiral.well": dial({ role: "medium", name: "Well", radius: 12, pillars: [...diagonals(7.5, 0.85, 4), WELL_SPIRE], hazard: beam(WELL_SPIRE.radius, 30) }),
  "spiral.dial": dial({ role: "large", name: "Dial", radius: 15, pillars: SPIRAL_ARENA.pillars, hazard: beam(2, 40) }),
  "spiral.orrery": dial({
    role: "boss",
    name: "Orrery",
    radius: 15,
    pillars: [30, 90, 150, 210, 270, 330].map((degrees) => pillarAt(degrees, 9.5, 1.0, 4.5)),
    bossHazard: ORRERY_BEAM
  })
} as const satisfies Record<`spiral.${string}`, RoomTemplate>
