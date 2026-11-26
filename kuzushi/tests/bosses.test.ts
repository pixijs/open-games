import { describe, expect, test } from "vitest"

import { BOSSES, Tuning } from "../src/sim/index.ts"
import type { BossId, BossPattern } from "../src/sim/index.ts"
import { makeGame, shiftTo } from "./harness.ts"
import type { TestGame } from "./harness.ts"

/** A sandbox in the boss's zone with the boss spawned at its start; `still` keeps the player from being hurt. */
const fight = (boss: BossId, options: { readonly still?: boolean; readonly seed?: number } = {}) => {
  const game = makeGame()
  game.startStage(BOSSES[boss].zone, 0, options.seed ?? 5)
  if (options.still !== false) game.send({ type: "invulnerable", on: true })
  game.send({ type: "spawn", kind: boss, x: null, z: null })
  game.tick()
  return game
}

const bossId = (game: TestGame) => game.view().boss?.id ?? -1

/** Plays past the name card. */
const pastIntro = (game: TestGame) => game.tickUntil(() => game.view().boss?.state === "fighting", 400)

const patternsOf = (game: TestGame): ReadonlyArray<BossPattern> => game.of("bossPattern").map((moment) => moment.pattern)

const blow = (game: TestGame, id: number, damage: number) => {
  game.send({ type: "blow", id, damage, step: 1 })
  game.tick()
}

