import { Keyboard } from "@typeonce/ritmo-browser"
import { describe, expect, test } from "vitest"

import { CHAINS, Intents, keys, Tuning, weaponIds } from "../src/sim/index.ts"
import type { ComboStep, DrillMode, EnemyKind, WeaponId } from "../src/sim/index.ts"
import { makeGame, px, pz, replays, settle } from "./harness.ts"
import type { TestGame } from "./harness.ts"

const { DARTS, MOVE, SIGIL } = Tuning

type Placed = readonly [EnemyKind, number, number, DrillMode?]

/**
 * A sandbox run on the open floor holding `weapon`, the player facing east with no cursor, enemies placed relative to
 * it and done appearing.
 */
const armed = (weapon: WeaponId, enemies: ReadonlyArray<Placed> = []): TestGame => {
  const game = makeGame()
  game.start()
  game.send({ type: "floor", open: true })
  game.send({ type: "setWeapon", weapon })
  game.send({ type: "teleport", x: px, z: pz, facing: 0 })
  for (const [kind, dx, dz, drill] of enemies) game.send({ type: "spawn", kind, x: px + dx, z: pz + dz, facing: Math.PI, drill: drill ?? "dummy" })
  game.tick()
  settle(game)
  return game
}

const press = (game: TestGame, step?: ComboStep) => {
  game.send({ type: "press", action: "slash", step: step ?? null })
  game.tick()
  return game.frame() - 1
}

describe("weapon frame data", () => {
  for (const weapon of weaponIds) {
    CHAINS[weapon].forEach((move, index) => {
      const step = (index + 1) as ComboStep
      test(`${weapon} ${move} (press ${step}) goes live after its windup and ends after its recovery`, () => {
        const game = armed(weapon)
        const pressed = press(game, step)
        const spec = MOVE[move]
        game.tickUntil(() => game.of("attack").length > 0, 60)
        const attack = game.of("attack")[0]
        expect(attack).toMatchObject({ weapon, move, step })
        expect((attack?.frame ?? 0) - pressed).toBe(spec.windup.steps)
        game.tickUntil(() => game.view().player?.state === "Free", 120)
        expect(game.frame() - 1 - pressed).toBe(spec.windup.steps + spec.active.steps + spec.recover.steps)
      })
    })
  }
})

describe("equip", () => {
  test("setWeapon puts a weapon in hand; only darts carry ammo", () => {
    const game = armed("blade")
    expect(game.view().weapon).toMatchObject({ id: "blade", ammo: null, charge: null, marks: [] })
    game.send({ type: "setWeapon", weapon: "darts" })
    game.tick()
    expect(game.view().weapon).toMatchObject({ id: "darts", ammo: { loaded: DARTS.clip, size: DARTS.clip } })
  })

  test("a swap ends the attack in progress", () => {
    const game = armed("breaker")
    press(game)
    game.tick(3)
    expect(game.view().player).toMatchObject({ state: "Attack", move: "cleave" })
    game.send({ type: "setWeapon", weapon: "blade" })
    game.tick(2)
    expect(game.view().player?.state).toBe("Free")
    game.tick(30)
    expect(game.of("attack")).toHaveLength(0)
  })

  test("marks on the ground still land after a swap", () => {
    const game = armed("sigil", [["chaser", 5, 0]])
    press(game)
    game.tickUntil(() => game.of("marked").length > 0, 30)
    game.send({ type: "setWeapon", weapon: "blade" })
    game.tickUntil(() => game.of("burst").length > 0, 60)
    expect(game.of("burst")[0]).toMatchObject({ move: "sigil", hits: 1 })
  })
})

describe("blade", () => {
  test("the blade still sends its slash moment beside the attack", () => {
    const game = armed("blade")
    press(game)
    game.tick(10)
    expect(game.of("slash")).toHaveLength(1)
    expect(game.of("attack")[0]?.shape).toMatchObject({ kind: "arc", range: Tuning.SLASH[1].range })
  })
})

