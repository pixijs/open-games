import { describe, expect, test } from "vitest"

import { stageIds, stageOf, Tuning } from "../src/sim/index.ts"
import type { EnemyKind } from "../src/sim/index.ts"
import { APPEAR, makeGame, px, pz } from "./harness.ts"

describe("debug hooks", () => {
  test("a spawn takes a position and a facing", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind: "lancer", x: 3, z: -4, facing: 1.2, drill: "idle" })
    game.tick()
    expect(game.view().enemies[0]).toMatchObject({ kind: "lancer", x: 3, z: -4, facing: 1.2, drill: "idle" })
  })

  test("an idle enemy stands still and never attacks until ordered, then plays its attack through", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind: "chaser", x: px + 2, z: pz, drill: "idle" })
    game.tick(APPEAR + 120)
    expect(game.of("telegraph")).toHaveLength(0)
    expect(game.view().enemies[0]).toMatchObject({ x: px + 2, z: pz, state: "Move" })
    game.send({ type: "attack", id: game.view().enemies[0]?.id ?? null })
    game.tick()
    expect(game.of("telegraph")).toEqual([expect.objectContaining({ kind: "chaser" })])
    game.tickUntil(() => game.view().enemies[0]?.state === "Move", 200)
    expect(game.of("enemyAttack")).toHaveLength(1)
    game.tick(120)
    expect(game.of("telegraph")).toHaveLength(1)
  })

  test.each(Tuning.enemyKinds)("a %s ordered to attack telegraphs at once, at any distance", (kind: EnemyKind) => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind, x: px - 10, z: pz, drill: "idle" })
    game.tick(APPEAR)
    game.send({ type: "attack", id: null })
    game.tick()
    expect(game.of(kind === "trickster" ? "blink" : "telegraph")).toHaveLength(1)
  })

  test("a dummy takes every hit but never dies, never moves and never staggers", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "aim", x: px + 10, z: pz })
    game.send({ type: "spawn", kind: "shooter", x: px + 1.8, z: pz, drill: "dummy" })
    game.tick(APPEAR)
    for (let index = 0; index < 6; index++) {
      game.send({ type: "press", action: "slash" })
      game.tick(12)
    }
    expect(game.of("hit").length).toBeGreaterThanOrEqual(Tuning.ENEMY.shooter.hp + 1)
    expect(game.of("enemyKilled")).toHaveLength(0)
    expect(game.view().enemies[0]).toMatchObject({ x: px + 1.8, z: pz, drill: "dummy" })
    expect(game.view().enemies[0]?.hp).toBeGreaterThan(0)
    expect(game.view().enemies[0]?.state).not.toBe("Stagger")
  })

  test("invulnerable, the player takes no hits until switched off", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "invulnerable", on: true })
    game.send({ type: "spawn", kind: "chaser", x: px + 3, z: pz })
    game.tick(600)
    expect(game.of("playerHurt")).toHaveLength(0)
    expect(game.view().debug.invulnerable).toBe(true)
    game.send({ type: "invulnerable", on: false })
    game.tickUntil(() => game.of("playerHurt").length > 0, 600)
  })

  test("invulnerability and movement numbers change on any screen, with no run playing", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "invulnerable", on: true })
    game.send({ type: "tune", moves: { speed: 12 } })
    game.tick()
    game.send({ type: "pause" })
    game.send({ type: "invulnerable", on: false })
    game.send({ type: "tune", moves: null })
    game.tick()
    expect(game.view().flow).toBe("Paused")
    expect(game.view().debug.invulnerable).toBe(false)
    expect(game.view().debug.moves).toMatchObject({ speed: Tuning.PLAYER.speed })
    game.send({ type: "quit" })
    game.tick()
    game.send({ type: "invulnerable", on: true })
    game.tick()
    expect(game.view().flow).toBe("Title")
    expect(game.view().debug.invulnerable).toBe(true)
    expect(game.view().debug.moves).toMatchObject({ speed: Tuning.PLAYER.speed })
  })

  test("teleport puts the player at a point and facing, out of any wall", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "teleport", x: -10, z: 4, facing: Math.PI })
    game.tick()
    expect(game.view().player).toMatchObject({ x: -10, z: 4, facing: Math.PI })
    game.send({ type: "teleport", x: 8, z: 1.5, facing: null })
    game.tick()
    const player = game.view().player
    expect(Math.abs((player?.x ?? 8) - 8) > 1 || Math.abs((player?.z ?? 1.5) - 1.5) > 1).toBe(true)
  })

  test("press acts as a key press: slash, dash, parry and the special", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "press", action: "slash" })
    game.tick(40)
    game.send({ type: "press", action: "dash" })
    game.tick(40)
    game.send({ type: "press", action: "parry" })
    game.tick(40)
    game.send({ type: "grantFocus" })
    game.send({ type: "press", action: "special" })
    game.tick(2)
    expect(game.of("slash")).toHaveLength(1)
    expect(game.of("dashStarted")).toHaveLength(1)
    expect(game.of("parryStarted")).toHaveLength(1)
    expect(game.of("specialStarted")).toHaveLength(1)
  })

  test("steer holds a direction until released, and a new run releases it", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "steer", x: 1, z: 0 })
    game.tick(60)
    const moved = (game.view().player?.x ?? 0) - px
    expect(moved).toBeGreaterThan(Tuning.PLAYER.speed * 0.8)
    game.send({ type: "steer", x: 0, z: 0 })
    game.tick(30)
    const stopped = game.view().player?.x ?? 0
    game.tick(30)
    expect(game.view().player?.x).toBeCloseTo(stopped)
    game.send({ type: "steer", x: 0, z: 1 })
    game.tick()
    game.start()
    expect(game.view().debug.steer).toBeNull()
  })

  test("tune overrides the player's speed and dash, lasts across runs, and resets", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "tune", moves: { speed: 12, dashDistance: 6, dashTime: 0.25 } })
    game.send({ type: "steer", x: -1, z: 0 })
    game.tick(61)
    expect(px - (game.view().player?.x ?? 0)).toBeGreaterThan(10)
    expect(game.view().debug.moves).toMatchObject({ speed: 12, dashTime: 0.25 })
    expect(game.view().debug.moves.dashDistance).toBeCloseTo(6)
    game.start()
    game.send({ type: "press", action: "dash" })
    game.tick(30)
    const [started] = game.of("dashStarted").slice(-1)
    const [ended] = game.of("dashEnded").slice(-1)
    expect(Math.hypot((ended?.x ?? 0) - (started?.x ?? 0), (ended?.z ?? 0) - (started?.z ?? 0))).toBeCloseTo(6, 1)
    game.send({ type: "tune", moves: null })
    game.tick()
    expect(game.view().debug.moves).toMatchObject({ speed: Tuning.PLAYER.speed })
    expect(game.view().debug.moves.dashDistance).toBeCloseTo(Tuning.DASH.speed * Tuning.DASH.time.steps / 60)
  })

  test.each(stageIds)("the %s sandbox runs with its hazard on or off", (stage) => {
    const game = makeGame()
    game.startStage(stage)
    expect(game.view()).toMatchObject({ zone: stage, wave: { index: 0, phase: "idle" } })
    game.send({ type: "hazard", on: false })
    game.tick()
    const hazard = game.view().hazard
    expect(hazard.kind === "none" || !hazard.on).toBe(true)
    game.send({ type: "spawn", kind: "chaser", x: null, z: null })
    game.tick()
    const spawned = game.of("enemySpawned")[0]
    expect(stageOf(stage).layout.spawnPoints).toContainEqual({ x: spawned?.x, z: spawned?.z })
  })
})
