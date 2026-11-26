import { Clock, Random } from "@typeonce/ritmo"

import type { Point } from "../arena.ts"
import { angleOf } from "../geometry.ts"
import { fallenOf } from "../ground.ts"
import type { MomentOf } from "../moments.ts"
import { opposite, SIDE_DIRS } from "../rooms.ts"
import type { Side, TransitionKind } from "../rooms.ts"
import { Actor, Body, CurrentStage, Game, Hazard, Loadout, Moments, Motion, Moves, PlayerState, PrevBody, Rng, Seam, Waves } from "../schema.ts"
import type { HazardValue, StageValue, WavesValue } from "../schema.ts"
import { playing } from "../tempo.ts"
import { inSteps, PlayTime, Time } from "../time.ts"
import { loadoutFor } from "../weapons.ts"
import type { WeaponId } from "../weapons.ts"
import { zoneOf } from "../zones.ts"
import type { ZoneId } from "../zones.ts"
import { arrive } from "./enter.ts"
import type { Arrival } from "./enter.ts"
import { generateDungeon, roomThrough } from "./generate.ts"
import { doorTaken } from "./layout.ts"
import { BEATS, DOOR, SEED_MAX, TRANSITION } from "./rules.ts"
import { Dungeon, Transition, updateRoom } from "./schema.ts"
import type { TransitionValue, ZoneDungeon } from "./schema.ts"

type Playing = Exclude<TransitionValue, { readonly _tag: "None" }>

/** The steps of each beat of a door or zone transition, in the order they play. */
export const beatLengths = (kind: Playing["_tag"]): ReadonlyArray<number> =>
  kind === "Door" ? BEATS.door.map((beat) => TRANSITION.door[beat]) : BEATS.zone.map((beat) => TRANSITION.zone[beat])

/** The whole transition's length, and the step its swap comes on, in steps. */
export const timingOf = (kind: Playing["_tag"]): { readonly total: number; readonly swapAt: number } => {
  const table = kind === "Door" ? TRANSITION.door : TRANSITION.zone
  return { total: beatLengths(kind).reduce((sum, steps) => sum + steps, 0), swapAt: table.exit + table.cover }
}

/** The transition moved on to its next beat, or ended (`None`) after its reveal. */
const nextBeat = (transition: Playing, time: Clock.Time<60>): TransitionValue => {
  if (transition._tag === "Door") {
    const beat = BEATS.door[BEATS.door.indexOf(transition.beat) + 1]
    return beat === undefined ? { _tag: "None" } : { ...transition, beat, until: Clock.deadline(time, inSteps(TRANSITION.door[beat])) }
  }
  const beat = BEATS.zone[BEATS.zone.indexOf(transition.beat) + 1]
  return beat === undefined ? { _tag: "None" } : { ...transition, beat, until: Clock.deadline(time, inSteps(TRANSITION.zone[beat])) }
}

/** Starts a door transition out of `side` of the current room into room `to`. */
export const doorTransition = (from: number, to: number, side: Side, time: Clock.Time<60>): TransitionValue =>
  ({ _tag: "Door", side, from, to, beat: "exit", until: Clock.deadline(time, inSteps(TRANSITION.door.exit)) })

/** The moment a transition starts, the hero at `body`: its whole length and when its swap comes, in seconds. */
export const transitionStartedMoment = (kind: TransitionKind, side: Side, from: number, to: number, body: Point, time: Clock.Time<60>): MomentOf<"transitionStarted"> => {
  const timing = timingOf(kind === "door" ? "Door" : "Zone")
  return { type: "transitionStarted", kind, side, from, to, x: body.x, z: body.z, duration: timing.total / time.hz, swapAt: timing.swapAt / time.hz }
}

/**
 * The player arriving through a door: the room left keeps its fallen slabs, and room `to` is entered through the
 * side opposite the one left by.
 */
export const throughDoor = (
  dungeon: ZoneDungeon,
  to: number,
  side: Side,
  stage: StageValue,
  hazard: HazardValue,
  play: Clock.Time<60>,
  random: Random.Random,
  hand: WeaponId,
  control: boolean
): Arrival => {
  const kept = updateRoom(dungeon, dungeon.current, (record) => ({ ...record, fallen: fallenOf(hazard) }))
  return arrive(kept, to, opposite[side], stage, play, random, hand, control)
}

/**
 * Door and zone transitions, on the run clock while gameplay holds (docs/DESIGN.md, Transitions). Walking
 * `DOOR.trigger` past the floor's edge into an open door (or the boss room's open gate) starts one: the hero is carried
 * into the doorway, and under full cover the next room (or the next zone's dungeon and its start room) replaces the
 * old one, every other actor gone and the hand's darts and marks reset. The hero stands `DOOR.arrival` inside the
 * opposite door, still moving the same way (a zone starts facing north at its start room's south door). Control
 * returns as the reveal ends, and a room still to win arms its doors then.
 */
