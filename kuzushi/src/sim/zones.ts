import type { BossId, EnemyKind } from "./tuning.ts"

/**
 * The zones in run order. Each grew from a stage: its location, hazard and enemies make a dungeon of rooms that ends
 * at its boss. A zone's id is also its palette's key (`paletteOf` in src/art/palette.ts).
 */
export const zoneIds = ["courtyard", "spiral", "void"] as const
export type ZoneId = (typeof zoneIds)[number]

export type ZoneHazard = "none" | "beam" | "collapse"

export interface Zone {
  readonly id: ZoneId
  /** Shown as "ZONE 2". */
  readonly number: 1 | 2 | 3
  readonly name: string
  readonly kanji: string
  /** The four kinds its rooms send; splitters bring splitlings. */
  readonly roster: readonly [EnemyKind, EnemyKind, EnemyKind, EnemyKind]
  readonly boss: BossId
  /** How many rooms its dungeon has, the start and the boss's included. */
  readonly rooms: number
  readonly hazard: ZoneHazard
  /** The zone its boss opens the way to; null after the last. */
  readonly next: ZoneId | null
}

export const ZONES = {
  courtyard: {
    id: "courtyard",
    number: 1,
    name: "The Courtyard",
    kanji: "中庭",
    roster: ["chaser", "shooter", "bruiser", "trickster"],
    boss: "gatekeeper",
    rooms: 8,
    hazard: "none",
    next: "spiral"
  },
  spiral: {
    id: "spiral",
    number: 2,
    name: "The Spiral",
    kanji: "螺旋",
    roster: ["orbiter", "warden", "sweeper", "pulsar"],
    boss: "orrery",
    rooms: 10,
    hazard: "beam",
    next: "void"
  },
  void: {
    id: "void",
    number: 3,
    name: "The Void",
    kanji: "虚空",
    roster: ["lancer", "splitter", "leaper", "cutter"],
    boss: "sunder",
    rooms: 12,
    hazard: "collapse",
    next: null
  }
} as const satisfies Record<ZoneId, Zone>

export const ZONE_LIST: ReadonlyArray<Zone> = zoneIds.map((id) => ZONES[id])

export const zoneOf = (id: ZoneId): Zone => ZONES[id]

/**
 * The zone a kind belongs to: the zone whose roster sends it (a splitter's splitlings with it), or whose boss it is.
 * Its body, glow and telegraphs take that zone's danger accent.
 */
export const homeOf = (kind: EnemyKind): ZoneId =>
  ZONE_LIST.find((zone) => zone.boss === kind || zone.roster.some((each) => each === kind || (each === "splitter" && kind === "splitling")))?.id ?? "courtyard"
