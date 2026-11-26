import { blocked, buildTerrain, doorLine, onSide, standable } from "../arena.ts"
import type { ArenaLayout, Block, FloorShape, Pillar, Point } from "../arena.ts"
import { within } from "../geometry.ts"
import { sides } from "../rooms.ts"
import type { StageHazard } from "../stages.ts"
import type { ZoneId } from "../zones.ts"
import { SPAWNS } from "./rules.ts"

/** What a template is for: a zone's start room, its weapon and spring rooms (the shrine), a fight of a size, or its boss. */
export type TemplateRole = "start" | "shrine" | "small" | "medium" | "large" | "boss"

/**
 * A room as authored, centred on (0, 0) before it is mirrored: its floor's bounding box (a door stands at the centre
 * of each edge), the boundary wall, props, where altars and the spring stand, and the hazard it carries.
 */
export interface RoomPlan {
  readonly zone: ZoneId
  readonly role: TemplateRole
  readonly name: string
  readonly halfWidth: number
  readonly halfDepth: number
  readonly wall: number
  readonly wallHeight: number
  readonly tile: number
  readonly floor: FloorShape
  readonly blocks: ReadonlyArray<Block>
  readonly pillars: ReadonlyArray<Pillar>
  /** A start room's three altars, or a shrine's two. */
  readonly altars: ReadonlyArray<Point>
  /** A shrine's spring, when it is a spring room. */
  readonly spring: Point | null
  /** How far from the centre the boss stands, away from the door the player came in by. */
  readonly bossOffset: number
  readonly hazard: StageHazard
  /** The hazard the boss's first shift lights in its room in place of `hazard` (the Orrery's beam). */
  readonly bossHazard?: StageHazard
}

export interface RoomTemplate extends RoomPlan {
  /** Where enemies appear, found from the plan: clear of props, away from every door. */
  readonly spawnPoints: ReadonlyArray<Point>
}

/** The plan as a layout with every doorway closed, before mirroring. */
export const planLayout = (plan: RoomPlan, spawnPoints: ReadonlyArray<Point>): ArenaLayout => ({
  name: plan.name,
  halfWidth: plan.halfWidth,
  halfDepth: plan.halfDepth,
  wall: plan.wall,
  wallHeight: plan.wallHeight,
  tile: plan.tile,
  blocks: plan.blocks,
  pillars: plan.pillars,
  backdrop: [],
  floor: plan.floor,
  start: onSide("south", plan.halfDepth - 1.6),
  spawnPoints,
  beacon: plan.floor.kind === "slabs" ? { x: 0, z: -plan.halfDepth - 8 } : null,
  doors: sides.map((side) => ({ side, state: "closed" as const }))
})

/** Every door's mouth: the centre of each edge of the floor's bounding box. */
const mouthsOf = (plan: Pick<RoomPlan, "halfWidth" | "halfDepth">): ReadonlyArray<Point> =>
  sides.map((side) => onSide(side, doorLine(plan, side)))

/**
 * Spawn points on a lattice over the floor, kept where the largest wave enemy stands clear of every prop and wall, in from
 * every edge, and at least `SPAWNS.fromDoor` from every door's mouth, then thinned to the `SPAWNS.most` that spread widest.
 */
const findSpawnPoints = (plan: RoomPlan): ReadonlyArray<Point> => {
  const terrain = buildTerrain(planLayout(plan, []))
  const mouths = mouthsOf(plan)
  const candidates: Array<Point> = []
  for (let x = -plan.halfWidth + 1; x <= plan.halfWidth - 1; x += SPAWNS.spacing / 2) {
    for (let z = -plan.halfDepth + 1; z <= plan.halfDepth - 1; z += SPAWNS.spacing / 2) {
      if (!standable(terrain, x, z, SPAWNS.edge) || blocked(terrain.solid, x, z, SPAWNS.clearance + 0.1)) continue
      if (mouths.some((mouth) => within(x, z, mouth.x, mouth.z, SPAWNS.fromDoor))) continue
      if ([...plan.altars, ...(plan.spring === null ? [] : [plan.spring])].some((spot) => within(x, z, spot.x, spot.z, 2))) continue
      candidates.push({ x, z })
    }
  }
  const distance = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2
  const first = candidates.reduce<Point | undefined>((best, point) => best === undefined || distance(point, { x: 0, z: 0 }) > distance(best, { x: 0, z: 0 }) ? point : best, undefined)
  if (first === undefined) return []
  const chosen: Array<Point> = [first]
  while (chosen.length < Math.min(SPAWNS.most, candidates.length)) {
    const gap = (point: Point) => Math.min(...chosen.map((other) => distance(point, other)))
    const next = candidates.reduce((best, point) => gap(point) > gap(best) ? point : best, first)
    if (gap(next) <= SPAWNS.spacing ** 2 * 0.9) break
    chosen.push(next)
  }
  return chosen
}

/** A template from its plan, with its spawn points found. */
export const room = (plan: RoomPlan): RoomTemplate => ({ ...plan, spawnPoints: findSpawnPoints(plan) })
