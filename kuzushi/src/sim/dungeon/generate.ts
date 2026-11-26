import { Random } from "@typeonce/ritmo"

import { opposite, SIDE_DIRS, sides } from "../rooms.ts"
import type { RoomKind, Side } from "../rooms.ts"
import { zoneOf } from "../zones.ts"
import type { ZoneId } from "../zones.ts"
import { mirror } from "./layout.ts"
import { eliteWave, POOLS, rosterOf, tiersOf } from "./pools.ts"
import type { Tier, WaveSlot } from "./pools.ts"
import { GRID, SEED_MAX } from "./rules.ts"
import type { RoomRecord } from "./schema.ts"
import { templateOf, templatesFor } from "./templates.ts"
import type { TemplateId } from "./templates.ts"
import type { TemplateRole } from "./plan.ts"

/** A room's cell on the map's grid. */
export interface Cell {
  readonly column: number
  readonly row: number
}

/** What a zone's dungeon must have to be kept: enough dead ends, the deepest one deep enough for the boss. */
const NEEDS = {
  courtyard: { deadEnds: 3, bossDepth: 3 },
  spiral: { deadEnds: 4, bossDepth: 4 },
  void: { deadEnds: 4, bossDepth: 4 }
} as const satisfies Record<ZoneId, { readonly deadEnds: number; readonly bossDepth: number }>

const step = (cell: Cell, side: Side): Cell => ({ column: cell.column + SIDE_DIRS[side].x, row: cell.row + SIDE_DIRS[side].z })

const same = (a: Cell, b: Cell) => a.column === b.column && a.row === b.row

const onGrid = (cell: Cell) => cell.column >= 0 && cell.row >= 0 && cell.column < GRID.columns && cell.row < GRID.rows

/** The sides of `cell` with a room behind them. */
export const exitsOf = (cells: ReadonlyArray<Cell>, cell: Cell): ReadonlyArray<Side> =>
  sides.filter((side) => cells.some((other) => same(other, step(cell, side))))

/**
 * The Binding of Isaac's growth: breadth first from the start, each neighbour north, east, south, west becoming a room
 * unless it is off the grid, taken, next to more than one room, the count is reached, or a coin says no. Null when
 * the queue empties short of `count`.
 */
const grow = (random: Random.Random, count: number): ReadonlyArray<Cell> | null => {
  const cells: Array<Cell> = [GRID.start]
  const queue: Array<Cell> = [GRID.start]
  for (let at = 0; at < queue.length && cells.length < count; at++) {
    const cell = queue[at] ?? GRID.start
    for (const side of sides) {
      if (cells.length >= count) break
      const next = step(cell, side)
      if (!onGrid(next) || cells.some((other) => same(other, next))) continue
      if (exitsOf(cells, next).length > 1) continue
      if (random.next() < 0.5) continue
      cells.push(next)
      queue.push(next)
    }
  }
  return cells.length === count ? cells : null
}

/** Each room's distance in doors from the start (index 0). */
const depthsOf = (cells: ReadonlyArray<Cell>): ReadonlyArray<number> => {
  const depths: Array<number> = cells.map((_, index) => (index === 0 ? 0 : -1))
  const queue = [0]
  for (let at = 0; at < queue.length; at++) {
    const index = queue[at] ?? 0
    const cell = cells[index] ?? GRID.start
    for (const side of exitsOf(cells, cell)) {
      const next = cells.findIndex((other) => same(other, step(cell, side)))
      if (next < 0 || (depths[next] ?? 0) >= 0) continue
      depths[next] = (depths[index] ?? 0) + 1
      queue.push(next)
    }
  }
  return depths
}

