import { Random } from "@typeonce/ritmo"

import { arrive } from "./dungeon/enter.ts"
import { generateDungeon } from "./dungeon/generate.ts"
import { SEED_MAX } from "./dungeon/rules.ts"
import { Dungeon, Transition } from "./dungeon/schema.ts"
import type { RoomRecord, ZoneDungeon } from "./dungeon/schema.ts"
import { startingHazard } from "./hazards.ts"
import type { Intent } from "./moments.ts"
import type { RoomKind } from "./rooms.ts"
import { Actor, Aim, Body, Buffer, CurrentStage, Flow, Game, Hazard, Input, Intents, Loadout, Moments, Motion, PlayerState, PrevBody, Rng, Run, Steer, Tempo, Vitals, Waves } from "./schema.ts"
import { playerDraft } from "./spawning.ts"
import { stageOf } from "./stages.ts"
import { calmTempo } from "./tempo.ts"
import { PlayTime, Time } from "./time.ts"
import { PLAYER } from "./tuning.ts"
import { loadoutFor, STARTING_WEAPON, weaponIds } from "./weapons.ts"
import type { WeaponId } from "./weapons.ts"
import { zoneOf } from "./zones.ts"
import type { ZoneId } from "./zones.ts"

/**
 * A run to start: in `zone` (null: the zone the run being played started in, The Courtyard from the title), in its
 * dungeon from room `room` (null: its start room) or, when `sandbox`, on its classic arena with no fights (null: as
 * the run being played), with `seed` (null: a fresh one) and `weapon` in hand (null: the blade).
 */
interface Start {
  readonly kind: "start"
  readonly zone: ZoneId | null
  readonly room: number | RoomKind | null
  readonly sandbox: boolean | null
  readonly seed: number | null
  readonly weapon: WeaponId | null
}

type Request = Start | { readonly kind: "pause" } | { readonly kind: "resume" } | { readonly kind: "toggle" } | { readonly kind: "quit" }

const again: Start = { kind: "start", zone: null, room: null, sandbox: null, seed: null, weapon: null }

const requestOf = (intent: Intent): Request | undefined => {
  switch (intent.type) {
    case "start": return { kind: "start", zone: "courtyard", room: null, sandbox: intent.wave === 0, seed: intent.seed, weapon: null }
    case "startStage": return { kind: "start", zone: intent.stage, room: null, sandbox: intent.wave === 0, seed: intent.seed, weapon: null }
    case "startZone": return { kind: "start", zone: intent.zone, room: intent.room, sandbox: false, seed: intent.seed, weapon: intent.weapon }
    case "restart": return again
    case "pause": return { kind: "pause" }
    case "resume": return { kind: "resume" }
    case "quit": return { kind: "quit" }
    default: return undefined
  }
}

/** The room a run starts in: by index (clamped), the first of a kind (the start room when the zone has none), or the start room. */
export const roomIndexOf = (rooms: ReadonlyArray<RoomRecord>, room: number | RoomKind | null): number => {
  if (room === null) return 0
  if (typeof room === "number") return Math.min(rooms.length - 1, Math.max(0, Math.round(room)))
  return Math.max(0, rooms.findIndex((record) => record.kind === room))
}

/** Aim intents set where the mouse points on the ground. */
export const AimIntents = Game.System("Game/AimIntents", {
  events: { intents: Game.System.readEvent(Intents) },
  resources: { aim: Game.System.writeResource(Aim) }
}, ({ events, resources }) => {
  for (const intent of events.intents.all()) {
    if (intent.type === "aim") resources.aim.set({ _tag: "Point", x: intent.x, z: intent.z })
    else if (intent.type === "aimFree") resources.aim.set({ _tag: "Free" })
  }
})

/**
 * Moves between the screens: start, pause, resume, restart and quit, from intents or the pause and confirm keys.
 * Starting a run clears the world and resets the run: full diamonds, FOCUS 0, the blade (or the weapon asked for). A
 * dungeon run makes its zone's dungeon from the run's seed, stocks its first room's altars with the three other
 * weapons, and puts the player at the south door of its start room (or the room the debug hooks name); a sandbox
 * run stands the player on the zone's classic arena with no fights. Restart begins a fresh run (a new seed) the way
 * the last one began: in the zone it started in, in its dungeon or its sandbox.
 */
