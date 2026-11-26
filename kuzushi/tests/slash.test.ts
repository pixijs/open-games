import { describe, expect, test } from "vitest"

import { Tuning } from "../src/sim/index.ts"
import { makeGame, px, pz, tap } from "./harness.ts"
import type { Script } from "./harness.ts"

/** A sandbox run with the player facing east (+x) and enemies placed around it, all done appearing by frame 45. */
const arena = (keys: NonNullable<Script["keys"]>, enemies: ReadonlyArray<readonly ["chaser" | "shooter" | "bruiser" | "trickster", number, number]>) => {
  const game = makeGame({ keys })
  game.start()
  game.send({ type: "aim", x: px + 10, z: pz })
  for (const [kind, dx, dz] of enemies) game.send({ type: "spawn", kind, x: px + dx, z: pz + dz })
  game.tick(44)
  return game
}

describe("slash", () => {
  test("a slash hits the enemy in front and misses the one behind", () => {
    const game = arena(tap("slash", 46), [["bruiser", 1.9, 0], ["bruiser", -2.2, 0]])
    game.tick(12)
    const hits = game.of("hit")
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ source: "slash", step: 1, damage: 1 })
    expect(hits[0]?.x).toBeGreaterThan(px)
    expect(game.of("slash")[0]).toMatchObject({ step: 1, sweep: 1 })
    expect(game.of("slash")[0]?.facing).toBeCloseTo(0)
  })

  test("three presses chain the combo: two crescents on alternating sides, then the spin", () => {
    const game = arena([...tap("slash", 46), ...tap("slash", 56), ...tap("slash", 68)], [])
    game.tick(60)
    expect(game.of("slash").map((slash) => [slash.step, slash.sweep])).toEqual([[1, 1], [2, -1], [3, 0]])
    expect(game.of("slash")[2]?.halfAngle).toBeCloseTo(Math.PI)
  })

  test("the spin hits the enemies on every side", () => {
    const game = arena([...tap("slash", 46), ...tap("slash", 56), ...tap("slash", 68)], [["bruiser", 0, 2.4], ["bruiser", 0, -2.4], ["bruiser", -2.3, 0]])
    game.tick(50)
    const spins = game.of("hit").filter((hit) => hit.source === "spin")
    expect(spins).toHaveLength(3)
    expect(spins.every((hit) => hit.damage === 2)).toBe(true)
  })

  test("one swing hits an enemy once, however long the hitbox stays live", () => {
    const game = arena(tap("slash", 46), [["bruiser", 1.8, 0]])
    game.tick(30)
    expect(game.of("hit")).toHaveLength(1)
  })

  test("after a pause between presses the combo starts over", () => {
    const game = arena([...tap("slash", 46), ...tap("slash", 110)], [])
    game.tick(90)
    expect(game.of("slash").map((slash) => slash.step)).toEqual([1, 1])
  })

  test("a hit starts hit-stop: the run clock goes on while the gameplay clock holds", () => {
    const game = arena(tap("slash", 46), [["bruiser", 1.9, 0]])
    game.tickUntil(() => game.of("hit").length > 0)
    const at = game.view().tempo
    game.tick(Tuning.SLASH[1].hitStop.steps)
    const after = game.view().tempo
    expect(after.step - at.step).toBe(Tuning.SLASH[1].hitStop.steps)
    expect(after.playStep).toBe(at.playStep)
    game.tick(3)
    expect(game.view().tempo.playStep).toBeGreaterThan(at.playStep)
  })

  test("killing blows fill FOCUS and count kills", () => {
    const game = arena([...tap("slash", 46), ...tap("slash", 56)], [["shooter", 1.8, 0]])
    game.tick(40)
    expect(game.of("enemyKilled")).toHaveLength(1)
    expect(game.view().kills).toBe(1)
    expect(game.view().focus).toBeCloseTo((Tuning.FOCUS.slashHit * 2 + Tuning.FOCUS.kill) / Tuning.FOCUS.max)
  })
})
