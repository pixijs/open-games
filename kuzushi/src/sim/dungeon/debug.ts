import { Clock, Random } from "@typeonce/ritmo"

import { roomIndexOf } from "../flow.ts"
import { Actor, Body, CurrentStage, Game, Hazard, Intents, Loadout, Moments, Motion, PlayerState, PrevBody, Rng, Seam, Waves } from "../schema.ts"
import { playing } from "../tempo.ts"
import { PlayTime, step, Time } from "../time.ts"
import { loadoutFor } from "../weapons.ts"
import { fights } from "./enter.ts"
import { sideToward } from "./generate.ts"
import { Dungeon, Transition } from "./schema.ts"
import { doorTransition, throughDoor, transitionStartedMoment } from "./transitions.ts"

/**
 * The debug hooks for a dungeon run (docs/DESIGN.md, Debug hooks), beside `DebugIntents`: go to any room of the zone
 * through a door's transition or at once (`enterRoom`), end the room's fight as if its enemies fell, without kills
 * (`openDoors`), shut or break the seals alone (`lockDoors`), show the whole map (`revealMap`), and mark every other room cleared (`clearRooms`, for the lab).
 */
export const DungeonIntents = Game.System("Game/DungeonIntents", {
  when: [playing],
  events: { intents: Game.System.readEvent(Intents), moments: Game.System.writeEvent(Moments) },
  resources: {
    time: Game.System.readResource(Time),
    play: Game.System.readResource(PlayTime),
    dungeon: Game.System.writeResource(Dungeon),
    transition: Game.System.writeResource(Transition),
    stage: Game.System.writeResource(CurrentStage),
    hazard: Game.System.writeResource(Hazard),
    waves: Game.System.writeResource(Waves),
    rng: Game.System.writeResource(Rng),
    loadout: Game.System.writeResource(Loadout)
  },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.write(Body), prev: Game.Query.write(PrevBody), motion: Game.Query.write(Motion) }, with: [PlayerState] }),
    actors: Game.Query({ selection: { actor: Game.Query.read(Actor) }, without: [PlayerState] }),
    seams: Game.Query({ selection: { seam: Game.Query.read(Seam) } })
  },
  commands: Game.System.commands(Game.System.despawns(Actor), Game.System.despawns(Seam))
}, ({ events, resources, queries, commands }) => {
  const time = resources.time.get()
  const play = resources.play.get()
  const players = queries.players
  const player = players.each()[0]
  const clearField = () => {
    for (const entity of queries.actors.each()) commands.despawn(entity)
    for (const entity of queries.seams.each()) commands.despawn(entity)
  }

  for (const intent of events.intents.all()) {
    const dungeon = resources.dungeon.get()
    const stage = resources.stage.get()
    const ground = stage.room
    if (dungeon._tag !== "Zone" || ground === null) continue
    switch (intent.type) {
      case "enterRoom": {
        const to = roomIndexOf(dungeon.rooms, intent.room)
        const from = dungeon.rooms[ground.index]
        const target = dungeon.rooms[to]
        if (resources.transition.get()._tag !== "None" || from === undefined || target === undefined || player === undefined) break
        const side = sideToward(from, target)
        if (intent.instant !== true) {
          resources.transition.set(doorTransition(ground.index, to, side, time))
          events.moments.emit(transitionStartedMoment("door", side, ground.index, to, players.data.body.get(player), time))
          break
        }
        clearField()
        const hand = resources.loadout.get().weapon
        resources.loadout.set(loadoutFor(hand))
        const arrival = throughDoor(dungeon, to, side, stage, resources.hazard.get(), play, Random.draw(resources.rng), hand, true)
        resources.dungeon.set(arrival.dungeon)
        resources.stage.set(arrival.stage)
        resources.hazard.set(arrival.hazard)
        resources.waves.set(arrival.waves)
        players.data.body.set(player, arrival.body)
        players.data.prev.set(player, arrival.body)
        players.data.motion.set(player, { vx: 0, vz: 0 })
        const record = arrival.dungeon.rooms[to]
        events.moments.emit({ type: "roomSwapped", kind: "door", zone: dungeon.zone, room: to, side, x: arrival.body.x, z: arrival.body.z })
        events.moments.emit({ type: "roomEntered", zone: dungeon.zone, room: to, kind: target.kind, from: null, cleared: record?.state === "cleared", waves: target.waves.length })
        break
      }
      case "openDoors": {
        const record = dungeon.rooms[ground.index]
        const waves = resources.waves.get()
        if (record !== undefined && fights(record) && waves._tag !== "Clearing" && waves._tag !== "Won") {
          clearField()
          const total = record.kind === "boss" ? 1 : Math.max(1, record.waves.length)
          const size = record.waves[total - 1]?.length ?? 1
          resources.stage.set({ ...stage, room: { ...ground, sealed: true } })
          resources.waves.set({ _tag: "Fighting", wave: total, total, spawned: size, size, nextSpawnAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)) })
          break
        }
        if (!ground.sealed) break
        resources.stage.set({ ...stage, room: { ...ground, sealed: false } })
        events.moments.emit({ type: "doorsOpened", room: ground.index, sides: ground.exits })
        break
      }
      case "lockDoors": {
        if (ground.sealed === intent.locked) break
        resources.stage.set({ ...stage, room: { ...ground, sealed: intent.locked } })
        events.moments.emit({ type: intent.locked ? "doorsLocked" : "doorsOpened", room: ground.index, sides: ground.exits })
        break
      }
      case "revealMap": {
        resources.dungeon.set({ ...dungeon, revealed: true, rooms: dungeon.rooms.map((record) => (record.state === "hidden" ? { ...record, state: "seen" } : record)) })
        break
      }
      case "clearRooms": {
        resources.dungeon.set({ ...dungeon, revealed: true, rooms: dungeon.rooms.map((record, index) => (index === ground.index ? record : { ...record, state: "cleared" })) })
        break
      }
      default:
        break
    }
  }
})
