import { Clock } from "@typeonce/ritmo"
import type { Random } from "@typeonce/ritmo"

import type { ArenaLayout, Point, Terrain } from "./arena.ts"
import { within } from "./geometry.ts"
import type { DrillMode } from "./moments.ts"
import { Actor, Body, Drill, EnemyState, Game, Health, HitMark, Motion, PlayerState, PrevBody, Vitals } from "./schema.ts"
import { ENEMY, SPAWN } from "./tuning.ts"
import type { EnemyKind } from "./tuning.ts"

/** Facing up the screen (-z): where the player looks when a run starts. */
export const NORTH = -Math.PI / 2

export const playerDraft = (start: Point) => {
  const body = { x: start.x, z: start.z, facing: NORTH }
  return Game.Command.spawn(
    [Actor, { kind: "player" }],
    [Body, body],
    [PrevBody, body],
    [Motion, { vx: 0, vz: 0 }],
    [PlayerState, { _tag: "Free" }],
    [Vitals, { invulnerableUntil: null, dashReadyAt: null, parryReadyAt: null, comboNext: 1, comboUntil: null }]
  )
}

export const enemyDraft = (kind: EnemyKind, at: Point, facing: number, play: Clock.Time<60>) => {
  const body = { x: at.x, z: at.z, facing }
  const { hp } = ENEMY[kind]
  return Game.Command.spawn(
    [Actor, { kind }],
    [Body, body],
    [PrevBody, body],
    [Motion, { vx: 0, vz: 0 }],
    [Health, { hp, max: hp }],
    [HitMark, { swing: -1 }],
    [EnemyState, { _tag: "Spawning", readyAt: Clock.deadline(play, SPAWN.time) }]
  )
}

/** A training enemy from the debug hooks: an enemy that stands where it was put until ordered to attack. */
export const drillDraft = (kind: EnemyKind, at: Point, facing: number, play: Clock.Time<60>, mode: DrillMode) =>
  Game.Command.extend(enemyDraft(kind, at, facing, play), [Drill, { mode }])

/** The floor's spawn points that stand on it as it is now (none on a fallen slab). */
export const spawnPointsOf = (layout: ArenaLayout, terrain: Terrain): ReadonlyArray<Point> =>
  layout.spawnPoints.filter((point) => terrain.onFloor(point.x, point.z))

/**
 * A spawn point away from the player and from enemies already standing there, picked at random among the good ones;
 * the farthest from the player when none is good.
 */
export const pickSpawnPoint = (random: Random.Random, points: ReadonlyArray<Point>, player: Point | undefined, taken: ReadonlyArray<Point>): Point => {
  const fromPlayer = (point: Point) => player === undefined ? Number.MAX_VALUE : (point.x - player.x) ** 2 + (point.z - player.z) ** 2
  const free = points.filter((point) => !taken.some((other) => within(point.x, point.z, other.x, other.z, 1.5)))
  const good = free.filter((point) => fromPlayer(point) >= SPAWN.minDistanceFromPlayer ** 2)
  const picked = random.pick(good)
  if (picked !== undefined) return picked
  const pool = free.length > 0 ? free : points
  return pool.reduce((best, point) => fromPlayer(point) > fromPlayer(best) ? point : best, pool[0] ?? { x: 0, z: 0 })
}
