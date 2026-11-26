import { HostClock } from "@typeonce/ritmo"
import { Keyboard, Pointer } from "@typeonce/ritmo-browser"
import { Determinism } from "@typeonce/ritmo-devtools"
import { expect } from "vitest"

import { buttons, Game, Intents, keys, makeControls, makeHeadlessRuntime, Moments, ReadGame, SIDE_DIRS, sides, Tuning, update } from "../src/sim/index.ts"
import type { EnemyKind, Intent, Moment, MomentOf, MomentType, PlayerAction, RoomKind, RoomRecord, StageId, WeaponId, ZoneId } from "../src/sim/index.ts"

const ReadMoments = Game.Inspector("Game/ReadMoments", {
  events: { moments: Game.System.readEvent(Moments) }
}, ({ events }) => events.moments.all())

type Keys = Keyboard.Timeline<typeof keys>

export interface Script {
  /** Keyboard timeline, by update tick from 0 (the tick that starts the run). */
  readonly keys?: Keys
  readonly mouse?: Pointer.Timeline
}

/** The player's start, which the tests place enemies round. */
export const { x: px, z: pz } = Tuning.PLAYER.start

/** Steps until an enemy spawned now has finished appearing, with two to spare. */
export const APPEAR = Tuning.SPAWN.time.steps + 2

/** Seconds as update steps, at 60 a second. */
export const steps = (seconds: number) => Math.round(seconds * 60)

/** A press of `key` at `frame`, released the next. */
export const tap = (key: Keyboard.TimelineName<typeof keys>, frame: number): Keys => [{ frame, press: [key] }, { frame: frame + 1, release: [key] }]

/** Scripted play for the replay tests: walking each way, a slash chain, two dashes, a parry and the special. */
export const SCRIPTED_KEYS: Keys = [
  { frame: 10, press: ["move.right"] },
  { frame: 40, press: ["slash"] }, { frame: 41, release: ["slash"] },
  { frame: 50, press: ["slash"] }, { frame: 51, release: ["slash"] },
  { frame: 60, press: ["slash"] }, { frame: 61, release: ["slash"] },
  { frame: 80, release: ["move.right"], press: ["move.up", "dash"] }, { frame: 81, release: ["dash"] },
  { frame: 120, press: ["parry"] }, { frame: 121, release: ["parry"] },
  { frame: 200, release: ["move.up"], press: ["move.left"] },
  { frame: 260, press: ["slash"] }, { frame: 261, release: ["slash"] },
  { frame: 400, release: ["move.left"], press: ["move.down", "special"] }, { frame: 401, release: ["special"] },
  { frame: 700, press: ["dash"] }, { frame: 701, release: ["dash"] }
]

const makeRuntime = (keyboard: Keys = [], mouse: Pointer.Timeline = [], debug?: { readonly hostClock: HostClock.HostClock }) => {
  const made = makeHeadlessRuntime({ controls: makeControls({ keyboard: Keyboard.scripted(keys, keyboard), mouse: Pointer.scripted(buttons, mouse) }), debug })
  if (!made.ok) throw new Error("The headless runtime could not start")
  return made.value
}

type Runtime = ReturnType<typeof makeRuntime>

/** Plays a fresh runtime, readied by `setup`, for `frames` steps twice over and compares the runs (`Determinism.check`). */
export const replays = (frames: number, setup: (runtime: Runtime) => void, keyboard: Keys = []) =>
  Determinism.check(({ hostClock }) => {
    const runtime = makeRuntime(keyboard, [], { hostClock })
    setup(runtime)
    return { runtime, schedules: { update } }
  }, { schedule: "update", frames, hostClock: HostClock.test() })

