import { Ops } from "@typeonce/ritmo"
import { Box2, Collide2, Segment2 } from "@typeonce/ritmo-math"
import type { Vec2 } from "@typeonce/ritmo-math"

import { within } from "./geometry.ts"
import type { Side } from "./rooms.ts"

/** A box prop: centre on the ground, half extents, and height. */
export interface Block {
  readonly x: number
  readonly z: number
  readonly halfWidth: number
  readonly halfDepth: number
  readonly height: number
}

/** A round pillar: centre on the ground, radius, and height. */
export interface Pillar {
  readonly x: number
  readonly z: number
  readonly radius: number
  readonly height: number
}

/** One floating slab of The Void's floor: a rectangle on the half-unit grid, and the wave after which it falls (never when null). */
export interface Slab {
  readonly x: number
  readonly z: number
  readonly halfWidth: number
  readonly halfDepth: number
  readonly fallsAfter: number | null
}

/** A slab from its corners, falling after wave `fallsAfter` (never when null). */
export const slab = (x0: number, x1: number, z0: number, z1: number, fallsAfter: number | null = null): Slab =>
  ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, halfWidth: (x1 - x0) / 2, halfDepth: (z1 - z0) / 2, fallsAfter })

export interface Point {
  readonly x: number
  readonly z: number
}

/** The walkable floor: the whole bounding box, a disc, or slabs over nothing. */
export type FloorShape =
  | { readonly kind: "rect" }
  | { readonly kind: "round"; readonly radius: number }
  | { readonly kind: "slabs"; readonly slabs: ReadonlyArray<Slab> }

/**
 * A doorway at the centre of one edge of the floor's bounding box: `open` (a gap with a recess behind it, or a Void
 * landing), `locked` (its seal is a wall to bodies and orbs), or `closed` (no room behind it: a closed recess, a wall).
 */
export interface LayoutDoor {
  readonly side: Side
  readonly state: "open" | "locked" | "closed"
}

/** A room's or stage's ground plan. Collisions and visuals both read it. */
export interface ArenaLayout {
  readonly name: string
  /** The floor's bounding box: x in [-halfWidth, halfWidth], z in [-halfDepth, halfDepth]. */
  readonly halfWidth: number
  readonly halfDepth: number
  /** Thickness of the boundary wall around the floor; 0 when it has none. */
  readonly wall: number
  readonly wallHeight: number
  readonly tile: number
  readonly blocks: ReadonlyArray<Block>
  readonly pillars: ReadonlyArray<Pillar>
  /** Scenery beyond the floor: never collided with. */
  readonly backdrop: ReadonlyArray<Block>
  /** A Void room's landings are slabs here too. */
  readonly floor: FloorShape
  /** Where the player starts, facing up the screen. */
  readonly start: Point
  /** Where enemies appear, each clear of every prop for the largest enemy. */
  readonly spawnPoints: ReadonlyArray<Point>
  /** A landmark beyond the floor (The Void's column of light), or null. */
  readonly beacon: Point | null
  /** A room's four doorways; the classic stages have none. */
  readonly doors: ReadonlyArray<LayoutDoor>
}

/** What bodies move on: the walls, the floor's open edges, and where the floor is. */
export interface Terrain {
  /** The boundary, blocks, pillars and locked seals: they stop every body and every orb. */
  readonly solid: Collide2.Walls
  /** `solid` plus the floor's open edges, which stop the player and enemies walking under their own power. */
  readonly bounded: Collide2.Walls
  readonly onFloor: (x: number, z: number) => boolean
  /** Whether (x, z) lies inside a pillar: `solid` holds one only as its outline. */
  readonly inPillar: (x: number, z: number) => boolean
  /** The box the floor lies within, doorway recesses and landings included. */
  readonly bounds: Box2.Box2
}

/** Ground x/z as the 2D vector the collision helpers read. */
export const ground = (x: number, z: number): Vec2.Vec2 => ({ x, y: z })

/** A doorway's opening and how deep its recess (or a Void landing) reaches past the floor's edge. */
export const DOORWAY = { width: 3, recess: 2 } as const

/** Each side's outward direction (north is -z), and the direction across it. */
const outward = (side: Side): { readonly x: number; readonly z: number } =>
  side === "north" ? { x: 0, z: -1 } : side === "east" ? { x: 1, z: 0 } : side === "south" ? { x: 0, z: 1 } : { x: -1, z: 0 }

