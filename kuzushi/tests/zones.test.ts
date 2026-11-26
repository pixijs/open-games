import { describe, expect, test } from "vitest"

import { BOSSES, bossIds, enemyKinds, isBoss, STARTING_WEAPON, Tuning, ZONE_LIST, zoneIds, ZONES } from "../src/sim/index.ts"
import { makeGame } from "./harness.ts"

describe("zones, weapons and bosses", () => {
  test("every enemy kind but the splitling and the bosses belongs to exactly one zone, and every boss to its own", () => {
    const rostered = ZONE_LIST.flatMap((zone) => zone.roster)
    const sent = enemyKinds.filter((kind) => kind !== "splitling" && !isBoss(kind))
    expect([...rostered].sort()).toEqual([...sent].sort())
    expect(ZONE_LIST.map((zone) => zone.boss)).toEqual([...bossIds])
    for (const id of zoneIds) expect(BOSSES[ZONES[id].boss].zone).toBe(id)
  })

  test("a zone started directly plays there, holding the weapon it names; a new run puts the blade back", () => {
    const game = makeGame()
    game.startZone("spiral", null, 4, "darts")
    expect(game.view()).toMatchObject({ flow: "Playing", zone: "spiral", weapon: { id: "darts" } })
    game.send({ type: "startStage", stage: "void", wave: 0, seed: 4 })
    game.tick()
    expect(game.view()).toMatchObject({ zone: "void", weapon: { id: STARTING_WEAPON } })
  })

  test("the debug hooks put a weapon in hand and set the diamonds between one and the most", () => {
    const game = makeGame()
    game.start()
    game.send({ type: "setWeapon", weapon: "sigil" })
    game.send({ type: "lives", lives: 2 })
    game.tick()
    expect(game.view()).toMatchObject({ weapon: { id: "sigil" }, lives: 2 })
    game.send({ type: "lives", lives: 0 })
    game.tick()
    expect(game.view().lives).toBe(1)
    game.send({ type: "lives", lives: 99 })
    game.tick()
    expect(game.view().lives).toBe(Tuning.PLAYER.lives)
  })
})
