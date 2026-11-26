import { Clock } from "@typeonce/ritmo"

import { DOORWAY } from "../arena.ts"
import { step } from "../time.ts"

/** The dungeon's and the run's numbers (docs/DESIGN.md: The run, The dungeon, Doors, Waves in rooms, Transitions). */

/** Run and dungeon seeds are drawn from 1 to this, the largest 32-bit signed integer. */
export const SEED_MAX = 2147483647

export const GRID = {
  columns: 9,
  rows: 9,
  start: { column: 4, row: 4 },
  /** Fresh starts the generator may take (tests/dungeon.test.ts finds a dungeon well inside it for every seed tried). */
  tries: 500
} as const

export const DOOR = {
  /** The doorway's opening. */
  width: DOORWAY.width,
  /** How far past the floor's edge the player walks into an open door before the transition starts. */
  trigger: 0.6,
  /** Where the hero stands after a transition: this far inside the new room's door. */
  arrival: 1.6,
  /** The doors lock this long after control returns, once the player's whole body is `inside` (plus its radius) in from every door line. */
  lockDelay: Clock.duration(step, 0.4),
  inside: 0.6,
  /** How fast the hero is carried into the doorway while the transition's first beat plays, units per second. */
  carry: 18,
  /** No prop stands this near a door's mouth along its lane. */
  lane: 4
} as const

/** The beats of a transition in the order they play: a door holds on the new room, a zone change shows its card. */
export const BEATS = {
  door: ["exit", "cover", "hold", "reveal"],
  zone: ["exit", "cover", "card", "reveal"]
} as const

/** Steps of each beat of a transition (docs/DESIGN.md, Transitions). */
export const TRANSITION = {
  door: { exit: 8, cover: 18, hold: 36, reveal: 18 },
  zone: { exit: 10, cover: 30, card: 120, reveal: 36 }
} as const satisfies { readonly [Kind in keyof typeof BEATS]: Readonly<Record<(typeof BEATS)[Kind][number], number>> }

export const ROOM = {
  /** A cleared combat room's chance of dropping a diamond, per diamond missing. */
  healChance: 0.12,
  /** How near a drop's centre the player picks it up. */
  dropReach: 0.9,
  /** How far apart a clear's diamond and FOCUS stand. */
  dropApart: 1.3,
  /** What a cache's FOCUS drop fills. */
  cacheFocus: 40,
  /** How near an altar's centre the player takes its weapon. */
  altarReach: 1.4,
  springRadius: 1.4,
  /** From the last boss's defeat to the results. */
  runClear: Clock.duration(step, 3.0)
} as const

/**
 * Spawn points of a template: at least `fromDoor` from every door's mouth, clear of props and walls for the largest wave
 * enemy (`clearance`), `edge` in from any open edge, on a lattice `spacing` apart thinned to the `most` that spread widest.
 */
export const SPAWNS = {
  fromDoor: 4,
  clearance: 1.0,
  edge: 0.6,
  spacing: 2,
  most: 16
} as const

export type Rank = "S" | "A" | "B" | "C"

/** A full run's rank: its time plus `hitPenalty` seconds per hit taken, against each rank's limit in seconds. */
export const RANK = {
  hitPenalty: 30,
  limits: [["S", 14 * 60], ["A", 19 * 60], ["B", 26 * 60]] as const satisfies ReadonlyArray<readonly [Rank, number]>
} as const

export const rankOf = (seconds: number, hits: number): Rank => {
  const score = seconds + hits * RANK.hitPenalty
  return RANK.limits.find(([, limit]) => score <= limit)?.[0] ?? "C"
}
