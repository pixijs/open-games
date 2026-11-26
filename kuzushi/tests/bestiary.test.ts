import { describe, expect, test } from "vitest"

import { Tuning } from "../src/sim/index.ts"
import type { EnemyKind, StageId } from "../src/sim/index.ts"
import { APPEAR, makeGame, pressAt, px, pz } from "./harness.ts"
import type { TestGame } from "./harness.ts"

/** A sandbox with one enemy at (dx, dz) from the player, its AI off until ordered. */
const lone = (kind: EnemyKind, dx: number, dz: number, stage: StageId = "courtyard", elite = false) => {
  const game = makeGame()
  game.startStage(stage, 0, 3)
  game.send({ type: "spawn", kind, x: px + dx, z: pz + dz, drill: "idle", elite })
  game.tick(APPEAR)
  return game
}

const order = (game: TestGame) => {
  game.send({ type: "attack", id: null })
  game.tick()
}

describe("sweeper", () => {
  test("it marks an arc of 200° round the player, then sweeps its arm through it", () => {
    const game = lone("sweeper", 2, 0)
    order(game)
    const [telegraph] = game.of("telegraph")
    expect(telegraph).toMatchObject({ kind: "sweeper", shape: "arc", size: Tuning.SWEEPER.radius })
    expect(telegraph?.halfAngle).toBeCloseTo(Tuning.SWEEPER.span / 2, 5)
    expect(Math.abs(telegraph?.turn ?? 0)).toBe(1)
    expect(game.view().enemies[0]?.telegraph).toMatchObject({ shape: "arc", size: Tuning.SWEEPER.radius })
    game.tickUntil(() => game.of("sweep").length > 0, 120)
    expect((game.of("sweep")[0]?.frame ?? 0) - (telegraph?.frame ?? 0)).toBe(Tuning.SWEEPER.windup.steps)
    expect(game.view().enemies[0]?.state).toBe("Sweep")
    game.tickUntil(() => game.view().enemies[0]?.state === "Recover", 60)
    expect(game.of("playerHurt")).toHaveLength(1)
  })

  test("a parry as the arm reaches the player staggers it", () => {
    const probe = lone("sweeper", 2, 0)
    order(probe)
    probe.tickUntil(() => probe.of("playerHurt").length > 0, 120)
    const hurt = probe.of("playerHurt")[0]?.frame ?? 0

    const game = lone("sweeper", 2, 0)
    order(game)
    pressAt(game, hurt - 3, "parry")
    game.tick(6)
    expect(game.of("parry")).toEqual([expect.objectContaining({ against: "melee" })])
    expect(game.of("playerHurt")).toHaveLength(0)
    expect(game.view().enemies[0]?.state).toBe("Stagger")
  })

  test("outside its reach the sweep passes the player by", () => {
    const game = lone("sweeper", 0, -4)
    order(game)
    game.tickUntil(() => game.view().enemies[0]?.state === "Recover", 120)
    expect(game.of("playerHurt")).toHaveLength(0)
  })
})

