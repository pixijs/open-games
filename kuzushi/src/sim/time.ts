import { Clock } from "@typeonce/ritmo"
import { z } from "zod"

/** The fixed step: 60 simulation steps per second. */
export const step = Clock.hz(60)

export type Deadline = Clock.Deadline<60>
export type Duration = Clock.Duration<60>

/** The run clock: advances every step of a run and stops while the game is not playing (title, pause, results). */
export const Time = Clock.resource("Game/Time", step)

/**
 * The gameplay clock: the run clock minus hit-stop, slow-motion beats and the special's freeze.
 * Movement, AI, cooldowns and projectiles measure against it.
 */
export const PlayTime = Clock.resource("Game/PlayTime", step)

export const deadline = z.unknown().refine(Clock.isDeadline(step))

/** A duration of `seconds`, at least one step. */
export const seconds = (value: number): Duration => {
  const made = Clock.durationRaw(step, Math.max(1 / step.hz, value))
  return made.ok ? made.value : Clock.durationOfSteps(step, 1)
}

/** A duration of `count` steps, at least one. */
export const inSteps = (count: number): Duration => {
  const made = Clock.durationOfStepsRaw(step, Math.max(1, Math.round(count)))
  return made.ok ? made.value : Clock.durationOfSteps(step, 1)
}

/** How far, 0 to 1, the gameplay clock `play` is through `steps` that end at `at`. */
export const progressTo = (play: Clock.Time<60>, at: Deadline, steps: number): number =>
  steps <= 0 ? 1 : Math.min(1, Math.max(0, 1 - Clock.remaining(play, at) / steps))

/** A duration in seconds, for moments the host reads. */
export const secondsOf = (duration: Duration): number => Clock.steps(duration) / step.hz

/** The step that `durations` laid end to end from now end on. */
export const after = (time: Clock.Time<60>, ...durations: ReadonlyArray<Duration>): Deadline => {
  const total = durations.reduce((sum, duration) => sum + Clock.steps(duration), 0)
  const span = Clock.durationOfStepsRaw(step, Math.max(1, total))
  return Clock.deadline(time, span.ok ? span.value : Clock.durationOfSteps(step, 1))
}
