import { describe, expect, test } from "vitest"

import { Tuning } from "../src/sim/index.ts"
import type { EnemyKind } from "../src/sim/index.ts"
import { APPEAR, makeGame, pressAt, px, pz } from "./harness.ts"
import type { TestGame } from "./harness.ts"

const distanceTo = (game: TestGame, id: number) => {
  const enemy = game.view().enemies.find((each) => each.id === id)
  const player = game.view().player
  return Math.hypot((enemy?.x ?? 0) - (player?.x ?? 0), (enemy?.z ?? 0) - (player?.z ?? 0))
}

/** A Courtyard sandbox with one enemy at (dx, dz) from the player; `drill` turns its AI off. */
const lone = (kind: EnemyKind, dx: number, dz: number, drill: "idle" | "dummy" | null = null) => {
  const game = makeGame()
  game.start()
  game.send({ type: "spawn", kind, x: px + dx, z: pz + dz, drill })
  game.tick()
  return game
}

describe("orbiter", () => {
  test("it circles in, its orbit tightening, then cuts straight through the player", () => {
    const game = lone("orbiter", 8, 0)
    const id = game.of("enemySpawned")[0]?.id ?? -1
    game.tick(Tuning.SPAWN.time.steps + 60)
    const early = distanceTo(game, id)
    game.tickUntil(() => game.of("telegraph").length > 0, 600)
    const late = distanceTo(game, id)
    expect(late).toBeLessThan(early)
    expect(late).toBeLessThanOrEqual(Tuning.ORBITER.far + 1)
    const [telegraph] = game.of("telegraph")
    expect(telegraph).toMatchObject({ kind: "orbiter", shape: "line" })
    expect(telegraph?.size).toBeCloseTo(late + Tuning.ORBITER.overshoot, 0)
    game.tickUntil(() => game.of("enemyAttack").length > 0)
    expect((game.of("enemyAttack")[0]?.frame ?? 0) - (telegraph?.frame ?? 0)).toBe(Tuning.ORBITER.windup.steps)
    const from = game.view().enemies[0]
    game.tickUntil(() => game.view().enemies[0]?.state === "Recover", 120)
    const to = game.view().enemies[0]
    const player = game.view().player
    const side = (point: { readonly x: number; readonly z: number } | undefined) =>
      ((point?.x ?? 0) - (player?.x ?? 0)) * (telegraph?.dirX ?? 0) + ((point?.z ?? 0) - (player?.z ?? 0)) * (telegraph?.dirZ ?? 0)
    expect(Math.sign(side(from))).toBe(-1)
    expect(Math.sign(side(to))).toBe(1)
    expect(game.of("playerHurt")).toHaveLength(1)
  })
})

describe("warden", () => {
  test("it telegraphs a ring, then fires a turning spiral volley, and opens up after", () => {
    const game = lone("warden", 0, -6, "idle")
    game.tick(APPEAR)
    game.send({ type: "attack", id: null })
    game.tickUntil(() => game.of("wardenOpen").length > 0, 300)
    const [telegraph] = game.of("telegraph")
    expect(telegraph).toMatchObject({ kind: "warden", shape: "ring", size: Tuning.WARDEN.telegraphRadius })
    const [volley] = game.of("volley")
    expect(volley).toMatchObject({ arms: Tuning.WARDEN.arms, shots: Tuning.WARDEN.shots })
    expect((volley?.frame ?? 0) - (telegraph?.frame ?? 0)).toBe(Tuning.WARDEN.windup.steps)
    const fired = game.of("projectileFired")
    expect(fired).toHaveLength(Tuning.WARDEN.shots * Tuning.WARDEN.arms)
    const angle = (shot: number) => Math.atan2(fired[shot * Tuning.WARDEN.arms]?.dirZ ?? 0, fired[shot * Tuning.WARDEN.arms]?.dirX ?? 0)
    const turned = Math.atan2(Math.sin(angle(1) - angle(0)), Math.cos(angle(1) - angle(0)))
    expect(Math.abs(turned)).toBeCloseTo(Tuning.WARDEN.spin, 3)
    expect(game.view().enemies[0]?.state).toBe("Recover")
  })

  test("its shell turns blows aside while it fires; open, it takes them", () => {
    const game = lone("warden", 0, -1.9, "idle")
    game.send({ type: "aim", x: px, z: pz - 10 })
    game.tick(APPEAR)
    game.send({ type: "attack", id: null })
    game.tick(5)
    expect(game.view().enemies[0]?.shielded).toBe(true)
    pressAt(game, game.frame(), "slash")
    game.tick(12)
    expect(game.of("clank")).toHaveLength(1)
    expect(game.of("hit")).toHaveLength(0)
    expect(game.view().enemies[0]?.hp).toBe(Tuning.ENEMY.warden.hp)
    game.send({ type: "invulnerable", on: true })
    game.tickUntil(() => game.of("wardenOpen").length > 0, 300)
    expect(game.view().enemies[0]?.shielded).toBe(false)
    pressAt(game, game.frame() + 2, "slash")
    game.tick(12)
    expect(game.of("hit")).toEqual([expect.objectContaining({ kind: "warden", source: "slash", damage: 1 })])
  })

  test("a parried orb flies back into it for triple damage and breaks its volley", () => {
    const probe = lone("warden", 0, -6, "idle")
    probe.tick(APPEAR)
    probe.send({ type: "attack", id: null })
    probe.tickUntil(() => probe.of("playerHurt").length > 0, 300)
    const hurt = probe.of("playerHurt")[0]?.frame ?? 0

    const game = lone("warden", 0, -6, "idle")
    game.tick(APPEAR)
    game.send({ type: "attack", id: null })
    pressAt(game, hurt - 4, "parry")
    game.tickUntil(() => game.of("hit").length > 0, 200)
    expect(game.of("reflect")).toHaveLength(1)
    expect(game.of("hit")[0]).toMatchObject({ kind: "warden", source: "reflect", damage: Tuning.PARRY.reflectDamage * Tuning.WARDEN.reflectFactor })
    expect(game.view().enemies[0]?.state).toBe("Stagger")
  })
})

