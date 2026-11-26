import { Collide2 } from "@typeonce/ritmo-math"
import { describe, expect, test } from "vitest"

import { blocked, buildTerrain, standable } from "../src/sim/arena.ts"
import { roomLayout } from "../src/sim/dungeon/layout.ts"
import { DOOR, generateDungeon, onSide, doorLine, sides, templateIds, templateOf, templatesFor, Tuning, zoneIds, ZONES } from "../src/sim/index.ts"
import type { RoomRecord, Side, ZoneId } from "../src/sim/index.ts"
import { neighbours, reachable } from "./harness.ts"

const NEEDS = { courtyard: { deadEnds: 3, bossDepth: 3 }, spiral: { deadEnds: 4, bossDepth: 4 }, void: { deadEnds: 4, bossDepth: 4 } } as const

describe("the dungeon generator", () => {
  test.each(zoneIds)("every %s dungeon from seeds 1 to 1000 is a tree of the zone's rooms with the boss in the deepest dead end", (zone: ZoneId) => {
    for (let seed = 1; seed <= 1000; seed++) {
      const rooms = generateDungeon(zone, seed)
      expect(rooms).toHaveLength(ZONES[zone].rooms)
      expect(rooms[0]).toMatchObject({ column: 4, row: 4, kind: "start", depth: 0 })
      const edges = rooms.reduce((sum, _, index) => sum + neighbours(rooms, index).length, 0) / 2
      expect(edges).toBe(rooms.length - 1)
      expect(reachable(rooms).size).toBe(rooms.length)
      for (const room of rooms) expect(room.column >= 0 && room.column < 9 && room.row >= 0 && room.row < 9).toBe(true)
      const deadEnds = rooms.flatMap((_, index) => (index > 0 && neighbours(rooms, index).length === 1 ? [index] : []))
      expect(deadEnds.length).toBeGreaterThanOrEqual(NEEDS[zone].deadEnds)
      const boss = rooms.findIndex((room) => room.kind === "boss")
      expect(deadEnds).toContain(boss)
      expect(rooms[boss]?.depth).toBe(Math.max(...deadEnds.map((index) => rooms[index]?.depth ?? 0)))
      expect(rooms[boss]?.depth).toBeGreaterThanOrEqual(NEEDS[zone].bossDepth)
      const count = (kind: RoomRecord["kind"]) => rooms.filter((room) => room.kind === kind).length
      expect([count("start"), count("boss"), count("weapon"), count("spring"), count("elite")]).toEqual([1, 1, 1, 1, zone === "courtyard" ? 0 : 1])
    }
  })

  test.each(zoneIds)("the same %s seed makes the same dungeon, and another seed another", (zone: ZoneId) => {
    expect(generateDungeon(zone, 77)).toEqual(generateDungeon(zone, 77))
    expect(generateDungeon(zone, 77)).not.toEqual(generateDungeon(zone, 78))
  })

  test.each(zoneIds)("%s rooms take their zone's templates by kind and depth, never a neighbour's when the size has two", (zone: ZoneId) => {
    for (let seed = 1; seed <= 200; seed++) {
      const rooms = generateDungeon(zone, seed)
      rooms.forEach((room, index) => {
        const template = templateOf(room.template)
        expect(template.zone).toBe(zone)
        const role = room.kind === "start" ? "start" : room.kind === "boss" ? "boss" : room.kind === "weapon" || room.kind === "spring" ? "shrine"
          : room.kind === "elite" ? (room.depth <= 3 ? "medium" : "large") : room.depth <= 1 ? "small" : room.depth <= 3 ? "medium" : "large"
        expect(template.role).toBe(role)
        if (templatesFor(zone, role).length < 2) return
        for (const other of neighbours(rooms, index)) expect(rooms[other]?.template).not.toBe(room.template)
      })
    }
  })

  test.each(zoneIds)("%s waves follow depth, send only the zone's kinds, and an elite room ends on its elite", (zone: ZoneId) => {
    const roster = new Set<string>(ZONES[zone].roster)
    for (let seed = 1; seed <= 200; seed++) {
      for (const room of generateDungeon(zone, seed)) {
        if (room.kind !== "combat" && room.kind !== "elite") {
          expect(room.waves).toHaveLength(0)
          continue
        }
        const count = room.depth <= 1 ? 1 : room.depth <= 3 ? 2 : 3
        expect(room.waves).toHaveLength(count + (room.kind === "elite" ? 1 : 0))
        for (const wave of room.waves) for (const slot of wave) expect(roster.has(slot.kind)).toBe(true)
        const last = room.waves[room.waves.length - 1] ?? []
        expect(last.filter((slot) => slot.elite)).toHaveLength(room.kind === "elite" ? 1 : 0)
      }
    }
  })
})

