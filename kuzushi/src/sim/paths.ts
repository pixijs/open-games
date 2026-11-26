import { Box2, Segment2 } from "@typeonce/ritmo-math"
import type { Vec2 } from "@typeonce/ritmo-math"
import {
  addHeightfieldSpan,
  addTile,
  BuildContext,
  buildCompactHeightfield,
  buildContours,
  buildDistanceField,
  buildPolyMesh,
  buildRegions,
  buildTile,
  ContourBuildFlags,
  createFindNearestPolyResult,
  createHeightfield,
  createNavMesh,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  findNodePath,
  findPath,
  findStraightPath,
  polyMeshToTilePolys,
  polysToTileDetailMesh,
  WALKABLE_AREA
} from "navcat"
import type { Box3, NavMesh, Vec3 } from "navcat"

import { clearPath, ground } from "./arena.ts"
import type { Point, Terrain } from "./arena.ts"
import { SUMMONS } from "./bosses/rules.ts"
import { fights } from "./dungeon/enter.ts"
import { roomLayout, roomTerrain } from "./dungeon/layout.ts"
import { Dungeon, Transition } from "./dungeon/schema.ts"
import type { RoomGround, ZoneDungeon } from "./dungeon/schema.ts"
import { normalize, within } from "./geometry.ts"
import type { Dir } from "./geometry.ts"
import { groundsAheadOf } from "./ground.ts"
import { sides } from "./rooms.ts"
import { Actor, CurrentStage, Elite, enemyKindOf, Game, Hazard, Health } from "./schema.ts"
import { slabGroupsOf } from "./stages.ts"
import { ENEMY, radiusOf } from "./tuning.ts"
import type { EnemyKind } from "./tuning.ts"
import { zoneOf } from "./zones.ts"

/**
 * How bodies find their way round the floor's walls, props and edges: a navcat navigation mesh of the terrain for the
 * radius a body keeps clear, built from the same walls it collides with, so any floor a layout makes (props, broken
 * pillars, seals, fallen slabs) gets its mesh with no authoring. Meshes are derived from the terrain alone and kept in
 * a small cache, never in the world: the same terrain always builds the same mesh.
 */

/** The grid the floor is sampled on, in units: finer costs more to build (0.2 doubles it) for little better a path. */
const CELL = 0.25
/** The floor is flat at y = 0: one layer of spans, each this tall. */
const LAYER = 0.2
/** Smallest island the mesh keeps, and the size under which a region merges into its neighbour, in cells. */
const MIN_REGION = 8
const MERGE_REGION = 20
/**
 * How far a traced edge may stray from the cells it outlines, and the longest edge, in cells; vertices per polygon. Over
 * every room, 0.8 finds every way a body fits and cuts a corner by under a quarter unit (it slides round); 1.3 is
 * cheaper but closes gaps a large body just fits.
 */
const SIMPLIFY = 0.8
const LONGEST_EDGE = 40
const VERTICES = 6
/** How much further than a body's radius to look for its mesh from a point: the player keeps closer to walls than an enemy can. */
const REACH = 0.5
/** Terrains whose meshes stay cached: a room changes its terrain a few times at most (seals, falling slabs, broken pillars). */
const KEPT = 8

/** Which way a body walks to reach a point. */
export interface Route {
  /** No wall or prop stands between it and the point: a lunge, a shot or a leap gets there. Edges don't block it. */
  readonly sight: boolean
  /** Unit vector to walk: at the point when nothing (edges included) stands between, else at the next corner of the shortest way round. */
  readonly way: Dir
}

const segmentBox = (segment: Segment2.Segment2): Box2.Box2 => ({
  minX: Math.min(segment.ax, segment.bx),
  minY: Math.min(segment.ay, segment.by),
  maxX: Math.max(segment.ax, segment.bx),
  maxY: Math.max(segment.ay, segment.by)
})

