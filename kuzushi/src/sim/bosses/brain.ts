import { Clock, Random } from "@typeonce/ritmo"

import { move, standable } from "../arena.ts"
import type { Point } from "../arena.ts"
import type { BossPattern } from "../bosses.ts"
import type { FoeKind } from "../foes.ts"
import { armSweepTime, gapOf, LINE, RING, shotDraft, telegraphMoment, through } from "../foes.ts"
import { angleOf, dirOf, lengthOf, normalize } from "../geometry.ts"
import type { Dir } from "../geometry.ts"
import { groundOf } from "../ground.ts"
import { routesTo } from "../paths.ts"
import { chase, floorPlanOf, lineContact, pillarsOf, sweepContact, waveContact } from "../reach.ts"
import {
  Actor,
  Body,
  Boss,
  BossState,
  CurrentStage,
  Drill,
  EnemyState,
  enemyKindOf,
  Game,
  Hazard,
  Health,
  HitMark,
  Moments,
  Motion,
  Orders,
  PlayerState,
  PrevBody,
  Projectile,
  Rng,
  Run,
  Seam,
  Strikes,
  Tempo,
  Twin
} from "../schema.ts"
import type { BossValue, TellValue } from "../schema.ts"
import { seamDraft } from "../seams.ts"
import { enemyDraft, pickSpawnPoint, spawnPointsOf } from "../spawning.ts"
import { hitStopMoment, slowMoment, withHitStop, withSlowMotion } from "../tempo.ts"
import { after, inSteps, PlayTime, secondsOf, step, Time } from "../time.ts"
import type { Duration } from "../time.ts"
import { BOSS, ENEMY, GATEKEEPER, NEEDLE, ORB, ORRERY, PLAYER, SPAWN, SUNDER } from "../tuning.ts"
import { CUT_LENGTH, moonsElapsed, moonsOf, MOONS_STEPS, moonTimes } from "./moons.ts"
import { nextPattern, restOf, shiftDue, SUMMONS, windupPattern } from "./rules.ts"
import { twinDraft } from "./spawn.ts"

/** Where Sunder's halves come back together. */
const CENTRE: Point = { x: 0, z: 0 }

/** The orbs of one fan burst: `count` over `spread` round `angle`, nudged half a gap on every other burst. */
const fanAngles = (angle: number, burst: number): ReadonlyArray<number> => {
  const { orbs, spread } = GATEKEEPER.fan
  const gap = spread / (orbs - 1)
  const nudge = burst % 2 === 1 ? gap / 2 : 0
  return Array.from({ length: orbs }, (_, index) => angle - spread / 2 + gap * index + nudge)
}

/**
 * The bosses on the gameplay clock (docs/DESIGN.md, Bosses): the name card that holds the game, the patterns each
 * phase plays (phase 1 in order, later at random), the shifts between phases (roar, summons), the balance meter's
 * drain and the break when it fills, Sunder's split into halves, and the defeat in slow motion. Patterns play through
 * the enemy states each grew from, with the boss's own numbers; combat resolves the blows.
 */
