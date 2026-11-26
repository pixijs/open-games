import { describe, expect, test } from "vitest"

import { buildTerrain, clearPath, standable } from "../src/sim/arena.ts"
import type { ArenaLayout, Point, Terrain } from "../src/sim/arena.ts"
import { groundFor } from "../src/sim/dungeon/enter.ts"
import { arrivalOf, bossSpot, roomLayout, roomTerrain } from "../src/sim/dungeon/layout.ts"
import { within } from "../src/sim/geometry.ts"
import { enemyKinds, generateDungeon, Intents, OPEN_FLOOR, POOLS, sides, slabGroupsOf, templateIds, templateOf, terrainOf, TRANSITION, Tuning, update, zoneIds, ZONES } from "../src/sim/index.ts"
import type { EnemyKind, Intent, RoomRecord, TemplateId, ZoneId } from "../src/sim/index.ts"
import { cornersOf, fightOf, meshesBuilt, meshOf, routesTo } from "../src/sim/paths.ts"
import { makeGame, replays } from "./harness.ts"
import type { TestGame } from "./harness.ts"

/**
 * How far a path may cut into a body's radius at a corner: the mesh samples the floor on a quarter-unit grid and traces
 * its outline to within 0.8 of a cell. The body slides round the corner on its collision.
 */
const SLACK = 0.3

/** The radius of every body that walks `zone`'s waves: its pools' kinds, their elites, and the splitter's halves. */
const walkersOf = (zone: ZoneId): ReadonlyArray<number> => {
  const kinds = new Set(Object.values(POOLS[zone]).flat().flatMap((entry) => enemyKinds.filter((kind) => entry[kind] > 0)))
  if (kinds.has("splitter")) kinds.add("splitling")
  return [...new Set([...kinds].flatMap((kind) => [Tuning.radiusOf(kind), Tuning.radiusOf(kind, true)]))]
}

/** Whether every leg of the walk from `from` through `corners` is clear of the terrain's walls and edges for a body of `radius`. */
const walkable = (terrain: Terrain, from: Point, corners: ReadonlyArray<Point>, radius: number) =>
  corners.every((corner, index) => {
    const start = corners[index - 1] ?? from
    return clearPath(terrain.bounded, start.x, start.z, corner.x - start.x, corner.z - start.z, radius - SLACK)
  })

/** Whether the walk the mesh finds from `from` reaches `to`, every leg clear for a body of `radius`. */
const reaches = (terrain: Terrain, from: Point, to: Point, radius: number) => {
  const corners = cornersOf(terrain, radius, from, to)
  const last = corners.at(-1) ?? from
  return within(last.x, last.z, to.x, to.z, 0.05) && walkable(terrain, from, corners, radius)
}

const routeToward = (terrain: Terrain, from: Point, to: Point, radius: number) => routesTo(terrain, to)(from, radius, { x: 1, z: 0 })

const sealed = (template: TemplateId) => ({ template, mirrorX: false, mirrorZ: false, exits: sides, sealed: true, broken: [] })

/** The Courtyard's great hall, sealed, and its first pillar. */
const greatHall = () => {
  const great = sealed("courtyard.great")
  const pillar = roomLayout(great).pillars[0]
  if (pillar === undefined) throw new Error("The great hall has no pillar")
  return { great, pillar }
}

