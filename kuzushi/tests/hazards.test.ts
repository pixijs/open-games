import { describe, expect, test } from "vitest"

import { generateDungeon, slabGroupsOf, stageOf, terrainOf, Tuning } from "../src/sim/index.ts"
import type { BeamHazard, HazardView, TemplateId, ZoneId } from "../src/sim/index.ts"
import { APPEAR, makeGame, steps } from "./harness.ts"
import type { TestGame } from "./harness.ts"

const beam = ((): BeamHazard => {
  const hazard = stageOf("spiral").hazard
  if (hazard.kind !== "beam") throw new Error("The Spiral has a beam")
  return hazard
})()
const sweepSteps = steps(beam.sweep / beam.speed)

const beamOf = (game: TestGame): Extract<HazardView, { readonly kind: "beam" }> => {
  const hazard = game.view().hazard
  if (hazard.kind !== "beam") throw new Error("expected the beam")
  return hazard
}

const slabsOf = (game: TestGame): Extract<HazardView, { readonly kind: "slabs" }> => {
  const hazard = game.view().hazard
  if (hazard.kind !== "slabs") throw new Error("The Void shows its slabs")
  return hazard
}

/** A Spiral sandbox with the player put at (x, z). */
const spiral = (x: number, z: number) => {
  const game = makeGame()
  game.startStage("spiral")
  game.send({ type: "teleport", x, z, facing: null })
  game.tick()
  return game
}

/** The first run of `zone`, by seed from 1 to below `seeds`, whose dungeon has a room made from one of `templates`, and that room. */
const firstRunWith = (zone: ZoneId, templates: ReadonlyArray<TemplateId>, seeds: number) => {
  for (let seed = 1; seed < seeds; seed++) {
    const game = makeGame()
    game.startZone(zone, null, seed)
    const started = game.of("zoneStarted")[0]
    const room = generateDungeon(zone, started?.seed ?? 0).findIndex((each) => templates.includes(each.template))
    if (room >= 0) return { game, room }
  }
  throw new Error(`no ${templates.join(" or ")} room in the seeds tried`)
}

/** A Void run standing in a room whose slabs fall after its first wave, its doors locked and that wave spawned. */
const collapseRoom = () => {
  const { game, room } = firstRunWith("void", ["void.causeway", "void.collapse"], 80)
  game.send({ type: "invulnerable", on: true })
  game.send({ type: "enterRoom", room, instant: true })
  game.tick()
  game.tickUntil(() => game.view().wave.phase === "fighting" && game.of("enemySpawned").length >= (game.of("waveStarted")[0]?.enemies ?? 99), 600)
  return { game, room }
}

/** The frame the beam first hurts a player standing at (x, z) with no defence. */
const beamHurtFrame = (x: number, z: number) => {
  const probe = spiral(x, z)
  probe.tickUntil(() => probe.of("playerHurt").length > 0, 1200)
  return probe.of("playerHurt")[0]?.frame ?? 0
}

