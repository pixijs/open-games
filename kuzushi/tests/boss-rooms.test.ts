import { describe, expect, test } from "vitest"

import { Tuning } from "../src/sim/index.ts"
import type { ZoneId } from "../src/sim/index.ts"
import { makeGame, shiftTo } from "./harness.ts"
import type { TestGame } from "./harness.ts"

/** A run in `zone`'s boss room, its doors locked and the boss past its name card. */
const bossRoom = (zone: ZoneId, seed = 3): TestGame => {
  const game = makeGame()
  game.startZone(zone, "boss", seed)
  game.send({ type: "invulnerable", on: true })
  game.tickUntil(() => game.view().boss?.state === "fighting", 600)
  return game
}

describe("what a boss changes in its room", () => {
  test("the Orrery's 50% shift lights the beam from its own body; the room had none before", () => {
    const game = bossRoom("spiral")
    expect(game.view().hazard.kind).toBe("none")
    shiftTo(game, 2)
    expect(game.view().hazard).toMatchObject({ kind: "beam", x: 0, z: 0, from: Tuning.ORRERY.beam.from })
    game.tickUntil(() => game.of("beamStarted").length > 0, 600)
    expect(game.of("beamStarted")[0]).toMatchObject({ x: 0, z: 0, speed: expect.closeTo(Tuning.ORRERY.beam.speed, 6) })
  })

  test("Sunder's shifts crack the abyss's outer slabs, then its rim, and they fall", () => {
    const game = bossRoom("void")
    const slabs = game.view().room?.layout.floor
    expect(slabs?.kind).toBe("slabs")
    shiftTo(game, 2)
    game.tickUntil(() => game.of("slabsFell").length > 0, 400)
    const outer = game.of("slabsCracking")[0]?.slabs ?? []
    expect(outer).toHaveLength(4)
    shiftTo(game, 3)
    game.tickUntil(() => game.of("slabsFell").length > 1, 400)
    const rim = game.of("slabsCracking")[1]?.slabs ?? []
    expect(rim.length).toBeGreaterThan(0)
    expect(rim.some((index) => outer.includes(index))).toBe(false)
  })

  test("Sunder landing on a cracking slab brings its group down at once", () => {
    const game = bossRoom("void")
    shiftTo(game, 2)
    game.tickUntil(() => game.of("slabsFell").length > 0, 400)
    for (const enemy of game.view().enemies) if (enemy.kind !== "sunder") game.send({ type: "remove", id: enemy.id })
    game.send({ type: "teleport", x: 5, z: -5.5, facing: null })
    game.send({ type: "bossPattern", pattern: "leap" })
    game.tickUntil(() => game.of("leap").length > 0, 600)
    game.send({ type: "collapse" })
    game.tickUntil(() => game.of("landed").length > 0, 200)
    const fell = game.of("slabsFell")[1]
    expect(fell?.frame).toBe(game.of("landed")[0]?.frame)
    expect((fell?.frame ?? 0) - (game.of("slabsCracking")[1]?.frame ?? 0)).toBeLessThan(150)
  })

  test("from its second phase, a Gatekeeper charge that meets a pillar breaks it for good", () => {
    const game = bossRoom("courtyard")
    shiftTo(game, 2)
    for (const enemy of game.view().enemies) if (enemy.kind !== "gatekeeper") game.send({ type: "remove", id: enemy.id })
    const pillars = game.view().room?.layout.pillars ?? []
    const pillar = pillars[0]
    const boss = game.view().enemies.find((enemy) => enemy.kind === "gatekeeper")
    if (pillar === undefined || boss === undefined) throw new Error("a pillar and the Gatekeeper")
    const out = Math.hypot(pillar.x, pillar.z)
    const dir = { x: pillar.x / out, z: pillar.z / out }
    game.send({ type: "teleport", id: boss.id, x: pillar.x - dir.x * 5, z: pillar.z - dir.z * 5, facing: null })
    game.send({ type: "teleport", x: pillar.x + dir.x * 2.2, z: pillar.z + dir.z * 2.2, facing: null })
    game.send({ type: "bossPattern", pattern: "charge" })
    game.tickUntil(() => game.of("bossStunned").length > 0, 600)
    expect(game.of("bossStunned")[0]).toMatchObject({ breaks: true, pillar: 0 })
    game.tick()
    expect(game.view().room?.layout.pillars).toHaveLength(pillars.length - 1)
    expect(game.view().room?.layout.pillars).not.toContainEqual(pillar)
  })
})
