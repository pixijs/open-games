import { Clock } from "@typeonce/ritmo"

import type { Point } from "../arena.ts"
import type { MoonView } from "../bosses.ts"
import { dirOf } from "../geometry.ts"
import type { EnemyStateValue } from "../schema.ts"
import { step } from "../time.ts"
import { ORRERY } from "../tuning.ts"

/**
 * The Orrery's three moons, as pure functions of the gameplay step: resting, they orbit it; in the moons pattern they
 * leave for a circle round the player that tightens as it turns, hold and aim one by one, cut through, and fly home.
 */

const { moons: M } = ORRERY
const MOONS = 3
const THIRD = (Math.PI * 2) / MOONS

/** How far one cut runs: across the circle's tightest radius and past the player. */
export const CUT_LENGTH = M.near + M.overshoot
const steps = {
  leave: M.leave.steps,
  tighten: M.tighten.steps,
  stagger: M.stagger.steps,
  aim: M.aim.steps,
  cut: Math.ceil((CUT_LENGTH / M.speed) * step.hz),
  back: M.back.steps
}

/** The step of the pattern (from 0) each moon starts to aim, starts its cut, starts home, and is home. */
export const moonTimes = (moon: number) => {
  const aimAt = steps.leave + steps.tighten + moon * steps.stagger
  const cutAt = aimAt + steps.aim
  const backAt = cutAt + steps.cut
  return { aimAt, cutAt, backAt, homeAt: backAt + steps.back }
}

/** The whole pattern, in steps: until the last moon is home. */
export const MOONS_STEPS = moonTimes(MOONS - 1).homeAt

const smooth = (t: number) => t * t * (3 - 2 * t)
const lerp = (from: Point, to: Point, t: number): Point => ({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t })

/** Moon `moon` resting in orbit round the Orrery at (x, z) on gameplay step `at`. */
const orbitOf = (moon: number, at: number, x: number, z: number): Point => {
  const dir = dirOf((at / step.hz) * ORRERY.orbitSpin + moon * THIRD)
  return { x: x + dir.x * ORRERY.orbit, z: z + dir.z * ORRERY.orbit }
}

/** The moons pattern as the Orrery's `Moons` state holds it. */
export type MoonsState = Extract<EnemyStateValue, { readonly _tag: "Moons" }>

/** How far into the pattern the gameplay clock is, in steps. */
export const moonsElapsed = (state: MoonsState, play: Clock.Time<60>): number => Math.max(0, state.steps - Clock.remaining(play, state.endAt))

/** Where moon `moon` hunts at pattern step `elapsed`: on the tightening circle round the hunt's centre. */
const huntOf = (state: MoonsState, moon: number, elapsed: number, start: number): Point => {
  const t = Math.max(0, elapsed - steps.leave)
  const radius = M.far + (M.near - M.far) * Math.min(1, t / steps.tighten)
  const dir = dirOf((start / step.hz) * ORRERY.orbitSpin + moon * THIRD + state.spin * M.spin * (t / step.hz))
  return { x: state.centerX + dir.x * radius, z: state.centerZ + dir.z * radius }
}

/** Every moon of an Orrery at (x, z) on the gameplay clock: in orbit, or where the moons pattern `hunt` has it. */
export const moonsOf = (hunt: MoonsState | null, play: Clock.Time<60>, x: number, z: number): ReadonlyArray<MoonView> =>
  Array.from({ length: MOONS }, (_, moon): MoonView => {
    const home = orbitOf(moon, play.step, x, z)
    if (hunt === null) return { ...home, phase: "orbit" }
    const elapsed = moonsElapsed(hunt, play)
    const start = play.step - elapsed
    const times = moonTimes(moon)
    const line = hunt.lines[moon] ?? null
    if (elapsed < steps.leave) return { ...lerp(orbitOf(moon, start, x, z), huntOf(hunt, moon, steps.leave, start), smooth(elapsed / steps.leave)), phase: "leave" }
    if (elapsed < times.aimAt || line === null) return { ...huntOf(hunt, moon, elapsed, start), phase: "hunt" }
    if (elapsed < times.cutAt) return { x: line.x, z: line.z, phase: "aim" }
    const reach = Math.min(CUT_LENGTH, M.speed * ((elapsed - times.cutAt) / step.hz))
    const cut = { x: line.x + line.dirX * reach, z: line.z + line.dirZ * reach }
    if (elapsed < times.backAt) return { ...cut, phase: "cut" }
    if (elapsed < times.homeAt) {
      const end = { x: line.x + line.dirX * CUT_LENGTH, z: line.z + line.dirZ * CUT_LENGTH }
      return { ...lerp(end, home, smooth((elapsed - times.backAt) / steps.back)), phase: "back" }
    }
    return { ...home, phase: "orbit" }
  })