describe("the beam", () => {
  test("it rests, telegraphs a second ahead, sweeps 270° clockwise, then rests again", () => {
    const game = makeGame()
    game.startStage("spiral")
    game.tickUntil(() => game.of("beamWarned").length > 0)
    const [warned] = game.of("beamWarned")
    expect(warned).toMatchObject({ angle: beam.startAngle, lead: 1 })
    expect(warned?.frame).toBeGreaterThanOrEqual(beam.first.steps - 1)
    expect(beamOf(game)).toMatchObject({ phase: "warn", telegraph: { angle: beam.startAngle } })
    game.tickUntil(() => game.of("beamStarted").length > 0)
    expect((game.of("beamStarted")[0]?.frame ?? 0) - (warned?.frame ?? 0)).toBe(beam.lead.steps)
    game.tick(steps(1))
    const sweeping = beamOf(game)
    expect(sweeping.phase).toBe("sweep")
    expect(sweeping.angle).toBeGreaterThan(beam.startAngle)
    expect((sweeping.telegraph?.angle ?? 0) - sweeping.angle).toBeCloseTo(beam.speed * 1, 2)
    game.tickUntil(() => game.of("beamEnded").length > 0, sweepSteps + 10)
    expect(game.of("beamEnded")[0]?.angle).toBeCloseTo(beam.startAngle + beam.sweep)
    expect(beamOf(game).phase).toBe("rest")
  })

  test("it stops at the first pillar along its line", () => {
    const game = makeGame()
    game.startStage("spiral")
    game.tickUntil(() => game.of("beamStarted").length > 0)
    const pillars = stageOf("spiral").layout.pillars
    let blocked = false
    for (let index = 0; index < sweepSteps; index++) {
      game.tick()
      const view = beamOf(game)
      if (view.phase !== "sweep") break
      if (view.reach < 15 - 0.01) blocked = true
      const tip = { x: Math.cos(view.angle) * view.reach, z: Math.sin(view.angle) * view.reach }
      if (view.reach < 15 - 0.01) expect(pillars.some((pillar) => Math.hypot(tip.x - pillar.x, tip.z - pillar.z) <= pillar.radius + 0.05)).toBe(true)
    }
    expect(blocked).toBe(true)
  })

  test("standing in its path costs a life; behind a pillar is cover", () => {
    const open = spiral(0, 10)
    open.tickUntil(() => open.of("playerHurt").length > 0, 1200)
    expect(open.of("playerHurt")[0]).toMatchObject({ cause: "beam", lives: Tuning.PLAYER.lives - 1 })
    const pillar = stageOf("spiral").layout.pillars[4]
    if (pillar === undefined) throw new Error("The Spiral has a fifth pillar")
    const angle = Math.atan2(pillar.z, pillar.x)
    const covered = spiral(Math.cos(angle) * 10, Math.sin(angle) * 10)
    covered.tickUntil(() => covered.of("beamEnded").length > 0, 1200)
    expect(covered.of("playerHurt")).toHaveLength(0)
  })

  test("a dash passes through it: a near miss, no life lost", () => {
    const hurt = beamHurtFrame(0, 10)
    const game = spiral(0, 10)
    while (game.frame() < hurt - 6) game.tick()
    game.send({ type: "steer", x: 1, z: 0 })
    game.send({ type: "press", action: "dash" })
    game.tick(30)
    expect(game.of("nearMiss").length).toBeGreaterThan(0)
    expect(game.of("playerHurt")).toHaveLength(0)
  })

  test("switched off, it ends at once and starts no sweep; a debug sweep still plays one", () => {
    const game = makeGame()
    game.startStage("spiral")
    game.tickUntil(() => game.of("beamStarted").length > 0)
    game.send({ type: "hazard", on: false })
    game.tick()
    expect(game.of("beamEnded")).toHaveLength(1)
    game.tick(steps(15))
    expect(game.of("beamWarned")).toHaveLength(1)
    expect(beamOf(game)).toMatchObject({ on: false, phase: "rest" })
    game.send({ type: "sweep" })
    game.tick()
    expect(game.of("beamWarned")).toHaveLength(2)
    game.tick(beam.lead.steps + 1)
    expect(game.of("beamStarted")).toHaveLength(2)
  })
})

describe("The Void's floor", () => {
  test("its edges stop the player walking and dashing", () => {
    const game = makeGame()
    game.startStage("void")
    game.send({ type: "teleport", x: -4, z: 0, facing: -Math.PI / 2 })
    game.send({ type: "steer", x: 0, z: -1 })
    game.tick(120)
    game.send({ type: "press", action: "dash" })
    game.tick(40)
    const player = game.view().player
    expect(player?.z).toBeGreaterThan(-4)
    expect(terrainOf("void", 0).onFloor(player?.x ?? 0, player?.z ?? 0)).toBe(true)
  })

  test("in a room, after a listed wave clears, its slabs crack for a telegraph and fall, and stay fallen when the player comes back", () => {
    const { game, room } = collapseRoom()
    const group = slabGroupsOf(game.view().room?.layout ?? stageOf("void").layout)[0]
    game.send({ type: "clearWave" })
    game.tickUntil(() => game.of("slabsCracking").length > 0, 600)
    expect(game.of("slabsCracking")[0]).toMatchObject({ slabs: group?.slabs, duration: 2.6 })
    game.tickUntil(() => game.of("slabsFell").length > 0, 400)
    expect(game.of("slabsFell")[0]?.slabs).toEqual(group?.slabs)
    const fallen = () => slabsOf(game).slabs.filter((slab) => slab.state === "fallen").map((slab) => slab.index)
    expect(fallen()).toEqual(group?.slabs)
    game.send({ type: "openDoors" })
    game.tick()
    game.send({ type: "enterRoom", room: 0, instant: true })
    game.tick()
    game.send({ type: "enterRoom", room, instant: true })
    game.tick()
    expect(fallen()).toEqual(group?.slabs)
  })

  test("a player on a falling slab is hurt and set down on standing floor", () => {
    const { game } = collapseRoom()
    const layout = game.view().room?.layout ?? stageOf("void").layout
    const slab = layout.floor.kind === "slabs" ? layout.floor.slabs[slabGroupsOf(layout)[0]?.slabs[0] ?? 0] : undefined
    game.send({ type: "clearWave" })
    game.tickUntil(() => game.of("slabsCracking").length > 0, 600)
    game.send({ type: "invulnerable", on: false })
    game.send({ type: "teleport", x: slab?.x ?? 0, z: slab?.z ?? 0, facing: null })
    game.tickUntil(() => game.of("slabsFell").length > 0, 900)
    expect(game.of("playerCaught")[0]).toMatchObject({ fromX: slab?.x, fromZ: slab?.z })
    expect(game.of("playerHurt")[0]).toMatchObject({ cause: "fall" })
    const player = game.view().player
    expect(slabsOf(game).slabs.some((each) => each.state !== "fallen" && Math.abs((player?.x ?? 99) - each.x) <= each.halfWidth && Math.abs((player?.z ?? 99) - each.z) <= each.halfDepth)).toBe(true)
  })

  test("a beam room's beam waits for its doors to lock, and goes dark once the room is cleared", () => {
    const { game, room } = firstRunWith("spiral", ["spiral.well", "spiral.dial"], 60)
    game.send({ type: "invulnerable", on: true })
    game.send({ type: "enterRoom", room, instant: true })
    game.tick(2)
    expect(beamOf(game).on).toBe(false)
    game.tickUntil(() => game.of("doorsLocked").length > 0, 120)
    const locked = game.frame()
    game.tickUntil(() => game.of("beamWarned").length > 0, beam.first.steps + 10)
    expect((game.of("beamWarned")[0]?.frame ?? 0) - locked).toBeGreaterThanOrEqual(beam.first.steps - 2)
    game.send({ type: "openDoors" })
    game.tickUntil(() => game.of("doorsOpened").length > 0, 120)
    game.tick(steps(12))
    expect(beamOf(game)).toMatchObject({ on: false, phase: "rest" })
  })

  test("the sandbox cracks nothing by itself; a debug collapse cracks the next group", () => {
    const game = makeGame()
    game.startStage("void")
    game.tick(steps(10))
    expect(game.of("slabsCracking")).toHaveLength(0)
    game.send({ type: "collapse" })
    game.tick()
    expect(game.of("slabsCracking")).toHaveLength(1)
    game.tickUntil(() => game.of("slabsFell").length > 0, 400)
  })
})