/** A headless game with scripted input, a log of every moment, and helpers to start runs and send intents. */
export const makeGame = (script: Script = {}) => {
  const runtime = makeRuntime(script.keys, script.mouse)
  const moments: Array<Moment & { readonly frame: number }> = []
  let frame = 0

  const tick = (count = 1) => {
    for (let index = 0; index < count; index++) {
      const result = runtime.tick(update)
      if (!result.ok) throw new Error(`tick ${frame} failed: ${JSON.stringify(result.error)}`)
      for (const moment of runtime.inspect(ReadMoments)) moments.push({ ...moment, frame })
      frame += 1
    }
  }

  const send = (intent: Intent) => runtime.send(Intents, intent)
  const view = () => runtime.inspect(ReadGame)

  return {
    runtime,
    tick,
    send,
    view,
    moments,
    frame: () => frame,
    /** Starts a run (wave 0 is the sandbox, no waves) and ticks once so it commits. */
    start: (wave = 0, seed = 1) => {
      send({ type: "start", wave, seed })
      tick()
    },
    /** Starts a run of `stage` (wave 0 is its sandbox) and ticks once so it commits. */
    startStage: (stage: StageId, wave = 0, seed = 1) => {
      send({ type: "startStage", stage, wave, seed })
      tick()
    },
    /** Starts a run of `zone`'s dungeon in `room` (by index or kind; null: its start room) and ticks once so it commits. */
    startZone: (zone: ZoneId, room: number | RoomKind | null = null, seed = 3, weapon: WeaponId | null = null) => {
      send({ type: "startZone", zone, room, seed, weapon })
      tick()
    },
    spawn: (kind: EnemyKind, x: number, z: number) => {
      send({ type: "spawn", kind, x, z })
      tick()
    },
    of: <T extends MomentType>(type: T): ReadonlyArray<MomentOf<T> & { readonly frame: number }> =>
      moments.filter((moment): moment is MomentOf<T> & { readonly frame: number } => moment.type === type),
    tickUntil: (done: () => boolean, limit = 600) => {
      for (let index = 0; index < limit && !done(); index++) tick()
      expect(done()).toBe(true)
    }
  }
}

export type TestGame = ReturnType<typeof makeGame>

/** Ticks until every spawned enemy has finished appearing. */
export const settle = (game: TestGame) => game.tickUntil(() => game.view().enemies.every((enemy) => enemy.state !== "Spawning"))

/** Ticks to `frame`, presses `action` there by intent, and plays one step on. */
export const pressAt = (game: TestGame, frame: number, action: PlayerAction) => {
  while (game.frame() < frame) game.tick()
  game.send({ type: "press", action })
  game.tick()
}

/** Takes the boss into `phase` and plays its shift through. */
export const shiftTo = (game: TestGame, phase: number, limit = 400) => {
  game.send({ type: "bossPhase", phase })
  game.tickUntil(() => game.view().boss?.phase === phase && game.view().boss?.state === "fighting", limit)
}

/** Saves the game to JSON and restores it into a fresh one, which matches it then and `then` steps later. */
export const expectRestores = (game: TestGame, then = 180) => {
  const saved = game.runtime.snapshot()
  if (!saved.ok) throw new Error(JSON.stringify(saved.error))
  const copy = makeGame()
  const restored = copy.runtime.restore(JSON.parse(JSON.stringify(saved.value)))
  expect(restored.ok).toBe(true)
  expect(copy.view()).toEqual(game.view())
  game.tick(then)
  copy.tick(then)
  expect(copy.view()).toEqual(game.view())
}

/** The rooms on the grid cells beside room `index`. */
export const neighbours = (rooms: ReadonlyArray<RoomRecord>, index: number): ReadonlyArray<number> => {
  const room = rooms[index]
  if (room === undefined) return []
  return sides.flatMap((side) => {
    const found = rooms.findIndex((other) => other.column === room.column + SIDE_DIRS[side].x && other.row === room.row + SIDE_DIRS[side].z)
    return found < 0 ? [] : [found]
  })
}

/** The rooms reached from the start room through neighbouring rooms, never through room `skip`. */
export const reachable = (rooms: ReadonlyArray<RoomRecord>, skip = -1): ReadonlySet<number> => {
  const reached = new Set([0])
  const queue = [0]
  for (let at = 0; at < queue.length; at++) {
    for (const next of neighbours(rooms, queue[at] ?? 0)) {
      if (next === skip || reached.has(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  return reached
}
