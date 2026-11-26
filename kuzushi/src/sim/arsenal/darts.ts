import { Clock } from "@typeonce/ritmo"

import { angleOf } from "../geometry.ts"
import type { Dir } from "../geometry.ts"
import { Actor, Body, Dart, Game, Loadout, Moments, PrevBody } from "../schema.ts"
import { inSteps, PlayTime, step } from "../time.ts"
import { DARTS, MOVE } from "../tuning.ts"

/** A dart (or the pierce) leaving (x, z) along `dir`; it flies its move's reach, then is gone. */
export const dartDraft = (move: "dart" | "pierce", x: number, z: number, dir: Dir, damage: number, perfect: boolean, swing: number, play: Clock.Time<60>) => {
  const spec = MOVE[move]
  const body = { x, z, facing: angleOf(dir.x, dir.z) }
  const life = inSteps(Math.ceil((spec.reach / spec.speed) * step.hz))
  return Game.Command.spawn(
    [Actor, { kind: "dart" }],
    [Body, body],
    [PrevBody, body],
    [Dart, { move, dirX: dir.x, dirZ: dir.z, damage, perfect, swing, expiresAt: Clock.deadline(play, life) }]
  )
}

/**
 * Darts load back on the gameplay clock while the clip isn't full: the first after `DARTS.reloadAfter` without firing
 * (firing sets that deadline), then one every `reloadEvery`. A dash reloads the whole clip at once (PlayerControl).
 */
export const ReloadDarts = Game.System("Game/ReloadDarts", {
  resources: { play: Game.System.readResource(PlayTime), loadout: Game.System.writeResource(Loadout) },
  events: { moments: Game.System.writeEvent(Moments) }
}, ({ resources, events }) => {
  const hand = resources.loadout.get()
  if (hand.weapon !== "darts" || hand.loaded >= DARTS.clip) return
  const play = resources.play.get()
  if (hand.reloadAt === null) {
    resources.loadout.set({ ...hand, reloadAt: Clock.deadline(play, DARTS.reloadAfter) })
    return
  }
  if (!Clock.reached(play, hand.reloadAt)) return
  const loaded = hand.loaded + 1
  resources.loadout.set({ ...hand, loaded, reloadAt: loaded < DARTS.clip ? Clock.deadline(play, DARTS.reloadEvery) : null })
  events.moments.emit({ type: "reloaded", loaded, size: DARTS.clip, dash: false })
})