/** How far the floor's edge stands from the centre on `side`: the door line. */
export const doorLine = (layout: Pick<ArenaLayout, "halfWidth" | "halfDepth">, side: Side): number =>
  side === "north" || side === "south" ? layout.halfDepth : layout.halfWidth

/** A point's distance out along `side` and across it, in a room's coordinates. */
export const alongSide = (side: Side, x: number, z: number): { readonly along: number; readonly across: number } => {
  const dir = outward(side)
  return { along: x * dir.x + z * dir.z, across: x * -dir.z + z * dir.x }
}

/** The point `along` out from the centre on `side`, `across` to its right. */
export const onSide = (side: Side, along: number, across = 0): Point => {
  const dir = outward(side)
  return { x: dir.x * along - dir.z * across, z: dir.z * along + dir.x * across }
}

/** The landing a Void doorway stands on: a slab the opening's width, reaching `recess` out past the edge. */
export const landingOf = (layout: Pick<ArenaLayout, "halfWidth" | "halfDepth">, side: Side): Slab => {
  const line = doorLine(layout, side)
  const centre = onSide(side, line + DOORWAY.recess / 2)
  const wide = side === "north" || side === "south"
  return {
    x: centre.x,
    z: centre.z,
    halfWidth: wide ? DOORWAY.width / 2 : DOORWAY.recess / 2,
    halfDepth: wide ? DOORWAY.recess / 2 : DOORWAY.width / 2,
    fallsAfter: null
  }
}

const PILLAR_SIDES = 12
const RING_SIDES = 64

/** Corners of an arc of `radius` from `from` to `to` radians, pushed out so its segments never cut inside the circle. */
const arcSegments = (x: number, z: number, radius: number, from: number, to: number): ReadonlyArray<Segment2.Segment2> => {
  const pieces = Math.max(1, Math.ceil(((to - from) / (Math.PI * 2)) * RING_SIDES))
  const half = (to - from) / pieces / 2
  const outer = radius / Ops.cos(half)
  const corners = Array.from({ length: pieces + 1 }, (_, index) => {
    const angle = from + (index / pieces) * (to - from)
    const reach = index === 0 || index === pieces ? radius : outer
    return { x: x + Ops.cos(angle) * reach, y: z + Ops.sin(angle) * reach }
  })
  return corners.slice(1).map((corner, index) => Segment2.between(corners[index] ?? corner, corner))
}

/** A circle as a ring of segments, pushed out so the ring never cuts inside it. */
const ring = (x: number, z: number, radius: number, sides: number): ReadonlyArray<Segment2.Segment2> => {
  const outer = radius / Ops.cos(Math.PI / sides)
  const corners = Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * Math.PI * 2
    return { x: x + Ops.cos(angle) * outer, y: z + Ops.sin(angle) * outer }
  })
  return corners.map((corner, index) => Segment2.between(corner, corners[(index + 1) % sides] ?? corner))
}

export const insideSlab = (slab: Slab, x: number, z: number): boolean =>
  Math.abs(x - slab.x) <= slab.halfWidth && Math.abs(z - slab.z) <= slab.halfDepth

/** The box round a set of slabs, or an empty box when there are none. */
const slabBounds = (slabs: ReadonlyArray<Slab>): Box2.Box2 => slabs.length === 0
  ? Box2.around(0, 0, 0, 0)
  : {
    minX: Math.min(...slabs.map((slab) => slab.x - slab.halfWidth)),
    minY: Math.min(...slabs.map((slab) => slab.z - slab.halfDepth)),
    maxX: Math.max(...slabs.map((slab) => slab.x + slab.halfWidth)),
    maxY: Math.max(...slabs.map((slab) => slab.z + slab.halfDepth))
  }

/** Cells of the grid the slab outline is traced on: a half unit, so 3-wide landings and doorways fit it. */
const CELL = 0.5

