import { buildTerrain } from "./arena.ts"
import type { ArenaLayout, Terrain } from "./arena.ts"
import { roomLayout, roomTerrain } from "./dungeon/layout.ts"
import { templateOf } from "./dungeon/templates.ts"
import type { HazardValue, StageValue } from "./schema.ts"
import { stageOf, terrainOf } from "./stages.ts"
import type { StageHazard } from "./stages.ts"
import { ARENA } from "./stages/courtyard.ts"

/** The debug scenes' open floor: The Courtyard's size and boundary walls, with no props and nothing beyond. */
export const OPEN_FLOOR: ArenaLayout = { ...ARENA, name: "Open floor", blocks: [], pillars: [], backdrop: [], start: { x: 0, z: 0 } }

const OPEN_TERRAIN = buildTerrain(OPEN_FLOOR)

/** The ground as its terrain needs it: the zone, and the room the player is in (null on its classic arena). */
export type Ground = Pick<StageValue, "id" | "open" | "room">

/** How many of the floor's slab groups have fallen; 0 on every other floor. */
export const fallenOf = (hazard: HazardValue): number =>
  hazard._tag === "FloorSteady" || hazard._tag === "FloorCracking" ? hazard.fallen : 0

/** The plan of the floor the player is on: the room's (mirrored, with its doorways), or the zone's classic arena. */
export const layoutOf = (stage: Ground): ArenaLayout => (stage.room === null ? stageOf(stage.id).layout : roomLayout(stage.room))

/** The hazard the floor carries: the room's template's (its boss hazard once a shift lit it), or the classic arena's. */
export const hazardOf = (stage: Ground): StageHazard => {
  if (stage.room === null) return stageOf(stage.id).hazard
  const template = templateOf(stage.room.template)
  return stage.room.lit ? template.bossHazard ?? template.hazard : template.hazard
}

/** How far blows knock enemies back on this floor, as a factor of their usual push: further in The Void. */
export const knockbackOf = (stage: Ground): number => stageOf(stage.id).knockback

/** Whether the hazard runs: switched on, and in a room only while its doors are sealed for its fight. */
export const hazardLive = (stage: Pick<StageValue, "hazard" | "room">): boolean => stage.hazard && (stage.room === null || stage.room.sealed)

/** The terrain bodies move on right now: the floor with any fallen slabs gone, or the debug open floor. */
export const groundOf = (stage: Ground, hazard: HazardValue): Terrain =>
  stage.open ? OPEN_TERRAIN : stage.room === null ? terrainOf(stage.id, fallenOf(hazard)) : roomTerrain(stage.room, fallenOf(hazard))

/** The terrains bodies move on now and, while slabs crack, once they have fallen. */
export const groundsAheadOf = (stage: Ground, hazard: HazardValue): ReadonlyArray<Terrain> =>
  hazard._tag === "FloorCracking"
    ? [groundOf(stage, hazard), groundOf(stage, { _tag: "FloorSteady", fallen: hazard.fallen + 1 })]
    : [groundOf(stage, hazard)]