describe("ring-outs", () => {
  test("a slash that knocks an enemy past an edge drops it: a kill, no split", () => {
    const game = makeGame()
    game.startStage("void")
    game.send({ type: "teleport", x: -4, z: -2.2, facing: -Math.PI / 2 })
    game.send({ type: "spawn", kind: "splitter", x: -4, z: -3.4, facing: Math.PI / 2, drill: "idle" })
    game.tick(APPEAR)
    game.send({ type: "aim", x: -4, z: -10 })
    game.send({ type: "press", action: "slash" })
    game.tickUntil(() => game.of("ringOut").length > 0, 120)
    expect(game.of("ringOut")[0]).toMatchObject({ kind: "splitter" })
    expect(game.of("enemyKilled")[0]).toMatchObject({ source: "ringOut", kind: "splitter" })
    expect(game.of("split")).toHaveLength(0)
    expect(game.view().kills).toBe(1)
    expect(game.view().enemies[0]?.state).toBe("Falling")
    game.tickUntil(() => game.view().enemies.length === 0, Tuning.RING_OUT.fall.steps + Tuning.HIT_STOP.kill.steps + 4)
  })

  test("a lancer sidestepped near an edge charges off it", () => {
    const game = makeGame()
    game.startStage("void")
    game.send({ type: "teleport", x: 4.5, z: 3, facing: 0 })
    game.send({ type: "spawn", kind: "lancer", x: -3, z: 3, facing: 0, drill: "idle" })
    game.tick(APPEAR)
    game.send({ type: "attack", id: null })
    game.tick(5)
    game.send({ type: "teleport", x: 4.5, z: 0, facing: 0 })
    game.tickUntil(() => game.of("ringOut").length > 0, 200)
    expect(game.of("ringOut")[0]).toMatchObject({ kind: "lancer" })
    expect(game.of("playerHurt")).toHaveLength(0)
  })

  test("an enemy on a slab that falls goes with it", () => {
    const game = makeGame()
    game.startStage("void")
    game.send({ type: "spawn", kind: "chaser", x: -7.5, z: -6, drill: "idle" })
    game.tick(APPEAR)
    game.send({ type: "collapse" })
    game.tickUntil(() => game.of("ringOut").length > 0, 400)
    expect(game.of("enemyKilled")[0]).toMatchObject({ source: "ringOut" })
  })

  test("other stages have no edges to fall from", () => {
    const game = makeGame()
    game.start(0)
    game.send({ type: "spawn", kind: "chaser", x: 17.5, z: 0 })
    game.tick(120)
    expect(game.of("ringOut")).toHaveLength(0)
  })
})