describe("the room templates", () => {
  const largest = 1.0

  test.each(templateIds)("%s: spawn points stand clear of props, away from every door; a fight has at least 8", (id) => {
    const template = templateOf(id)
    const terrain = buildTerrain(roomLayout({ template: id, mirrorX: false, mirrorZ: false, exits: [], sealed: false, broken: [] }))
    if (template.role !== "start" && template.role !== "shrine") expect(template.spawnPoints.length).toBeGreaterThanOrEqual(8)
    for (const point of template.spawnPoints) {
      expect(standable(terrain, point.x, point.z, 0.6) && !blocked(terrain.solid, point.x, point.z, largest)).toBe(true)
      for (const side of sides) {
        const mouth = onSide(side, doorLine(template, side))
        expect(Math.hypot(point.x - mouth.x, point.z - mouth.z)).toBeGreaterThanOrEqual(4)
      }
    }
  })

  test.each(templateIds)("%s: no prop stands in a door's lane, and the hero arrives on open floor at every door, either way mirrored", (id) => {
    const template = templateOf(id)
    for (const side of sides) {
      const reach = (x0: number, x1: number, z0: number, z1: number) => {
        const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x = 0, z = 0]) => ({
          along: side === "north" ? -z : side === "south" ? z : side === "east" ? x : -x,
          across: side === "north" || side === "south" ? x : z
        }))
        const across = corners.map((corner) => corner.across)
        return Math.min(...across) < DOOR.width / 2 && Math.max(...across) > -DOOR.width / 2 && Math.max(...corners.map((corner) => corner.along)) > doorLine(template, side) - DOOR.lane
      }
      for (const block of template.blocks) expect(reach(block.x - block.halfWidth, block.x + block.halfWidth, block.z - block.halfDepth, block.z + block.halfDepth)).toBe(false)
      for (const pillar of template.pillars) expect(reach(pillar.x - pillar.radius, pillar.x + pillar.radius, pillar.z - pillar.radius, pillar.z + pillar.radius)).toBe(false)
      for (const mirrorX of [false, true]) {
        for (const mirrorZ of [false, true]) {
          const terrain = buildTerrain(roomLayout({ template: id, mirrorX, mirrorZ, exits: sides, sealed: false, broken: [] }))
          const arrival = onSide(side, doorLine(template, side) - DOOR.arrival)
          expect(standable(terrain, arrival.x, arrival.z, Tuning.PLAYER.radius)).toBe(true)
          const out = onSide(side, doorLine(template, side) + DOOR.trigger + 0.1)
          const moved = Collide2.moveCircle({ x: arrival.x, y: arrival.z }, { x: out.x - arrival.x, y: out.z - arrival.z }, Tuning.PLAYER.radius, terrain.bounded)
          expect(Math.hypot(moved.position.x - out.x, moved.position.y - out.z)).toBeLessThan(0.01)
        }
      }
    }
  })

  test.each(templateIds)("%s: every altar and the spring stand at least a door's lane from where the hero arrives through any door, either way mirrored", (id) => {
    const template = templateOf(id)
    const spots = [...template.altars, ...(template.spring === null ? [] : [template.spring])]
    for (const mirrorX of [false, true]) {
      for (const mirrorZ of [false, true]) {
        for (const spot of spots) {
          const at = { x: mirrorX ? -spot.x : spot.x, z: mirrorZ ? -spot.z : spot.z }
          for (const side of sides) {
            const arrival = onSide(side, doorLine(template, side) - DOOR.arrival)
            expect(Math.hypot(at.x - arrival.x, at.z - arrival.z)).toBeGreaterThanOrEqual(DOOR.lane)
          }
        }
      }
    }
  })

  test("a locked door is a wall, a closed side is a wall, an open door lets the player through", () => {
    for (const id of ["courtyard.yard", "spiral.ring", "void.islet"] as const) {
      const template = templateOf(id)
      const from = onSide("north", doorLine(template, "north") - DOOR.arrival)
      const to = onSide("north", doorLine(template, "north") + DOOR.trigger + 0.1)
      const through = (exits: ReadonlyArray<Side>, sealed: boolean) => {
        const terrain = buildTerrain(roomLayout({ template: id, mirrorX: false, mirrorZ: false, exits, sealed, broken: [] }))
        const moved = Collide2.moveCircle({ x: from.x, y: from.z }, { x: to.x - from.x, y: to.z - from.z }, Tuning.PLAYER.radius, terrain.bounded)
        return moved.position.y < -doorLine(template, "north")
      }
      expect(through(["north"], false)).toBe(true)
      expect(through(["north"], true)).toBe(false)
      expect(through(["south"], false)).toBe(false)
    }
  })
})
