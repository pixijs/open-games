import { describe, expect, test } from "vitest"

import { Tuning } from "../src/sim/index.ts"
import type { EnemyKind } from "../src/sim/index.ts"
import { makeGame, px, pz, tap } from "./harness.ts"
import type { Script } from "./harness.ts"

/** A sandbox run, facing east, with enemies placed relative to the player. */
const scene = (keys: NonNullable<Script["keys"]>, enemies: ReadonlyArray<readonly [EnemyKind, number, number]>) => {
  const game = makeGame({ keys })
  game.start()
  game.send({ type: "aim", x: px + 10, z: pz })
  for (const [kind, dx, dz] of enemies) game.send({ type: "spawn", kind, x: px + dx, z: pz + dz })
  game.tick()
  return game
}

/** Plays the scene with no defence and returns the frame the player is first hurt: deterministic, so a second run can react to it. */
const hurtFrame = (enemies: ReadonlyArray<readonly [EnemyKind, number, number]>) => {
  const probe = scene([], enemies)
  probe.tickUntil(() => probe.of("playerHurt").length > 0, 900)
  return probe.of("playerHurt")[0]?.frame ?? 0
}

describe("dash", () => {
  test("a dash covers its distance along the stick, then ends", () => {
    const game = scene([{ frame: 5, press: ["move.down"] }, ...tap("dash", 5), { frame: 30, release: ["move.down"] }], [])
    game.tick(30)
    const [started] = game.of("dashStarted")
    const [ended] = game.of("dashEnded")
    expect(started).toMatchObject({ dirX: 0, dirZ: 1 })
    expect((ended?.z ?? 0) - (started?.z ?? 0)).toBeCloseTo(Tuning.DASH.speed * Tuning.DASH.time.steps / 60, 1)
  })

  test("with no stick input the dash goes where the player faces", () => {
    const game = scene(tap("dash", 5), [])
    game.tick(20)
    expect(game.of("dashStarted")[0]).toMatchObject({ dirX: 1, dirZ: 0 })
  })

  test("a dash passes through an enemy", () => {
    const game = scene(tap("dash", 46), [["bruiser", 2, 0]])
    game.tick(70)
    expect(game.view().player?.x).toBeGreaterThan(px + 2 + Tuning.ENEMY.bruiser.radius)
  })

  test("a dash cancels a slash before it lands", () => {
    const game = scene([...tap("slash", 46), ...tap("dash", 47)], [])
    game.tick(70)
    expect(game.of("slash")).toHaveLength(0)
    expect(game.of("dashStarted")).toHaveLength(1)
  })

  test("a dash waits for its cooldown", () => {
    const game = scene([...tap("dash", 5), ...tap("dash", 16)], [])
    game.tick(40)
    expect(game.of("dashStarted")).toHaveLength(1)
  })

  test("a dash through an attack is a near miss: no life lost, FOCUS gained", () => {
    const hurt = hurtFrame([["chaser", 3, 0]])
    const game = scene(tap("dash", hurt - 2), [["chaser", 3, 0]])
    game.tick(hurt + 30)
    expect(game.of("playerHurt")).toHaveLength(0)
    expect(game.of("nearMiss")).toHaveLength(1)
    expect(game.view().lives).toBe(Tuning.PLAYER.lives)
    expect(game.view().focus).toBeGreaterThanOrEqual(Tuning.FOCUS.nearMiss / Tuning.FOCUS.max)
  })
})

describe("parry", () => {
  test("a parry in time against a lunge staggers the attacker and costs nothing", () => {
    const hurt = hurtFrame([["chaser", 3, 0]])
    const game = scene(tap("parry", hurt - 4), [["chaser", 3, 0]])
    game.tick(hurt + 6)
    expect(game.of("parry")).toEqual([expect.objectContaining({ against: "melee" })])
    expect(game.of("playerHurt")).toHaveLength(0)
    expect(game.view().enemies[0]?.state).toBe("Stagger")
  })

  test("a parry in time against an orb sends it back into the shooter", () => {
    const hurt = hurtFrame([["shooter", 7, 0]])
    const game = scene(tap("parry", hurt - 4), [["shooter", 7, 0]])
    game.tick(hurt + 90)
    expect(game.of("reflect")).toHaveLength(1)
    expect(game.of("hit").some((hit) => hit.source === "reflect")).toBe(true)
  })

  test("a parry too early leaves the player open", () => {
    const hurt = hurtFrame([["chaser", 3, 0]])
    const game = scene(tap("parry", hurt - 40), [["chaser", 3, 0]])
    game.tick(hurt + 10)
    expect(game.of("parry")).toHaveLength(0)
    expect(game.of("playerHurt")).toHaveLength(1)
  })
})