describe("bosses", () => {
  test("a boss's name card holds the gameplay clock for 2 s; it can't be hurt until it fights", () => {
    const game = fight("gatekeeper")
    const [intro] = game.of("bossIntro")
    expect(intro).toMatchObject({ boss: "gatekeeper", duration: Tuning.BOSS.intro.steps / 60 })
    expect(game.view().boss).toMatchObject({ state: "intro", hp: 60, maxHp: 60, phase: 1, phases: 2, thresholds: [0.5] })
    const held = game.view().tempo.playStep
    blow(game, bossId(game), 5)
    game.tick(Tuning.BOSS.intro.steps - 4)
    expect(game.view().tempo.playStep).toBe(held)
    expect(game.view().boss?.hp).toBe(60)
    pastIntro(game)
    expect(game.frame() - (intro?.frame ?? 0)).toBeLessThanOrEqual(Tuning.BOSS.intro.steps + 3)
  })

  test.each([
    ["gatekeeper", ["slam", "charge", "fan", "charge", "slam"]],
    ["orrery", ["volley", "moons", "hands", "moons", "volley"]],
    ["sunder", ["needles", "lunge", "needles", "lunge", "needles"]]
  ] as const)("%s plays its first phase's patterns in order, looping", (boss, order) => {
    const game = fight(boss)
    game.tickUntil(() => game.of("bossPattern").length >= order.length, 3000)
    expect(patternsOf(game)).toEqual(order)
  })

  test.each(["gatekeeper", "orrery", "sunder"] as const)("%s's later phases draw at random from their list, never twice in a row", (boss) => {
    const game = fight(boss, { seed: 9 })
    pastIntro(game)
    const last = BOSSES[boss].phases.length
    shiftTo(game, last)
    const from = game.of("bossPattern").length
    game.tickUntil(() => game.of("bossPattern").length >= from + 12, 9000)
    const later = patternsOf(game).slice(from)
    const allowed = new Set<BossPattern>(BOSSES[boss].phases[last - 1]?.patterns ?? [])
    expect(later.every((pattern) => allowed.has(pattern))).toBe(true)
    expect(later.some((pattern, index) => index > 0 && pattern === later[index - 1])).toBe(false)
    expect(new Set(later).size).toBeGreaterThan(2)
  })

  test("blows can't take a boss past its next threshold: it shifts there, roars, summons, and can't be hurt meanwhile", () => {
    const game = fight("gatekeeper")
    pastIntro(game)
    const id = bossId(game)
    blow(game, id, 40)
    expect(game.view().boss?.hp).toBe(30)
    game.tickUntil(() => game.of("bossPhase").length > 0, 30)
    const [shift] = game.of("bossPhase")
    expect(shift).toMatchObject({ boss: "gatekeeper", phase: 2, duration: Tuning.BOSS.shift.steps / 60 })
    expect(game.view().boss).toMatchObject({ state: "shifting", phase: 2 })
    const summoned = game.of("enemySpawned").filter((moment) => moment.frame >= (shift?.frame ?? 0)).map((moment) => moment.kind)
    expect(summoned.sort()).toEqual(["chaser", "chaser", "shooter"])
    blow(game, id, 5)
    game.tick(10)
    expect(game.view().boss?.hp).toBe(30)
    game.tickUntil(() => game.view().boss?.state === "fighting", 200)
    blow(game, id, 5)
    expect(game.view().boss?.hp).toBe(25)
  })

  test("the roar pushes the player back", () => {
    const game = fight("gatekeeper")
    pastIntro(game)
    const boss = game.view().enemies.find((enemy) => enemy.id === bossId(game))
    game.send({ type: "teleport", x: boss?.x ?? 0, z: (boss?.z ?? 0) + 3, facing: null })
    game.tick()
    game.send({ type: "bossHealth", hp: 30 })
    game.tick(40)
    const player = game.view().player
    expect((player?.z ?? 0) - ((boss?.z ?? 0) + 3)).toBeGreaterThan(0.5)
  })

  test("blows fill the balance meter, which drains after 2.5 s without one", () => {
    const game = fight("sunder")
    pastIntro(game)
    const id = bossId(game)
    for (let index = 0; index < 5; index++) blow(game, id, 1)
    const filled = game.view().boss?.balance ?? 0
    expect(filled).toBeCloseTo((5 * Tuning.MOVE.cut.balance) / Tuning.BOSS.balance.max, 5)
    game.tick(Tuning.BOSS.balance.calm.steps - 10)
    expect(game.view().boss?.balance).toBeCloseTo(filled, 5)
    game.tick(70)
    expect(game.view().boss?.balance ?? 1).toBeLessThan(filled)
  })

  test("a parried boss blow isn't a stagger: it fills a quarter of the balance meter", () => {
    const probe = fight("gatekeeper", { still: false })
    probe.send({ type: "bossPattern", pattern: "slam" })
    probe.tick()
    pastIntro(probe)
    const boss = probe.view().enemies.find((enemy) => enemy.id === bossId(probe))
    probe.send({ type: "teleport", x: boss?.x ?? 0, z: (boss?.z ?? 0) + 3, facing: null })
    probe.tickUntil(() => probe.of("playerHurt").length > 0, 400)
    const hurt = probe.of("playerHurt")[0]?.frame ?? 0

    const game = fight("gatekeeper", { still: false })
    game.send({ type: "bossPattern", pattern: "slam" })
    game.tick()
    pastIntro(game)
    game.send({ type: "teleport", x: boss?.x ?? 0, z: (boss?.z ?? 0) + 3, facing: null })
    while (game.frame() < hurt - 3) game.tick()
    game.send({ type: "press", action: "parry" })
    game.tick(6)
    expect(game.of("parry")).toHaveLength(1)
    expect(game.view().boss?.balance).toBeCloseTo(Tuning.BOSS.balance.parry / Tuning.BOSS.balance.max, 5)
    expect(game.view().enemies.find((enemy) => enemy.id === bossId(game))?.state).not.toBe("Stagger")
  })

  test("a full meter breaks the boss open for 3 s: blows land half again as hard, then it recovers", () => {
    const game = fight("orrery")
    pastIntro(game)
    const id = bossId(game)
    game.send({ type: "breakBoss" })
    game.tickUntil(() => game.of("bossBroken").length > 0, 30)
    game.tick(8)
    expect(game.of("bossBroken")).toEqual([expect.objectContaining({ boss: "orrery", duration: Tuning.BOSS.broken.steps / 60 })])
    expect(game.view().boss).toMatchObject({ state: "broken", balance: 0, open: true })
    blow(game, id, 2)
    expect(game.view().boss?.hp).toBe(90 - 2 * Tuning.BOSS.brokenDamage)
    game.tickUntil(() => game.of("bossRecovered").length > 0, Tuning.BOSS.broken.steps + 10)
    expect(game.view().boss?.state).toBe("fighting")
  })

  test("the killing blow fells it in slow motion; its summons go with it, then it is defeated", () => {
    const game = fight("gatekeeper")
    pastIntro(game)
    const id = bossId(game)
    game.send({ type: "bossHealth", hp: 30 })
    game.tickUntil(() => game.view().boss?.state === "fighting" && game.view().boss?.phase === 2, 300)
    expect(game.view().enemies.length).toBe(4)
    const kills = game.view().kills
    blow(game, id, 30)
    game.tickUntil(() => game.of("bossFelled").length > 0, 30)
    const [felled] = game.of("bossFelled")
    expect(felled).toMatchObject({ boss: "gatekeeper", duration: Tuning.BOSS.defeat.steps / 60 })
    expect(felled?.fallen.map((each) => each.kind).sort()).toEqual(["chaser", "chaser", "shooter"])
    expect(game.view().boss?.state).toBe("defeated")
    expect(game.view().tempo.slowScale).toBe(1 / Tuning.BOSS.defeatPeriod)
    game.tickUntil(() => game.of("bossDefeated").length > 0, Tuning.BOSS.defeat.steps + 10)
    expect(game.view().boss).toBeNull()
    expect(game.view().enemies).toHaveLength(0)
    expect(game.view().kills).toBe(kills + 1)
  })

  test("a charge into a wall or pillar stuns the Gatekeeper open", () => {
    const game = fight("gatekeeper")
    game.send({ type: "bossPattern", pattern: "charge" })
    game.tick()
    pastIntro(game)
    game.tickUntil(() => game.of("bossStunned").length > 0, 400)
    const id = bossId(game)
    expect(game.view().boss?.open).toBe(true)
    blow(game, id, 2)
    expect(game.view().boss?.hp).toBe(60 - 2 * Tuning.BOSS.stunnedDamage)
  })

  test("the Orrery's shell turns blows aside while it winds up and fires its volley", () => {
    const game = fight("orrery")
    pastIntro(game)
    game.send({ type: "teleport", x: 0, z: 2.6, facing: -Math.PI / 2 })
    game.send({ type: "aim", x: 0, z: 0 })
    game.tickUntil(() => game.view().boss?.pattern === "volley" && game.view().boss?.shelled === true, 400)
    game.send({ type: "press", action: "slash" })
    game.tick(12)
    expect(game.of("clank")).toEqual([expect.objectContaining({ kind: "orrery" })])
    expect(game.view().boss?.hp).toBe(90)
  })

  test("the Orrery's moons hunt round the player and cut through one by one", () => {
    const game = fight("orrery")
    game.send({ type: "bossPattern", pattern: "moons" })
    game.tick()
    pastIntro(game)
    game.tickUntil(() => game.of("moonCut").length >= 3, 600)
    const cuts = game.of("moonCut")
    expect(cuts.map((cut) => cut.moon)).toEqual([0, 1, 2])
    expect((cuts[1]?.frame ?? 0) - (cuts[0]?.frame ?? 0)).toBe(Tuning.ORRERY.moons.stagger.steps)
    expect(game.view().boss?.moons).toHaveLength(3)
  })

  test("Sunder's needles fly three abreast; its seams run out four ways", () => {
    const game = fight("sunder")
    pastIntro(game)
    game.tickUntil(() => game.of("projectileFired").length >= 3, 300)
    expect(game.view().projectiles.length).toBe(3)
    game.send({ type: "bossPattern", pattern: "seams" })
    game.tickUntil(() => game.of("seamDrawn").length >= 4, 400)
    expect(game.view().seams).toHaveLength(4)
  })

  test("Sunder splits in two: a blow on either half lands on the boss, and they come back together", () => {
    const game = fight("sunder")
    pastIntro(game)
    shiftTo(game, 3, 300)
    game.send({ type: "bossPattern", pattern: "split" })
    game.tickUntil(() => game.of("bossSplit").length > 0, 300)
    game.tick(2)
    const twin = game.view().boss?.twin ?? null
    expect(twin).not.toBeNull()
    const hp = game.view().boss?.hp ?? 0
    blow(game, twin ?? -1, 2)
    expect(game.view().boss?.hp).toBe(hp - 2)
    game.tickUntil(() => game.of("bossRejoined").length > 0, Tuning.SUNDER.split.time.steps + 400)
    game.tick(2)
    expect(game.view().boss?.twin).toBeNull()
  })

  test("a boss fight plays the same from the same seed", () => {
    const run = () => {
      const game = fight("sunder", { still: false, seed: 21 })
      game.send({ type: "bossPhase", phase: 3 })
      game.tick(2400)
      return JSON.stringify(game.moments)
    }
    expect(run()).toBe(run())
  })
})