export const RunFlow = Game.System("Game/Flow", {
  events: { intents: Game.System.readEvent(Intents), moments: Game.System.writeEvent(Moments) },
  resources: {
    input: Game.System.readResource(Input),
    time: Game.System.readResource(Time),
    play: Game.System.readResource(PlayTime),
    run: Game.System.writeResource(Run),
    waves: Game.System.writeResource(Waves),
    tempo: Game.System.writeResource(Tempo),
    buffer: Game.System.writeResource(Buffer),
    rng: Game.System.writeResource(Rng),
    stage: Game.System.writeResource(CurrentStage),
    hazard: Game.System.writeResource(Hazard),
    loadout: Game.System.writeResource(Loadout),
    steer: Game.System.writeResource(Steer),
    dungeon: Game.System.writeResource(Dungeon),
    transition: Game.System.writeResource(Transition)
  },
  machines: { flow: Game.System.machine(Flow) },
  nextMachines: { flow: Game.System.nextState(Flow) },
  queries: { actors: Game.Query({ selection: { actor: Game.Query.read(Actor) } }) },
  commands: Game.System.commands(Game.System.spawns(Actor, Body, PrevBody, Motion, PlayerState, Vitals), Game.System.despawns(Actor))
}, ({ resources, events, machines, nextMachines, queries, commands }) => {
  const { actions } = resources.input.get()
  const requests: Array<Request> = []
  for (const intent of events.intents.all()) {
    const request = requestOf(intent)
    if (request !== undefined) requests.push(request)
  }
  if (actions.pause.pressed) requests.push({ kind: "toggle" })
  if (actions.confirm.pressed) requests.push(again)
  const request = requests[0]
  if (request === undefined) return
  const state = machines.flow.get()._tag

  const clear = () => {
    for (const entity of queries.actors.each()) commands.despawn(entity)
    resources.waves.set({ _tag: "Idle" })
    resources.tempo.set(calmTempo())
    resources.buffer.set({ _tag: "Empty" })
    resources.steer.set({ _tag: "Free" })
    resources.transition.set({ _tag: "None" })
  }

  const begin = (start: Start) => {
    const title = state === "Title"
    const zone = start.zone ?? (title ? "courtyard" : resources.run.get().from)
    const sandbox = start.sandbox ?? (!title && resources.dungeon.get()._tag === "None")
    clear()
    const chosen = start.seed ?? Random.draw(resources.rng).integer(1, SEED_MAX)
    resources.rng.set(Random.seed(chosen))
    const hand = start.weapon ?? STARTING_WEAPON
    const play = resources.play.get()
    const time = resources.time.get()
    resources.loadout.set(loadoutFor(hand))
    resources.run.set({ lives: PLAYER.lives, focus: 0, startedAt: time.step, endedAt: null, swings: 0, kills: 0, seed: chosen, from: zone, rooms: 0, hits: 0 })
    const ground = { id: zone, hazard: true, open: false, room: null }

    if (sandbox) {
      const stage = stageOf(zone)
      commands.spawn(playerDraft(stage.layout.start))
      resources.stage.set(ground)
      resources.hazard.set(startingHazard(stage.hazard, play, 0))
      resources.dungeon.set({ _tag: "None" })
      events.moments.emit({ type: "runStarted", zone, seed: chosen, sandbox: true })
      return
    }

    // The run's first draw, as `dungeonSeedOf(chosen)`: the lab plans dungeons by it.
    const seed = Random.draw(resources.rng).integer(1, SEED_MAX)
    const rooms = generateDungeon(zone, seed).map((record, index) => (index === 0 ? { ...record, altars: weaponIds.filter((weapon) => weapon !== hand) } : record))
    const made: ZoneDungeon = { _tag: "Zone", zone, seed, rooms, current: 0, revealed: false, startedAt: time.step }
    const index = roomIndexOf(rooms, start.room)
    const arrival = arrive(made, index, null, ground, play, Random.draw(resources.rng), hand, true)
    commands.spawn(playerDraft(arrival.body))
    resources.dungeon.set(arrival.dungeon)
    resources.stage.set(arrival.stage)
    resources.hazard.set(arrival.hazard)
    resources.waves.set(arrival.waves)
    const record = arrival.dungeon.rooms[index]
    events.moments.emit({ type: "runStarted", zone, seed: chosen, sandbox: false })
    events.moments.emit({ type: "zoneStarted", zone, number: zoneOf(zone).number, rooms: rooms.length, seed })
    events.moments.emit({ type: "roomEntered", zone, room: index, kind: record?.kind ?? "start", from: null, cleared: record?.state === "cleared", waves: record?.waves.length ?? 0 })
  }

  switch (state) {
    case "Title":
      if (request.kind !== "start") return
      begin(request)
      nextMachines.flow.transition({ from: "Title", to: "Playing" })
      return
    case "Playing":
      if (request.kind === "pause" || request.kind === "toggle") {
        nextMachines.flow.transition({ from: "Playing", to: "Paused" })
        events.moments.emit({ type: "paused" })
      } else if (request.kind === "start") begin(request)
      return
    case "Paused":
      if (request.kind === "resume" || request.kind === "toggle") {
        nextMachines.flow.transition({ from: "Paused", to: "Playing" })
        events.moments.emit({ type: "resumed" })
      } else if (request.kind === "start") {
        begin(request)
        nextMachines.flow.transition({ from: "Paused", to: "Playing" })
      } else if (request.kind === "quit") {
        clear()
        nextMachines.flow.transition({ from: "Paused", to: "Title" })
        events.moments.emit({ type: "quit" })
      }
      return
    case "RunClear":
    case "GameOver":
      if (request.kind === "start") {
        begin(request)
        nextMachines.flow.transition({ from: state, to: "Playing" })
      } else if (request.kind === "quit") {
        clear()
        nextMachines.flow.transition({ from: state, to: "Title" })
        events.moments.emit({ type: "quit" })
      }
      return
  }
})
