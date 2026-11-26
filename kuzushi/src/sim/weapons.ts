import type { LoadoutValue } from "./schema.ts"
import { DARTS } from "./tuning.ts"

/**
 * The weapons. None is drawn as an object: each is a way of attacking (its moves, timing, hit shapes and effects) on
 * the attack button. Dash, parry and KUZUSHI stay the same with every weapon. Frame data: docs/DESIGN.md, Weapons,
 * and `MOVE` in tuning.ts.
 */
export const weaponIds = ["blade", "breaker", "darts", "sigil"] as const
export type WeaponId = (typeof weaponIds)[number]

export type WeaponStyle = "melee" | "heavy" | "ranged" | "magic"

/** Every move the weapons play, as the `attack` moment and `WeaponView.move` name them. */
export const weaponMoves = ["cut", "crosscut", "spin", "cleave", "slam", "dart", "pierce", "sigil", "seal"] as const
export type WeaponMove = (typeof weaponMoves)[number]

export interface Weapon {
  readonly id: WeaponId
  readonly name: string
  readonly kanji: string
  readonly style: WeaponStyle
  /** What it does, in a line, for the altar and the HUD. */
  readonly line: string
  /** Its moves in chain order. */
  readonly moves: ReadonlyArray<WeaponMove>
}

export const WEAPONS = {
  blade: { id: "blade", name: "Blade", kanji: "刃", style: "melee", line: "Three cuts; the third spins all round.", moves: ["cut", "crosscut", "spin"] },
  breaker: { id: "breaker", name: "Breaker", kanji: "砕", style: "heavy", line: "A wide cleave, then an aimed slam that staggers armour.", moves: ["cleave", "slam"] },
  darts: { id: "darts", name: "Darts", kanji: "矢", style: "ranged", line: "Six shots, reloaded by a dash; hold to charge a piercing shot.", moves: ["dart", "pierce"] },
  sigil: { id: "sigil", name: "Sigil", kanji: "印", style: "magic", line: "Seals at the aim burst after 0.4 s; every third is greater.", moves: ["sigil", "seal"] }
} as const satisfies Record<WeaponId, Weapon>

export const WEAPON_LIST: ReadonlyArray<Weapon> = weaponIds.map((id) => WEAPONS[id])

export const weaponOf = (id: WeaponId): Weapon => WEAPONS[id]

/** The weapon a move belongs to. */
export const weaponOfMove = (move: WeaponMove): WeaponId => weaponIds.find((id) => WEAPONS[id].moves.some((each) => each === move)) ?? "blade"

/** What every run starts with. */
export const STARTING_WEAPON: WeaponId = "blade"

/**
 * Which move each press of a chain plays, from the first: the blade cuts, crosses and spins; the breaker cleaves then
 * slams; darts fire one at a time (holding on charges the pierce); every third sigil in a row is a seal.
 */
export const CHAINS = {
  blade: ["cut", "crosscut", "spin"],
  breaker: ["cleave", "slam"],
  darts: ["dart"],
  sigil: ["sigil", "sigil", "seal"]
} as const satisfies Record<WeaponId, ReadonlyArray<WeaponMove>>

/** The chain's length: a press after its last move starts it again. */
export const chainLength = (weapon: WeaponId): 1 | 2 | 3 => CHAINS[weapon].length

/** The move press `step` (from 1) of `weapon`'s chain plays; past its end, its last. */
export const moveAt = (weapon: WeaponId, step: number): WeaponMove => {
  const chain: ReadonlyArray<WeaponMove> = CHAINS[weapon]
  return chain[Math.min(chain.length, Math.max(1, step)) - 1] ?? chain[0] ?? "cut"
}

/** The weapon in hand, the darts loaded (and when the next loads, null when full), and the sigils waiting to land. */
export type Hand = LoadoutValue

/** A sigil or seal waiting on the ground: it bursts when `landAt` is reached (gameplay clock), `steps` after its cast. */
export type Mark = Hand["marks"][number]

/**
 * The `Loadout` of a hand that just took `weapon`: a full clip and no marks, unless `marks` already on the ground
 * should still land. A run's start, a room's entry, an altar and the debug hooks all put a weapon in hand through it.
 */
export const loadoutFor = (weapon: WeaponId, marks: Hand["marks"] = []): Hand => ({ weapon, loaded: DARTS.clip, reloadAt: null, marks })

/** A mark the player's attack leaves on the ground before it lands: the breaker's slam ring, a sigil. */
export interface MarkView {
  readonly id: number
  readonly move: WeaponMove
  readonly x: number
  readonly z: number
  readonly radius: number
  /** 0 when placed, 1 when it lands. */
  readonly progress: number
}

/** The weapon in hand and what it is doing. */
export interface WeaponView {
  readonly id: WeaponId
  /** The move playing, or null when the player isn't attacking. */
  readonly move: WeaponMove | null
  /** Which part of the move is playing. */
  readonly phase: "windup" | "active" | "recover" | null
  /** Darts: shots loaded and the clip's size; null for the others. */
  readonly ammo: { readonly loaded: number; readonly size: number } | null
  /** Darts: 0 to 1 while the attack is held to charge, 1 once charged; null when not charging. */
  readonly charge: number | null
  /** Marks on the ground waiting to land. */
  readonly marks: ReadonlyArray<MarkView>
}

/** A dart in flight: a dart or the charged pierce (`perfect` when released on the beat). */
export interface DartView {
  readonly id: number
  readonly move: "dart" | "pierce"
  readonly x: number
  readonly z: number
  readonly dirX: number
  readonly dirZ: number
  readonly perfect: boolean
}
