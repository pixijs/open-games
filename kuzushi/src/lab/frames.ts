import { step, Tuning } from "../sim/index.ts"
import type { AttackPhase, GameView, PlayerView, WeaponMove } from "../sim/index.ts"

const { DARTS, MOVE, PARRY } = Tuning

/** Seconds as gameplay steps, rounded to the nearest. */
export const toSteps = (seconds: number): number => Math.round(seconds * step.hz)

/** Gameplay steps as seconds. */
export const toSeconds = (steps: number): number => steps / step.hz

/** Each weapon move's name in the lab. */
export const MOVE_LABELS: Readonly<Record<WeaponMove, string>> = {
  cut: "Cut",
  crosscut: "Crosscut",
  spin: "Spin",
  cleave: "Cleave",
  slam: "Slam",
  dart: "Dart",
  pierce: "Pierce",
  sigil: "Sigil",
  seal: "Seal"
}

/**
 * Where an attack is: its move, its phase ("charge" while the darts charge), the step within that phase (from 1) and
 * the phase's length, all in gameplay steps.
 */
export const attackFrame = (player: PlayerView): { readonly move: WeaponMove; readonly phase: AttackPhase | "charge"; readonly frame: number; readonly of: number } | null => {
  if (player.move === null || player.attackPhase === null) return null
  const charging = player.state === "Charge"
  const of = charging ? DARTS.charge.steps : MOVE[player.move][player.attackPhase].steps
  const frame = Math.min(of, Math.max(1, Math.round(player.progress * of)))
  return { move: player.move, phase: charging ? "charge" : player.attackPhase, frame, of }
}

/** The player's state as the lab shows it: the state, and for timed states the frame within it of its length. */
export const playerStateLabel = (view: GameView): string => {
  const player = view.player
  if (player === null) return "None"
  switch (player.state) {
    case "Attack":
    case "Slam":
    case "Charge": {
      const at = attackFrame(player)
      return at === null ? player.state : `${MOVE_LABELS[at.move]} · ${at.phase} ${at.frame}/${at.of}`
    }
    case "Dash": {
      const total = toSteps(view.debug.moves.dashTime)
      return `Dash ${total - toSteps(player.timeLeft) + 1}/${total}`
    }
    case "Parry": {
      const total = PARRY.time.steps
      const frame = total - toSteps(player.timeLeft) + 1
      return player.parryOpen ? `Parry · window ${frame}/${PARRY.window.steps}` : `Parry · stance ${frame}/${total}`
    }
    case "Special": return "KUZUSHI"
    case "Down": return "Down"
    case "Free": return player.invulnerable ? "Free · invulnerable" : "Free"
  }
}