describe("lancer", () => {
  test("it locks a long line at the player and charges its whole length", () => {
    const game = lone("lancer", -8, 0, "idle")
    game.tick(APPEAR)
    game.send({ type: "attack", id: null })
    game.tick()
    const [telegraph] = game.of("telegraph")
    expect(telegraph).toMatchObject({ kind: "lancer", shape: "line", size: 8 + Tuning.LANCER.overshoot, dirX: 1 })
    expect(game.view().enemies[0]?.telegraph?.size).toBe(8 + Tuning.LANCER.overshoot)
    const start = game.view().enemies[0]?.x ?? 0
    game.send({ type: "invulnerable", on: true })
    game.tickUntil(() => game.view().enemies[0]?.state === "Recover", 200)
    expect((game.view().enemies[0]?.x ?? 0) - start).toBeCloseTo(8 + Tuning.LANCER.overshoot, 0)
  })

  test("left to itself it keeps its distance, then attacks", () => {
    const game = lone("lancer", 3, 0)
    game.tickUntil(() => game.of("enemyAttack").length > 0, 600)
    const [telegraph] = game.of("telegraph")
    expect(telegraph?.size).toBeGreaterThanOrEqual(Tuning.LANCER.reachMin)
    expect(telegraph?.size).toBeLessThanOrEqual(Tuning.LANCER.reachMax)
  })
})

describe("splitter", () => {
  test("killed, it breaks into two splitlings thrown out either side of the blow", () => {
    const game = lone("splitter", 0, -1.6, "idle")
    game.send({ type: "aim", x: px, z: pz - 10 })
    game.tick(APPEAR)
    for (const wait of [0, 10, 10]) pressAt(game, game.frame() + wait, "slash")
    game.tickUntil(() => game.of("split").length > 0, 120)
    const [split] = game.of("split")
    expect(split?.pieces).toHaveLength(2)
    const [a, b] = split?.pieces ?? []
    expect((a?.dirX ?? 0) + (b?.dirX ?? 0)).toBeCloseTo(0)
    game.tick(2)
    expect(game.view().enemies.map((enemy) => enemy.kind)).toEqual(["splitling", "splitling"])
    expect(game.view().wave.enemiesLeft).toBe(2)
  })

  test("splitlings rush and lunge, and touching one hurts", () => {
    const game = lone("splitling", 4, 0)
    game.tickUntil(() => game.of("playerHurt").length > 0, 600)
    game.tickUntil(() => game.of("telegraph").some((telegraph) => telegraph.kind === "splitling"), 600)
  })

  test("the special breaks splitters and strikes the pieces too", () => {
    const game = lone("splitter", 3, 0)
    game.tick(APPEAR)
    game.send({ type: "special" })
    game.tickUntil(() => game.of("specialEnded").length > 0, 300)
    expect(game.of("split")).toHaveLength(1)
    expect(game.of("enemyKilled").map((kill) => kill.kind).sort()).toEqual(["splitling", "splitling", "splitter"])
  })
})

describe("telegraphs", () => {
  test.each(["orbiter", "warden", "lancer", "splitter", "splitling"] as const)("a %s's every attack follows its own telegraph", (kind) => {
    const game = lone(kind, 6, 0)
    game.tick(60 * 10)
    const attacks = game.of("enemyAttack")
    expect(attacks.length).toBeGreaterThan(0)
    for (const attack of attacks) expect(game.of("telegraph").some((telegraph) => telegraph.id === attack.id && telegraph.frame < attack.frame)).toBe(true)
  })
})