export const BossBrain = Game.System("Game/BossBrain", {
  resources: {
    play: Game.System.readResource(PlayTime),
    time: Game.System.readResource(Time),
    rng: Game.System.writeResource(Rng),
    tempo: Game.System.writeResource(Tempo),
    run: Game.System.writeResource(Run),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard)
  },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.read(Body), motion: Game.Query.write(Motion), state: Game.Query.read(PlayerState) } }),
    bosses: Game.Query({
      selection: {
        actor: Game.Query.read(Actor),
        body: Game.Query.write(Body),
        prev: Game.Query.write(PrevBody),
        state: Game.Query.write(EnemyState),
        boss: Game.Query.write(Boss),
        fight: Game.Query.write(BossState),
        health: Game.Query.write(Health),
        drill: Game.Query.optional(Drill),
        twin: Game.Query.optional(Twin)
      }
    }),
    others: Game.Query({ selection: { actor: Game.Query.read(Actor), body: Game.Query.read(Body), health: Game.Query.read(Health) }, with: [EnemyState], without: [Boss] })
  },
  events: { moments: Game.System.writeEvent(Moments), strikes: Game.System.writeEvent(Strikes), orders: Game.System.readEvent(Orders) },
  commands: Game.System.commands(
    Game.System.spawns(Actor, Body, PrevBody, Motion, Health, HitMark, EnemyState, Boss, BossState, Twin, Projectile, Seam),
    Game.System.despawns(Actor)
  )
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const time = resources.time.get()
  const random = Random.draw(resources.rng)
  const current = resources.stage.get()
  const terrain = groundOf(current, resources.hazard.get())
  const pillars = pillarsOf(current)
  const orders = events.orders.all()
  const players = queries.players
  const hero = players.each()[0]
  const target = hero === undefined ? undefined : players.data.body.get(hero)
  const hunting = target !== undefined && hero !== undefined && players.data.state.get(hero)._tag !== "Down"
  const routes = hunting ? routesTo(terrain, target) : null
  const { bosses, others } = queries
  const { data } = bosses
  type Unit = (ReturnType<typeof bosses.each>)[number]

  const hold = (duration: Duration) => {
    resources.tempo.update((tempo) => withHitStop(tempo, time, duration))
    events.moments.emit(hitStopMoment(duration))
  }

  for (const entity of bosses.each()) {
    const twin = data.twin.get(entity)
    if (twin !== undefined) {
      const main = bosses.each().find((each) => each.id === twin.boss)
      if (main === undefined) {
        commands.despawn(entity)
        continue
      }
      data.health.set(entity, data.health.get(main))
      if (data.fight.get(main)._tag === "Fighting") act(entity, true)
      continue
    }

    const fight = data.fight.get(entity)
    const health = data.health.get(entity)
    const body = data.body.get(entity)
    const drill = data.drill.get(entity)?.mode ?? null
    const boss = data.boss.get(entity)
    const half = bosses.each().find((each) => data.twin.get(each)?.boss === entity.id)

    /** Ends a split at once: the second half folds back into the boss where it stands. */
    const rejoin = () => {
      if (half === undefined) return
      commands.despawn(half)
      events.moments.emit({ type: "bossRejoined", id: entity.id, x: body.x, z: body.z })
    }

    switch (fight._tag) {
      case "Arrived": {
        if (drill !== null) {
          data.fight.transition(entity, { from: "Arrived", to: "Fighting" })
          continue
        }
        hold(BOSS.intro)
        data.fight.transition(entity, { from: "Arrived", to: "Intro", data: { until: Clock.deadline(time, BOSS.intro) } })
        if (target !== undefined) data.body.set(entity, { ...body, facing: angleOf(target.x - body.x, target.z - body.z) })
        events.moments.emit({ type: "bossIntro", id: entity.id, boss: boss.boss, x: body.x, z: body.z, duration: secondsOf(BOSS.intro) })
        continue
      }
      case "Intro": {
        if (!Clock.reached(time, fight.until)) continue
        data.fight.transition(entity, { from: "Intro", to: "Fighting" })
        rest(entity, restOf(boss.phase))
        continue
      }
      case "Felled": {
        if (!Clock.reached(time, fight.until)) continue
        commands.despawn(entity)
        resources.run.update((run) => ({ ...run, kills: run.kills + 1 }))
        events.moments.emit({ type: "bossDefeated", id: entity.id, boss: boss.boss, x: body.x, z: body.z })
        continue
      }
      case "Shift": {
        const roared = (play.step - fight.startedAt) / BOSS.roarTime.steps
        if (roared <= 1 && hero !== undefined && target !== undefined) {
          const reach = BOSS.roarReach * roared
          const away = normalize(target.x - body.x, target.z - body.z, { x: 0, z: 1 })
          const distance = lengthOf(target.x - body.x, target.z - body.z)
          if (distance <= reach + PLAYER.radius) players.data.motion.set(hero, { vx: away.x * BOSS.roarPush, vz: away.z * BOSS.roarPush })
        }
        if (!Clock.reached(play, fight.until)) continue
        data.fight.transition(entity, { from: "Shift", to: "Fighting" })
        rest(entity, restOf(boss.phase))
        continue
      }
      case "Broken": {
        if (health.hp <= 0) break
        if (!Clock.reached(play, fight.until)) continue
        data.fight.transition(entity, { from: "Broken", to: "Fighting" })
        recover(entity, BOSS.open)
        events.moments.emit({ type: "bossRecovered", id: entity.id, boss: boss.boss })
        continue
      }
      case "Fighting":
        break
    }

    const dir = target === undefined ? dirOf(body.facing) : normalize(body.x - target.x, body.z - target.z, dirOf(body.facing + Math.PI))

    if (health.hp <= 0) {
      const stunned = { endAt: Clock.deadline(play, BOSS.defeat) }
      stagger(entity, stunned.endAt)
      const fallen = others.each().flatMap((other) => {
        const kind = enemyKindOf(others.data.actor.get(other).kind)
        if (kind === undefined || others.data.health.get(other).hp <= 0) return []
        commands.despawn(other)
        const at = others.data.body.get(other)
        return [{ id: other.id, kind, x: at.x, z: at.z }]
      })
      rejoin()
      if (fight._tag === "Fighting") data.fight.transition(entity, { from: "Fighting", to: "Felled", data: { until: Clock.deadline(time, BOSS.defeat) } })
      else if (fight._tag === "Broken") data.fight.transition(entity, { from: "Broken", to: "Felled", data: { until: Clock.deadline(time, BOSS.defeat) } })
      resources.tempo.update((tempo) => withSlowMotion(tempo, time, BOSS.defeat, BOSS.defeatPeriod))
      events.moments.emit(slowMoment(BOSS.defeat, BOSS.defeatPeriod))
      events.moments.emit({ type: "bossFelled", id: entity.id, boss: boss.boss, x: body.x, z: body.z, dirX: -dir.x, dirZ: -dir.z, duration: secondsOf(BOSS.defeat), fallen })
      continue
    }

    if (drill === null && shiftDue(boss, health.hp, health.max)) {
      const phase = boss.phase + 1
      const until = Clock.deadline(play, BOSS.shift)
      rejoin()
      data.boss.set(entity, { ...boss, phase, cursor: 0, pattern: null, split: null })
      data.fight.transition(entity, { from: "Fighting", to: "Shift", data: { until, startedAt: play.step } })
      recover(entity, BOSS.shift)
      summon(SUMMONS[boss.boss][phase - 2] ?? [])
      hold(BOSS.shiftHitStop)
      events.moments.emit({ type: "bossPhase", id: entity.id, boss: boss.boss, phase, x: body.x, z: body.z, duration: secondsOf(BOSS.shift) })
      continue
    }

    if (boss.balance >= BOSS.balance.max) {
      const until = Clock.deadline(play, BOSS.broken)
      rejoin()
      data.boss.set(entity, { ...boss, balance: 0, calmAt: null, pattern: null, split: null })
      data.fight.transition(entity, { from: "Fighting", to: "Broken", data: { until } })
      stagger(entity, until)
      hold(BOSS.breakHitStop)
      events.moments.emit({ type: "bossBroken", id: entity.id, boss: boss.boss, x: body.x, z: body.z, duration: secondsOf(BOSS.broken) })
      continue
    }

    if (boss.calmAt !== null && Clock.reached(play, boss.calmAt) && boss.balance > 0) {
      data.boss.set(entity, { ...boss, balance: Math.max(0, boss.balance - BOSS.balance.decay * play.dt) })
    }
    act(entity, false)
  }

  /** Brings in a shift's summons at the floor's spawn points, away from the player. */
  function summon(kinds: ReadonlyArray<FoeKind>) {
    const taken: Array<Point> = []
    const points = spawnPointsOf(floorPlanOf(current), terrain)
    for (const kind of kinds) {
      const at = pickSpawnPoint(random, points, target, taken)
      taken.push(at)
      const facing = target === undefined ? 0 : angleOf(target.x - at.x, target.z - at.z)
      const id = commands.spawn(enemyDraft(kind, at, facing, play))
      events.moments.emit({ type: "enemySpawned", id, kind, x: at.x, z: at.z, duration: secondsOf(SPAWN.time) })
    }
  }

  /** Puts a boss (or half) back to walking, its next pattern `delay` away. */
  function rest(entity: Unit, delay: Duration) {
    const state = data.state.get(entity)
    const move = { attackAt: Clock.deadline(play, delay), strafe: 1 as const, switchAt: Clock.deadline(play, delay) }
    if (state._tag === "Move") data.state.update(entity, { state: "Move", data: () => move })
    else if (state._tag === "Recover" || state._tag === "Stagger") data.state.transition(entity, { from: state._tag, to: "Move", data: move })
  }

  /** Holds a boss open, attacking nothing, for `duration`. */
  function recover(entity: Unit, duration: Duration) {
    const state = data.state.get(entity)
    const open = { endAt: Clock.deadline(play, duration) }
    if (state._tag === "Recover") data.state.update(entity, { state: "Recover", data: () => open })
    else if (state._tag !== "Spawning" && state._tag !== "Falling") data.state.transition(entity, { from: state._tag, to: "Recover", data: open })
  }

  /** Staggers a boss until `endAt`: stunned, broken or felled. */
  function stagger(entity: Unit, endAt: Clock.Deadline<60>) {
    const state = data.state.get(entity)
    if (state._tag === "Stagger") data.state.update(entity, { state: "Stagger", data: () => ({ endAt }) })
    else if (state._tag !== "Spawning" && state._tag !== "Falling" && state._tag !== "Blink") data.state.transition(entity, { from: state._tag, to: "Stagger", data: { endAt } })
  }

  /** One step of a boss's (or Sunder's half's) action: resting, winding up, or playing its pattern. */
  function act(entity: Unit, isHalf: boolean) {
    const boss: BossValue = data.boss.get(entity)
    const id = boss.boss
    const state = data.state.get(entity)
    const body = data.body.get(entity)
    const radius = ENEMY[id].radius
    const drill = data.drill.get(entity)?.mode ?? null
    const toward = target === undefined ? dirOf(body.facing) : normalize(target.x - body.x, target.z - body.z, dirOf(body.facing))
    const distance = target === undefined ? 0 : lengthOf(target.x - body.x, target.z - body.z)
    const splitting = boss.split !== null
    const playing = windupPattern(boss, state, isHalf)
    const face = (facing: number) => data.body.set(entity, { ...data.body.get(entity), facing })
    const place = (at: Point, facing: number) => {
      const set = { x: at.x, z: at.z, facing }
      data.body.set(entity, set)
      data.prev.set(entity, set)
    }
    const strike = (at: Point, reach: number, dir: Dir, melee = true) =>
      events.strikes.emit({ id: entity.id, x: at.x, z: at.z, radius: reach, dirX: dir.x, dirZ: dir.z, melee })
    const telegraph = (tell: TellValue, from: Point, dir: Dir, size: number, duration: Duration, feint = false) =>
      events.moments.emit(telegraphMoment(entity.id, id, tell, from, dir, size, duration, feint))
    const windup = (tell: TellValue, dir: Dir, size: number, duration: Duration, feint = false) => {
      const windupData = { endAt: after(play, duration), dirX: dir.x, dirZ: dir.z, feint, size, steps: Math.max(1, Clock.steps(duration)), tell }
      const now = data.state.get(entity)
      if (now._tag === "Move" || now._tag === "Windup") data.state.transition(entity, { from: now._tag, to: "Windup", data: windupData })
      telegraph(tell, data.body.get(entity), dir, size, duration, feint)
    }
    const fire = (aim: number, speed: number, kind: "orb" | "needle") => {
      const life = kind === "needle" ? inSteps(((SUNDER.needles.length + SUNDER.needles.lifePad) / speed) * step.hz) : ORB.life
      const { draft, start, dir } = shotDraft(kind, body, radius, aim, speed, kind === "needle" ? NEEDLE.damage : ORB.damage, life, play)
      const shot = commands.spawn(draft)
      events.moments.emit({ type: "projectileFired", id: shot, x: start.x, z: start.z, dirX: dir.x, dirZ: dir.z, speed })
    }
    const attack = (dir: Dir) => events.moments.emit({ type: "enemyAttack", id: entity.id, kind: id, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z })
    const done = (duration: Duration) => recover(entity, duration)

    /** Starts a pattern from rest. */
    const begin = (pattern: BossPattern) => {
      switch (pattern) {
        case "slam": return windup(RING, toward, GATEKEEPER.slam.inner, GATEKEEPER.slam.windup)
        case "charge": return windup(LINE, toward, GATEKEEPER.charge.length, GATEKEEPER.charge.windup)
        case "fan": return windup(LINE, toward, GATEKEEPER.fan.telegraph, GATEKEEPER.fan.windup)
        case "blink": {
          const side = random.next() < 0.5 ? 1 : -1
          const around = target ?? body
          const spots = [side, -side].map((sign) => ({ x: around.x - toward.z * sign * GATEKEEPER.blink.beside, z: around.z + toward.x * sign * GATEKEEPER.blink.beside }))
          const spot = spots.find((each) => standable(terrain, each.x, each.z, radius)) ?? { x: body.x, z: body.z }
          if (state._tag === "Move") data.state.transition(entity, { from: "Move", to: "Blink", data: { endAt: Clock.deadline(play, GATEKEEPER.blink.out), toX: spot.x, toZ: spot.z } })
          events.moments.emit({ type: "blink", id: entity.id, fromX: body.x, fromZ: body.z, toX: spot.x, toZ: spot.z, duration: secondsOf(GATEKEEPER.blink.out) })
          return
        }
        case "volley": return windup(RING, toward, ORRERY.volley.telegraph, ORRERY.volley.windup)
        case "moons": {
          if (state._tag !== "Move") return
          const spin = random.next() < 0.5 ? 1 as const : -1 as const
          const center = target ?? body
          data.state.transition(entity, { from: "Move", to: "Moons", data: { endAt: Clock.deadline(play, inSteps(MOONS_STEPS)), steps: MOONS_STEPS, centerX: center.x, centerZ: center.z, spin, lines: [null, null, null] } })
          return
        }
        case "hands": {
          const turn = random.next() < 0.5 ? 1 : -1
          return windup({ shape: "arc", halfAngle: ORRERY.hands.span / 2, turn }, toward, ORRERY.hands.radius, ORRERY.hands.windup)
        }
        case "pulse": return windup({ shape: "arc", halfAngle: Math.PI - ORRERY.pulse.gap / 2, turn: 0 }, dirOf(random.range(-Math.PI, Math.PI)), ORRERY.pulse.reach, ORRERY.pulse.windup)
        case "needles": return windup(LINE, toward, SUNDER.needles.length, SUNDER.needles.windup)
        case "lunge": return windup(LINE, toward, SUNDER.lunge.length, SUNDER.lunge.windup)
        case "leap": return windup(RING, toward, radius + SUNDER.leap.ring, SUNDER.leap.crouch)
        case "seams": {
          const across = random.next() < 0.5 ? 0 : Math.PI / 4
          return windup(LINE, dirOf(angleOf(toward.x, toward.z) + across), SUNDER.seams.reach, SUNDER.seams.windup)
        }
        case "split": return windup(RING, toward, radius + SUNDER.split.ring, SUNDER.split.windup)
      }
    }

    /** What a pattern does when its windup ends. */
    const unleash = (pattern: BossPattern, held: Extract<typeof state, { readonly _tag: "Windup" }>) => {
      const dir: Dir = { x: held.dirX, z: held.dirZ }
      const angle = angleOf(dir.x, dir.z)
      switch (pattern) {
        case "slam":
          strike(body, GATEKEEPER.slam.inner, dir)
          events.moments.emit({ type: "slam", id: entity.id, x: body.x, z: body.z, radius: GATEKEEPER.slam.inner })
          data.state.transition(entity, { from: "Windup", to: "Quake", data: { endAt: Clock.deadline(play, GATEKEEPER.slam.echo) } })
          return
        case "charge":
          data.state.transition(entity, { from: "Windup", to: "Lunge", data: { endAt: after(play, inSteps((GATEKEEPER.charge.length / GATEKEEPER.charge.speed) * step.hz)), dirX: dir.x, dirZ: dir.z } })
          attack(dir)
          return
        case "lunge":
          data.state.transition(entity, { from: "Windup", to: "Lunge", data: { endAt: after(play, SUNDER.lunge.time), dirX: dir.x, dirZ: dir.z } })
          attack(dir)
          return
        case "fan":
          data.state.transition(entity, { from: "Windup", to: "Burst", data: { shotsLeft: GATEKEEPER.fan.bursts, nextShotAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)), angle } })
          attack(dir)
          return
        case "blink": {
          if (held.feint) return windup(LINE, dir, GATEKEEPER.blink.length / 2, GATEKEEPER.blink.windup)
          for (const line of [dir, { x: -dir.z, z: dir.x }]) {
            const from = { x: body.x - line.x * GATEKEEPER.blink.length / 2, z: body.z - line.z * GATEKEEPER.blink.length / 2 }
            const touch = target === undefined ? null : lineContact(from.x, from.z, line, GATEKEEPER.blink.length, GATEKEEPER.blink.halfWidth, target)
            if (touch !== null) strike(touch, GATEKEEPER.blink.halfWidth, touch.dir)
          }
          attack(dir)
          return done(GATEKEEPER.blink.recover)
        }
        case "volley": {
          const turn = random.next() < 0.5 ? 1 as const : -1 as const
          data.state.transition(entity, { from: "Windup", to: "Volley", data: { shotsLeft: ORRERY.volley.shots, nextShotAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)), angle, turn } })
          events.moments.emit({ type: "volley", id: entity.id, x: body.x, z: body.z, arms: ORRERY.volley.arms, shots: ORRERY.volley.shots, interval: secondsOf(ORRERY.volley.interval), turn: turn * ORRERY.volley.spin })
          return
        }
        case "hands": {
          const turn = held.tell.shape === "arc" && held.tell.turn === -1 ? -1 as const : 1 as const
          const sweep = armSweepTime(ORRERY.hands.span, ORRERY.hands.speed)
          const from = angle - turn * ORRERY.hands.span / 2
          data.state.transition(entity, { from: "Windup", to: "Sweep", data: { endAt: Clock.deadline(play, sweep), steps: Clock.steps(sweep), from, turn } })
          events.moments.emit({ type: "sweep", id: entity.id, kind: id, x: body.x, z: body.z, from, span: ORRERY.hands.span, turn, radius: ORRERY.hands.radius, arms: 2, duration: secondsOf(sweep) })
          return
        }
        case "pulse": {
          const { pulse } = ORRERY
          const gap = gapOf(dir)
          const gaps = Array.from({ length: pulse.waves }, (_, wave) => gap + (wave * Math.PI * 2) / pulse.waves)
          const total = inSteps((pulse.waves - 1) * pulse.interval.steps + ((pulse.reach - radius) / pulse.speed) * step.hz)
          data.state.transition(entity, { from: "Windup", to: "Pulse", data: { endAt: Clock.deadline(play, total), steps: Clock.steps(total), gaps } })
          events.moments.emit({ type: "wave", id: entity.id, kind: id, x: body.x, z: body.z, from: radius, reach: pulse.reach, speed: pulse.speed, halfWidth: pulse.halfWidth, gapAngle: gap, gap: pulse.gap })
          return
        }
        case "needles":
          for (const turn of [-1, 0, 1]) fire(angle + turn * SUNDER.needles.spread, SUNDER.needles.speed, "needle")
          attack(dir)
          return done(SUNDER.needles.open)
        case "leap": {
          const spot = target ?? body
          const { leap } = SUNDER
          data.state.transition(entity, { from: "Windup", to: "Leap", data: { endAt: Clock.deadline(play, leap.air), steps: leap.air.steps, fromX: body.x, fromZ: body.z, spotX: spot.x, spotZ: spot.z, followUntil: Clock.deadline(play, leap.followFor) } })
          events.moments.emit({ type: "leap", id: entity.id, kind: id, fromX: body.x, fromZ: body.z, spotX: spot.x, spotZ: spot.z, radius: leap.spot, follow: secondsOf(leap.followFor), duration: secondsOf(leap.air) })
          telegraph({ shape: "spot", x: spot.x, z: spot.z }, body, dir, leap.spot, leap.air)
          return
        }
        case "seams": {
          const { seams } = SUNDER
          let grown = Clock.deadline(play, Clock.durationOfSteps(step, 1))
          for (let index = 0; index < seams.count; index++) {
            const line = dirOf(angle + (index * Math.PI * 2) / seams.count)
            const start = { x: body.x + line.x * radius, z: body.z + line.z * radius }
            const drawn = seamDraft({ owner: entity.id, x: start.x, z: start.z, dir: line, reach: seams.reach - radius, speed: seams.speed, halfWidth: seams.halfWidth, live: seams.live }, terrain, play)
            const seam = commands.spawn(Game.Command.spawn([Seam, drawn.seam]))
            grown = Clock.remaining(play, drawn.seam.grownAt) > Clock.remaining(play, grown) ? drawn.seam.grownAt : grown
            events.moments.emit({ type: "seamDrawn", id: seam, owner: entity.id, x: start.x, z: start.z, dirX: line.x, dirZ: line.z, length: drawn.seam.length, halfWidth: seams.halfWidth, grow: drawn.grow, live: secondsOf(seams.live) })
          }
          attack(dir)
          data.state.transition(entity, { from: "Windup", to: "Cut", data: { endAt: grown } })
          return
        }
        case "split": {
          const across = { x: -dir.z, z: dir.x }
          const { offset } = SUNDER.split
          const spots = [1, -1].map((sign) => ({ x: body.x + across.x * offset * sign, z: body.z + across.z * offset * sign }))
          const [mine, theirs] = spots.map((spot) => standable(terrain, spot.x, spot.z, radius * 0.6) ? spot : { x: body.x, z: body.z })
          const splitAt = Clock.deadline(play, SUNDER.split.time)
          const split = { ...boss, split: splitAt }
          data.boss.set(entity, split)
          const health = data.health.get(entity)
          const other = commands.spawn(twinDraft(entity.id, split, theirs ?? body, angle, health.hp, health.max, play))
          place(mine ?? body, angle)
          done(SUNDER.split.rest)
          events.moments.emit({ type: "bossSplit", id: entity.id, twin: other, x: body.x, z: body.z })
          return
        }
        case "moons":
          return done(BOSS.open)
      }
    }

    switch (state._tag) {
      case "Move": {
        const ordered = orders.some((order) => order.id === null || order.id === entity.id)
        if (splitting && boss.split !== null && Clock.reached(play, boss.split)) {
          if (!isHalf) data.boss.set(entity, { ...boss, split: null })
          data.state.transition(entity, { from: "Move", to: "Glide", data: { endAt: Clock.deadline(play, SUNDER.split.rejoin), steps: SUNDER.split.rejoin.steps, from: { x: body.x, z: body.z }, to: CENTRE } })
          return
        }
        if (drill !== null && !ordered) return
        if (target !== undefined) face(angleOf(toward.x, toward.z))
        const ready = Clock.reached(play, state.attackAt) || ordered
        if (!ready) {
          const speed = ENEMY[id].speed
          if (speed <= 0 || routes === null || distance <= radius + PLAYER.radius + BOSS.standOff) return
          const way = routes(body, radius, toward).way
          const moved = move(terrain.bounded, body.x, body.z, way.x * speed * play.dt, way.z * speed * play.dt, radius)
          data.body.set(entity, { x: moved.x, z: moved.z, facing: angleOf(way.x, way.z) })
          return
        }
        if (isHalf || splitting) return begin(random.next() < 0.5 ? "lunge" : "leap")
        const next = nextPattern(boss, random)
        data.boss.set(entity, { ...boss, pattern: next.pattern, cursor: next.cursor, forced: null })
        events.moments.emit({ type: "bossPattern", id: entity.id, boss: id, pattern: next.pattern, x: body.x, z: body.z })
        return begin(next.pattern)
      }
      case "Windup": {
        face(angleOf(state.dirX, state.dirZ))
        if (!Clock.reached(play, state.endAt) || playing === null) return
        return unleash(playing, state)
      }
      case "Blink": {
        if (!Clock.reached(play, state.endAt)) return
        const facing = target === undefined ? body.facing : angleOf(target.x - state.toX, target.z - state.toZ)
        place({ x: state.toX, z: state.toZ }, facing)
        const feint = random.next() < GATEKEEPER.blink.feintChance
        const duration = feint ? GATEKEEPER.blink.feint : GATEKEEPER.blink.windup
        const tell = LINE
        const dir = dirOf(facing)
        data.state.transition(entity, { from: "Blink", to: "Windup", data: { endAt: after(play, duration), dirX: dir.x, dirZ: dir.z, feint, size: GATEKEEPER.blink.length / 2, steps: Math.max(1, Clock.steps(duration)), tell } })
        telegraph(tell, { x: state.toX, z: state.toZ }, dir, GATEKEEPER.blink.length / 2, duration, feint)
        return
      }
      case "Lunge": {
        const charge = id === "gatekeeper"
        const dir = { x: state.dirX, z: state.dirZ }
        const speed = charge ? GATEKEEPER.charge.speed : SUNDER.lunge.speed
        const moved = move(terrain.bounded, body.x, body.z, dir.x * speed * play.dt, dir.z * speed * play.dt, radius)
        data.body.set(entity, { x: moved.x, z: moved.z, facing: angleOf(dir.x, dir.z) })
        strike(moved, radius + 0.1, dir)
        if (charge && moved.blocked) {
          const stun = GATEKEEPER.charge.stun
          const pillar = pillars.findIndex((each) => lengthOf(each.x - moved.x, each.z - moved.z) <= each.radius + radius + 0.3)
          stagger(entity, Clock.deadline(play, stun))
          events.moments.emit({ type: "bossStunned", id: entity.id, boss: id, x: moved.x, z: moved.z, duration: secondsOf(stun), pillar: pillar < 0 ? null : pillar, breaks: pillar >= 0 && boss.phase >= 2 })
          return
        }
        if (Clock.reached(play, state.endAt)) done(charge ? GATEKEEPER.charge.recover : SUNDER.lunge.recover)
        return
      }
      case "Quake": {
        if (!Clock.reached(play, state.endAt)) return
        const { inner, outer } = GATEKEEPER.slam
        if (hunting && distance >= inner - PLAYER.radius && distance <= outer + PLAYER.radius) {
          const reach = Math.min(outer, Math.max(inner, distance))
          strike({ x: body.x + toward.x * reach, z: body.z + toward.z * reach }, 0.05, toward)
        }
        events.moments.emit({ type: "slam", id: entity.id, x: body.x, z: body.z, radius: outer })
        return done(GATEKEEPER.slam.recover)
      }
      case "Burst": {
        if (!Clock.reached(play, state.nextShotAt)) return
        const burst = GATEKEEPER.fan.bursts - state.shotsLeft
        for (const aim of fanAngles(state.angle, burst)) fire(aim, ORB.speed, "orb")
        if (state.shotsLeft <= 1) return done(GATEKEEPER.fan.recover)
        data.state.update(entity, { state: "Burst", data: (now) => ({ shotsLeft: now.shotsLeft - 1, nextShotAt: Clock.deadline(play, GATEKEEPER.fan.interval), angle: now.angle }) })
        return
      }
      case "Volley": {
        if (target !== undefined) face(angleOf(toward.x, toward.z))
        if (!Clock.reached(play, state.nextShotAt)) return
        const { volley } = ORRERY
        for (let arm = 0; arm < volley.arms; arm++) fire(state.angle + (arm / volley.arms) * Math.PI * 2, volley.orbSpeed, "orb")
        if (state.shotsLeft <= 1) {
          events.moments.emit({ type: "wardenOpen", id: entity.id, x: body.x, z: body.z, duration: secondsOf(volley.open) })
          return done(volley.open)
        }
        data.state.update(entity, { state: "Volley", data: (now) => ({ shotsLeft: now.shotsLeft - 1, nextShotAt: Clock.deadline(play, volley.interval), angle: now.angle + now.turn * volley.spin, turn: now.turn }) })
        return
      }
      case "Sweep": {
        const { hands } = ORRERY
        const { now, before } = through(play, state.endAt, state.steps)
        for (const arm of [0, Math.PI]) {
          const from = state.from + arm
          const touch = !hunting || target === undefined ? null
            : sweepContact(body.x, body.z, from + state.turn * hands.span * before, from + state.turn * hands.span * now, state.turn, hands.radius, hands.safe, target)
          if (touch !== null) strike(touch, 0.05, touch.dir)
        }
        if (Clock.reached(play, state.endAt)) done(hands.recover)
        return
      }
      case "Pulse": {
        const { pulse } = ORRERY
        const elapsed = Math.max(0, state.steps - Clock.remaining(play, state.endAt))
        state.gaps.forEach((gap, wave) => {
          const since = elapsed - wave * pulse.interval.steps
          if (since < 0) return
          if (since === 0 && wave > 0) {
            events.moments.emit({ type: "wave", id: entity.id, kind: id, x: body.x, z: body.z, from: radius, reach: pulse.reach, speed: pulse.speed, halfWidth: pulse.halfWidth, gapAngle: gap, gap: pulse.gap })
          }
          const front = radius + pulse.speed * (since / step.hz)
          if (front > pulse.reach || !hunting || target === undefined) return
          const touch = waveContact(body.x, body.z, front, pulse.halfWidth, gap, pulse.gap, pillars, target)
          if (touch !== null) strike(touch, pulse.halfWidth, touch.dir, false)
        })
        if (Clock.reached(play, state.endAt)) done(pulse.recover)
        return
      }
      case "Leap": {
        const { leap } = SUNDER
        const following = hunting && target !== undefined && !Clock.reached(play, state.followUntil)
        const spot = following && target !== undefined ? chase(state.spotX, state.spotZ, target.x, target.z, leap.follow * play.dt) : { x: state.spotX, z: state.spotZ }
        const t = through(play, state.endAt, state.steps).now
        const heading = lengthOf(spot.x - state.fromX, spot.z - state.fromZ) > 1e-6 ? angleOf(spot.x - state.fromX, spot.z - state.fromZ) : body.facing
        if (Clock.reached(play, state.endAt)) {
          const landing = terrain.onFloor(spot.x, spot.z) ? spot : { x: state.fromX, z: state.fromZ }
          place(landing, heading)
          strike(landing, leap.spot, dirOf(heading))
          events.moments.emit({ type: "landed", id: entity.id, kind: id, x: landing.x, z: landing.z, radius: leap.spot })
          return done(leap.recover)
        }
        if (following) data.state.update(entity, { state: "Leap", data: (now) => ({ ...now, spotX: spot.x, spotZ: spot.z }) })
        data.body.set(entity, { x: state.fromX + (spot.x - state.fromX) * t, z: state.fromZ + (spot.z - state.fromZ) * t, facing: heading })
        return
      }
      case "Cut": {
        if (Clock.reached(play, state.endAt)) done(SUNDER.seams.recover)
        return
      }
      case "Moons": {
        const { moons } = ORRERY
        const elapsed = moonsElapsed(state, play)
        const center = hunting && target !== undefined ? chase(state.centerX, state.centerZ, target.x, target.z, moons.chase * play.dt) : { x: state.centerX, z: state.centerZ }
        const before = moonsOf(state, play, body.x, body.z)
        const lines = state.lines.map((line, moon) => {
          const times = moonTimes(moon)
          const at = before[moon]
          if (line !== null || elapsed < times.aimAt || at === undefined) return line
          const aim = target === undefined ? dirOf(body.facing) : normalize(target.x - at.x, target.z - at.z, dirOf(body.facing))
          events.moments.emit({ type: "telegraph", id: entity.id, kind: id, shape: "line", x: at.x, z: at.z, dirX: aim.x, dirZ: aim.z, size: CUT_LENGTH, duration: secondsOf(moons.aim), feint: false })
          return { x: at.x, z: at.z, dirX: aim.x, dirZ: aim.z }
        })
        data.state.update(entity, { state: "Moons", data: (now) => ({ ...now, centerX: center.x, centerZ: center.z, lines }) })
        lines.forEach((line, moon) => {
          if (line === null) return
          const times = moonTimes(moon)
          if (elapsed === times.cutAt) events.moments.emit({ type: "moonCut", id: entity.id, moon, x: line.x, z: line.z, dirX: line.dirX, dirZ: line.dirZ, length: CUT_LENGTH })
          if (elapsed < times.cutAt || elapsed >= times.backAt) return
          const at = before[moon]
          if (at !== undefined) strike(at, ORRERY.moonRadius, { x: line.dirX, z: line.dirZ })
        })
        if (target !== undefined) face(angleOf(toward.x, toward.z))
        if (Clock.reached(play, state.endAt)) done(moons.recover)
        return
      }
      case "Glide": {
        const t = through(play, state.endAt, state.steps).now
        const at = { x: state.from.x + (state.to.x - state.from.x) * t, z: state.from.z + (state.to.z - state.from.z) * t }
        data.body.set(entity, { ...body, x: at.x, z: at.z })
        if (!Clock.reached(play, state.endAt)) return
        if (isHalf) {
          commands.despawn(entity)
          const main = data.twin.get(entity)?.boss ?? entity.id
          events.moments.emit({ type: "bossRejoined", id: main, x: at.x, z: at.z })
          return
        }
        stagger(entity, Clock.deadline(play, SUNDER.split.open))
        return
      }
      case "Recover": {
        if (!Clock.reached(play, state.endAt)) return
        if (!isHalf && !splitting) data.boss.set(entity, { ...boss, last: boss.pattern ?? boss.last, pattern: null })
        return rest(entity, isHalf || splitting ? SUNDER.split.rest : restOf(boss.phase))
      }
      case "Stagger": {
        if (!Clock.reached(play, state.endAt)) return
        if (!isHalf) data.boss.set(entity, { ...boss, last: boss.pattern ?? boss.last, pattern: null })
        return rest(entity, restOf(boss.phase))
      }
      case "Spawning":
      case "Falling":
        return
    }
  }
})