describe("paths load under a door's ink", () => {
  /** How many slab groups fall in a room over its fight. */
  const falls = (record: RoomRecord) => slabGroupsOf(roomLayout({ ...record, exits: [], sealed: true, broken: [] })).length

  test.each(zoneIds)("in %s, a room's fight walks on meshes built under the door's hold: none is built from its first enemy to its clear", (zone) => {
    const game = makeGame()
    game.startZone(zone)
    game.send({ type: "invulnerable", on: true })
    const rooms = generateDungeon(zone, game.of("zoneStarted")[0]?.seed ?? 0)
    const { index } = rooms
      .map((record, at) => ({ record, index: at }))
      .filter(({ record }) => record.kind === "combat" || record.kind === "elite")
      .reduce((most, each) => (falls(each.record) > falls(most.record) ? each : most))
    const before = meshesBuilt()
    game.send({ type: "enterRoom", room: index, instant: false })
    game.tickUntil(() => game.of("transitionEnded").length > 0, 200)
    const loaded = meshesBuilt()
    expect(loaded).toBeGreaterThan(before)
    for (let wave = 0; wave < 12 && game.of("roomCleared").length === 0; wave++) {
      game.tick(240)
      game.send({ type: "clearWave" })
      game.tick()
    }
    expect(game.of("roomCleared")).toHaveLength(1)
    expect(game.of("enemySpawned").length).toBeGreaterThan(0)
    expect(meshesBuilt()).toBe(loaded)
  })

  test("every room's fight, in any dungeon, needs no more meshes than the hold has steps to build them in", () => {
    for (const zone of zoneIds) {
      for (let seed = 1; seed <= 40; seed++) {
        const rooms = generateDungeon(zone, seed)
        const dungeon = { _tag: "Zone", zone, seed, rooms, current: 0, revealed: false, startedAt: 0 } as const
        rooms.forEach((_, index) => {
          const room = groundFor(dungeon, index, false)
          if (room === null) return
          const fight = fightOf(dungeon, room)
          expect(fight.floors.length * fight.radii.length, `${zone}, seed ${seed}, room ${index}`).toBeLessThanOrEqual(TRANSITION.door.hold)
        })
      }
    }
  })
})

describe("paths round the rooms", () => {
  test("in every room, each body its zone's waves send finds a way from every spawn point to every door the player comes in by", () => {
    for (const id of templateIds) {
      const placed = sealed(id)
      const terrain = roomTerrain(placed, 0)
      for (const radius of walkersOf(templateOf(id).zone)) {
        const fits = (point: Point) => standable(terrain, point.x, point.z, radius)
        for (const from of roomLayout(placed).spawnPoints.filter(fits)) {
          for (const to of sides.map((side) => arrivalOf(placed, side)).filter(fits)) {
            expect(reaches(terrain, from, to, radius), `${id}, radius ${radius}, (${from.x}, ${from.z}) to (${to.x}, ${to.z})`).toBe(true)
          }
        }
      }
    }
  })

  test("a boss that walks finds a way from where it stands to every spawn point of its room", () => {
    for (const id of templateIds.filter((each) => templateOf(each).role === "boss")) {
      const boss = ZONES[templateOf(id).zone].boss
      const radius = Tuning.radiusOf(boss)
      if (Tuning.ENEMY[boss].speed <= 0) continue
      const placed = sealed(id)
      const terrain = roomTerrain(placed, 0)
      for (const entry of sides) {
        const from = bossSpot(placed, entry)
        for (const to of roomLayout(placed).spawnPoints.filter((point) => standable(terrain, point.x, point.z, radius))) {
          expect(reaches(terrain, from, to, radius), `${boss} in ${id} to (${to.x}, ${to.z})`).toBe(true)
        }
      }
    }
  })

  test("as slabs fall, the ways keep to the floor that is left", () => {
    for (const id of templateIds) {
      const placed = sealed(id)
      const layout = roomLayout(placed)
      for (let fallen = 1; fallen <= slabGroupsOf(layout).length; fallen++) {
        const terrain = roomTerrain(placed, fallen)
        expect(meshOf(terrain, 0.45), `${id} after ${fallen} fell`).not.toBeNull()
        const standing = layout.spawnPoints.filter((point) => standable(terrain, point.x, point.z, 0.45))
        for (const from of standing) {
          for (const to of standing) expect(walkable(terrain, from, cornersOf(terrain, 0.45, from, to), 0.45), `${id} after ${fallen} fell`).toBe(true)
        }
      }
    }
  })

  test("a broken pillar opens the way through where it stood", () => {
    const { great, pillar } = greatHall()
    const from = { x: pillar.x - 3, z: pillar.z }
    const to = { x: pillar.x + 3, z: pillar.z }
    expect(routeToward(roomTerrain(great, 0), from, to, 0.45)).toMatchObject({ sight: false })
    expect(routeToward(roomTerrain({ ...great, broken: [0] }, 0), from, to, 0.45)).toEqual({ sight: true, way: { x: 1, z: 0 } })
  })

  test("across a gap in the floor an enemy still sees the player, but walks the way round", () => {
    const islands: ArenaLayout = {
      ...OPEN_FLOOR,
      floor: { kind: "slabs", slabs: [{ x: -4, z: 0, halfWidth: 2, halfDepth: 4, fallsAfter: null }, { x: 4, z: 0, halfWidth: 2, halfDepth: 4, fallsAfter: null }, { x: 0, z: 3, halfWidth: 2, halfDepth: 1, fallsAfter: null }] }
    }
    const route = routeToward(buildTerrain(islands), { x: -4, z: -2 }, { x: 4, z: -2 }, 0.45)
    expect(route.sight).toBe(true)
    expect(route.way.z).toBeGreaterThan(0.5)
  })

  test("a body inside a pillar's footprint is no place to stand", () => {
    const { great, pillar } = greatHall()
    const terrain = roomTerrain(great, 0)
    expect(standable(terrain, pillar.x, pillar.z, 0.3)).toBe(false)
    expect(terrain.inPillar(pillar.x + pillar.radius + 0.1, pillar.z)).toBe(false)
  })
})

