import { Clock } from "@typeonce/ritmo"

import { Angle } from "@typeonce/ritmo-math"

import { clearPath, move } from "./arena.ts"
import { angleOf, dirOf } from "./geometry.ts"
import { groundOf, layoutOf } from "./ground.ts"
import { Actor, Body, CurrentStage, Dart, enemyKindOf, EnemyState, Game, Hazard, Health, Moments, Projectile } from "./schema.ts"
import { PlayTime } from "./time.ts"
import { MOVE, ORB } from "./tuning.ts"
import type { EnemyKind } from "./tuning.ts"

interface Target {
  readonly kind: EnemyKind
  readonly x: number
  readonly z: number
}

/** Where a reflected orb at (x, z) flies: the nearest warden while one stands, else the nearest enemy. */
export const reflectTarget = (targets: ReadonlyArray<Target>, x: number, z: number): Target | undefined => {
  const nearest = (pool: ReadonlyArray<Target>) => pool.reduce<Target | undefined>((best, target) =>
    best === undefined || (target.x - x) ** 2 + (target.z - z) ** 2 < (best.x - x) ** 2 + (best.z - z) ** 2 ? target : best, undefined)
  return nearest(targets.filter((target) => target.kind === "warden")) ?? nearest(targets)
}

/** How far past the floor's bounding box (and its wall) an orb may fly before it is gone. */
const ORB_MARGIN = 4

/**
 * Orbs fly straight on the gameplay clock and vanish on a wall, far past the floor, or when their time runs out;
 * they fly on over The Void's edges. A reflected orb bends toward its target, so a good parry pays off.
 */
export const MoveOrbs = Game.System("Game/MoveOrbs", {
  resources: { play: Game.System.readResource(PlayTime), stage: Game.System.readResource(CurrentStage), hazard: Game.System.readResource(Hazard) },
  queries: {
    orbs: Game.Query({ selection: { body: Game.Query.write(Body), projectile: Game.Query.write(Projectile) }, with: [Actor] }),
    enemies: Game.Query({ selection: { actor: Game.Query.read(Actor), body: Game.Query.read(Body), state: Game.Query.read(EnemyState), health: Game.Query.read(Health) } })
  },
  events: { moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(Game.System.despawns(Actor))
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const stage = resources.stage.get()
  const walls = groundOf(stage, resources.hazard.get()).solid
  const layout = layoutOf(stage)
  const { data } = queries.orbs
  const enemies = queries.enemies
  const targets = enemies.each().flatMap((enemy): ReadonlyArray<Target> => {
    const kind = enemyKindOf(enemies.data.actor.get(enemy).kind)
    const tag = enemies.data.state.get(enemy)._tag
    if (kind === undefined || enemies.data.health.get(enemy).hp <= 0 || tag === "Spawning" || tag === "Blink") return []
    const body = enemies.data.body.get(enemy)
    return [{ kind, x: body.x, z: body.z }]
  })
  for (const orb of queries.orbs.each()) {
    const body = data.body.get(orb)
    const flying = data.projectile.get(orb)
    const nearest = flying.owner !== "player" ? undefined : reflectTarget(targets, body.x, body.z)
    const heading = nearest === undefined ? undefined
      : Angle.turnToward(angleOf(flying.dirX, flying.dirZ), angleOf(nearest.x - body.x, nearest.z - body.z), ORB.homing * play.dt)
    const turned = heading === undefined ? undefined : dirOf(heading)
    if (turned !== undefined) data.projectile.set(orb, { ...flying, dirX: turned.x, dirZ: turned.z })
    const projectile = data.projectile.get(orb)
    if (Clock.reached(play, projectile.expiresAt)) {
      commands.despawn(orb)
      events.moments.emit({ type: "projectileGone", id: orb.id, x: body.x, z: body.z, reason: "expired" })
      continue
    }
    const dx = projectile.dirX * projectile.speed * play.dt
    const dz = projectile.dirZ * projectile.speed * play.dt
    const free = clearPath(walls, body.x, body.z, dx, dz, ORB.radius)
    const moved = move(walls, body.x, body.z, dx, dz, ORB.radius)
    data.body.set(orb, { x: moved.x, z: moved.z, facing: body.facing })
    const margin = layout.wall + ORB_MARGIN
    const outside = Math.abs(moved.x) > layout.halfWidth + margin || Math.abs(moved.z) > layout.halfDepth + margin
    if (free && !outside) continue
    commands.despawn(orb)
    events.moments.emit({ type: "projectileGone", id: orb.id, x: moved.x, z: moved.z, reason: "wall" })
  }
})

/**
 * The player's darts fly straight on the gameplay clock, faster than orbs and never bending: a wall stops them, they
 * fly on over The Void's gaps, and they are gone at the end of their reach. Hitting enemies is Combat's.
 */
export const MoveDarts = Game.System("Game/MoveDarts", {
  resources: { play: Game.System.readResource(PlayTime), stage: Game.System.readResource(CurrentStage), hazard: Game.System.readResource(Hazard) },
  queries: { darts: Game.Query({ selection: { body: Game.Query.write(Body), dart: Game.Query.read(Dart) }, with: [Actor] }) },
  events: { moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(Game.System.despawns(Actor))
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const walls = groundOf(resources.stage.get(), resources.hazard.get()).solid
  const { data } = queries.darts
  for (const dart of queries.darts.each()) {
    const body = data.body.get(dart)
    const flying = data.dart.get(dart)
    if (Clock.reached(play, flying.expiresAt)) {
      commands.despawn(dart)
      events.moments.emit({ type: "projectileGone", id: dart.id, x: body.x, z: body.z, reason: "expired" })
      continue
    }
    const spec = MOVE[flying.move]
    const dx = flying.dirX * spec.speed * play.dt
    const dz = flying.dirZ * spec.speed * play.dt
    const free = clearPath(walls, body.x, body.z, dx, dz, spec.radius)
    const moved = move(walls, body.x, body.z, dx, dz, spec.radius)
    data.body.set(dart, { x: moved.x, z: moved.z, facing: body.facing })
    if (free) continue
    commands.despawn(dart)
    events.moments.emit({ type: "projectileGone", id: dart.id, x: moved.x, z: moved.z, reason: "wall" })
  }
})
