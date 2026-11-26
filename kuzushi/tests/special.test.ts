import { describe, expect, test } from "vitest"

import { Tuning } from "../src/sim/index.ts"
import { makeGame, px, pz, tap } from "./harness.ts"
import type { Script } from "./harness.ts"

const withEnemies = (keys: NonNullable<Script["keys"]>) => {
  const game = makeGame({ keys })
  game.start()
  game.send({ type: "spawn", kind: "bruiser", x: px + 4, z: pz })
  game.send({ type: "spawn", kind: "chaser", x: px - 5, z: pz + 2 })
  game.send({ type: "spawn", kind: "shooter", x: px + 15, z: pz - 10 })
  game.tick(45)
  return game
}

describe("special", () => {
  test("without full FOCUS the special does nothing", () => {
    const game = withEnemies(tap("special", 50))
    game.tick(20)
    expect(game.of("specialStarted")).toHaveLength(0)
    expect(game.view().player?.state).toBe("Free")
  })

  test("with full FOCUS it freezes the world, strikes every enemy in range, and empties FOCUS", () => {
    const game = withEnemies(tap("special", 50))
    game.send({ type: "grantFocus" })
    game.tick(4)
    expect(game.view().focusFull).toBe(true)
    game.tick(1)
    expect(game.of("specialStarted")).toHaveLength(1)
    expect(game.view().focus).toBe(0)
    const frozen = game.view()
    game.tick(Tuning.SPECIAL.freeze.steps - 2)
    expect(game.view().tempo.playStep).toBe(frozen.tempo.playStep)
    expect(game.view().enemies.map((enemy) => [enemy.x, enemy.z])).toEqual(frozen.enemies.map((enemy) => [enemy.x, enemy.z]))
    game.tickUntil(() => game.of("specialEnded").length > 0)
    const beats = game.of("specialHit")
    expect(beats).toHaveLength(Tuning.SPECIAL.hits)
    expect(beats.at(-1)?.final).toBe(true)
    expect(beats.every((beat) => beat.targets.length >= 1)).toBe(true)
    expect(game.view().enemies.map((enemy) => enemy.kind)).toEqual(["shooter"])
    expect(game.of("enemyKilled").map((kill) => kill.kind).sort()).toEqual(["bruiser", "chaser"])
    expect(game.view().player?.state).toBe("Free")
  })

  test("after the finisher the game runs in slow motion for a moment", () => {
    const game = withEnemies(tap("special", 50))
    game.send({ type: "grantFocus" })
    game.tickUntil(() => game.of("specialEnded").length > 0)
    game.tick(1)
    expect(game.view().tempo.slowScale).toBeCloseTo(1 / Tuning.SPECIAL.slowPeriod)
    const start = game.view().tempo
    game.tick(30)
    expect(game.view().tempo.playStep - start.playStep).toBe(10)
  })

  test("the debug special intent fills FOCUS and fires the special", () => {
    const game = withEnemies([])
    game.send({ type: "special" })
    game.tick(2)
    expect(game.of("specialStarted")).toHaveLength(1)
  })
})
