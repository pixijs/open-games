import { describe, expect, test } from "vitest"

import { Intents, Tuning } from "../src/sim/index.ts"
import { expectRestores, makeGame, px, pz, replays, SCRIPTED_KEYS } from "./harness.ts"

describe("lives", () => {
  test("a hit costs a life and gives a moment of invulnerability", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "spawn", kind: "chaser", x: px + 0.5, z: pz })
    game.send({ type: "spawn", kind: "chaser", x: px - 0.5, z: pz })
    game.tickUntil(() => game.of("playerHurt").length > 0)
    expect(game.view().lives).toBe(Tuning.PLAYER.lives - 1)
    expect(game.view().player?.invulnerable).toBe(true)
    game.tick(Tuning.PLAYER.hurtInvulnerability.steps - 20)
    expect(game.of("playerHurt")).toHaveLength(1)
  })

  test("losing the last life downs the player, then the game is over", () => {
    const game = makeGame()
    game.start()
    for (const dx of [-0.5, 0.5, 1.5, -1.5]) game.send({ type: "spawn", kind: "chaser", x: px + dx, z: pz + 1 })
    game.tickUntil(() => game.of("playerDown").length > 0, 3000)
    expect(game.view().lives).toBe(0)
    expect(game.view().player?.state).toBe("Down")
    game.tickUntil(() => game.view().flow === "GameOver", 200)
    expect(game.of("gameOver")).toHaveLength(1)
    const timer = game.view().timer
    game.tick(60)
    expect(game.view().timer).toBe(timer)
  })

  test("from game over, confirm starts a fresh run", () => {
    const game = makeGame()
    game.start()
    for (const dx of [-0.5, 0.5, 1.5, -1.5]) game.send({ type: "spawn", kind: "chaser", x: px + dx, z: pz + 1 })
    game.tickUntil(() => game.view().flow === "GameOver", 3000)
    game.send({ type: "restart" })
    game.tick(2)
    expect(game.view().flow).toBe("Playing")
    expect(game.view().lives).toBe(Tuning.PLAYER.lives)
    expect(game.view().enemies).toHaveLength(0)
  })
})

describe("saves", () => {
  test("a run in progress saves to JSON and restores into a fresh game that plays on the same", () => {
    const game = makeGame()
    game.start(2, 11)
    game.tick(240)
    expectRestores(game)
  })
})

describe("determinism", () => {
  test("a scripted run from The Courtyard's start room replays exactly", () => {
    expect(replays(1500, (runtime) => runtime.send(Intents, { type: "start", wave: 2, seed: 42 }), SCRIPTED_KEYS)).toEqual({ ok: true, frames: 1500 })
  })
})
