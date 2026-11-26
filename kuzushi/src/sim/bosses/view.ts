import { Clock } from "@typeonce/ritmo"

import { BOSSES, thresholdsOf } from "../bosses.ts"
import type { BossStateName, BossTelegraph, BossView } from "../bosses.ts"
import { angleOf, dirOf } from "../geometry.ts"
import type { Dir } from "../geometry.ts"
import type { BossStateValue, BossValue, EnemyStateValue, TellValue } from "../schema.ts"
import { progressTo } from "../time.ts"
import { BOSS, GATEKEEPER, ORRERY, SUNDER } from "../tuning.ts"
import { CUT_LENGTH, moonsElapsed, moonsOf, moonTimes } from "./moons.ts"
import { bossShelled, windupPattern } from "./rules.ts"

/** What the view reads of one boss body: the boss, or Sunder's second half. */
export interface BossBody {
  readonly id: number
  readonly x: number
  readonly z: number
  readonly facing: number
  readonly state: EnemyStateValue
  readonly boss: BossValue
  readonly fight: BossStateValue
  readonly hp: number
  readonly maxHp: number
}

const NAMES: Readonly<Record<BossStateValue["_tag"], BossStateName>> = {
  Arrived: "intro",
  Intro: "intro",
  Fighting: "fighting",
  Shift: "shifting",
  Broken: "broken",
  Felled: "defeated"
}

const turnOf = (angle: number, by: number): Dir => dirOf(angle + by)
const angleOfDir = (dir: Dir) => angleOf(dir.x, dir.z)

/** A windup's telegraph as the tell draws it. */
export const told = (tell: TellValue) => {
  switch (tell.shape) {
    case "arc": return tell.turn === 0 ? { halfAngle: tell.halfAngle } : { halfAngle: tell.halfAngle, turn: tell.turn }
    case "spot": return { spot: { x: tell.x, z: tell.z } }
    case "line":
    case "ring": return {}
  }
}

/** Every telegraph a boss body shows now. */
const telegraphsOf = (body: BossBody, half: boolean, play: Clock.Time<60>): ReadonlyArray<BossTelegraph> => {
  const state = body.state
  const make = (key: number, x: number, z: number, dir: Dir, rest: Omit<BossTelegraph, "id" | "key" | "x" | "z" | "dirX" | "dirZ">): BossTelegraph =>
    ({ id: body.id, key, x, z, dirX: dir.x, dirZ: dir.z, ...rest })
  switch (state._tag) {
    case "Windup": {
      const dir = { x: state.dirX, z: state.dirZ }
      const angle = angleOfDir(dir)
      const progress = progressTo(play, state.endAt, state.steps)
      const base = { shape: state.tell.shape, size: state.size, progress, feint: state.feint, ...told(state.tell) }
      const fan = (angles: ReadonlyArray<number>, size: number) => angles.map((by, key) => make(key, body.x, body.z, turnOf(angle, by), { ...base, shape: "line", size }))
      switch (windupPattern(body.boss, body.state, half)) {
        case "slam": return [make(0, body.x, body.z, dir, base), make(1, body.x, body.z, dir, { ...base, size: GATEKEEPER.slam.outer })]
        case "fan": {
          const { lines, spread } = GATEKEEPER.fan
          return fan(Array.from({ length: lines }, (_, index) => -spread / 2 + (spread * index) / (lines - 1)), state.size)
        }
        case "blink": return state.feint ? [make(0, body.x, body.z, dir, base)] : fan([0, Math.PI / 2, Math.PI, -Math.PI / 2], state.size)
        case "needles": return fan([-SUNDER.needles.spread, 0, SUNDER.needles.spread], state.size)
        case "seams": return fan([0, Math.PI / 2, Math.PI, -Math.PI / 2], state.size)
        case "hands": return [make(0, body.x, body.z, dir, base), make(1, body.x, body.z, turnOf(angle, Math.PI), base)]
        default: return [make(0, body.x, body.z, dir, base)]
      }
    }
    case "Quake": {
      const progress = progressTo(play, state.endAt, GATEKEEPER.slam.echo.steps)
      return [make(0, body.x, body.z, dirOf(body.facing), { shape: "ring", size: GATEKEEPER.slam.outer, progress, feint: false })]
    }
    case "Pulse": {
      const { pulse } = ORRERY
      const elapsed = Math.max(0, state.steps - Clock.remaining(play, state.endAt))
      const next = Math.floor(elapsed / pulse.interval.steps) + 1
      const gap = state.gaps[next]
      if (gap === undefined) return []
      const progress = (elapsed % pulse.interval.steps) / pulse.interval.steps
      return [make(0, body.x, body.z, dirOf(gap + Math.PI), { shape: "arc", size: pulse.reach, progress, feint: false, halfAngle: Math.PI - pulse.gap / 2 })]
    }
    case "Leap": {
      const { leap } = SUNDER
      const spot = { x: state.spotX, z: state.spotZ }
      return [make(0, body.x, body.z, dirOf(body.facing), { shape: "spot", size: leap.spot, progress: progressTo(play, state.endAt, state.steps), feint: false, spot })]
    }
    case "Moons": {
      const elapsed = moonsElapsed(state, play)
      return state.lines.flatMap((line, moon) => {
        const times = moonTimes(moon)
        if (line === null || elapsed >= times.cutAt) return []
        const progress = (elapsed - times.aimAt) / (times.cutAt - times.aimAt)
        return [make(moon, line.x, line.z, { x: line.dirX, z: line.dirZ }, { shape: "line", size: CUT_LENGTH + ORRERY.moonRadius, progress, feint: false })]
      })
    }
    default:
      return []
  }
}

