import { Clock } from "@typeonce/ritmo"
import type { Random } from "@typeonce/ritmo"

import { startingHazard } from "../hazards.ts"
import { ROOM_KINDS, SIDE_DIRS } from "../rooms.ts"
import type { Side } from "../rooms.ts"
import type { HazardValue, StageValue, WavesValue } from "../schema.ts"
import { NORTH } from "../spawning.ts"
import { weaponIds } from "../weapons.ts"
import type { WeaponId } from "../weapons.ts"
import { zoneOf } from "../zones.ts"
import { exitsOf, gateSideOf } from "./generate.ts"
import { arrivalOf } from "./layout.ts"
import { DOOR } from "./rules.ts"
import type { RoomGround, RoomRecord, ZoneDungeon } from "./schema.ts"
import { templateOf } from "./templates.ts"

/** Whether the room still has a fight to win. */
export const fights = (record: RoomRecord): boolean => ROOM_KINDS[record.kind].fight && record.state !== "cleared"

/** The sides of room `index` with a door, the boss room's gate among them once its boss has fallen (zones 1 and 2). */
const exitsFor = (dungeon: ZoneDungeon, index: number): ReadonlyArray<Side> => {
  const record = dungeon.rooms[index]
  const doors = record === undefined ? [] : exitsOf(dungeon.rooms, record)
  if (record?.kind !== "boss" || record.state !== "cleared" || zoneOf(dungeon.zone).next === null) return doors
  return [...doors, gateSideOf(dungeon.rooms, index)]
}

/** The terrain's view of room `index` with its seals as given. */
export const groundFor = (dungeon: ZoneDungeon, index: number, sealed: boolean): RoomGround | null => {
  const record = dungeon.rooms[index]
  if (record === undefined) return null
  return {
    index,
    template: record.template,
    mirrorX: record.mirrorX,
    mirrorZ: record.mirrorZ,
    exits: exitsFor(dungeon, index),
    gate: record.kind === "boss" && zoneOf(dungeon.zone).next !== null ? gateSideOf(dungeon.rooms, index) : null,
    sealed,
    broken: record.broken,
    lit: record.lit
  }
}

/** The map after the player enters room `index`: it is visited (cleared at once when it has no fight) and its neighbours are seen. */
const marked = (dungeon: ZoneDungeon, index: number): ReadonlyArray<RoomRecord> => {
  const entered = dungeon.rooms[index]
  if (entered === undefined) return dungeon.rooms
  const near = new Set(exitsOf(dungeon.rooms, entered).map((side) => `${entered.column + SIDE_DIRS[side].x},${entered.row + SIDE_DIRS[side].z}`))
  return dungeon.rooms.map((record, at) => {
    if (at === index) return { ...record, state: record.state === "cleared" || !ROOM_KINDS[record.kind].fight ? "cleared" : "visited" }
    if (record.state === "hidden" && (dungeon.revealed || near.has(`${record.column},${record.row}`))) return { ...record, state: "seen" }
    return record
  })
}

/** A weapon room's two altars, stocked the first time it is entered with two of the three weapons not in hand. */
const stocked = (random: Random.Random, record: RoomRecord, hand: WeaponId): RoomRecord => {
  if (record.altars !== null) return record
  const others = random.shuffle(weaponIds.filter((weapon) => weapon !== hand))
  return { ...record, altars: others.slice(0, templateOf(record.template).altars.length) }
}

/** Everything a room sets when the player arrives in it. */
export interface Arrival {
  readonly dungeon: ZoneDungeon
  readonly stage: StageValue
  readonly hazard: HazardValue
  readonly waves: WavesValue
  readonly body: { readonly x: number; readonly z: number; readonly facing: number }
}

/**
 * The player arrives in room `index` through its `entry` side (its south door when null): the map marks it, a weapon
 * room stocks its altars, its slabs stand as they were left, its hazard waits for its doors to lock, and a room still
 * to win arms its doors (to lock `DOOR.lockDelay` after control returns: now, when `control` says so).
 */
export const arrive = (
  dungeon: ZoneDungeon,
  index: number,
  entry: Side | null,
  stage: StageValue,
  play: Clock.Time<60>,
  random: Random.Random,
  hand: WeaponId,
  control: boolean
): Arrival => {
  const rooms = marked({ ...dungeon, current: index }, index).map((record, at) => (at === index ? stocked(random, record, hand) : record))
  const next: ZoneDungeon = { ...dungeon, rooms, current: index }
  const record = rooms[index]
  const ground = groundFor(next, index, false)
  if (record === undefined || ground === null) {
    return { dungeon: next, stage, hazard: { _tag: "None" }, waves: { _tag: "Idle" }, body: { x: 0, z: 0, facing: NORTH } }
  }
  return {
    dungeon: next,
    stage: { ...stage, id: dungeon.zone, room: ground },
    hazard: startingHazard(templateOf(record.template).hazard, play, record.fallen),
    waves: fights(record) ? { _tag: "Arming", until: control ? Clock.deadline(play, DOOR.lockDelay) : null } : { _tag: "Idle" },
    body: arrivalOf(record, entry ?? "south")
  }
}