/** A sandbox in `stage` with the player held still (and unhurt) at `at`, and one `kind` appearing at `from`. */
const standoff = (stage: "courtyard" | "void", at: Point, kind: EnemyKind, from: Point): TestGame => {
  const game = makeGame()
  game.startStage(stage)
  game.send({ type: "invulnerable", on: true })
  game.send({ type: "teleport", x: at.x, z: at.z, facing: null })
  game.tick()
  game.spawn(kind, from.x, from.z)
  return game
}

describe("enemies walk round what stands between them and the player", () => {
  const behindBlock = { player: { x: 8, z: 4.4 }, enemy: { x: 8, z: -1.4 } }

  test("a chaser walks round a block to lunge instead of pressing into it", () => {
    const game = standoff("courtyard", behindBlock.player, "chaser", behindBlock.enemy)
    game.tickUntil(() => game.of("enemyAttack").length > 0, 300)
    const [lunge] = game.of("telegraph")
    expect(lunge).toMatchObject({ kind: "chaser", shape: "line" })
  })

  test("a shooter walks out from behind a block before it fires, so its shots have a clear line", () => {
    const game = standoff("courtyard", behindBlock.player, "shooter", { x: 8, z: -2.5 })
    game.tickUntil(() => game.of("projectileFired").length > 0, 900)
    const [shot] = game.of("projectileFired")
    const player = game.view().player
    expect(shot).toBeDefined()
    expect(player).not.toBeNull()
    if (shot === undefined || player === null) return
    const walls = terrainOf("courtyard", 0).bounded
    expect(clearPath(walls, shot.x, shot.z, player.x - shot.x, player.z - shot.z, Tuning.ORB.radius)).toBe(true)
  })

  test("on The Void, a chaser crosses by the slabs that join instead of stopping at the edge", () => {
    const game = standoff("void", { x: 10.5, z: 4.5 }, "chaser", { x: 3, z: 3 })
    game.tickUntil(() => game.of("enemyAttack").length > 0, 600)
    expect(game.of("ringOut")).toHaveLength(0)
  })
})

describe("paths and determinism", () => {
  test("a fight round props plays the same twice, whether the path meshes were built yet or not", () => {
    const placements: ReadonlyArray<[EnemyKind, number, number]> = [["chaser", 8, -1.4], ["shooter", -12.5, -3], ["bruiser", -3, -12], ["trickster", 5.5, -8], ["chaser", -6.5, -7]]
    const result = replays(900, (runtime) => {
      const send = (intent: Intent) => runtime.send(Intents, intent)
      send({ type: "startStage", stage: "courtyard", wave: 0, seed: 7 })
      const started = runtime.tick(update)
      if (!started.ok) throw new Error("The run did not start")
      send({ type: "invulnerable", on: true })
      send({ type: "teleport", x: 8, z: 4.4, facing: null })
      for (const [kind, x, z] of placements) send({ type: "spawn", kind, x, z })
    })
    expect(result).toEqual({ ok: true, frames: 900 })
  })
})