describe("breaker", () => {
  test("the cleave reaches round to the side, past the blade's arc", () => {
    const game = armed("breaker", [["chaser", 0, 2.7]])
    press(game)
    game.tick(20)
    expect(game.of("hit")).toEqual([expect.objectContaining({ source: "cleave", damage: MOVE.cleave.damage, step: 1 })])
  })

  test("cleave then slam: the slam marks its landing ahead, hops onto it and strikes round it", () => {
    const game = armed("breaker", [["chaser", 4.4, 0]])
    press(game)
    game.tick(MOVE.cleave.windup.steps + MOVE.cleave.active.steps + MOVE.cleave.cancel.steps)
    const from = game.view().player?.x ?? 0
    expect(from).toBeGreaterThan(px)
    press(game)
    const [marked] = game.of("marked")
    expect(marked).toMatchObject({ weapon: "breaker", move: "slam", radius: MOVE.slam.radius })
    expect(marked?.x).toBeCloseTo(from + MOVE.slam.reach.aim)
    game.tickUntil(() => game.of("burst").length > 0, 40)
    expect(game.view().player?.x).toBeCloseTo(from + MOVE.slam.reach.aim, 1)
    expect(game.of("burst")[0]).toMatchObject({ move: "slam", hits: 1 })
    expect(game.of("hit").filter((hit) => hit.source === "slam")).toEqual([expect.objectContaining({ damage: MOVE.slam.damage })])
  })

  test("the slam's hop stops at a wall", () => {
    const game = armed("breaker")
    const wall = 18 - Tuning.PLAYER.radius
    game.send({ type: "teleport", x: 18 - 1, z: 0, facing: 0 })
    game.tick()
    press(game, 2)
    game.tick(MOVE.slam.windup.steps + 2)
    expect(game.view().player?.x).toBeLessThanOrEqual(wall + 1e-6)
  })

  test("the slam staggers armour, which the cleave only damages", () => {
    const cleave = armed("breaker", [["bruiser", 2, 0, "idle"]])
    press(cleave)
    cleave.tick(MOVE.cleave.windup.steps + 2)
    expect(cleave.view().enemies[0]?.state).toBe("Move")
    const slam = armed("breaker", [["bruiser", 4, 0, "idle"]])
    press(slam, 2)
    slam.tick(MOVE.slam.windup.steps + 2)
    expect(slam.view().enemies[0]?.state).toBe("Stagger")
  })

  test("the slam lands through a warden's shell, where darts clank off it", () => {
    const game = armed("breaker", [["warden", 4, 0, "idle"]])
    game.send({ type: "attack", id: null })
    game.tick()
    expect(game.view().enemies[0]?.shielded).toBe(true)
    press(game, 2)
    game.tick(MOVE.slam.windup.steps + 2)
    expect(game.of("hit")).toEqual([expect.objectContaining({ source: "slam" })])
    const darts = armed("darts", [["warden", 4, 0, "idle"]])
    darts.send({ type: "attack", id: null })
    darts.tick()
    press(darts)
    darts.tick(20)
    expect(darts.of("clank")).toHaveLength(1)
    expect(darts.of("hit")).toHaveLength(0)
  })
})

describe("darts", () => {
  test("a press fires one dart from the tip; point blank it hits harder", () => {
    const near = armed("darts", [["bruiser", 2.2, 0]])
    press(near)
    near.tick(10)
    expect(near.of("shot")[0]).toMatchObject({ pierce: false, perfect: false, dirX: 1 })
    expect(near.of("shot")[0]?.x).toBeCloseTo(px + DARTS.muzzle)
    expect(near.view().weapon.ammo).toEqual({ loaded: DARTS.clip - 1, size: DARTS.clip })
    expect(near.of("hit")).toEqual([expect.objectContaining({ source: "dart", damage: 2 })])
    const far = armed("darts", [["bruiser", 7, 0]])
    press(far)
    far.tick(20)
    expect(far.of("hit")).toEqual([expect.objectContaining({ source: "dart", damage: 1 })])
  })

  test("darts fire no faster than one every 9 steps", () => {
    const game = armed("darts")
    for (let index = 0; index < 6; index++) {
      press(game)
      game.tick(3)
    }
    game.tick(20)
    const frames = game.of("shot").map((shot) => shot.frame)
    expect(frames.length).toBeGreaterThan(1)
    for (let index = 1; index < frames.length; index++) expect((frames[index] ?? 0) - (frames[index - 1] ?? 0)).toBeGreaterThanOrEqual(9)
  })

  test("an empty clip fires nothing; a dash reloads it at once", () => {
    const game = armed("darts")
    for (let index = 0; index < DARTS.clip; index++) {
      press(game)
      game.tick(9)
    }
    expect(game.view().weapon.ammo?.loaded).toBe(0)
    press(game)
    game.tick(10)
    expect(game.of("shot")).toHaveLength(DARTS.clip)
    game.send({ type: "press", action: "dash" })
    game.tick()
    expect(game.of("reloaded").at(-1)).toMatchObject({ loaded: DARTS.clip, dash: true })
    expect(game.view().weapon.ammo?.loaded).toBe(DARTS.clip)
  })

  test("darts load back one by one after a pause in firing", () => {
    const game = armed("darts")
    press(game)
    game.tick(9)
    press(game)
    game.tick(9)
    expect(game.view().weapon.ammo?.loaded).toBe(DARTS.clip - 2)
    game.tickUntil(() => game.of("reloaded").length === 1, DARTS.reloadAfter.steps + 2)
    game.tickUntil(() => game.of("reloaded").length === 2, DARTS.reloadEvery.steps + 2)
    expect(game.of("reloaded").map((each) => each.loaded)).toEqual([DARTS.clip - 1, DARTS.clip])
    expect((game.of("reloaded")[1]?.frame ?? 0) - (game.of("reloaded")[0]?.frame ?? 0)).toBe(DARTS.reloadEvery.steps)
  })

  test("holding charges the pierce; a release on the beat is perfect and passes through every enemy in line", () => {
    const game = armed("darts", [["bruiser", 5, 0], ["bruiser", 8, 0]])
    const pressed = game.frame()
    game.send({ type: "hold", seconds: (9 + DARTS.charge.steps + 4) / 60 })
    game.tickUntil(() => game.of("charged").length > 0, 80)
    game.tickUntil(() => game.of("shot").some((shot) => shot.pierce), 40)
    const pierce = game.of("shot").find((shot) => shot.pierce)
    expect(pierce).toMatchObject({ perfect: true })
    expect((game.of("charged")[0]?.frame ?? 0) - pressed).toBeGreaterThanOrEqual(9 + DARTS.charge.steps)
    game.tick(30)
    const pierced = game.of("hit").filter((hit) => hit.source === "pierce")
    expect(pierced).toHaveLength(2)
    expect(pierced.every((hit) => hit.damage === MOVE.pierce.damage + DARTS.perfectDamage)).toBe(true)
    expect(game.view().weapon.ammo?.loaded).toBe(DARTS.clip - 1 + game.of("reloaded").length - MOVE.pierce.ammo)
  })

  test("a late release is a plain pierce; an early one fires nothing more", () => {
    const late = armed("darts")
    late.send({ type: "hold", seconds: 1.2 })
    late.tick(90)
    expect(late.of("shot").find((shot) => shot.pierce)).toMatchObject({ perfect: false })
    const early = armed("darts")
    early.send({ type: "hold", seconds: 0.3 })
    early.tick(60)
    expect(early.of("shot")).toHaveLength(1)
    expect(early.of("charged")).toHaveLength(0)
  })

  test("a pierce cuts the enemy orbs on its line", () => {
    const game = armed("darts", [["shooter", 12, 0, "dummy"]])
    game.send({ type: "invulnerable", on: true })
    game.send({ type: "hold", seconds: 0.7 })
    game.send({ type: "attack", id: null })
    game.tickUntil(() => game.of("shot").some((shot) => shot.pierce), 60)
    game.tick(30)
    expect(game.of("projectileFired").length).toBeGreaterThan(0)
    const orbs = new Set(game.of("projectileFired").map((orb) => orb.id))
    expect(game.of("projectileGone").some((gone) => orbs.has(gone.id) && gone.reason === "hit")).toBe(true)
  })
})

