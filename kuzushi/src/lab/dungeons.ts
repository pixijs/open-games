import { dungeonSeedOf, generateDungeon, SIDE_DIRS, sides, templateOf } from "../sim/index.ts"
import type { RoomRecord, Side, TemplateId, ZoneId } from "../sim/index.ts"

/** A zone's dungeon for a run's seed as the generator makes it, every room known: what the lab's map and room pickers read. */
export interface Plan {
  readonly zone: ZoneId
  /** The run's seed, as `startZone` takes it. */
  readonly seed: number
  readonly rooms: ReadonlyArray<RoomRecord>
  /** Each room's sides with a door to another room. */
  readonly exits: ReadonlyArray<ReadonlyArray<Side>>
  /** Room indices from the start to the boss room, both included. */
  readonly path: ReadonlyArray<number>
}

/** Seeds the pickers search, from 1. */
const SEARCH = 600

/** A template's name without its zone: "forecourt" for "courtyard.forecourt". */
export const templateName = (template: string): string => template.slice(template.indexOf(".") + 1)

const cellOf = (room: RoomRecord, side: Side) => ({ column: room.column + SIDE_DIRS[side].x, row: room.row + SIDE_DIRS[side].z })

/** The room through `side` of room `index`, if any. */
export const neighbour = (rooms: ReadonlyArray<RoomRecord>, index: number, side: Side): number | undefined => {
  const room = rooms[index]
  if (room === undefined) return undefined
  const cell = cellOf(room, side)
  const found = rooms.findIndex((each) => each.column === cell.column && each.row === cell.row)
  return found < 0 ? undefined : found
}

const exitsOf = (rooms: ReadonlyArray<RoomRecord>, index: number): ReadonlyArray<Side> =>
  sides.filter((side) => neighbour(rooms, index, side) !== undefined)

/** The shortest way through the doors from room `from` to room `to`, both included; empty when there is none. */
const pathBetween = (rooms: ReadonlyArray<RoomRecord>, from: number, to: number): ReadonlyArray<number> => {
  const before = new Map<number, number>([[from, from]])
  const queue = [from]
  for (let at = 0; at < queue.length; at++) {
    const index = queue[at] ?? from
    if (index === to) break
    for (const side of sides) {
      const next = neighbour(rooms, index, side)
      if (next === undefined || before.has(next)) continue
      before.set(next, index)
      queue.push(next)
    }
  }
  if (!before.has(to)) return []
  const path = [to]
  while ((path[0] ?? from) !== from) path.unshift(before.get(path[0] ?? from) ?? from)
  return path
}

const cache = new Map<string, Plan>()

/** The dungeon `seed` makes in `zone`, with each room's doors and the way to the boss. */
export const planOf = (zone: ZoneId, seed: number): Plan => {
  const key = `${zone}:${seed}`
  const known = cache.get(key)
  if (known !== undefined) return known
  const rooms = generateDungeon(zone, dungeonSeedOf(seed))
  const boss = rooms.findIndex((room) => room.kind === "boss")
  const plan: Plan = { zone, seed, rooms, exits: rooms.map((_, index) => exitsOf(rooms, index)), path: boss < 0 ? [] : pathBetween(rooms, 0, boss) }
  if (cache.size > 200) cache.clear()
  cache.set(key, plan)
  return plan
}

/** Where a template is used: a seed and the room built from it there. */
export interface Placement {
  readonly seed: number
  readonly index: number
  readonly exits: ReadonlyArray<Side>
}

const searchRoom = (template: TemplateId, mirrorX: boolean, mirrorZ: boolean): Placement | null => {
  const zone = templateOf(template).zone
  let best: Placement | null = null
  for (let seed = 1; seed <= SEARCH; seed++) {
    const plan = planOf(zone, seed)
    for (const [index, room] of plan.rooms.entries()) {
      if (room.template !== template || room.mirrorX !== mirrorX || room.mirrorZ !== mirrorZ) continue
      const exits = plan.exits[index] ?? []
      if (best === null || exits.length > best.exits.length) best = { seed, index, exits }
    }
    if (best !== null && best.exits.length === 4) return best
  }
  return best
}

/** Each search's answer, kept: a search that never meets four doors plans every seed up to SEARCH, more than planOf keeps. */
const placements = new Map<string, Placement | null>()

/**
 * The first seed whose dungeon builds `template` mirrored as asked, in the room with the most doors (all four ends the
 * search), so the room shows as many doorways as it can. Null when no seed up to the search's end does.
 */
export const findRoom = (template: TemplateId, mirrorX: boolean, mirrorZ: boolean): Placement | null => {
  const key = `${template}:${mirrorX}:${mirrorZ}`
  const known = placements.get(key)
  if (known !== undefined) return known
  const placed = searchRoom(template, mirrorX, mirrorZ)
  placements.set(key, placed)
  return placed
}

/** The first seed whose start room in `zone` has a door on every side, so a door can be walked through each way. */
export const crossroads = (zone: ZoneId): number => {
  for (let seed = 1; seed <= SEARCH; seed++) {
    if ((planOf(zone, seed).exits[0] ?? []).length === 4) return seed
  }
  return 1
}
