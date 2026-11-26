import { within } from "../geometry.ts"
import { Body, CurrentStage, gainFocus, Game, Input, Intents, Loadout, Moments, PlayerState, Run } from "../schema.ts"
import { playing } from "../tempo.ts"
import { FOCUS, PLAYER } from "../tuning.ts"
import { loadoutFor } from "../weapons.ts"
import { altarSpots } from "./layout.ts"
import { ROOM } from "./rules.ts"
import { Dungeon, Transition, updateRoom } from "./schema.ts"

/**
 * Altars and springs in the room the player stands in, outside transitions. Interact (the key, or the debug hooks'
 * intent) by an altar swaps the weapon in hand for the one on it, so a choice can be undone in that room; it ends an
 * attack in progress, and the new weapon's darts start full. Walking over a clear's diamond takes it and heals one
 * when a diamond is missing; over its FOCUS, takes it and fills `ROOM.cacheFocus` when FOCUS isn't full (otherwise
 * each waits on the floor). Stepping into an unspent spring with diamonds missing heals them all and spends it.
 */
export const Shrines = Game.System("Game/Shrines", {
  when: [playing],
  resources: {
    input: Game.System.readResource(Input),
    stage: Game.System.readResource(CurrentStage),
    transition: Game.System.readResource(Transition),
    dungeon: Game.System.writeResource(Dungeon),
    loadout: Game.System.writeResource(Loadout),
    run: Game.System.writeResource(Run)
  },
  queries: { players: Game.Query({ selection: { body: Game.Query.read(Body), state: Game.Query.write(PlayerState) } }) },
  events: { intents: Game.System.readEvent(Intents), moments: Game.System.writeEvent(Moments) }
}, ({ resources, queries, events }) => {
  const pressed = resources.input.get().actions.interact.pressed || events.intents.all().some((intent) => intent.type === "interact")
  const dungeon = resources.dungeon.get()
  const ground = resources.stage.get().room
  const players = queries.players
  const player = players.each()[0]
  if (dungeon._tag !== "Zone" || ground === null || player === undefined || resources.transition.get()._tag !== "None") return
  const record = dungeon.rooms[ground.index]
  const body = players.data.body.get(player)
  const state = players.data.state.get(player)
  if (record === undefined || state._tag === "Down" || state._tag === "Special") return

  const altars = record.altars ?? []
  const spots = altarSpots(record)
  const near = altars.flatMap((weapon, index) => {
    const spot = spots[index]
    return weapon === null || spot === undefined || !within(body.x, body.z, spot.x, spot.z, ROOM.altarReach) ? [] : [{ weapon, index, spot }]
  }).sort((a, b) => ((a.spot.x - body.x) ** 2 + (a.spot.z - body.z) ** 2) - ((b.spot.x - body.x) ** 2 + (b.spot.z - body.z) ** 2))[0]
  if (pressed && near !== undefined) {
    const hand = resources.loadout.get()
    const left = hand.weapon
    resources.loadout.set(loadoutFor(near.weapon, hand.marks))
    resources.dungeon.set(updateRoom(dungeon, ground.index, (room) => ({ ...room, altars: altars.map((weapon, at) => (at === near.index ? left : weapon)) })))
    if (state._tag === "Attack" || state._tag === "Slam" || state._tag === "Charge") players.data.state.transition(player, { from: state._tag, to: "Free" })
    events.moments.emit({ type: "weaponTaken", weapon: near.weapon, left, altar: near.index, x: near.spot.x, z: near.spot.z })
    return
  }

  const run = resources.run.get()
  const reached = record.drops.findIndex((drop) => !drop.taken && within(body.x, body.z, drop.x, drop.z, ROOM.dropReach) && (drop.kind === "diamond" ? run.lives < PLAYER.lives : run.focus < FOCUS.max))
  const drop = record.drops[reached]
  if (drop !== undefined) {
    resources.dungeon.set(updateRoom(dungeon, ground.index, (room) => ({ ...room, drops: room.drops.map((each, at) => (at === reached ? { ...each, taken: true } : each)) })))
    if (drop.kind === "diamond") {
      resources.run.set({ ...run, lives: run.lives + 1 })
      events.moments.emit({ type: "dropTaken", kind: "diamond", x: drop.x, z: drop.z, amount: 1 })
      events.moments.emit({ type: "healed", amount: 1, lives: run.lives + 1, x: drop.x, z: drop.z, source: record.kind === "elite" ? "elite" : "room" })
      return
    }
    const gained = gainFocus(run, ROOM.cacheFocus)
    resources.run.set(gained.run)
    events.moments.emit({ type: "dropTaken", kind: "focus", x: drop.x, z: drop.z, amount: gained.run.focus - run.focus })
    if (gained.filled) events.moments.emit({ type: "focusFull" })
    return
  }

  const spring = record.spring
  if (spring === null || spring.spent || run.lives >= PLAYER.lives || !within(body.x, body.z, spring.x, spring.z, ROOM.springRadius)) return
  resources.run.set({ ...run, lives: PLAYER.lives })
  resources.dungeon.set(updateRoom(dungeon, ground.index, (room) => ({ ...room, spring: { ...spring, spent: true } })))
  events.moments.emit({ type: "healed", amount: PLAYER.lives - run.lives, lives: PLAYER.lives, x: spring.x, z: spring.z, source: "spring" })
})