/** Which cells of a grid over the floor's bounds a body of `radius` may stand at the centre of: floor, outside pillars, clear of every wall and edge. */
const openCells = (terrain: Terrain, radius: number, columns: number, rows: number): Uint8Array => {
  const { minX, minY } = terrain.bounds
  const centre = (column: number, row: number): Vec2.Vec2 => ground(minX + (column + 0.5) * CELL, minY + (row + 0.5) * CELL)
  const open = new Uint8Array(columns * rows)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const { x, y } = centre(column, row)
      if (terrain.onFloor(x, y) && !terrain.inPillar(x, y)) open[row * columns + column] = 1
    }
  }
  const close = (box: Box2.Box2, touches: (point: Vec2.Vec2) => boolean) => {
    const fromColumn = Math.max(0, Math.floor((box.minX - radius - minX) / CELL))
    const toColumn = Math.min(columns - 1, Math.floor((box.maxX + radius - minX) / CELL))
    const fromRow = Math.max(0, Math.floor((box.minY - radius - minY) / CELL))
    const toRow = Math.min(rows - 1, Math.floor((box.maxY + radius - minY) / CELL))
    for (let row = fromRow; row <= toRow; row++) {
      for (let column = fromColumn; column <= toColumn; column++) {
        const index = row * columns + column
        if (open[index] === 1 && touches(centre(column, row))) open[index] = 0
      }
    }
  }
  for (const box of terrain.bounded.boxes ?? []) close(box, (point) => Box2.overlapsCircle(box, point, radius))
  for (const segment of terrain.bounded.segments ?? []) close(segmentBox(segment), (point) => Segment2.overlapsCircle(segment, point, radius))
  return open
}

/** The mesh of where a body of `radius` may walk on `terrain`, or null when it fits nowhere. */
const build = (terrain: Terrain, radius: number): NavMesh | null => {
  const { minX, minY, maxX, maxY } = terrain.bounds
  const columns = Math.ceil((maxX - minX) / CELL)
  const rows = Math.ceil((maxY - minY) / CELL)
  if (columns <= 0 || rows <= 0) return null
  const open = openCells(terrain, radius, columns, rows)
  const bounds: Box3 = [minX, -LAYER, minY, minX + columns * CELL, LAYER, minY + rows * CELL]
  const heightfield = createHeightfield(columns, rows, bounds, CELL, LAYER)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (open[row * columns + column] === 1) addHeightfieldSpan(heightfield, column, row, 0, 1, WALKABLE_AREA, 1)
    }
  }
  const context = BuildContext.create()
  const field = buildCompactHeightfield(context, 1, 1, heightfield)
  buildDistanceField(field)
  buildRegions(context, field, 0, MIN_REGION, MERGE_REGION)
  const contours = buildContours(context, field, SIMPLIFY, LONGEST_EDGE, ContourBuildFlags.CONTOUR_TESS_WALL_EDGES)
  const polygons = buildPolyMesh(context, contours, VERTICES)
  if (polygons.nPolys === 0) return null
  for (let index = 0; index < polygons.nPolys; index++) {
    polygons.areas[index] = 0
    polygons.flags[index] = 1
  }
  const tile = polyMeshToTilePolys(polygons)
  const detail = polysToTileDetailMesh(tile.polys)
  const mesh = createNavMesh()
  mesh.origin = [polygons.bounds[0], polygons.bounds[1], polygons.bounds[2]]
  mesh.tileWidth = polygons.bounds[3] - polygons.bounds[0]
  mesh.tileHeight = polygons.bounds[5] - polygons.bounds[2]
  addTile(mesh, buildTile({
    bounds: polygons.bounds,
    vertices: tile.vertices,
    polys: tile.polys,
    detailMeshes: detail.detailMeshes,
    detailVertices: detail.detailVertices,
    detailTriangles: detail.detailTriangles,
    tileX: 0,
    tileY: 0,
    tileLayer: 0,
    cellSize: CELL,
    cellHeight: LAYER,
    walkableHeight: LAYER,
    walkableRadius: radius,
    walkableClimb: LAYER
  }))
  return mesh
}

/** Meshes by terrain, then by the radius they keep clear; the terrain first used longest ago goes past `KEPT`. */
const MESHES = new Map<Terrain, Map<number, NavMesh | null>>()
let builds = 0

/** How many meshes have been built since the game loaded. */
export const meshesBuilt = (): number => builds