/** The outline of the slabs' union, from their cells on the half-unit grid, merged into straight runs. */
const slabEdges = (slabs: ReadonlyArray<Slab>): ReadonlyArray<Segment2.Segment2> => {
  if (slabs.length === 0) return []
  const { minX, minY, maxX, maxY } = slabBounds(slabs)
  const left = Math.floor(minX) - 1
  const top = Math.floor(minY) - 1
  const columns = Math.ceil((maxX + 1 - left) / CELL)
  const rows = Math.ceil((maxY + 1 - top) / CELL)
  const floor = (column: number, row: number) =>
    column >= 0 && row >= 0 && column < columns && row < rows &&
    slabs.some((slab) => insideSlab(slab, left + (column + 0.5) * CELL, top + (row + 0.5) * CELL))
  const edges: Array<Segment2.Segment2> = []
  const runs = (lines: number, length: number, edge: (line: number, at: number) => boolean, segment: (line: number, from: number, to: number) => Segment2.Segment2) => {
    for (let line = 0; line <= lines; line++) {
      let start: number | null = null
      for (let at = 0; at <= length; at++) {
        const open = at < length && edge(line, at)
        if (open && start === null) start = at
        if (!open && start !== null) {
          edges.push(segment(line, start, at))
          start = null
        }
      }
    }
  }
  runs(rows, columns, (row, column) => floor(column, row - 1) !== floor(column, row),
    (row, from, to) => Segment2.between({ x: left + from * CELL, y: top + row * CELL }, { x: left + to * CELL, y: top + row * CELL }))
  runs(columns, rows, (column, row) => floor(column - 1, row) !== floor(column, row),
    (column, from, to) => Segment2.between({ x: left + column * CELL, y: top + from * CELL }, { x: left + column * CELL, y: top + to * CELL }))
  return edges
}

/** The walls round a rectangular floor, broken by a gap at each open doorway (the wall's depth is its recess). */
const rectBoundary = (layout: ArenaLayout, open: ReadonlySet<Side>): ReadonlyArray<Box2.Box2> => {
  const { halfWidth: hw, halfDepth: hd, wall } = layout
  const gap = DOORWAY.width / 2
  const horizontal = (z: number, side: Side) => open.has(side)
    ? [{ minX: -hw - wall, minY: z - wall / 2, maxX: -gap, maxY: z + wall / 2 }, { minX: gap, minY: z - wall / 2, maxX: hw + wall, maxY: z + wall / 2 }]
    : [Box2.around(0, z, hw + wall, wall / 2)]
  const vertical = (x: number, side: Side) => open.has(side)
    ? [{ minX: x - wall / 2, minY: -hd - wall, maxX: x + wall / 2, maxY: -gap }, { minX: x - wall / 2, minY: gap, maxX: x + wall / 2, maxY: hd + wall }]
    : [Box2.around(x, 0, wall / 2, hd + wall)]
  return [
    ...horizontal(-hd - wall / 2, "north"),
    ...horizontal(hd + wall / 2, "south"),
    ...vertical(-hw - wall / 2, "west"),
    ...vertical(hw + wall / 2, "east")
  ]
}

const angleOfSide = (side: Side): number => {
  const dir = outward(side)
  return Ops.atan2(dir.z, dir.x)
}