describe("sigil", () => {
  test("a sigil goes 5 units along the facing with no cursor and bursts after its delay", () => {
    const game = armed("sigil", [["chaser", 5.6, 0], ["chaser", -3, 0]])
    press(game)
    game.tickUntil(() => game.of("marked").length > 0, 20)
    const [marked] = game.of("marked")
    expect(marked).toMatchObject({ weapon: "sigil", move: "sigil", radius: MOVE.sigil.radius })
    expect(marked?.x).toBeCloseTo(px + SIGIL.free)
    expect(game.view().weapon.marks).toHaveLength(1)
    game.tickUntil(() => game.of("burst").length > 0, 40)
    expect((game.of("burst")[0]?.frame ?? 0) - (marked?.frame ?? 0)).toBe(MOVE.sigil.delay.steps)
    expect(game.of("hit")).toEqual([expect.objectContaining({ source: "sigil", damage: MOVE.sigil.damage })])
    expect(game.view().weapon.marks).toHaveLength(0)
  })

  test("the cursor places the sigil, clamped to its reach", () => {
    const game = armed("sigil")
    game.send({ type: "aim", x: px + 30, z: pz })
    game.tick()
    press(game)
    game.tick(10)
    expect(game.of("marked")[0]?.x).toBeCloseTo(px + SIGIL.far)
  })

  test("every third cast in a row is a seal", () => {
    const game = armed("sigil")
    for (let index = 0; index < 4; index++) {
      press(game)
      game.tick(15)
    }
    expect(game.of("marked").map((mark) => mark.move)).toEqual(["sigil", "sigil", "seal", "sigil"])
    expect(game.of("marked")[2]?.radius).toBe(MOVE.seal.radius)
  })

  test("a pause of more than a second starts the count again", () => {
    const game = armed("sigil")
    press(game)
    game.tick(15)
    press(game)
    game.tick(80)
    press(game)
    game.tick(15)
    expect(game.of("marked").map((mark) => mark.move)).toEqual(["sigil", "sigil", "sigil"])
  })
})

describe("determinism", () => {
  for (const weapon of weaponIds) {
    test(`a fight with the ${weapon} plays out the same every time`, () => {
      const timeline: Keyboard.Timeline<typeof keys> = Array.from({ length: 40 }, (_, index) => {
        const frame = 50 + index * 13
        return [{ frame, press: ["slash" as const] }, { frame: frame + (index % 5 === 4 ? 50 : 1), release: ["slash" as const] }]
      }).flat()
      const result = replays(700, (runtime) => {
        runtime.send(Intents, { type: "start", wave: 0, seed: 9 })
        runtime.send(Intents, { type: "setWeapon", weapon })
        runtime.send(Intents, { type: "aim", x: px + 6, z: pz - 2 })
        for (const [kind, dx, dz] of [["bruiser", 3, 0], ["chaser", 5, -2], ["shooter", 7, 1]] as const) runtime.send(Intents, { type: "spawn", kind, x: px + dx, z: pz + dz })
      }, timeline)
      expect(result).toEqual({ ok: true, frames: 700 })
    })
  }
})