export const Transitions = Game.System("Game/Transitions", {
  when: [playing],
  resources: {
    time: Game.System.readResource(Time),
    play: Game.System.readResource(PlayTime),
    moves: Game.System.readResource(Moves),
    transition: Game.System.writeResource(Transition),
    dungeon: Game.System.writeResource(Dungeon),
    stage: Game.System.writeResource(CurrentStage),
    hazard: Game.System.writeResource(Hazard),
    waves: Game.System.writeResource(Waves),
    rng: Game.System.writeResource(Rng),
    loadout: Game.System.writeResource(Loadout)
  },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.write(Body), prev: Game.Query.write(PrevBody), motion: Game.Query.write(Motion), state: Game.Query.read(PlayerState) } }),
    actors: Game.Query({ selection: { actor: Game.Query.read(Actor) }, without: [PlayerState] }),
    seams: Game.Query({ selection: { seam: Game.Query.read(Seam) } })
  },
  events: { moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(Game.System.despawns(Actor), Game.System.despawns(Seam))
}, ({ resources, queries, events, commands }) => {
  const time = resources.time.get()
  const play = resources.play.get()
  const dungeon = resources.dungeon.get()
  const transition = resources.transition.get()
  const stage = resources.stage.get()
  const players = queries.players
  const player = players.each()[0]
  if (dungeon._tag !== "Zone" || player === undefined) return
  const body = players.data.body.get(player)
  const settle = (arrival: Arrival) => {
    resources.dungeon.set(arrival.dungeon)
    resources.stage.set(arrival.stage)
    resources.hazard.set(arrival.hazard)
    resources.waves.set(arrival.waves)
  }

  if (transition._tag === "None") {
    const ground = stage.room
    const tag = players.data.state.get(player)._tag
    if (ground === null || tag === "Down" || tag === "Special" || resources.waves.get()._tag === "Won") return
    const side = doorTaken(ground, body.x, body.z)
    if (side === undefined) return
    const next = side === ground.gate ? zoneOf(dungeon.zone).next : null
    const to = next !== null ? 0 : roomThrough(dungeon.rooms, ground.index, side)
    if (to === undefined) return
    const started: TransitionValue = next !== null
      ? { _tag: "Zone", side, from: ground.index, zone: next, beat: "exit", until: Clock.deadline(time, inSteps(TRANSITION.zone.exit)) }
      : doorTransition(ground.index, to, side, time)
    resources.transition.set(started)
    events.moments.emit(transitionStartedMoment(next !== null ? "zone" : "door", side, ground.index, to, body, time))
    return
  }

  if (transition.beat === "exit") {
    const dir = SIDE_DIRS[transition.side]
    const carry = DOOR.carry / time.hz
    players.data.prev.set(player, body)
    players.data.body.set(player, { x: body.x + dir.x * carry, z: body.z + dir.z * carry, facing: angleOf(dir.x, dir.z) })
  }
  if (!Clock.reached(time, transition.until)) return

  if (transition.beat === "cover") {
    for (const entity of queries.actors.each()) commands.despawn(entity)
    for (const entity of queries.seams.each()) commands.despawn(entity)
    const hand = resources.loadout.get().weapon
    resources.loadout.set(loadoutFor(hand))
    const random = Random.draw(resources.rng)
    const arrival = transition._tag === "Door"
      ? throughDoor(dungeon, transition.to, transition.side, stage, resources.hazard.get(), play, random, hand, false)
      : arrive(madeZone(transition.zone, random.integer(1, SEED_MAX), time), 0, "south", { ...stage, id: transition.zone, room: null }, play, random, hand, false)
    settle(arrival)
    const dir = SIDE_DIRS[transition.side]
    const speed = transition._tag === "Door" ? resources.moves.get().speed : 0
    const placed = { x: arrival.body.x, z: arrival.body.z, facing: arrival.body.facing }
    players.data.body.set(player, placed)
    players.data.prev.set(player, placed)
    players.data.motion.set(player, { vx: dir.x * speed, vz: dir.z * speed })
    const zone = arrival.dungeon.zone
    const room = arrival.dungeon.current
    const record = arrival.dungeon.rooms[room]
    if (transition._tag === "Zone") {
      events.moments.emit({ type: "zoneStarted", zone, number: zoneOf(zone).number, rooms: arrival.dungeon.rooms.length, seed: arrival.dungeon.seed })
    }
    events.moments.emit({ type: "roomSwapped", kind: transition._tag === "Door" ? "door" : "zone", zone, room, side: transition.side, x: placed.x, z: placed.z })
    events.moments.emit({
      type: "roomEntered",
      zone,
      room,
      kind: record?.kind ?? "combat",
      from: transition._tag === "Door" ? opposite[transition.side] : null,
      cleared: record?.state === "cleared",
      waves: record?.waves.length ?? 0
    })
  }

  const next = nextBeat(transition, time)
  resources.transition.set(next)
  if (next._tag !== "None") return
  const after = resources.dungeon.get()
  events.moments.emit({ type: "transitionEnded", kind: transition._tag === "Door" ? "door" : "zone", zone: after._tag === "Zone" ? after.zone : dungeon.zone, room: after._tag === "Zone" ? after.current : 0 })
  resources.waves.set(armed(resources.waves.get(), play))
})

/** A zone's dungeon made fresh as the gate is walked through. */
const madeZone = (zone: ZoneId, seed: number, time: Clock.Time<60>): ZoneDungeon =>
  ({ _tag: "Zone", zone, seed, rooms: generateDungeon(zone, seed), current: 0, revealed: false, startedAt: time.step })

/** Doors waiting for control start their lock delay now. */
export const armed = (waves: WavesValue, play: Clock.Time<60>): WavesValue =>
  waves._tag === "Arming" && waves.until === null ? { _tag: "Arming", until: Clock.deadline(play, DOOR.lockDelay) } : waves