const meshesOf = (terrain: Terrain): Map<number, NavMesh | null> => {
  const known = MESHES.get(terrain)
  if (known !== undefined) return known
  const byRadius = new Map<number, NavMesh | null>()
  MESHES.set(terrain, byRadius)
  const oldest = MESHES.keys().next()
  if (MESHES.size > KEPT && oldest.done !== true) MESHES.delete(oldest.value)
  return byRadius
}

/** The mesh a body of `radius` walks on `terrain`: built on first use (a few milliseconds), then only read. */
export const meshOf = (terrain: Terrain, radius: number): NavMesh | null => {
  const byRadius = meshesOf(terrain)
  const known = byRadius.get(radius)
  if (known !== undefined) return known
  const mesh = build(terrain, radius)
  builds += 1
  byRadius.set(radius, mesh)
  return mesh
}

/** Builds the first mesh `terrains` need for `radii` that isn't built yet, the earlier terrains first. */
const buildNext = (terrains: ReadonlyArray<Terrain>, radii: ReadonlyArray<number>): void => {
  for (const terrain of terrains) {
    const radius = radii.find((each) => MESHES.get(terrain)?.has(each) !== true)
    if (radius !== undefined) {
      meshOf(terrain, radius)
      return
    }
  }
}

/** What a room's fight walks on: the floors, sealed as they will be once its doors lock, and the radius of every body that walks them. */
export interface Fight {
  readonly floors: ReadonlyArray<Terrain>
  readonly radii: ReadonlyArray<number>
}

/**
 * The fight still to come in `dungeon`'s `room`: on its floor with its slabs standing as they were left, then after
 * each group falls; for its waves' kinds, or its boss and what its shifts summon, splitters bringing splitlings.
 * Nothing once it is won.
 */
export const fightOf = (dungeon: ZoneDungeon, room: RoomGround): Fight => {
  const record = dungeon.rooms[room.index]
  if (record === undefined || !fights(record)) return { floors: [], radii: [] }
  const sealed = { ...room, sealed: true }
  const stages = Math.max(1, slabGroupsOf(roomLayout(sealed)).length - record.fallen + 1)
  const boss = zoneOf(dungeon.zone).boss
  const slots: ReadonlyArray<{ readonly kind: EnemyKind; readonly elite: boolean }> = record.kind === "boss"
    ? [boss, ...SUMMONS[boss].flat()].map((kind) => ({ kind, elite: false }))
    : record.waves.flat()
  const split = slots.some(({ kind }) => kind === "splitter") ? [{ kind: "splitling", elite: false } as const] : []
  return {
    floors: Array.from({ length: stages }, (_, index) => roomTerrain(sealed, record.fallen + index)),
    radii: [...new Set([...slots, ...split].filter(({ kind }) => ENEMY[kind].speed > 0).map(({ kind, elite }) => radiusOf(kind, elite)))]
  }
}

/**
 * Builds one mesh a step at most that a walking body will need, ahead of its first route, so the cost lands where it
 * isn't seen. Under a door's or the zone change's full ink, once the room has swapped: every mesh of the fight in the
 * room arrived in. In play, any still missing for the bodies walking (a broken pillar's floor, the sandbox's spawns):
 * on the floor now and, while slabs crack, the floor once they fall. Routes come out the same either way.
 */
export const PreparePaths = Game.System("Game/PreparePaths", {
  resources: {
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard),
    dungeon: Game.System.readResource(Dungeon),
    transition: Game.System.readResource(Transition)
  },
  queries: {
    walkers: Game.Query({ selection: { actor: Game.Query.read(Actor), health: Game.Query.read(Health), elite: Game.Query.optional(Elite) } })
  }
}, ({ resources, queries }) => {
  const stage = resources.stage.get()
  const transition = resources.transition.get()
  if (transition._tag !== "None") {
    const dungeon = resources.dungeon.get()
    if ((transition.beat === "hold" || transition.beat === "card") && dungeon._tag === "Zone" && stage.room !== null) {
      const fight = fightOf(dungeon, stage.room)
      buildNext(fight.floors, fight.radii)
    }
    return
  }
  const { data } = queries.walkers
  const radii = queries.walkers.each().flatMap((walker) => {
    const kind = enemyKindOf(data.actor.get(walker).kind)
    return kind === undefined || ENEMY[kind].speed <= 0 || data.health.get(walker).hp <= 0 ? [] : [radiusOf(kind, data.elite.get(walker) !== undefined)]
  })
  buildNext(groundsAheadOf(stage, resources.hazard.get()), radii)
})