/** The rooms on the way from the start to room `to`, stepping back through a neighbour one door nearer each time. */
const wayTo = (cells: ReadonlyArray<Cell>, depths: ReadonlyArray<number>, to: number): ReadonlySet<number> => {
  const way = new Set<number>()
  let at = to
  while (at >= 0 && !way.has(at)) {
    way.add(at)
    const cell = cells[at] ?? GRID.start
    const depth = depths[at] ?? 0
    at = depth <= 0 ? -1 : exitsOf(cells, cell).map((side) => cells.findIndex((other) => same(other, step(cell, side)))).find((next) => next >= 0 && depths[next] === depth - 1) ?? -1
  }
  return way
}

/** Rooms other than the start with one neighbour, deepest first (ties to the earlier room). */
const deadEndsOf = (cells: ReadonlyArray<Cell>, depths: ReadonlyArray<number>): ReadonlyArray<number> =>
  cells.flatMap((cell, index) => (index > 0 && exitsOf(cells, cell).length === 1 ? [index] : []))
    .sort((a, b) => (depths[b] ?? 0) - (depths[a] ?? 0) || a - b)

/**
 * The marked rooms by dead ends from the deepest: the boss, the weapon room, the spring, then (zones 2 and 3) the elite.
 * Short of dead ends, the deepest rooms left take them; an elite without a dead end takes the deepest room not next to
 * the boss.
 */
const kindsOf = (zone: ZoneId, cells: ReadonlyArray<Cell>, depths: ReadonlyArray<number>): ReadonlyArray<RoomKind> => {
  const kinds: Array<RoomKind> = cells.map((_, index) => (index === 0 ? "start" : "combat"))
  const deepest = cells.map((_, index) => index).filter((index) => index > 0).sort((a, b) => (depths[b] ?? 0) - (depths[a] ?? 0) || a - b)
  const ends = deadEndsOf(cells, depths)
  const marked: ReadonlyArray<RoomKind> = zone === "courtyard" ? ["boss", "weapon", "spring"] : ["boss", "weapon", "spring", "elite"]
  for (const kind of marked) {
    const free = (index: number) => kinds[index] === "combat"
    const boss = kinds.indexOf("boss")
    const nextToBoss = (index: number) => boss >= 0 && exitsOf(cells, cells[index] ?? GRID.start).some((side) => same(step(cells[index] ?? GRID.start, side), cells[boss] ?? GRID.start))
    const pick = ends.find(free) ?? deepest.find((index) => free(index) && (kind !== "elite" || !nextToBoss(index)))
    if (pick !== undefined) kinds[pick] = kind
  }
  return kinds
}

/** Whether a grown dungeon has what the zone needs. */
const fits = (zone: ZoneId, cells: ReadonlyArray<Cell>, depths: ReadonlyArray<number>): boolean => {
  const ends = deadEndsOf(cells, depths)
  return ends.length >= NEEDS[zone].deadEnds && (depths[ends[0] ?? 0] ?? 0) >= NEEDS[zone].bossDepth
}

const roleOf = (kind: RoomKind, depth: number): TemplateRole => {
  switch (kind) {
    case "start": return "start"
    case "weapon":
    case "spring": return "shrine"
    case "boss": return "boss"
    case "elite": return depth <= 3 ? "medium" : "large"
    case "combat": return depth <= 1 ? "small" : depth <= 3 ? "medium" : "large"
  }
}

/** A room's waves: one entry per tier its depth draws, never the same entry twice in a room; an elite room adds its elite wave. */
const wavesOf = (random: Random.Random, zone: ZoneId, kind: RoomKind, depth: number): ReadonlyArray<ReadonlyArray<WaveSlot>> => {
  if (kind !== "combat" && kind !== "elite") return []
  const taken: Record<Tier, Array<number>> = { light: [], medium: [], heavy: [] }
  const waves = tiersOf(depth).map((tier) => {
    const pool = POOLS[zone][tier]
    const left = pool.map((_, index) => index).filter((index) => !taken[tier].includes(index))
    const index = random.pick(left) ?? 0
    taken[tier].push(index)
    return rosterOf(pool[index] ?? pool[0]).map((each) => ({ kind: each, elite: false }))
  })
  if (kind !== "elite") return waves
  const roster = zoneOf(zone).roster
  return [...waves, eliteWave(roster[0], random.pick(roster) ?? roster[0])]
}

