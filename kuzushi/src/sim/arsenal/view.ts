import { Clock } from "@typeonce/ritmo"

import type { DartValue, LoadoutValue, PlayerStateValue } from "../schema.ts"
import { progressTo } from "../time.ts"
import { DARTS, MOVE } from "../tuning.ts"
import type { DartView, MarkView, WeaponMove, WeaponView } from "../weapons.ts"

export type AttackPhase = "windup" | "active" | "recover"

/** What the player's attack is doing, for `PlayerView`: its move, chain step, part and how far through that part. */
export interface AttackFrame {
  readonly move: WeaponMove
  readonly step: 1 | 2 | 3
  readonly phase: AttackPhase
  /** 0 to 1 through the phase; while charging, through the charge. */
  readonly progress: number
}

/** The charge's progress, 0 to 1, full at `fullAt`. */
const chargeOf = (play: Clock.Time<60>, fullAt: Clock.Deadline<60>): number => progressTo(play, fullAt, Clock.steps(DARTS.charge))

export const attackFrame = (state: PlayerStateValue, play: Clock.Time<60>): AttackFrame | null => {
  switch (state._tag) {
    case "Attack":
    case "Slam": {
      const move: WeaponMove = state._tag === "Attack" ? state.move : "slam"
      const spec = MOVE[move]
      const step = state._tag === "Attack" ? state.step : 2
      if (!Clock.reached(play, state.activeAt)) return { move, step, phase: "windup", progress: progressTo(play, state.activeAt, Clock.steps(spec.windup)) }
      if (!Clock.reached(play, state.recoverAt)) return { move, step, phase: "active", progress: progressTo(play, state.recoverAt, Clock.steps(spec.active)) }
      return { move, step, phase: "recover", progress: progressTo(play, state.endAt, Clock.steps(spec.recover)) }
    }
    case "Charge": return { move: "pierce", step: 1, phase: "windup", progress: chargeOf(play, state.fullAt) }
    default: return null
  }
}

/** The weapon in hand: its move and phase, the darts' clip and charge, and every mark waiting on the ground. */
export const weaponView = (hand: LoadoutValue, state: PlayerStateValue, play: Clock.Time<60>): WeaponView => {
  const frame = attackFrame(state, play)
  const slam: ReadonlyArray<MarkView> = state._tag === "Slam" && !Clock.reached(play, state.activeAt)
    ? [{ id: state.swing, move: "slam", x: state.toX, z: state.toZ, radius: MOVE.slam.radius, progress: progressTo(play, state.activeAt, Clock.steps(MOVE.slam.windup)) }]
    : []
  return {
    id: hand.weapon,
    move: frame?.move ?? null,
    phase: frame?.phase ?? null,
    ammo: hand.weapon === "darts" ? { loaded: hand.loaded, size: DARTS.clip } : null,
    charge: state._tag === "Charge" ? chargeOf(play, state.fullAt) : null,
    marks: [...slam, ...hand.marks.map((mark): MarkView => ({ id: mark.id, move: mark.move, x: mark.x, z: mark.z, radius: mark.radius, progress: progressTo(play, mark.landAt, mark.steps) }))]
  }
}

export const dartView = (id: number, x: number, z: number, dart: DartValue): DartView =>
  ({ id, move: dart.move, x, z, dirX: dart.dirX, dirZ: dart.dirZ, perfect: dart.perfect })
