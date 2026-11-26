import { Clock } from "@typeonce/ritmo"

import { doorLine, onSide } from "../arena.ts"
import { within } from "../geometry.ts"
import { ROOM_KINDS } from "../rooms.ts"
import type { AltarView, DoorView, MapView, RoomView, TransitionView } from "../rooms.ts"
import type { StageValue, WavesValue } from "../schema.ts"
import { enemyKinds } from "../tuning.ts"
import type { EnemyKind } from "../tuning.ts"
import type { ZoneId } from "../zones.ts"
import { exitsOf, roomThrough } from "./generate.ts"
import { altarSpots, roomLayout } from "./layout.ts"
import { BEATS, DOOR, GRID, ROOM, rankOf } from "./rules.ts"
import type { Rank } from "./rules.ts"
import type { DungeonValue, TransitionValue } from "./schema.ts"
import { templateOf } from "./templates.ts"
import { beatLengths, timingOf } from "./transitions.ts"

/** The zone's dungeon as the map draws it, or null on a classic arena. */
export const mapView = (dungeon: DungeonValue): MapView | null => {
  if (dungeon._tag !== "Zone") return null
  return {
    zone: dungeon.zone,
    columns: GRID.columns,
    rows: GRID.rows,
    rooms: dungeon.rooms.map((record, index) => ({
      index,
      column: record.column,
      row: record.row,
      kind: record.kind,
      state: record.state,
      depth: record.depth,
      exits: exitsOf(dungeon.rooms, record),
      cache: record.cache
    })),
    current: dungeon.current
  }
}

/** The room the player is in: its plan, its doors and what their seals carry, its altars, its spring and its clear's drops. */
export const roomView = (dungeon: DungeonValue, stage: StageValue, player: { readonly x: number; readonly z: number } | null): RoomView | null => {
  const ground = stage.room
  if (dungeon._tag !== "Zone" || ground === null) return null
  const record = dungeon.rooms[ground.index]
  if (record === undefined) return null
  const template = templateOf(record.template)
  const doors = ground.exits.map((side): DoorView => {
    const gate = side === ground.gate
    const to = gate ? null : roomThrough(dungeon.rooms, ground.index, side) ?? null
    const behind = to === null ? undefined : dungeon.rooms[to]
    const mouth = onSide(side, doorLine(template, side))
    return {
      side,
      x: mouth.x,
      z: mouth.z,
      width: DOOR.width,
      state: ground.sealed ? "locked" : "open",
      to,
      mark: gate ? "gate" : behind === undefined || behind.state === "hidden" ? null : ROOM_KINDS[behind.kind].marked ? behind.kind : behind.cache && behind.state !== "cleared" ? "cache" : null
    }
  })
  const spots = altarSpots(record)
  const altars = (record.altars ?? []).flatMap((weapon, index): ReadonlyArray<AltarView> => {
    const spot = spots[index]
    if (spot === undefined) return []
    return [{ index, x: spot.x, z: spot.z, weapon, near: player !== null && weapon !== null && within(player.x, player.z, spot.x, spot.z, ROOM.altarReach) }]
  })
  return {
    index: ground.index,
    kind: record.kind,
    template: record.template,
    mirror: { x: record.mirrorX, z: record.mirrorZ },
    layout: roomLayout(ground),
    state: record.state,
    doors,
    altars,
    spring: record.spring === null ? null : { ...record.spring, radius: ROOM.springRadius },
    cache: record.cache,
    drops: record.drops.map((drop, index) => ({ index, ...drop }))
  }
}

/** The transition playing, with how far through its beat and the whole it is. */
export const transitionView = (transition: TransitionValue, dungeon: DungeonValue, time: Clock.Time<60>): TransitionView | null => {
  if (transition._tag === "None") return null
  const lengths = beatLengths(transition._tag)
  const at = transition._tag === "Door" ? BEATS.door.indexOf(transition.beat) : BEATS.zone.indexOf(transition.beat)
  const length = lengths[at] ?? 1
  const done = Math.min(length, Math.max(0, length - Clock.remaining(time, transition.until)))
  const before = lengths.slice(0, at).reduce((sum, steps) => sum + steps, 0)
  const { total } = timingOf(transition._tag)
  const zone: ZoneId = transition._tag === "Zone" ? transition.zone : dungeon._tag === "Zone" ? dungeon.zone : "courtyard"
  return {
    kind: transition._tag === "Door" ? "door" : "zone",
    side: transition.side,
    beat: transition.beat,
    progress: done / length,
    overall: (before + done) / total,
    swapped: transition.beat !== "exit" && transition.beat !== "cover",
    from: transition.from,
    to: transition._tag === "Door" ? transition.to : 0,
    zone
  }
}

/** How many of each kind a wave sends, the elite marked, in `enemyKinds` order. */
export interface WaveMix {
  readonly kind: EnemyKind
  readonly count: number
  readonly elite: boolean
}

/** The current room's waves as the HUD shows them: which wave (0 before the first), of how many, its phase and its mix. */
export interface RoomWaves {
  readonly index: number
  readonly total: number
  readonly phase: "idle" | "intro" | "fighting" | "cleared" | "done"
  readonly mix: ReadonlyArray<WaveMix>
}

export const roomWaves = (waves: WavesValue, dungeon: DungeonValue, stage: StageValue): RoomWaves => {
  const record = dungeon._tag === "Zone" && stage.room !== null ? dungeon.rooms[stage.room.index] : undefined
  const total = record?.waves.length ?? 0
  const mixOf = (wave: number): ReadonlyArray<WaveMix> => {
    const slots = record?.waves[wave - 1] ?? []
    return enemyKinds.flatMap((kind) => [false, true].flatMap((elite) => {
      const count = slots.filter((slot) => slot.kind === kind && slot.elite === elite).length
      return count > 0 ? [{ kind, count, elite }] : []
    }))
  }
  switch (waves._tag) {
    case "Idle": return { index: 0, total, phase: "idle", mix: [] }
    case "Arming": return { index: 0, total, phase: "idle", mix: mixOf(1) }
    case "Intro": return { index: waves.wave, total: waves.total, phase: "intro", mix: mixOf(waves.wave) }
    case "Fighting": return { index: waves.wave, total: waves.total, phase: "fighting", mix: mixOf(waves.wave) }
    case "Breath": return { index: waves.wave, total: waves.total, phase: "cleared", mix: mixOf(waves.wave + 1) }
    case "Clearing": return { index: total, total, phase: "cleared", mix: [] }
    case "Won": return { index: total, total, phase: "done", mix: [] }
  }
}

/** The run's tally for the results: where it began, rooms cleared, hits taken, and a won full run's rank. */
export interface RunView {
  /** The zone the run started in: a full run starts in The Courtyard. */
  readonly from: ZoneId
  /** A run on a classic arena with no fights (the debug scenes). */
  readonly sandbox: boolean
  readonly rooms: number
  readonly hits: number
  /** A won run started in zone 1: its time plus 30 s per hit against the ranks (docs/DESIGN.md, The run); else null. */
  readonly rank: Rank | null
}

export const runView = (
  run: { readonly from: ZoneId; readonly rooms: number; readonly hits: number },
  dungeon: DungeonValue,
  won: boolean,
  seconds: number
): RunView => ({
  from: run.from,
  sandbox: dungeon._tag === "None",
  rooms: run.rooms,
  hits: run.hits,
  rank: won && run.from === "courtyard" ? rankOf(seconds, run.hits) : null
})
