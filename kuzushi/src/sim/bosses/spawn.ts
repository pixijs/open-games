import { Clock } from "@typeonce/ritmo"

import type { Point } from "../arena.ts"
import type { DrillMode } from "../moments.ts"
import { Actor, Body, Boss, BossState, Drill, Elite, EnemyState, Game, Health, HitMark, Motion, PrevBody, Twin } from "../schema.ts"
import type { BossValue } from "../schema.ts"
import { step } from "../time.ts"
import { ELITE, ENEMY, GATEKEEPER, ORRERY, SPAWN, SUNDER } from "../tuning.ts"
import type { BossId, EnemyKind } from "../tuning.ts"

/** Where each boss stands when its room opens (docs/DESIGN.md, Bosses). */
export const BOSS_START: Readonly<Record<BossId, Point>> = { gatekeeper: GATEKEEPER.start, orrery: ORRERY.start, sunder: SUNDER.start }

const fresh = (play: Clock.Time<60>) => ({ attackAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)), strafe: 1 as const, switchAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)) })

/**
 * A boss, standing ready for its name card: the first step its brain runs plays the intro. A drill (from the debug
 * hooks) skips the card and waits for orders.
 */
export const bossDraft = (boss: BossId, at: Point, facing: number, play: Clock.Time<60>) => {
  const body = { x: at.x, z: at.z, facing }
  const { hp } = ENEMY[boss]
  return Game.Command.spawn(
    [Actor, { kind: boss }],
    [Body, body],
    [PrevBody, body],
    [Motion, { vx: 0, vz: 0 }],
    [Health, { hp, max: hp }],
    [HitMark, { swing: -1 }],
    [EnemyState, { _tag: "Move", ...fresh(play) }],
    [Boss, { boss, phase: 1, balance: 0, calmAt: null, cursor: 0, pattern: null, last: null, forced: null, split: null }],
    [BossState, { _tag: "Arrived" }]
  )
}

export const bossDrillDraft = (boss: BossId, at: Point, facing: number, play: Clock.Time<60>, mode: DrillMode) =>
  Game.Command.extend(bossDraft(boss, at, facing, play), [Drill, { mode }])

/**
 * Sunder's second half, split off at `at`: it shares the boss's health (blows on it land on the boss), holds a copy of
 * its fight (`boss`, with the split's end), and plays lunge and leap on its own.
 */
export const twinDraft = (of: number, boss: BossValue, at: Point, facing: number, hp: number, max: number, play: Clock.Time<60>) => {
  const body = { x: at.x, z: at.z, facing }
  return Game.Command.spawn(
    [Actor, { kind: "sunder" }],
    [Body, body],
    [PrevBody, body],
    [Motion, { vx: 0, vz: 0 }],
    [Health, { hp, max }],
    [HitMark, { swing: -1 }],
    [EnemyState, { _tag: "Move", ...fresh(play) }],
    [Boss, { ...boss, pattern: "split" }],
    [BossState, { _tag: "Fighting" }],
    [Twin, { boss: of }]
  )
}

/** An elite of `kind`: three times its health, under a crown. */
export const eliteDraft = (kind: EnemyKind, at: Point, facing: number, play: Clock.Time<60>) => {
  const body = { x: at.x, z: at.z, facing }
  const hp = ENEMY[kind].hp * ELITE.health
  return Game.Command.spawn(
    [Actor, { kind }],
    [Body, body],
    [PrevBody, body],
    [Motion, { vx: 0, vz: 0 }],
    [Health, { hp, max: hp }],
    [HitMark, { swing: -1 }],
    [EnemyState, { _tag: "Spawning", readyAt: Clock.deadline(play, SPAWN.time) }],
    [Elite, {}]
  )
}
