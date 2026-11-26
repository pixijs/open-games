import { Clock, Random } from "@typeonce/ritmo"
import { Vec2 } from "@typeonce/ritmo-math"

import { move, standable } from "./arena.ts"
import type { Point, Terrain } from "./arena.ts"
import { armSweepTime, cooldownOf, firstAttackOf, gapOf, openingOf, shotDraft, strideOf, strikeOf, telegraphMoment, through } from "./foes.ts"
import type { FoeKind, Sight } from "./foes.ts"
import { angleOf, dirOf, lengthOf, normalize } from "./geometry.ts"
import type { Dir } from "./geometry.ts"
import { groundOf } from "./ground.ts"
import { routesTo } from "./paths.ts"
import { chase, clearReach, pillarsOf, sweepContact, waveContact } from "./reach.ts"
import {
  Actor,
  Body,
  CurrentStage,
  Drill,
  Elite,
  EnemyState,
  enemyKindOf,
  Game,
  Hazard,
  Health,
  Moments,
  Motion,
  Orders,
  PlayerState,
  PrevBody,
  Projectile,
  Rng,
  Seam,
  Strikes
} from "./schema.ts"
import type { TellValue } from "./schema.ts"
import { seamDraft } from "./seams.ts"
import { after, inSteps, PlayTime, secondsOf, step } from "./time.ts"
import type { Duration } from "./time.ts"
import { BRUISER, CUTTER, ELITE, ENEMY, ENEMY_BODY, isBoss, LEAPER, ORB, ORBITER, PLAYER, PULSAR, radiusOf, RING_OUT, SHOOTER, SWEEPER, TRICKSTER, WARDEN } from "./tuning.ts"

/** A windup an elite plays: the same telegraph, shorter. */
const windupFor = (windup: Duration, elite: boolean): Duration => elite ? inSteps(Clock.steps(windup) * ELITE.windup) : windup

/**
 * Every enemy's behaviour on the gameplay clock, one state machine for all kinds but the bosses; foes.ts holds what
 * each kind decides. Each attack starts with a telegraph. Enemies walk inside the floor's edges, round walls and props
 * by the floor's paths (paths.ts); a lunge or a hard knock carries them over the edges, and a leap flies over them.
 * Drills from the debug hooks stand still until ordered to attack.
 */
