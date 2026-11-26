import { describe, expect, test } from "vitest"

import { Tuning } from "../src/sim/index.ts"
import type { EnemyKind } from "../src/sim/index.ts"
import { makeGame, px, pz, steps } from "./harness.ts"

const lone = (kind: EnemyKind, dx: number, dz: number) => {
  const game = makeGame()
  game.start()
  game.send({ type: "spawn", kind, x: px + dx, z: pz + dz })
  game.tick()
  return game
}

describe("enemies", () => {
  test("an enemy appears over a moment, untouchable, then starts to act", () => {
    const game = lone("chaser", 6, 0)
    expect(game.of("enemySpawned")).toEqual([expect.objectContaining({ kind: "chaser", x: px + 6, z: pz })])
    expect(game.view().enemies[0]?.state).toBe("Spawning")
    game.tick(Tuning.SPAWN.time.steps + 1)
    expect(game.view().enemies[0]?.state).not.toBe("Spawning")
  })

  test("a chaser rushes in, telegraphs a line, then lunges", () => {
    const game = lone("chaser", 8, 0)
    game.tickUntil(() => game.of("enemyAttack").length > 0)
    const [telegraph] = game.of("telegraph")
    const [attack] = game.of("enemyAttack")
    expect(telegraph).toMatchObject({ kind: "chaser", shape: "line", size: Tuning.CHASER.telegraphLength, feint: false })
    expect((attack?.frame ?? 0) - (telegraph?.frame ?? 0)).toBe(Tuning.CHASER.windup.steps)
    game.tick(20)
    expect(game.of("playerHurt")).toHaveLength(1)
  })

  test("a shooter keeps its distance, telegraphs, then fires a burst of three orbs", () => {
    const game = lone("shooter", 4, 0)
    game.tickUntil(() => game.of("projectileFired").length >= 3, 900)
    const [telegraph] = game.of("telegraph")
    const shots = game.of("projectileFired")
    expect(telegraph).toMatchObject({ kind: "shooter", shape: "line" })
    expect((shots[0]?.frame ?? 0) - (telegraph?.frame ?? 0)).toBeGreaterThanOrEqual(Tuning.SHOOTER.windup.steps)
    expect((shots[1]?.frame ?? 0) - (shots[0]?.frame ?? 0)).toBe(Tuning.SHOOTER.shotInterval.steps)
    expect((shots[2]?.frame ?? 0) - (shots[1]?.frame ?? 0)).toBe(Tuning.SHOOTER.shotInterval.steps)
    const shooter = game.view().enemies[0]
    expect(Math.hypot((shooter?.x ?? 0) - (game.view().player?.x ?? 0), (shooter?.z ?? 0) - (game.view().player?.z ?? 0))).toBeGreaterThan(Tuning.SHOOTER.near - 1.5)
  })

  test("a bruiser telegraphs a ring, then slams everything inside it", () => {
    const game = lone("bruiser", 2.5, 0)
    game.tickUntil(() => game.of("slam").length > 0, 900)
    const [telegraph] = game.of("telegraph")
    const [slam] = game.of("slam")
    expect(telegraph).toMatchObject({ kind: "bruiser", shape: "ring", size: Tuning.BRUISER.slamRadius })
    expect((slam?.frame ?? 0) - (telegraph?.frame ?? 0)).toBe(Tuning.BRUISER.windup.steps)
    expect(slam?.radius).toBe(Tuning.BRUISER.slamRadius)
    expect(game.of("playerHurt")).toHaveLength(1)
  })

  test("a trickster blinks next to the player, may feint, then dashes in", () => {
    const game = lone("trickster", 6, 0)
    game.tickUntil(() => game.of("enemyAttack").length > 0, 900)
    const [blink] = game.of("blink")
    const telegraphs = game.of("telegraph")
    expect(blink).toBeDefined()
    expect(Math.hypot((blink?.toX ?? 0) - px, (blink?.toZ ?? 0) - pz)).toBeLessThan(Tuning.TRICKSTER.blinkDistanceMax + 1)
    expect(telegraphs.at(-1)?.feint).toBe(false)
    expect(telegraphs.slice(0, -1).every((telegraph) => telegraph.feint)).toBe(true)
  })

  test("over many seeds, every trickster attack has a telegraph and some open with a feint", () => {
    let feints = 0
    for (let seed = 1; seed <= 12; seed++) {
      const game = makeGame()
      game.start(0, seed)
      game.send({ type: "spawn", kind: "trickster", x: px + 6, z: pz })
      game.tickUntil(() => game.of("enemyAttack").length > 0, 900)
      if (game.of("telegraph").some((telegraph) => telegraph.feint)) feints += 1
    }
    expect(feints).toBeGreaterThan(0)
    expect(feints).toBeLessThan(12)
  })

  test("every attack of every kind follows its own telegraph", () => {
    const game = makeGame()
    game.start(0, 7)
    for (const [kind, dx] of [["chaser", 5], ["shooter", -6], ["bruiser", 3], ["trickster", -4]] as const) {
      game.send({ type: "spawn", kind, x: px + dx, z: pz })
    }
    game.tick(steps(8))
    for (const attack of game.of("enemyAttack")) {
      const before = game.of("telegraph").filter((telegraph) => telegraph.id === attack.id && telegraph.frame < attack.frame && !telegraph.feint)
      expect(before.length).toBeGreaterThan(0)
    }
    expect(game.of("enemyAttack").length).toBeGreaterThan(2)
  })
})