/** Where a point stands on a body's mesh: its polygon and the nearest point of it. */
type Spot = ReturnType<typeof createFindNearestPolyResult>

/** How far from a point to look for a body's mesh: a little past its radius, which is as far as the floor's walls keep it off. */
const extentsOf = (radius: number): Vec3 => [radius + REACH, LAYER, radius + REACH]

const spotOf = (mesh: NavMesh, point: Point, radius: number): Spot | null => {
  const spot = findNearestPoly(createFindNearestPolyResult(), mesh, [point.x, 0, point.z], extentsOf(radius), DEFAULT_QUERY_FILTER)
  return spot.success ? spot : null
}

/** The first corner of the shortest walk on `mesh` between two spots, after where it starts, that a body at `from` isn't already on. */
const nextCorner = (mesh: NavMesh, start: Spot, end: Spot, from: Point): Point | undefined => {
  const nodes = findNodePath(mesh, start.nodeRef, end.nodeRef, start.position, end.position, DEFAULT_QUERY_FILTER)
  if (!nodes.success) return undefined
  const corner = findStraightPath(mesh, start.position, end.position, nodes.path, 3).path
    .slice(1)
    .find(({ position }) => !within(position[0], position[2], from.x, from.z, 0.01))
  return corner === undefined ? undefined : { x: corner.position[0], z: corner.position[2] }
}

/**
 * The corners of the shortest walk a body of `radius` takes on `terrain` from `from` to `to`, after where it starts:
 * the last is `to`, or the nearest the floor lets it get. Empty when either point is nowhere near the floor.
 */
export const cornersOf = (terrain: Terrain, radius: number, from: Point, to: Point): ReadonlyArray<Point> => {
  const mesh = meshOf(terrain, radius)
  if (mesh === null) return []
  const walk = findPath(mesh, [from.x, 0, from.z], [to.x, 0, to.z], extentsOf(radius), DEFAULT_QUERY_FILTER)
  return walk.path.slice(1).map(({ position }) => ({ x: position[0], z: position[2] }))
}

/**
 * The ways to `to` on `terrain` this step, for bodies of any radius: where `to` stands on each one's mesh is found once.
 * A body at `from` walks straight at `to` when nothing stands between, else toward the next corner of the shortest way
 * round the walls, props and edges; straight at it (`fallback` when they meet) when the floor has no way there.
 */
export const routesTo = (terrain: Terrain, to: Point): ((from: Point, radius: number, fallback: Dir) => Route) => {
  const ends = new Map<number, Spot | null>()
  return (from, radius, fallback) => {
    const dx = to.x - from.x
    const dz = to.z - from.z
    const straight = normalize(dx, dz, fallback)
    if (clearPath(terrain.bounded, from.x, from.z, dx, dz, radius)) return { sight: true, way: straight }
    // `bounded` is `solid` with the floor's edges: on a floor with none they're the same walls, and this one just hit.
    const sight = terrain.bounded !== terrain.solid && clearPath(terrain.solid, from.x, from.z, dx, dz, radius)
    const mesh = meshOf(terrain, radius)
    if (mesh === null) return { sight, way: straight }
    let end = ends.get(radius)
    if (end === undefined) {
      end = spotOf(mesh, to, radius)
      ends.set(radius, end)
    }
    const start = spotOf(mesh, from, radius)
    const corner = start === null || end === null ? undefined : nextCorner(mesh, start, end, from)
    return { sight, way: corner === undefined ? straight : normalize(corner.x - from.x, corner.z - from.z, straight) }
  }
}

/**
 * Builds and drops a few meshes of a small room. The engine compiles the builder over its first builds, which run
 * several times slower than the rest; the host calls this while the game loads, so the first fight's builds run compiled.
 */
export const warmPaths = (): void => {
  const gnomon = roomTerrain({ template: "spiral.gnomon", mirrorX: false, mirrorZ: false, exits: sides, sealed: true, broken: [] }, 0)
  for (const radius of [0.3, 0.45, 0.6, 0.75]) build(gnomon, radius)
}