describe("pulsar", () => {
  test("it rings itself with a gapped telegraph, then sends a wave out to 6 units", () => {
    const game = lone("pulsar", 0, -4)
    order(game)
    const [telegraph] = game.of("telegraph")
    expect(telegraph).toMatchObject({ kind: "pulsar", shape: "arc", size: Tuning.PULSAR.reach })
    expect(telegraph?.halfAngle).toBeCloseTo(Math.PI - Tuning.PULSAR.gap / 2, 5)
    expect(telegraph?.turn).toBeUndefined()
    game.tickUntil(() => game.of("wave").length > 0, 120)
    const [wave] = game.of("wave")
    expect((wave?.frame ?? 0) - (telegraph?.frame ?? 0)).toBe(Tuning.PULSAR.windup.steps)
    expect(wave).toMatchObject({ reach: Tuning.PULSAR.reach, speed: Tuning.PULSAR.speed, gap: Tuning.PULSAR.gap })
    const gapAngle = Math.atan2(-(telegraph?.dirZ ?? 0), -(telegraph?.dirX ?? 0))
    expect(Math.cos((wave?.gapAngle ?? 0) - gapAngle)).toBeCloseTo(1, 5)
    game.tickUntil(() => game.view().enemies[0]?.state === "Recover", 120)
    const hurt = game.of("playerHurt")
    const caught = Math.atan2(-4 * -1, 0)
    expect(hurt.length).toBe(Math.cos(caught - gapAngle) > Math.cos(Tuning.PULSAR.gap / 2) ? 0 : 1)
  })

  test("standing in the gap, the wave passes", () => {
    const game = lone("pulsar", 0, -4)
    order(game)
    const [telegraph] = game.of("telegraph")
    const pulsar = game.view().enemies[0]
    const gap = { x: -(telegraph?.dirX ?? 0), z: -(telegraph?.dirZ ?? 0) }
    game.send({ type: "teleport", x: (pulsar?.x ?? 0) + gap.x * 4, z: (pulsar?.z ?? 0) + gap.z * 4, facing: null })
    game.tickUntil(() => game.view().enemies[0]?.state === "Recover", 120)
    expect(game.of("playerHurt")).toHaveLength(0)
  })

  test("it can't be parried: the wave hurts through a parry, and a dash through it is a near miss", () => {
    const probe = lone("pulsar", 0, -4)
    order(probe)
    const [telegraph] = probe.of("telegraph")
    const away = { x: telegraph?.dirX ?? 0, z: telegraph?.dirZ ?? 0 }
    const pulsar = probe.view().enemies[0]
    const spot = { x: (pulsar?.x ?? 0) + away.x * 4, z: (pulsar?.z ?? 0) + away.z * 4 }
    probe.send({ type: "teleport", x: spot.x, z: spot.z, facing: null })
    probe.tickUntil(() => probe.of("playerHurt").length > 0, 120)
    const hurt = probe.of("playerHurt")[0]?.frame ?? 0

    const parried = lone("pulsar", 0, -4)
    order(parried)
    parried.send({ type: "teleport", x: spot.x, z: spot.z, facing: null })
    pressAt(parried, hurt - 3, "parry")
    parried.tick(8)
    expect(parried.of("parry")).toHaveLength(0)
    expect(parried.of("playerHurt")).toHaveLength(1)

    const dashed = lone("pulsar", 0, -4)
    dashed.send({ type: "tune", moves: { dashDistance: 0.05 } })
    order(dashed)
    dashed.send({ type: "teleport", x: spot.x, z: spot.z, facing: null })
    pressAt(dashed, hurt - 2, "dash")
    dashed.tick(8)
    expect(dashed.of("nearMiss")).toHaveLength(1)
    expect(dashed.of("playerHurt")).toHaveLength(0)
  })
})

describe("leaper", () => {
  test("it crouches, leaps untouchable, and lands on the spot that followed the player", () => {
    const game = lone("leaper", 0, -5)
    order(game)
    expect(game.of("telegraph")[0]).toMatchObject({ kind: "leaper", shape: "ring" })
    game.tickUntil(() => game.of("leap").length > 0, 60)
    const [leap] = game.of("leap")
    expect(leap).toMatchObject({ radius: Tuning.LEAPER.spot })
    expect(game.of("telegraph")[1]).toMatchObject({ shape: "spot", spotX: px, spotZ: pz })
    expect(game.view().enemies[0]?.telegraph).toMatchObject({ shape: "spot", spot: { x: px, z: pz } })
    const id = game.view().enemies[0]?.id ?? -1
    game.send({ type: "blow", id, damage: 1, step: 1 })
    game.tick()
    expect(game.of("hit")).toHaveLength(0)
    game.send({ type: "steer", x: 1, z: 0 })
    game.tickUntil(() => game.of("landed").length > 0, 120)
    const [landed] = game.of("landed")
    expect((landed?.frame ?? 0) - (leap?.frame ?? 0)).toBe(Tuning.LEAPER.air.steps)
    const followed = Tuning.LEAPER.follow * (Tuning.LEAPER.followFor.steps / 60)
    expect((landed?.x ?? 0) - px).toBeGreaterThan(followed * 0.8)
    expect((landed?.x ?? 0) - px).toBeLessThanOrEqual(followed + 1e-6)
    expect(game.view().enemies[0]?.state).toBe("Recover")
  })

  test("the spot can't keep up: running on, the player escapes the landing", () => {
    const caught = lone("leaper", 0, -5)
    order(caught)
    caught.tickUntil(() => caught.of("landed").length > 0, 120)
    expect(caught.of("playerHurt")).toHaveLength(1)

    const escaped = lone("leaper", 0, -5)
    order(escaped)
    escaped.tickUntil(() => escaped.of("leap").length > 0, 60)
    escaped.send({ type: "steer", x: 1, z: 0 })
    escaped.tickUntil(() => escaped.of("landed").length > 0, 120)
    expect(escaped.of("playerHurt")).toHaveLength(0)
  })

  test("landing over the void, it falls", () => {
    const game = lone("leaper", 0, -2, "void")
    game.send({ type: "teleport", x: 3, z: 9.5, facing: null })
    game.tick()
    order(game)
    game.tickUntil(() => game.of("ringOut").length > 0, 200)
    expect(game.of("enemyKilled")).toEqual([expect.objectContaining({ kind: "leaper", source: "ringOut" })])
  })
})

