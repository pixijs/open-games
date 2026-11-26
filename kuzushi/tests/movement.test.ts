import { describe, expect, test } from "vitest"

import { ARENA, Tuning } from "../src/sim/index.ts"
import { makeGame } from "./harness.ts"

describe("flow", () => {
  test("the game opens on the title, and confirm starts a run with the player at The Courtyard's start room", () => {
    const game = makeGame({ keys: [{ frame: 2, press: ["confirm"] }, { frame: 3, release: ["confirm"] }] })
    game.tick(2)
    expect(game.view().flow).toBe("Title")
    expect(game.view().player).toBeNull()
    game.tick(2)
    expect(game.view().flow).toBe("Playing")
    const start = game.view().room?.layout.start
    expect(game.view().room?.kind).toBe("start")
    expect(game.view().player).toMatchObject({ x: start?.x, z: start?.z, state: "Free" })
    expect(game.view().lives).toBe(Tuning.PLAYER.lives)
    expect(game.of("runStarted")).toHaveLength(1)
  })

  test("pause holds both clocks and resume lets them run again", () => {
    const game = makeGame()
    game.start(1)
    game.tick(30)
    const before = game.view().tempo
    game.send({ type: "pause" })
    game.tick(30)
    expect(game.view().flow).toBe("Paused")
    expect(game.view().tempo.step).toBe(before.step + 1)
    game.send({ type: "resume" })
    game.tick(10)
    expect(game.view().flow).toBe("Playing")
    expect(game.view().tempo.step).toBeGreaterThan(before.step + 5)
  })

  test("the pause key toggles pause", () => {
    const game = makeGame({ keys: [{ frame: 5, press: ["pause"] }, { frame: 6, release: ["pause"] }, { frame: 10, press: ["pause"] }, { frame: 11, release: ["pause"] }] })
    game.start()
    game.tick(6)
    expect(game.view().flow).toBe("Paused")
    game.tick(6)
    expect(game.view().flow).toBe("Playing")
  })

  test("quit from pause goes back to the title and clears the world", () => {
    const game = makeGame()
    game.start(1)
    game.tick(5)
    game.send({ type: "pause" })
    game.tick()
    game.send({ type: "quit" })
    game.tick(2)
    expect(game.view().flow).toBe("Title")
    expect(game.view().player).toBeNull()
  })
})

describe("movement", () => {
  test("holding right reaches the player's speed within a tenth of a second", () => {
    const game = makeGame({ keys: [{ frame: 1, press: ["move.right"] }] })
    game.start()
    game.tick(7)
    expect(game.view().player?.vx).toBeCloseTo(Tuning.PLAYER.speed)
    game.tick(24)
    const player = game.view().player
    expect(player?.x).toBeGreaterThan(Tuning.PLAYER.speed * 0.5 - 0.5)
    expect(player?.x).toBeLessThan(Tuning.PLAYER.speed * 0.5 + 0.01)
    expect(player?.z).toBeCloseTo(Tuning.PLAYER.start.z)
  })

  test("up on the stick is away from the camera (-z), and the player faces where it runs", () => {
    const game = makeGame({ keys: [{ frame: 1, press: ["move.up"] }] })
    game.start()
    game.tick(30)
    const player = game.view().player
    expect(player?.z).toBeLessThan(Tuning.PLAYER.start.z - 2)
    expect(player?.facing).toBeCloseTo(-Math.PI / 2)
  })

  test("the boundary walls stop the player", () => {
    const game = makeGame({ keys: [{ frame: 1, press: ["move.down"] }] })
    game.start()
    game.tick(300)
    expect(game.view().player?.z).toBeLessThanOrEqual(ARENA.halfDepth - Tuning.PLAYER.radius + 0.001)
    expect(game.view().player?.z).toBeGreaterThan(ARENA.halfDepth - Tuning.PLAYER.radius - 0.05)
  })

  test("a block stops the player and it slides along", () => {
    const block = ARENA.blocks[6]
    const game = makeGame({ keys: [{ frame: 1, press: ["move.right"] }] })
    game.start()
    game.tick(120)
    expect(block).toBeDefined()
    const player = game.view().player
    expect(player?.x).toBeLessThan((block?.x ?? 0) - (block?.halfWidth ?? 0) - Tuning.PLAYER.radius + 0.02)
  })

  test("the mouse aim turns the player toward the pointed spot", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "aim", x: Tuning.PLAYER.start.x + 5, z: Tuning.PLAYER.start.z })
    game.tick(2)
    expect(game.view().player?.facing).toBeCloseTo(0)
    game.send({ type: "aim", x: Tuning.PLAYER.start.x, z: Tuning.PLAYER.start.z + 5 })
    game.tick(2)
    expect(game.view().player?.facing).toBeCloseTo(Math.PI / 2)
  })
})
