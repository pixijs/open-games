import { Clock } from "@typeonce/ritmo"

import { Flow, Game, PlayerState, Tempo, Transition } from "./schema.ts"
import type { TempoValue } from "./schema.ts"
import type { Moment } from "./moments.ts"
import { after, PlayTime, secondsOf, step, Time } from "./time.ts"
import type { Duration } from "./time.ts"

export const playing = Game.Condition.inState(Flow, "Playing")

const hitStopping = Game.Condition.check("Game/HitStopping", {
  resources: { time: Game.System.readResource(Time), tempo: Game.System.readResource(Tempo) }
}, ({ resources }) => {
  const { hitStopUntil } = resources.tempo.get()
  return hitStopUntil !== null && !Clock.reached(resources.time.get(), hitStopUntil)
})

const slowBeat = Game.Condition.check("Game/SlowBeat", {
  resources: { time: Game.System.readResource(Time), tempo: Game.System.readResource(Tempo) }
}, ({ resources }) => {
  const time = resources.time.get()
  const { slowUntil, slowPeriod } = resources.tempo.get()
  return slowUntil !== null && !Clock.reached(time, slowUntil) && time.step % slowPeriod !== 0
})

const finishing = Game.Condition.check("Game/Finishing", {
  queries: { players: Game.Query({ selection: { state: Game.Query.read(PlayerState) } }) }
}, ({ queries }) => queries.players.each().some((entity) => queries.players.data.state.get(entity)._tag === "Special"))

/** A door or zone transition is playing: the run clock runs, gameplay holds. */
const transitioning = Game.Condition.check("Game/Transitioning", {
  resources: { transition: Game.System.readResource(Transition) }
}, ({ resources }) => resources.transition.get()._tag !== "None")

/** The run clock: stands still outside a run's play (title, pause, results). */
export const AdvanceTime = Clock.system(Game, { name: "Game/AdvanceTime", resource: Time, hold: [Game.Condition.not(playing)] })

/** The gameplay clock: also stands still through hit-stop, skips beats in slow motion, and freezes for the special and transitions. */
export const AdvancePlay = Clock.system(Game, {
  name: "Game/AdvancePlay",
  resource: PlayTime,
  hold: [Game.Condition.not(playing), hitStopping, slowBeat, finishing, transitioning]
})

/** True on a step the gameplay clock did not advance: gameplay systems pause, keeping the events they read. */
export const playHeld = Game.Condition.check("Game/PlayHeld", {
  resources: { play: Game.System.readResource(PlayTime) }
}, ({ resources }) => resources.play.get().dt === 0)

export const calmTempo = (): TempoValue => ({ hitStopUntil: null, slowUntil: null, slowPeriod: 1 })

/** Holds the gameplay clock for the `duration` steps after this one, keeping a longer hit-stop already running. */
export const withHitStop = (tempo: TempoValue, time: Clock.Time<60>, duration: Duration): TempoValue => {
  const until = after(time, duration, Clock.durationOfSteps(step, 1))
  return { ...tempo, hitStopUntil: tempo.hitStopUntil !== null && tempo.hitStopUntil > until ? tempo.hitStopUntil : until }
}

/** Runs the gameplay clock at 1/`period` speed for `duration` from now. */
export const withSlowMotion = (tempo: TempoValue, time: Clock.Time<60>, duration: Duration, period: number): TempoValue =>
  ({ ...tempo, slowUntil: Clock.deadline(time, duration), slowPeriod: period })

export const hitStopMoment = (duration: Duration): Moment => ({ type: "hitStop", seconds: secondsOf(duration) })

export const slowMoment = (duration: Duration, period: number): Moment =>
  ({ type: "slowMotion", seconds: secondsOf(duration), scale: 1 / period })