export const EnemyBrain = Game.System("Game/EnemyBrain", {
  resources: {
    play: Game.System.readResource(PlayTime),
    rng: Game.System.writeResource(Rng),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard)
  },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.read(Body), state: Game.Query.read(PlayerState) } }),
    enemies: Game.Query({
      selection: {
        actor: Game.Query.read(Actor),
        body: Game.Query.write(Body),
        prev: Game.Query.write(PrevBody),
        motion: Game.Query.write(Motion),
        state: Game.Query.write(EnemyState),
        health: Game.Query.read(Health),
        drill: Game.Query.optional(Drill),
        elite: Game.Query.optional(Elite)
      }
    }),
    seams: Game.Query({ selection: { seam: Game.Query.read(Seam) } })
  },
  events: { moments: Game.System.writeEvent(Moments), strikes: Game.System.writeEvent(Strikes), orders: Game.System.readEvent(Orders) },
  commands: Game.System.commands(Game.System.spawns(Actor, Body, PrevBody, Projectile, Seam), Game.System.despawns(Seam))
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const dt = play.dt
  const random = Random.draw(resources.rng)
  const current = resources.stage.get()
  const terrain = groundOf(current, resources.hazard.get())
  const pillars = pillarsOf(current)
  const orders = events.orders.all()
  const players = queries.players
  const target = players.each().map((entity) => ({ body: players.data.body.get(entity), state: players.data.state.get(entity) }))[0]
  const hunting = target !== undefined && target.state._tag !== "Down"
  const routes = hunting ? routesTo(terrain, target.body) : null
  const enemies = queries.enemies
  const { data } = enemies
  const seams = queries.seams

  for (const enemy of enemies.each()) {
    if (data.health.get(enemy).hp <= 0) continue
    const known = enemyKindOf(data.actor.get(enemy).kind)
    if (known === undefined || isBoss(known)) continue
    const kind: FoeKind = known
    const elite = data.elite.get(enemy) !== undefined
    const radius = radiusOf(kind, elite)
    const body = data.body.get(enemy)
    const state = data.state.get(enemy)
    const drill = data.drill.get(enemy)?.mode ?? null
    const toX = hunting ? target.body.x - body.x : 0
    const toZ = hunting ? target.body.z - body.z : 0
    const distance = lengthOf(toX, toZ)
    const toward = normalize(toX, toZ, dirOf(body.facing))
    const strafe = state._tag === "Move" ? state.strafe : 1
    const sight: Sight = { hunting, toward, distance, side: { x: -toward.z * strafe, z: toward.x * strafe } }
    const strike = (at: Point, reach: number, dir: Dir, melee: boolean) =>
      events.strikes.emit({ id: enemy.id, x: at.x, z: at.z, radius: reach, dirX: dir.x, dirZ: dir.z, melee })

    const telegraph = (tell: TellValue, from: Point, dir: Dir, size: number, duration: Duration, feint: boolean) =>
      events.moments.emit(telegraphMoment(enemy.id, kind, tell, from, dir, size, duration, feint))

    const moveData = (delay: Duration) => ({
      attackAt: Clock.deadline(play, delay),
      strafe: random.next() < 0.5 ? 1 as const : -1 as const,
      switchAt: Clock.deadline(play, SHOOTER.strafeSwitch)
    })

    const fire = (aim: number, orbSpeed: number) => {
      const { draft, start, dir } = shotDraft("orb", body, radius, aim, orbSpeed, ORB.damage, ORB.life, play)
      const id = commands.spawn(draft)
      events.moments.emit({ type: "projectileFired", id, x: start.x, z: start.z, dirX: dir.x, dirZ: dir.z, speed: orbSpeed })
    }

    /** Leaves Move into the kind's attack: its windup and telegraph, or the trickster's blink. */
    const open = () => {
      const opening = openingOf(kind, sight, { random, reach: (dir, max) => clearReach(terrain, body.x, body.z, dir, max) })
      if (opening.to === "blink") {
        const around = hunting ? target.body : body
        const spot = blinkSpot(random, terrain, around.x, around.z, radius) ?? { x: body.x, z: body.z }
        data.state.transition(enemy, { from: "Move", to: "Blink", data: { endAt: Clock.deadline(play, TRICKSTER.blinkTime), toX: spot.x, toZ: spot.z } })
        events.moments.emit({ type: "blink", id: enemy.id, fromX: body.x, fromZ: body.z, toX: spot.x, toZ: spot.z, duration: secondsOf(TRICKSTER.blinkTime) })
        return
      }
      const { dir, size, tell } = opening
      const windup = windupFor(opening.windup, elite)
      data.state.transition(enemy, { from: "Move", to: "Windup", data: { endAt: after(play, windup), dirX: dir.x, dirZ: dir.z, feint: false, size, steps: Math.max(1, Clock.steps(windup)), tell } })
      telegraph(tell, body, dir, size, windup, false)
    }

    let desired: Dir = { x: 0, z: 0 }
    let speed = 0
    let facing = body.facing

    switch (state._tag) {
      case "Spawning": {
        if (Clock.reached(play, state.readyAt)) data.state.transition(enemy, { from: "Spawning", to: "Move", data: moveData(firstAttackOf(kind, random)) })
        break
      }
      case "Move": {
        if (orders.some((order) => order.id === null || order.id === enemy.id)) {
          if (hunting) facing = angleOf(toward.x, toward.z)
          open()
          break
        }
        if (drill !== null || routes === null) break
        const route = routes(body, radius, toward)
        facing = route.sight ? angleOf(toward.x, toward.z) : angleOf(route.way.x, route.way.z)
        if (Clock.reached(play, state.switchAt)) {
          data.state.update(enemy, { state: "Move", data: (current) => ({ attackAt: current.attackAt, strafe: current.strafe === 1 ? -1 as const : 1 as const, switchAt: Clock.deadline(play, SHOOTER.strafeSwitch) }) })
        }
        const closing = 1 - Math.min(1, Clock.remaining(play, state.attackAt) / Math.max(1, Clock.steps(ORBITER.tighten)))
        const stride = strideOf(kind, sight, route, Clock.reached(play, state.attackAt), closing)
        if (stride.attack) {
          open()
          break
        }
        desired = stride.desired
        speed = stride.speed
        break
      }
      case "Windup": {
        facing = angleOf(state.dirX, state.dirZ)
        if (!Clock.reached(play, state.endAt)) break
        const dir: Dir = { x: state.dirX, z: state.dirZ }
        if (state.feint) {
          const real = hunting ? toward : dir
          const windup = windupFor(TRICKSTER.windup, elite)
          const tell: TellValue = { shape: "line" }
          data.state.transition(enemy, { from: "Windup", to: "Windup", data: { endAt: Clock.deadline(play, windup), dirX: real.x, dirZ: real.z, feint: false, size: TRICKSTER.telegraphLength, steps: Math.max(1, Clock.steps(windup)), tell } })
          telegraph(tell, body, real, TRICKSTER.telegraphLength, windup, false)
          break
        }
        const attack = () => events.moments.emit({ type: "enemyAttack", id: enemy.id, kind, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z })
        const plan = strikeOf(kind, state.size)
        switch (plan.to) {
          case "lunge":
            data.state.transition(enemy, { from: "Windup", to: "Lunge", data: { endAt: after(play, plan.time), dirX: dir.x, dirZ: dir.z } })
            attack()
            break
          case "burst":
            data.state.transition(enemy, { from: "Windup", to: "Burst", data: { shotsLeft: SHOOTER.shots, nextShotAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)), angle: angleOf(dir.x, dir.z) } })
            attack()
            break
          case "volley": {
            const turn = random.next() < 0.5 ? 1 as const : -1 as const
            data.state.transition(enemy, { from: "Windup", to: "Volley", data: { shotsLeft: WARDEN.shots, nextShotAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)), angle: angleOf(dir.x, dir.z), turn } })
            attack()
            events.moments.emit({ type: "volley", id: enemy.id, x: body.x, z: body.z, arms: WARDEN.arms, shots: WARDEN.shots, interval: secondsOf(WARDEN.shotInterval), turn: turn * WARDEN.spin })
            break
          }
          case "slam":
            data.state.transition(enemy, { from: "Windup", to: "Recover", data: { endAt: Clock.deadline(play, BRUISER.recover) } })
            strike(body, BRUISER.slamRadius, dir, true)
            events.moments.emit({ type: "slam", id: enemy.id, x: body.x, z: body.z, radius: BRUISER.slamRadius })
            break
          case "sweep": {
            const turn = state.tell.shape === "arc" && state.tell.turn === -1 ? -1 as const : 1 as const
            const sweep = armSweepTime(SWEEPER.span, SWEEPER.speed)
            const from = angleOf(dir.x, dir.z) - turn * SWEEPER.span / 2
            data.state.transition(enemy, { from: "Windup", to: "Sweep", data: { endAt: Clock.deadline(play, sweep), steps: Clock.steps(sweep), from, turn } })
            attack()
            events.moments.emit({ type: "sweep", id: enemy.id, kind, x: body.x, z: body.z, from, span: SWEEPER.span, turn, radius: SWEEPER.radius, arms: 1, duration: secondsOf(sweep) })
            break
          }
          case "pulse": {
            const run = inSteps(((PULSAR.reach - radius) / PULSAR.speed) * step.hz)
            const gap = gapOf(dir)
            data.state.transition(enemy, { from: "Windup", to: "Pulse", data: { endAt: Clock.deadline(play, run), steps: Clock.steps(run), gaps: [gap] } })
            attack()
            events.moments.emit({ type: "wave", id: enemy.id, kind, x: body.x, z: body.z, from: radius, reach: PULSAR.reach, speed: PULSAR.speed, halfWidth: PULSAR.halfWidth, gapAngle: gap, gap: PULSAR.gap })
            break
          }
          case "leap": {
            const spot = hunting ? target.body : body
            data.state.transition(enemy, { from: "Windup", to: "Leap", data: { endAt: Clock.deadline(play, LEAPER.air), steps: Clock.steps(LEAPER.air), fromX: body.x, fromZ: body.z, spotX: spot.x, spotZ: spot.z, followUntil: Clock.deadline(play, LEAPER.followFor) } })
            events.moments.emit({ type: "leap", id: enemy.id, kind, fromX: body.x, fromZ: body.z, spotX: spot.x, spotZ: spot.z, radius: LEAPER.spot, follow: secondsOf(LEAPER.followFor), duration: secondsOf(LEAPER.air) })
            telegraph({ shape: "spot", x: spot.x, z: spot.z }, body, dir, LEAPER.spot, LEAPER.air, false)
            break
          }
          case "cut": {
            const own = seams.each().filter((entity) => seams.data.seam.get(entity).owner === enemy.id)
            const oldest = [...own].sort((a, b) => Clock.remaining(play, seams.data.seam.get(a).endAt) - Clock.remaining(play, seams.data.seam.get(b).endAt))
            for (const old of oldest.slice(0, Math.max(0, own.length - CUTTER.most + 1))) {
              commands.despawn(old)
              events.moments.emit({ type: "seamHealed", id: old.id })
            }
            const drawn = seamDraft({ owner: enemy.id, x: body.x, z: body.z, dir, reach: CUTTER.reach, speed: CUTTER.speed, halfWidth: CUTTER.halfWidth, live: CUTTER.live }, terrain, play)
            const id = commands.spawn(Game.Command.spawn([Seam, drawn.seam]))
            data.state.transition(enemy, { from: "Windup", to: "Cut", data: { endAt: drawn.seam.grownAt } })
            attack()
            events.moments.emit({ type: "seamDrawn", id, owner: enemy.id, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z, length: drawn.seam.length, halfWidth: CUTTER.halfWidth, grow: drawn.grow, live: secondsOf(CUTTER.live) })
            break
          }
        }
        break
      }
      case "Lunge": {
        facing = angleOf(state.dirX, state.dirZ)
        const plan = strikeOf(kind, 0)
        if (plan.to !== "lunge" || Clock.reached(play, state.endAt)) {
          const recover = plan.to === "lunge" ? plan.recover : Clock.durationOfSteps(step, 1)
          data.state.transition(enemy, { from: "Lunge", to: "Recover", data: { endAt: Clock.deadline(play, recover) } })
          break
        }
        desired = { x: state.dirX, z: state.dirZ }
        speed = plan.speed
        strike(body, radius + 0.1, desired, true)
        break
      }
      case "Burst": {
        if (hunting) facing = angleOf(toward.x, toward.z)
        if (!Clock.reached(play, state.nextShotAt)) break
        fire(angleOf(toward.x, toward.z) + random.range(-SHOOTER.spread, SHOOTER.spread), ORB.speed)
        if (state.shotsLeft <= 1) {
          data.state.transition(enemy, { from: "Burst", to: "Recover", data: { endAt: Clock.deadline(play, SHOOTER.recover) } })
        } else {
          data.state.update(enemy, { state: "Burst", data: (burst) => ({ shotsLeft: burst.shotsLeft - 1, nextShotAt: Clock.deadline(play, SHOOTER.shotInterval), angle: burst.angle }) })
        }
        break
      }
      case "Volley": {
        if (hunting) facing = angleOf(toward.x, toward.z)
        if (!Clock.reached(play, state.nextShotAt)) break
        for (let arm = 0; arm < WARDEN.arms; arm++) fire(state.angle + (arm / WARDEN.arms) * Math.PI * 2, WARDEN.orbSpeed)
        if (state.shotsLeft <= 1) {
          data.state.transition(enemy, { from: "Volley", to: "Recover", data: { endAt: Clock.deadline(play, WARDEN.open) } })
          events.moments.emit({ type: "wardenOpen", id: enemy.id, x: body.x, z: body.z, duration: secondsOf(WARDEN.open) })
        } else {
          data.state.update(enemy, {
            state: "Volley",
            data: (volley) => ({ shotsLeft: volley.shotsLeft - 1, nextShotAt: Clock.deadline(play, WARDEN.shotInterval), angle: volley.angle + volley.turn * WARDEN.spin, turn: volley.turn })
          })
        }
        break
      }
      case "Sweep": {
        const { now, before } = through(play, state.endAt, state.steps)
        const angle = state.from + state.turn * SWEEPER.span * now
        facing = angle
        if (hunting) {
          const touch = sweepContact(body.x, body.z, state.from + state.turn * SWEEPER.span * before, angle, state.turn, SWEEPER.radius, 0, target.body)
          if (touch !== null) strike(touch, 0.05, touch.dir, true)
        }
        if (Clock.reached(play, state.endAt)) data.state.transition(enemy, { from: "Sweep", to: "Recover", data: { endAt: Clock.deadline(play, SWEEPER.recover) } })
        break
      }
      case "Pulse": {
        const front = radius + (PULSAR.reach - radius) * through(play, state.endAt, state.steps).now
        if (hunting) {
          const touch = waveContact(body.x, body.z, front, PULSAR.halfWidth, state.gaps[0] ?? 0, PULSAR.gap, pillars, target.body)
          if (touch !== null) strike(touch, PULSAR.halfWidth, touch.dir, false)
        }
        if (Clock.reached(play, state.endAt)) data.state.transition(enemy, { from: "Pulse", to: "Recover", data: { endAt: Clock.deadline(play, PULSAR.recover) } })
        break
      }
      case "Leap": {
        const following = hunting && !Clock.reached(play, state.followUntil)
        const spot = following ? chase(state.spotX, state.spotZ, target.body.x, target.body.z, LEAPER.follow * dt) : { x: state.spotX, z: state.spotZ }
        const t = through(play, state.endAt, state.steps).now
        const heading = lengthOf(spot.x - state.fromX, spot.z - state.fromZ) > 1e-6 ? angleOf(spot.x - state.fromX, spot.z - state.fromZ) : body.facing
        if (Clock.reached(play, state.endAt)) {
          data.body.set(enemy, { x: spot.x, z: spot.z, facing: heading })
          data.state.transition(enemy, { from: "Leap", to: "Recover", data: { endAt: Clock.deadline(play, LEAPER.recover) } })
          strike(spot, LEAPER.spot, dirOf(heading), true)
          events.moments.emit({ type: "landed", id: enemy.id, kind, x: spot.x, z: spot.z, radius: LEAPER.spot })
          continue
        }
        if (following) data.state.update(enemy, { state: "Leap", data: (leap) => ({ ...leap, spotX: spot.x, spotZ: spot.z }) })
        data.body.set(enemy, { x: state.fromX + (spot.x - state.fromX) * t, z: state.fromZ + (spot.z - state.fromZ) * t, facing: heading })
        continue
      }
      case "Cut": {
        if (Clock.reached(play, state.endAt)) data.state.transition(enemy, { from: "Cut", to: "Recover", data: { endAt: Clock.deadline(play, CUTTER.recover) } })
        break
      }
      case "Recover": {
        if (!Clock.reached(play, state.endAt)) break
        data.state.transition(enemy, { from: "Recover", to: "Move", data: moveData(cooldownOf(kind, random)) })
        break
      }
      case "Stagger": {
        if (!Clock.reached(play, state.endAt)) break
        data.state.transition(enemy, { from: "Stagger", to: "Move", data: moveData(ENEMY_BODY.staggerCooldown) })
        break
      }
      case "Blink": {
        if (!Clock.reached(play, state.endAt)) break
        const arrived = { x: state.toX, z: state.toZ, facing: hunting ? angleOf(target.body.x - state.toX, target.body.z - state.toZ) : body.facing }
        data.body.set(enemy, arrived)
        data.prev.set(enemy, arrived)
        const dir = dirOf(arrived.facing)
        const feint = random.next() < TRICKSTER.feintChance
        const windup = windupFor(feint ? TRICKSTER.feint : TRICKSTER.windup, elite)
        const tell: TellValue = { shape: "line" }
        data.state.transition(enemy, { from: "Blink", to: "Windup", data: { endAt: after(play, windup), dirX: dir.x, dirZ: dir.z, feint, size: TRICKSTER.telegraphLength, steps: Math.max(1, Clock.steps(windup)), tell } })
        telegraph(tell, arrived, dir, TRICKSTER.telegraphLength, windup, feint)
        continue
      }
      case "Quake":
      case "Moons":
      case "Glide":
      case "Falling":
        continue
    }

    const knockback = data.motion.get(enemy)
    const free = carried(state._tag, knockback)
    const fade = Vec2.decayToward({ x: knockback.vx, y: knockback.vz }, Vec2.zero, ENEMY_BODY.knockbackDecay, dt)
    data.motion.set(enemy, { vx: fade.x, vz: fade.y })
    const vx = desired.x * speed + knockback.vx
    const vz = desired.z * speed + knockback.vz
    const now = data.body.get(enemy)
    const moved = move(free ? terrain.solid : terrain.bounded, now.x, now.z, vx * dt, vz * dt, radius)
    data.body.set(enemy, { x: moved.x, z: moved.z, facing })

    if (ENEMY[kind].contact && drill === null && hunting && state._tag === "Move" && distance <= radius + PLAYER.radius) {
      strike(moved, radius, toward, true)
    }
  }

  const solid = enemies.each().flatMap((enemy) => {
    const kind = enemyKindOf(data.actor.get(enemy).kind)
    const tag = data.state.get(enemy)._tag
    if (kind === undefined || tag === "Spawning" || tag === "Blink" || tag === "Leap" || data.health.get(enemy).hp <= 0) return []
    const radius = radiusOf(kind, data.elite.get(enemy) !== undefined)
    const planted = data.drill.get(enemy)?.mode === "dummy" || isBoss(kind)
    return [{ enemy, radius, lunging: tag === "Lunge" || tag === "Glide", planted, free: carried(tag, data.motion.get(enemy)) }]
  })
  const blocker = target !== undefined && target.state._tag !== "Dash" ? target.body : undefined
  for (const [index, one] of solid.entries()) {
    if (one.planted) continue
    const body = data.body.get(one.enemy)
    let pushX = 0
    let pushZ = 0
    for (const [otherIndex, other] of solid.entries()) {
      if (otherIndex === index) continue
      const otherBody = data.body.get(other.enemy)
      const gap = one.radius + other.radius - lengthOf(body.x - otherBody.x, body.z - otherBody.z)
      if (gap <= 0) continue
      const away = normalize(body.x - otherBody.x, body.z - otherBody.z, { x: index < otherIndex ? -1 : 1, z: 0 })
      const share = other.planted ? 1 : 0.5
      pushX += away.x * gap * share
      pushZ += away.z * gap * share
    }
    if (blocker !== undefined && !one.lunging) {
      const gap = one.radius + PLAYER.radius - lengthOf(body.x - blocker.x, body.z - blocker.z)
      if (gap > 0) {
        const away = normalize(body.x - blocker.x, body.z - blocker.z, dirOf(body.facing + Math.PI))
        pushX += away.x * gap
        pushZ += away.z * gap
      }
    }
    if (pushX === 0 && pushZ === 0) continue
    const pushed = move(one.free ? terrain.solid : terrain.bounded, body.x, body.z, pushX, pushZ, one.radius)
    data.body.set(one.enemy, { ...body, x: pushed.x, z: pushed.z })
  }
})

/** Whether an enemy is carried rather than walking: lunging or knocked hard, so the floor's edges don't hold it. */
const carried = (state: string, knockback: { readonly vx: number; readonly vz: number }): boolean =>
  state === "Lunge" || lengthOf(knockback.vx, knockback.vz) > RING_OUT.knockedSpeed

/** A point a trickster can blink to: a few units from the player at a random angle, on the floor and clear of props. */
const blinkSpot = (random: Random.Random, terrain: Terrain, x: number, z: number, radius: number): { readonly x: number; readonly z: number } | undefined => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = dirOf(random.range(0, Math.PI * 2))
    const reach = random.range(TRICKSTER.blinkDistanceMin, TRICKSTER.blinkDistanceMax)
    const spot = { x: x + dir.x * reach, z: z + dir.z * reach }
    if (standable(terrain, spot.x, spot.z, radius)) return spot
  }
  return undefined
}
