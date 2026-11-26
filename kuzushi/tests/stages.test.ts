import { Collide2 } from "@typeonce/ritmo-math"
import { describe, expect, test } from "vitest"

import { Intents, slabGroupsOf, stageIds, stageOf, STAGES, terrainOf, Tuning } from "../src/sim/index.ts"
import { makeGame, replays, SCRIPTED_KEYS } from "./harness.ts"

/** The largest enemy a wave sends: bosses stand where their rooms put them, never on a spawn point. */
const largest = Math.max(...Tuning.enemyKinds.filter((kind) => !Tuning.isBoss(kind)).map((kind) => Tuning.ENEMY[kind].radius))

describe("stages", () => {
  test("there is one classic arena per zone, in the zones' order", () => {
    expect(STAGES.map((stage) => stage.id)).toEqual(["courtyard", "spiral", "void"])
  })

  test.each(stageIds)("%s's sandbox starts directly: its classic floor, its start and its hazard, with no fight", (stage) => {
    const game = makeGame()
    game.startStage(stage, 0)
    const view = game.view()
    const layout = stageOf(stage).layout
    expect(view.zone).toBe(stage)
    expect(view.player).toMatchObject({ x: layout.start.x, z: layout.start.z })
    expect(view.wave).toMatchObject({ index: 0, phase: "idle" })
    expect(view.hazard.kind).toBe(({ courtyard: "none", spiral: "beam", void: "slabs" } as const)[stage])
    expect(game.of("runStarted")).toEqual([expect.objectContaining({ zone: stage, sandbox: true })])
  })

  test("start keeps starting The Courtyard, and any wave but 0 starts a stage's dungeon", () => {
    const game = makeGame()
    game.startStage("void", 3)
    expect(game.view()).toMatchObject({ zone: "void", room: { kind: "start" } })
    game.send({ type: "restart" })
    game.tick()
    expect(game.view()).toMatchObject({ zone: "void", room: { kind: "start" } })
    game.send({ type: "start", wave: 2, seed: 4 })
    game.tick()
    expect(game.view()).toMatchObject({ zone: "courtyard", room: { kind: "start" } })
  })

  test("game over names the zone it happened in", () => {
    const game = makeGame()
    game.startStage("spiral", 0)
    const { x, z } = stageOf("spiral").layout.start
    for (const dx of [-0.5, 0.5, 1.5, -1.5, 2.5]) game.send({ type: "spawn", kind: "orbiter", x: x + dx, z: z - 1 })
    game.tickUntil(() => game.view().flow === "GameOver", 4000)
    expect(game.of("gameOver")[0]).toMatchObject({ zone: "spiral", room: null })
  })
})

describe("layouts", () => {
  test.each(stageIds)("every %s spawn point stands on the floor, clear of every wall, for the largest enemy", (stage) => {
    const terrain = terrainOf(stage, 0)
    for (const point of stageOf(stage).layout.spawnPoints) {
      expect(terrain.onFloor(point.x, point.z)).toBe(true)
      expect(Collide2.pushOut({ x: point.x, y: point.z }, largest, terrain.bounded)).toEqual({ x: point.x, y: point.z })
    }
  })

  test.each(stageIds)("the %s start stands clear on floor that never falls", (stage) => {
    const { start } = stageOf(stage).layout
    const last = terrainOf(stage, slabGroupsOf(stageOf(stage).layout).length)
    expect(last.onFloor(start.x, start.z)).toBe(true)
    expect(Collide2.pushOut({ x: start.x, y: start.z }, Tuning.PLAYER.radius, last.bounded)).toEqual({ x: start.x, y: start.z })
  })

  test("The Void's slabs sit on the 1-unit grid and fall in four groups, after waves 2 to 5", () => {
    const layout = stageOf("void").layout
    if (layout.floor.kind !== "slabs") throw new Error("The Void has a slab floor")
    for (const slab of layout.floor.slabs) {
      for (const edge of [slab.x - slab.halfWidth, slab.x + slab.halfWidth, slab.z - slab.halfDepth, slab.z + slab.halfDepth]) expect(Number.isInteger(edge)).toBe(true)
    }
    expect(slabGroupsOf(layout).map((group) => group.after)).toEqual([2, 3, 4, 5])
  })
})

describe("determinism", () => {
  test.each(["spiral", "void"] as const)("a scripted run from %s's start room replays exactly", (stage) => {
    expect(replays(1500, (runtime) => runtime.send(Intents, { type: "startStage", stage, wave: 1, seed: 42 }), SCRIPTED_KEYS)).toEqual({ ok: true, frames: 1500 })
  })
})
