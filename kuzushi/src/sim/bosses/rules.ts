import { Clock } from "@typeonce/ritmo"
import type { Random } from "@typeonce/ritmo"

import { BOSSES } from "../bosses.ts"
import type { BossPattern } from "../bosses.ts"
import type { FoeKind } from "../foes.ts"
import type { HitSource } from "../moments.ts"
import type { BossStateValue, BossValue, EnemyStateValue } from "../schema.ts"
import type { Duration } from "../time.ts"
import { BOSS, GATEKEEPER, ORRERY, SUNDER } from "../tuning.ts"
import type { BossId } from "../tuning.ts"

/** What every system that touches a boss agrees on: when it can be hurt, how hard, its balance, its next pattern. */

/** What each boss's shifts summon, by the phase they start (from phase 2). */
export const SUMMONS: Readonly<Record<BossId, ReadonlyArray<ReadonlyArray<FoeKind>>>> = {
  gatekeeper: GATEKEEPER.summons,
  orrery: ORRERY.summons,
  sunder: SUNDER.summons
}

/** The pattern a boss body's step belongs to: Sunder's halves play lunges and leaps of their own while split. */
export const windupPattern = (boss: BossValue, state: EnemyStateValue, half: boolean): BossPattern | null =>
  (half || boss.split !== null) && state._tag === "Windup" ? (state.tell.shape === "line" ? "lunge" : "leap") : boss.pattern

/** Whether blows land on a boss now: not during its name card, a shift between phases, or its defeat. */
export const bossOpen = (fight: BossStateValue["_tag"]): boolean => fight === "Fighting" || fight === "Broken"

/** Whether a boss's shell turns blows aside: the Orrery while it winds up and fires its volley. */
export const bossShelled = (boss: BossValue, action: string): boolean =>
  boss.boss === "orrery" && boss.pattern === "volley" && (action === "Windup" || action === "Volley")

/**
 * How much a blow of `amount` takes off a boss: half again as much while it is broken or stunned open (its action is
 * `Stagger`), and the special twice as much while it is broken.
 */
export const bossDamage = (fight: BossStateValue["_tag"], action: string, amount: number, source: HitSource): number => {
  if (fight === "Broken") return amount * (source === "special" ? BOSS.brokenSpecial : BOSS.brokenDamage)
  return action === "Stagger" ? amount * BOSS.stunnedDamage : amount
}

/** The health a boss can't be taken below in its current phase: the next phase's threshold, so every shift plays. */
export const healthFloor = (boss: BossValue, max: number): number => {
  const next = BOSSES[boss.boss].phases[boss.phase]
  return next === undefined ? 0 : Math.round(next.from * max)
}

/** Whether a boss at `hp` has reached its next phase's threshold. */
export const shiftDue = (boss: BossValue, hp: number, max: number): boolean => {
  const next = BOSSES[boss.boss].phases[boss.phase]
  return next !== undefined && hp <= Math.round(next.from * max)
}

/** The boss after its balance meter gains `amount`: it holds for a while before it drains. Only a fighting boss gains. */
export const withBalance = (boss: BossValue, fight: BossStateValue["_tag"], amount: number, play: Clock.Time<60>): BossValue =>
  fight !== "Fighting" || amount <= 0 ? boss : { ...boss, balance: Math.min(BOSS.balance.max, boss.balance + amount), calmAt: Clock.deadline(play, BOSS.balance.calm) }

/** The rest between patterns in `phase`. */
export const restOf = (phase: number): Duration => BOSS.rest[Math.min(BOSS.rest.length - 1, Math.max(0, phase - 1))] ?? BOSS.rest[0]

/**
 * The next pattern a boss plays, and where its phase's list stands after it: a pattern the debug hooks asked for; phase
 * 1's in order, looping; later phases' at random, never the one just played.
 */
export const nextPattern = (boss: BossValue, random: Random.Random): { readonly pattern: BossPattern; readonly cursor: number } => {
  if (boss.forced !== null) return { pattern: boss.forced, cursor: boss.cursor }
  const phase = BOSSES[boss.boss].phases[boss.phase - 1] ?? BOSSES[boss.boss].phases[0]
  const patterns = phase.patterns
  if (phase.order === "fixed") return { pattern: patterns[boss.cursor % patterns.length] ?? patterns[0] ?? "slam", cursor: boss.cursor + 1 }
  const fresh = patterns.filter((pattern) => pattern !== boss.last)
  return { pattern: random.pick(fresh) ?? patterns[0] ?? "slam", cursor: boss.cursor }
}