/** The seed of a run's first dungeon: the first draw of the run's generator, seeded with the run's seed (flow.ts draws it so; a test holds the two together). */
export const dungeonSeedOf = (runSeed: number): number => Random.make(runSeed).integer(1, SEED_MAX)

/**
 * A zone's dungeon from `seed`: grown on the grid until it has what the zone needs (or the tries run out, keeping the
 * last that reached the count), its rooms' kinds placed, its caches marked (the combat rooms off the way from the
 * start to the boss), and each room's template (never a neighbour's when its size
 * has more than one), mirroring and waves drawn, in room order. The same zone and seed make the same dungeon.
 */
export const generateDungeon = (zone: ZoneId, seed: number): ReadonlyArray<RoomRecord> => {
  const random = Random.make(seed)
  const count = zoneOf(zone).rooms
  let cells: ReadonlyArray<Cell> | null = null
  for (let attempt = 0; attempt < GRID.tries; attempt++) {
    const grown = grow(random, count)
    if (grown === null) continue
    cells = grown
    if (fits(zone, grown, depthsOf(grown))) break
  }
  const rooms = cells ?? [GRID.start]
  const depths = depthsOf(rooms)
  const kinds = kindsOf(zone, rooms, depths)
  const way = wayTo(rooms, depths, kinds.indexOf("boss"))
  const templates: Array<TemplateId> = []
  return rooms.map((cell, index): RoomRecord => {
    const kind = kinds[index] ?? "combat"
    const depth = depths[index] ?? 0
    const options = templatesFor(zone, roleOf(kind, depth))
    const nextDoor = exitsOf(rooms, cell).flatMap((side) => {
      const other = rooms.findIndex((each) => same(each, step(cell, side)))
      return other >= 0 && other < index ? [templates[other]] : []
    })
    const fresh = options.filter((id) => !nextDoor.includes(id))
    const template = random.pick(options.length >= 2 && fresh.length > 0 ? fresh : options) ?? options[0] ?? "courtyard.yard"
    templates.push(template)
    const placed = { mirrorX: random.next() < 0.5, mirrorZ: random.next() < 0.5 }
    const spring = templateOf(template).spring
    return {
      column: cell.column,
      row: cell.row,
      kind,
      depth,
      template,
      ...placed,
      waves: wavesOf(random, zone, kind, depth),
      state: "hidden",
      fallen: 0,
      broken: [],
      lit: false,
      altars: kind === "weapon" ? null : [],
      spring: kind === "spring" && spring !== null ? { ...mirror(placed, spring), spent: false } : null,
      cache: kind === "combat" && !way.has(index),
      drops: []
    }
  })
}

/** The side of room `from` whose door leads to room `to`, when they are next door; else the way toward it on the grid. */
export const sideToward = (from: Cell, to: Cell): Side => {
  const found = sides.find((side) => same(step(from, side), to))
  if (found !== undefined) return found
  const dx = to.column - from.column
  const dz = to.row - from.row
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "east" : "west") : dz > 0 ? "south" : "north"
}

/** The room next door through `side`, by index, if there is one. */
export const roomThrough = (rooms: ReadonlyArray<Cell>, from: number, side: Side): number | undefined => {
  const cell = rooms[from]
  if (cell === undefined) return undefined
  const index = rooms.findIndex((each) => same(each, step(cell, side)))
  return index < 0 ? undefined : index
}

/** The boss room's gate: in the wall opposite its one door. */
export const gateSideOf = (rooms: ReadonlyArray<Cell>, index: number): Side => {
  const cell = rooms[index] ?? GRID.start
  const door = exitsOf(rooms, cell)[0] ?? "south"
  return opposite[door]
}
