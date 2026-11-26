import type { TelegraphShape } from "./moments.ts"
import type { BossId } from "./tuning.ts"
import type { ZoneId } from "./zones.ts"

/** Every boss attack pattern, as `BossView.pattern` names it (docs/DESIGN.md, Bosses). */
export const bossPatterns = ["slam", "charge", "fan", "blink", "volley", "moons", "hands", "pulse", "needles", "lunge", "leap", "seams", "split"] as const
export type BossPattern = (typeof bossPatterns)[number]

export interface BossPhase {
  /** The fraction of its health the boss is down to when this phase begins: 1 for the first. */
  readonly from: number
  readonly patterns: ReadonlyArray<BossPattern>
  /** `fixed` plays the patterns in order, looping; `random` draws them, never the same twice in a row. */
  readonly order: "fixed" | "random"
}

/** A boss as its name card and fight read it: its names, zone and phases. */
export interface BossInfo {
  readonly id: BossId
  readonly name: string
  readonly kanji: string
  readonly zone: ZoneId
  readonly phases: ReadonlyArray<BossPhase>
}

export const BOSSES = {
  gatekeeper: {
    id: "gatekeeper",
    name: "Gatekeeper",
    kanji: "門番",
    zone: "courtyard",
    phases: [
      { from: 1, patterns: ["slam", "charge", "fan", "charge"], order: "fixed" },
      { from: 0.5, patterns: ["slam", "charge", "fan", "blink"], order: "random" }
    ]
  },
  orrery: {
    id: "orrery",
    name: "Orrery",
    kanji: "渾天儀",
    zone: "spiral",
    phases: [
      { from: 1, patterns: ["volley", "moons", "hands", "moons"], order: "fixed" },
      { from: 0.5, patterns: ["volley", "moons", "hands", "pulse"], order: "random" }
    ]
  },
  sunder: {
    id: "sunder",
    name: "Sunder",
    kanji: "断",
    zone: "void",
    phases: [
      { from: 1, patterns: ["needles", "lunge", "needles", "lunge"], order: "fixed" },
      { from: 0.6, patterns: ["needles", "lunge", "leap", "seams"], order: "random" },
      { from: 0.3, patterns: ["needles", "leap", "seams", "split"], order: "random" }
    ]
  }
} as const satisfies Record<BossId, BossInfo>

export const bossOf = (id: BossId): BossInfo => BOSSES[id]

/** The health fractions where the phases after the first begin: the ticks on the boss's bar. */
export const thresholdsOf = (id: BossId): ReadonlyArray<number> => BOSSES[id].phases.slice(1).map((phase) => phase.from)

/** Where a boss fight is: its name card, fighting, the invulnerable beat between phases, staggered open, or beaten. */
export type BossStateName = "intro" | "fighting" | "shifting" | "broken" | "defeated"

/** The boss in the room, for its bar, its name card and the camera. */
export interface BossView {
  /** Its entity, as `EnemyView.id`. */
  readonly id: number
  readonly boss: BossId
  readonly hp: number
  readonly maxHp: number
  /** 1-based. */
  readonly phase: number
  readonly phases: number
  readonly thresholds: ReadonlyArray<number>
  /** 0 to 1: the balance meter. Full breaks the boss open. */
  readonly balance: number
  readonly state: BossStateName
  /** Seconds left in the intro, the shift, the break or the defeat; 0 while fighting. */
  readonly timeLeft: number
  /** The pattern it is winding up or playing, or null between patterns. */
  readonly pattern: BossPattern | null
  /** 0 to 1 through the intro, the shift, the break or the defeat; 0 while fighting. */
  readonly progress: number
  /** Blows land half again as hard: broken, or stunned open after a charge or a split. */
  readonly open: boolean
  /** The Orrery's shell is up: blows clank off it. */
  readonly shelled: boolean
  /** The Orrery's three moons, wherever they are. Empty for the other bosses. */
  readonly moons: ReadonlyArray<MoonView>
  /** Every telegraph its pattern shows now, its halves' and moons' included. */
  readonly telegraphs: ReadonlyArray<BossTelegraph>
  /** Sunder's second half while it is split (its `EnemyView.id`), else null. */
  readonly twin: number | null
  /** The Orrery's two hands while they reach out and sweep: each one's angle and how far it reaches. */
  readonly arms: ReadonlyArray<{ readonly angle: number; readonly reach: number }>
}

/** One of the Orrery's moons: resting in orbit, leaving it, hunting round the player, aiming, cutting, or flying home. */
export interface MoonView {
  readonly x: number
  readonly z: number
  readonly phase: "orbit" | "leave" | "hunt" | "aim" | "cut" | "back"
}

/**
 * One telegraph of a boss's pattern, drawn from (x, z) as an enemy's are: a line, a ring, an arc or a spot.
 * `id` is the body it belongs to (the boss, or Sunder's half); `key` tells apart the ones it shows at once.
 */
export interface BossTelegraph {
  readonly id: number
  readonly key: number
  readonly x: number
  readonly z: number
  readonly shape: TelegraphShape
  readonly dirX: number
  readonly dirZ: number
  readonly size: number
  /** 0 when the windup starts, 1 when the attack lands. */
  readonly progress: number
  readonly feint: boolean
  readonly halfAngle?: number
  readonly turn?: 1 | -1
  readonly spot?: { readonly x: number; readonly z: number }
}