/** A round floor's ring wall, cut at each open doorway, with the cut's sides running out into its recess. */
const roundBoundary = (radius: number, open: ReadonlyArray<Side>): ReadonlyArray<Segment2.Segment2> => {
  if (open.length === 0) return ring(0, 0, radius, RING_SIDES)
  const gap = DOORWAY.width / 2
  const half = Ops.asin(gap / radius)
  const cuts = open.map(angleOfSide).map((angle) => (angle + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b)
  const arcs = cuts.flatMap((cut, index) => {
    const next = index + 1 < cuts.length ? (cuts[index + 1] ?? cut) : (cuts[0] ?? cut) + Math.PI * 2
    return arcSegments(0, 0, radius, cut + half, next - half)
  })
  const inner = Math.sqrt(radius * radius - gap * gap)
  const recesses = open.flatMap((side) => [-gap, gap].map((across) => {
    const from = onSide(side, inner, across)
    const to = onSide(side, radius + DOORWAY.recess, across)
    return Segment2.between({ x: from.x, y: from.z }, { x: to.x, y: to.z })
  }))
  return [...arcs, ...recesses]
}

/** A locked doorway's seal: a wall across the opening at the door line. */
const sealOf = (layout: ArenaLayout, side: Side): Segment2.Segment2 => {
  const line = doorLine(layout, side)
  const a = onSide(side, line, -DOORWAY.width / 2)
  const b = onSide(side, line, DOORWAY.width / 2)
  return Segment2.between({ x: a.x, y: a.z }, { x: b.x, y: b.z })
}

/** Whether (x, z) stands in an open doorway's recess, past the floor's edge. */
const inRecess = (layout: ArenaLayout, open: ReadonlyArray<Side>, x: number, z: number): boolean =>
  open.some((side) => {
    const { along, across } = alongSide(side, x, z)
    const line = doorLine(layout, side)
    return Math.abs(across) <= DOORWAY.width / 2 && along >= line - 1 && along <= line + DOORWAY.recess
  })

/**
 * The terrain of a layout. For a slab floor, `standing` says which slabs (by index) are still there; the rest have
 * fallen and their ground is gone. Open doorways are gaps in the wall with their recess behind; locked ones are walls.
 */
export const buildTerrain = (layout: ArenaLayout, standing: (index: number) => boolean = () => true): Terrain => {
  const boxes = layout.blocks.map((block) => Box2.around(block.x, block.z, block.halfWidth, block.halfDepth))
  const pillars = layout.pillars.flatMap((pillar) => ring(pillar.x, pillar.z, pillar.radius, PILLAR_SIDES))
  const inPillar = (x: number, z: number) => layout.pillars.some((pillar) => within(x, z, pillar.x, pillar.z, pillar.radius))
  const open = layout.doors.filter((door) => door.state === "open").map((door) => door.side)
  const recess = open.length > 0 ? DOORWAY.recess : 0
  const seals = layout.doors.filter((door) => door.state === "locked").map((door) => sealOf(layout, door.side))
  const floor = layout.floor
  switch (floor.kind) {
    case "rect": {
      const solid = { boxes: [...rectBoundary(layout, new Set(open)), ...boxes], segments: pillars }
      return {
        solid,
        bounded: solid,
        onFloor: (x, z) => (Math.abs(x) <= layout.halfWidth && Math.abs(z) <= layout.halfDepth) || inRecess(layout, open, x, z),
        inPillar,
        bounds: Box2.around(0, 0, layout.halfWidth + recess, layout.halfDepth + recess)
      }
    }
    case "round": {
      const solid = { boxes, segments: [...roundBoundary(floor.radius, open), ...pillars] }
      return {
        solid,
        bounded: solid,
        onFloor: (x, z) => x * x + z * z <= floor.radius * floor.radius || inRecess(layout, open, x, z),
        inPillar,
        bounds: Box2.around(0, 0, floor.radius + recess, floor.radius + recess)
      }
    }
    case "slabs": {
      const slabs = floor.slabs.filter((_, index) => standing(index))
      return {
        solid: { boxes, segments: [...pillars, ...seals] },
        bounded: { boxes, segments: [...slabEdges(slabs), ...pillars, ...seals] },
        onFloor: (x, z) => slabs.some((slab) => insideSlab(slab, x, z)),
        inPillar,
        bounds: slabBounds(slabs)
      }
    }
  }
}

/** Whether a circle at (x, z) overlaps any wall or prop. */
export const blocked = (walls: Collide2.Walls, x: number, z: number, radius: number): boolean => {
  const center = ground(x, z)
  return (walls.boxes ?? []).some((box) => Box2.overlapsCircle(box, center, radius)) ||
    (walls.segments ?? []).some((segment) => Segment2.overlapsCircle(segment, center, radius))
}

/** Moves a circle by (dx, dz), stopping at walls and sliding along them. */
export const move = (walls: Collide2.Walls, x: number, z: number, dx: number, dz: number, radius: number): { readonly x: number; readonly z: number; readonly blocked: boolean } => {
  const moved = Collide2.moveCircle(ground(x, z), ground(dx, dz), radius, walls)
  return { x: moved.position.x, z: moved.position.y, blocked: moved.blocked }
}

/** Whether a straight shot of a circle from (x, z) by (dx, dz) reaches the end without touching a wall. */
export const clearPath = (walls: Collide2.Walls, x: number, z: number, dx: number, dz: number, radius: number): boolean =>
  Collide2.sweepCircle(ground(x, z), ground(dx, dz), radius, walls) === undefined

/** Whether a whole circle stands on the floor, clear of walls and outside every pillar: a place a body may be put. */
export const standable = (terrain: Terrain, x: number, z: number, radius: number): boolean =>
  terrain.onFloor(x, z) && terrain.onFloor(x + radius, z) && terrain.onFloor(x - radius, z) &&
  terrain.onFloor(x, z + radius) && terrain.onFloor(x, z - radius) && !terrain.inPillar(x, z) && !blocked(terrain.bounded, x, z, radius)