describe("cutter", () => {
  test("it draws a seam along its telegraph that burns, stops at the wall, and heals", () => {
    const game = lone("cutter", -6, 0)
    order(game)
    const [telegraph] = game.of("telegraph")
    expect(telegraph).toMatchObject({ kind: "cutter", shape: "line" })
    expect(telegraph?.size).toBeCloseTo(Tuning.CUTTER.reach, 3)
    game.tickUntil(() => game.of("seamDrawn").length > 0, 120)
    const [seam] = game.of("seamDrawn")
    expect((seam?.frame ?? 0) - (telegraph?.frame ?? 0)).toBe(Tuning.CUTTER.windup.steps)
    expect(seam?.length).toBeCloseTo(Tuning.CUTTER.reach, 1)
    expect(game.view().seams).toHaveLength(1)
    game.tick(30)
    expect(game.of("playerHurt")).toHaveLength(1)
    game.tickUntil(() => game.view().seams.length === 0, 200)
    expect(game.of("seamHealed")).toHaveLength(1)
  })

  test("a seam aimed at a wall stops there", () => {
    const game = lone("cutter", 0, 0)
    game.send({ type: "teleport", x: 0, z: 9, facing: null })
    game.tick()
    game.send({ type: "teleport", x: 0, z: 6, facing: null, id: game.view().enemies[0]?.id ?? -1 })
    game.tick()
    order(game)
    game.tickUntil(() => game.of("seamDrawn").length > 0, 120)
    const bottom = Tuning.PLAYER.radius
    expect((game.of("seamDrawn")[0]?.length ?? 0)).toBeLessThan(12 - 6 + bottom)
  })

  test("a cutter keeps two seams burning at once; a third closes its oldest", () => {
    const game = lone("cutter", -6, 0)
    game.send({ type: "invulnerable", on: true })
    for (let index = 0; index < 3; index++) {
      game.tickUntil(() => game.view().enemies[0]?.state === "Move", 200)
      order(game)
      game.tickUntil(() => game.of("seamDrawn").length > index, 120)
    }
    expect(game.view().seams).toHaveLength(Tuning.CUTTER.most)
    expect(game.of("seamHealed")).toHaveLength(1)
  })

  test("dashing across a seam is a near miss", () => {
    const game = lone("cutter", -6, 0)
    game.send({ type: "tune", moves: { dashDistance: 0.05 } })
    order(game)
    game.tickUntil(() => game.of("seamDrawn").length > 0, 120)
    pressAt(game, game.frame() + 12, "dash")
    game.tick(6)
    expect(game.of("nearMiss")).toHaveLength(1)
  })
})

describe("elites", () => {
  test("an elite has three times the health, a larger body, a shorter windup, and the view marks it", () => {
    const game = lone("chaser", 0, -3, "courtyard", true)
    const elite = game.view().enemies[0]
    expect(elite).toMatchObject({ elite: true, hp: Tuning.ENEMY.chaser.hp * Tuning.ELITE.health, maxHp: Tuning.ENEMY.chaser.hp * Tuning.ELITE.health })
    order(game)
    game.tickUntil(() => game.of("enemyAttack").length > 0, 60)
    const windup = (game.of("enemyAttack")[0]?.frame ?? 0) - (game.of("telegraph")[0]?.frame ?? 0)
    expect(windup).toBe(Math.round(Tuning.CHASER.windup.steps * Tuning.ELITE.windup))
  })
})

describe("determinism", () => {
  test("the sweeper, pulsar, leaper and cutter play the same from the same seed", () => {
    const run = () => {
      const game = makeGame()
      game.startStage("void", 0, 11)
      for (const [kind, dx] of [["leaper", -5], ["cutter", 5], ["pulsar", 0], ["sweeper", 3]] as const) game.send({ type: "spawn", kind, x: px + dx, z: pz - 3 })
      game.tick(600)
      return JSON.stringify(game.moments)
    }
    expect(run()).toBe(run())
  })
})
