import { buildTerrain } from "./arena.ts"
import type { ArenaLayout, Terrain } from "./arena.ts"
import { COURTYARD } from "./stages/courtyard.ts"
import { SPIRAL } from "./stages/spiral.ts"
import { VOID } from "./stages/void.ts"
import type { Duration } from "./time.ts"
import { zoneIds } from "./zones.ts"
import type { ZoneId } from "./zones.ts"

/**
 * The stages, one per zone and named by its id: each zone's classic arena and its hazard, in its own file in
 * ./stages/. The sandbox plays on these arenas, the title stands in The Courtyard's, and a zone's rooms grow from
 * its stage (src/sim/dungeon/).
 */
export const stageIds = zoneIds
export type StageId = ZoneId

/** The Spiral's beam: it sweeps clockwise on screen from the spire's surface out to the first pillar or the wall. */
export interface BeamHazard {
  readonly kind: "beam"
  /** The spire's centre, and its radius, where the beam starts. */
  readonly x: number
  readonly z: number
  readonly from: number
  readonly halfWidth: number
  /** Radians per second. */
  readonly speed: number
  /** How far one sweep turns, in radians. */
  readonly sweep: number
  readonly rest: Duration
  /** How long the telegraph shows before a sweep, and how far ahead of the beam it runs during one. */
  readonly lead: Duration
  /** From the run's start to the first telegraph. */
  readonly first: Duration
  readonly startAngle: number
}

/** The Void's collapse: after the waves its slabs name, they crack for `crack` and fall. */
export interface CollapseHazard {
  readonly kind: "collapse"
  readonly crack: Duration
}

export type StageHazard = { readonly kind: "none" } | BeamHazard | CollapseHazard

/** A zone's classic arena: its name and number are the zone's (`zoneOf`). */
export interface Stage {
  readonly id: StageId
  readonly layout: ArenaLayout
  readonly hazard: StageHazard
  /** How far blows knock enemies back here, as a factor of their usual push. */
  readonly knockback: number
}

const BY_ID = { courtyard: COURTYARD, spiral: SPIRAL, void: VOID } as const satisfies Record<StageId, Stage>

export const STAGES: ReadonlyArray<Stage> = stageIds.map((id) => BY_ID[id])

export const stageOf = (id: StageId): Stage => BY_ID[id]

/** Slabs that fall together after one wave (in a boss room, one phase), by their index in the layout. */
export interface SlabGroup {
  readonly after: number
  readonly slabs: ReadonlyArray<number>
}

/** The groups of slabs that fall, in the order they fall. */
export const slabGroupsOf = (layout: ArenaLayout): ReadonlyArray<SlabGroup> => {
  if (layout.floor.kind !== "slabs") return []
  const slabs = layout.floor.slabs
  const waves = [...new Set(slabs.flatMap((slab) => slab.fallsAfter === null ? [] : [slab.fallsAfter]))].sort((a, b) => a - b)
  return waves.map((after) => ({ after, slabs: slabs.flatMap((slab, index) => slab.fallsAfter === after ? [index] : []) }))
}

/** The slabs gone once the first `fallen` groups have fallen, by their index in the layout. */
export const fallenSlabs = (layout: ArenaLayout, fallen: number): ReadonlySet<number> =>
  new Set(slabGroupsOf(layout).slice(0, fallen).flatMap((group) => group.slabs))

/** The terrain after each count of fallen groups: index 0 is the whole floor. */
const terrainsOf = (stage: Stage): ReadonlyArray<Terrain> =>
  Array.from({ length: slabGroupsOf(stage.layout).length + 1 }, (_, fallen) => {
    const gone = fallenSlabs(stage.layout, fallen)
    return buildTerrain(stage.layout, (index) => !gone.has(index))
  })

const TERRAINS = {
  courtyard: terrainsOf(COURTYARD),
  spiral: terrainsOf(SPIRAL),
  void: terrainsOf(VOID)
} as const satisfies Record<StageId, ReadonlyArray<Terrain>>

/** The ground a stage's bodies move on once `fallen` of its slab groups have fallen. */
export const terrainOf = (id: StageId, fallen: number): Terrain => {
  const terrains = TERRAINS[id]
  return terrains[Math.min(terrains.length - 1, Math.max(0, fallen))] ?? terrains[0] ?? buildTerrain(stageOf(id).layout)
}
