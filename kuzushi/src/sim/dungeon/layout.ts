import { alongSide, buildTerrain, doorLine, landingOf, onSide } from "../arena.ts"
import type { ArenaLayout, FloorShape, Point, Terrain } from "../arena.ts"
import { angleOf } from "../geometry.ts"
import { opposite, sides } from "../rooms.ts"
import type { Side } from "../rooms.ts"
import { fallenSlabs } from "../stages.ts"
import { planLayout } from "./plan.ts"
import type { RoomTemplate } from "./plan.ts"
import { DOOR } from "./rules.ts"
import type { RoomGround } from "./schema.ts"
import { templateOf } from "./templates.ts"

/** A room's template as placed: mirrored left to right (x) and top to bottom (z). */
export type Placed = Pick<RoomGround, "template" | "mirrorX" | "mirrorZ">

export const mirror = (placed: Pick<Placed, "mirrorX" | "mirrorZ">, point: Point): Point =>
  ({ x: placed.mirrorX ? -point.x : point.x, z: placed.mirrorZ ? -point.z : point.z })

const mirrored = <T extends Point>(placed: Placed, thing: T): T => ({ ...thing, ...mirror(placed, thing) })

const floorOf = (template: RoomTemplate, placed: Placed, exits: ReadonlyArray<Side>): FloorShape => {
  const floor = template.floor
  if (floor.kind !== "slabs") return floor
  return { kind: "slabs", slabs: [...floor.slabs.map((slab) => mirrored(placed, slab)), ...exits.map((side) => landingOf(template, side))] }
}

/** What a room's layout is made from: everything on its ground but its index, gate and boss hazard. */
type Shape = Omit<RoomGround, "index" | "gate" | "lit">

const keyOf = (ground: Shape) =>
  `${ground.template}|${ground.mirrorX ? 1 : 0}${ground.mirrorZ ? 1 : 0}|${[...ground.exits].sort().join(",")}|${ground.sealed ? 1 : 0}|${ground.broken.join(",")}`

/** Layouts already placed, by template, mirroring, exits and seals: each is made once and only read after. */
const LAYOUTS = new Map<string, ArenaLayout>()

/**
 * A room's ground plan in its own coordinates: its template mirrored, a Void landing at each door, each doorway open,
 * locked (sealed) or closed (no room behind it), and the pillars its boss broke gone.
 */
export const roomLayout = (ground: Shape): ArenaLayout => {
  const key = keyOf(ground)
  const known = LAYOUTS.get(key)
  if (known !== undefined) return known
  const template = templateOf(ground.template)
  const base = planLayout(template, template.spawnPoints)
  const layout: ArenaLayout = {
    ...base,
    blocks: base.blocks.map((block) => mirrored(ground, block)),
    pillars: base.pillars.flatMap((pillar, index) => (ground.broken.includes(index) ? [] : [mirrored(ground, pillar)])),
    floor: floorOf(template, ground, ground.exits),
    spawnPoints: base.spawnPoints.map((point) => mirror(ground, point)),
    doors: sides.map((side) => ({ side, state: !ground.exits.includes(side) ? "closed" : ground.sealed ? "locked" : "open" }))
  }
  LAYOUTS.set(key, layout)
  return layout
}

const TERRAINS = new Map<string, Terrain>()

/** The terrain of a room once `fallen` of its slab groups have fallen. */
export const roomTerrain = (ground: Shape, fallen: number): Terrain => {
  const key = `${keyOf(ground)}|${fallen}`
  const known = TERRAINS.get(key)
  if (known !== undefined) return known
  const layout = roomLayout(ground)
  const gone = fallenSlabs(layout, fallen)
  const terrain = buildTerrain(layout, (index) => !gone.has(index))
  TERRAINS.set(key, terrain)
  return terrain
}

/** Where the hero stands arriving through `side`: `DOOR.arrival` inside its door line, facing into the room. */
export const arrivalOf = (placed: Placed, side: Side): { readonly x: number; readonly z: number; readonly facing: number } => {
  const template = templateOf(placed.template)
  const spot = onSide(side, doorLine(template, side) - DOOR.arrival)
  const inward = onSide(opposite[side], 1)
  return { ...spot, facing: angleOf(inward.x, inward.z) }
}

/** The open door the player has walked `DOOR.trigger` past the floor's edge into, if any. */
export const doorTaken = (ground: RoomGround, x: number, z: number): Side | undefined => {
  if (ground.sealed) return undefined
  const template = templateOf(ground.template)
  return ground.exits.find((side) => {
    const { along, across } = alongSide(side, x, z)
    return Math.abs(across) <= DOOR.width / 2 && along >= doorLine(template, side) + DOOR.trigger
  })
}

/** Whether a body of `radius` at (x, z) stands wholly inside the room: `DOOR.inside` plus its radius in from every door line. */
export const wellInside = (ground: RoomGround, x: number, z: number, radius: number): boolean => {
  const template = templateOf(ground.template)
  return ground.exits.every((side) => alongSide(side, x, z).along <= doorLine(template, side) - radius - DOOR.inside)
}

/** The room's altars where they stand once mirrored. */
export const altarSpots = (placed: Placed): ReadonlyArray<Point> => templateOf(placed.template).altars.map((altar) => mirror(placed, altar))

/** Where a boss stands as its room seals: `bossOffset` from the centre, away from the door the player came in by. */
export const bossSpot = (placed: Placed, entry: Side | null): Point => {
  const offset = templateOf(placed.template).bossOffset
  return onSide(entry === null ? "north" : opposite[entry], offset)
}