/** The boss in the room as its bar, its name card, the camera and the art read it. */
export const bossViewOf = (main: BossBody, halves: ReadonlyArray<BossBody>, play: Clock.Time<60>, time: Clock.Time<60>): BossView => {
  const { boss, fight, state } = main
  const timed = (clock: Clock.Time<60>, until: Clock.Deadline<60>, total: number) => {
    const left = Math.max(0, Clock.remaining(clock, until))
    return { timeLeft: left / clock.hz, progress: total <= 0 ? 1 : Math.min(1, 1 - left / total) }
  }
  const progress = fight._tag === "Intro" ? timed(time, fight.until, BOSS.intro.steps)
    : fight._tag === "Felled" ? timed(time, fight.until, BOSS.defeat.steps)
    : fight._tag === "Shift" ? timed(play, fight.until, BOSS.shift.steps)
    : fight._tag === "Broken" ? timed(play, fight.until, BOSS.broken.steps)
    : fight._tag === "Arrived" ? { timeLeft: BOSS.intro.steps / play.hz, progress: 0 }
    : { timeLeft: 0, progress: 0 }
  return {
    id: main.id,
    boss: boss.boss,
    hp: main.hp,
    maxHp: main.maxHp,
    phase: boss.phase,
    phases: BOSSES[boss.boss].phases.length,
    thresholds: thresholdsOf(boss.boss),
    balance: Math.min(1, boss.balance / BOSS.balance.max),
    state: NAMES[fight._tag],
    timeLeft: progress.timeLeft,
    progress: progress.progress,
    pattern: boss.pattern,
    open: fight._tag === "Broken" || (fight._tag === "Fighting" && state._tag === "Stagger"),
    shelled: bossShelled(boss, state._tag),
    moons: boss.boss === "orrery" ? moonsOf(state._tag === "Moons" ? state : null, play, main.x, main.z) : [],
    telegraphs: fight._tag === "Fighting" ? [...telegraphsOf(main, false, play), ...halves.flatMap((half) => telegraphsOf(half, true, play))] : [],
    twin: halves[0]?.id ?? null,
    arms: armsOf(main, play)
  }
}

/** The Orrery's hands: reaching out to where its arcs start through the windup, then sweeping them. */
const armsOf = (body: BossBody, play: Clock.Time<60>): ReadonlyArray<{ readonly angle: number; readonly reach: number }> => {
  const { hands } = ORRERY
  const state = body.state
  if (body.boss.pattern !== "hands") return []
  const pair = (angle: number, reach: number) => [{ angle, reach }, { angle: angle + Math.PI, reach }]
  if (state._tag === "Windup" && state.tell.shape === "arc" && state.tell.turn !== 0) {
    const progress = progressTo(play, state.endAt, state.steps)
    return pair(angleOf(state.dirX, state.dirZ) - state.tell.turn * hands.span / 2, hands.radius * Math.min(1, progress * 1.4))
  }
  if (state._tag === "Sweep") {
    const progress = progressTo(play, state.endAt, state.steps)
    return pair(state.from + state.turn * hands.span * progress, hands.radius)
  }
  return []
}
