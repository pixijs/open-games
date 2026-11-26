import { describe, expect, test } from "vitest"

import { ARENA, dungeonSeedOf, Tuning } from "../src/sim/index.ts"
import { planOf } from "../src/lab/dungeons.ts"
import { makeGame, settle } from "./harness.ts"

const block = ARENA.blocks.find((each) => each.x === 8) ?? { x: 8, z: 1.5 }

describe("debug-scene hooks", () => {
  test("the open floor drops the stage's props until the run ends", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "floor", open: true })
    game.send({ type: "teleport", x: block.x, z: block.z, facing: null })
    game.tick()
    expect(game.view().debug.openFloor).toBe(true)
    expect(game.view().player).toMatchObject({ x: block.x, z: block.z })
    game.start()
    expect(game.view().debug.openFloor).toBe(false)
    game.send({ type: "teleport", x: block.x, z: block.z, facing: null })
    game.tick()
    const player = game.view().player
    expect(Math.hypot((player?.x ?? block.x) - block.x, (player?.z ?? block.z) - block.z)).toBeGreaterThan(1)
  })

  test("teleport with an id puts that enemy at a point and facing, at rest", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind: "chaser", x: 3, z: 0, drill: "idle" })
    game.tick()
    const id = game.view().enemies[0]?.id ?? -1
    game.send({ type: "teleport", x: -3, z: 1, facing: 0.5, id })
    game.tick()
    expect(game.view().enemies[0]).toMatchObject({ id, x: -3, z: 1, facing: 0.5 })
  })

  test("remove takes one enemy away without a kill", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind: "chaser", x: 3, z: 0, drill: "idle" })
    game.send({ type: "spawn", kind: "shooter", x: -3, z: 0, drill: "idle" })
    game.tick()
    const [first] = game.view().enemies
    game.send({ type: "remove", id: first?.id ?? -1 })
    game.tick()
    expect(game.view().enemies.map((enemy) => enemy.kind)).toEqual(["shooter"])
    expect(game.of("enemyKilled")).toHaveLength(0)
  })

  test("a blow staggers as a slash would, the spin staggers the armoured, and a heavy blow kills", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind: "chaser", x: 3, z: 0, drill: "idle" })
    game.send({ type: "spawn", kind: "bruiser", x: -3, z: 0, drill: "idle" })
    game.tick()
    settle(game)
    const [chaser, bruiser] = game.view().enemies
    game.send({ type: "blow", id: chaser?.id ?? -1, damage: 1, step: 1 })
    game.send({ type: "blow", id: bruiser?.id ?? -1, damage: 1, step: 1 })
    game.tick()
    expect(game.view().enemies.map((enemy) => [enemy.kind, enemy.state, enemy.hp])).toEqual([
      ["chaser", "Stagger", Tuning.ENEMY.chaser.hp - 1],
      ["bruiser", "Move", Tuning.ENEMY.bruiser.hp - 1]
    ])
    game.tick(30)
    game.send({ type: "blow", id: bruiser?.id ?? -1, damage: 0, step: 3 })
    game.send({ type: "blow", id: chaser?.id ?? -1, damage: 99, step: 1 })
    game.tick()
    expect(game.view().enemies.map((enemy) => [enemy.kind, enemy.state])).toEqual([["bruiser", "Stagger"]])
    expect(game.of("enemyKilled")).toEqual([expect.objectContaining({ kind: "chaser", source: "slash" })])
  })

  test("press with a step starts the slash at that step of the combo", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "press", action: "slash", step: 3 })
    game.tick()
    expect(game.view().player).toMatchObject({ state: "Attack", move: "spin", step: 3 })
    game.tick(60)
    game.send({ type: "press", action: "slash", step: 2 })
    game.tick()
    expect(game.view().player).toMatchObject({ state: "Attack", move: "crosscut", step: 2 })
  })

  test("heal refills the player's lives", () => {
    const game = makeGame()
    game.start()
    const { x, z } = game.view().player ?? { x: 0, z: 0 }
    game.send({ type: "spawn", kind: "chaser", x: x + 2, z, drill: "idle" })
    game.tick()
    settle(game)
    game.send({ type: "attack", id: null })
    game.tickUntil(() => game.of("playerHurt").length > 0, 120)
    expect(game.view().lives).toBe(Tuning.PLAYER.lives - 1)
    game.send({ type: "heal" })
    game.tick()
    expect(game.view().lives).toBe(Tuning.PLAYER.lives)
  })

  test("clearRooms leaves no room to lock: a combat room stays open and the boss room's gate stands open", () => {
    const game = makeGame()
    game.startZone("courtyard")
    game.tick()
    game.send({ type: "clearRooms" })
    game.tick()
    const map = game.view().map
    expect(map?.rooms.filter((room) => room.index !== 0).every((room) => room.state === "cleared")).toBe(true)
    const combat = map?.rooms.find((room) => room.kind === "combat")?.index ?? -1
    game.send({ type: "enterRoom", room: combat, instant: true })
    game.tick(60)
    expect(game.view().room).toMatchObject({ index: combat, state: "cleared" })
    expect(game.view().room?.doors.every((door) => door.state === "open")).toBe(true)
    expect(game.view().enemies).toHaveLength(0)
    game.send({ type: "enterRoom", room: "boss", instant: true })
    game.tick(60)
    expect(game.view().room?.doors.some((door) => door.mark === "gate" && door.state === "open")).toBe(true)
    expect(game.view().boss).toBeNull()
  })

  test("a drill boss takes the phase it is sent to at once, with no shift", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind: "sunder", x: 0, z: -4, drill: "idle" })
    game.tick(2)
    game.send({ type: "bossPhase", phase: 3 })
    game.tick(30)
    expect(game.view().boss).toMatchObject({ phase: 3, state: "fighting" })
    expect(game.of("bossPhase")).toHaveLength(0)
  })

  test("the lab plans the dungeon a run's seed makes", () => {
    for (const seed of [1, 7, 82]) {
      const game = makeGame()
      game.startZone("spiral", null, seed)
      expect(game.of("zoneStarted")[0]?.seed).toBe(dungeonSeedOf(seed))
      expect(game.view().map?.rooms.map((room) => room.kind)).toEqual(planOf("spiral", seed).rooms.map((room) => room.kind))
    }
  })
})
