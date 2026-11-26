import { Clock } from "@typeonce/ritmo"

import { inShape, liveHit } from "./arsenal/shapes.ts"
import { shelled } from "./foes.ts"
import { dirOf, normalize, within } from "./geometry.ts"
import type { Dir } from "./geometry.ts"
import { groundOf, knockbackOf } from "./ground.ts"
import type { ComboStep, HitSource, HurtCause } from "./moments.ts"
import { reflectTarget } from "./projectiles.ts"
import { bossDamage, bossOpen, bossShelled, healthFloor, withBalance } from "./bosses/rules.ts"
import {
  Actor,
  Blows,
  Body,
  Boss,
  BossState,
  Cheats,
  CurrentStage,
  Dart,
  Drill,
  Elite,
  enemyKindOf,
  EnemyState,
  gainFocus,
  Game,
  Hazard,
  HazardHits,
  Health,
  HitMark,
  Loadout,
  Moments,
  Motion,
  PlayerState,
  PrevBody,
  Projectile,
  Run,
  Strikes,
  Tempo,
  Twin,
  Vitals,
  Waves
} from "./schema.ts"
import { piecesOf, splitlingDraft } from "./split.ts"
import { hitStopMoment, slowMoment, withHitStop, withSlowMotion } from "./tempo.ts"
import { PlayTime, Time } from "./time.ts"
import type { Duration } from "./time.ts"
import { BOSS, DARTS, ELITE, ENEMY, FOCUS, HIT_STOP, isBoss, MOVE, ORB, PARRY, PLAYER, radiusOf, SIGIL, SLOW, WARDEN } from "./tuning.ts"
import { allSpawned } from "./waves.ts"
import type { EnemyKind } from "./tuning.ts"
import { moveAt } from "./weapons.ts"
import type { Mark, WeaponMove } from "./weapons.ts"

const untouchable = new Set(["Spawning", "Blink", "Leap", "Falling"])

/** One blow landing on an enemy: how hard, from which way, and what else it does (a move's `MoveHit` in tuning.ts). */
interface Landing {
  readonly amount: number
  readonly source: HitSource
  readonly step: ComboStep | 0
  readonly dir: Dir
  readonly knockback: number
  /** How long it staggers an armoured enemy; null when armour only takes the damage. */
  readonly breaks: Duration | null
  /** What a boss's balance meter gains from it. */
  readonly balance: number
}

/** How a weapon move names its hits: the blade's cuts are slashes, the rest go by their move. */
const sourceOf = (move: WeaponMove): HitSource => move === "cut" || move === "crosscut" ? "slash" : move

/** A weapon move's blow from `dir`, as tuning.ts gives it. */
const landingOf = (move: WeaponMove, step: ComboStep | 0, dir: Dir, amount: number = MOVE[move].damage): Landing => {
  const spec = MOVE[move]
  return { amount, source: sourceOf(move), step, dir, knockback: spec.knockback, breaks: spec.breaks, balance: spec.balance }
}

type Attack =
  | { readonly kind: "melee"; readonly enemy: number; readonly x: number; readonly z: number; readonly dir: Dir; readonly parryable: boolean }
  | { readonly kind: "projectile"; readonly orb: number; readonly x: number; readonly z: number; readonly dir: Dir }
  | { readonly kind: "hazard"; readonly hazard: "beam" | "fall"; readonly x: number; readonly z: number; readonly dir: Dir }

/**
 * Resolves every hit of the step. Against enemies: the weapon's live sweep or slam, darts in flight, sigils landing,
 * reflected orbs (which burst a sigil they cross) and debug blows. Against the player: enemy strikes, orbs and stage
 * hazards, where a dash's invulnerability turns them into near misses and a parry turns the strikes and orbs back.
 * Hits start hit-stop, kills fill FOCUS (and break splitters in two), a warden's shell turns blows aside (all but the
 * slam's), a pierce cuts the enemy orbs on its line, and a hit costs the player a life.
 */
export const Combat = Game.System("Game/Combat", {
  resources: {
    play: Game.System.readResource(PlayTime),
    time: Game.System.readResource(Time),
    run: Game.System.writeResource(Run),
    tempo: Game.System.writeResource(Tempo),
    waves: Game.System.readResource(Waves),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard),
    cheats: Game.System.readResource(Cheats),
    loadout: Game.System.writeResource(Loadout)
  },
  queries: {
    players: Game.Query({
      selection: { body: Game.Query.read(Body), motion: Game.Query.write(Motion), state: Game.Query.write(PlayerState), vitals: Game.Query.write(Vitals) }
    }),
    enemies: Game.Query({
      selection: {
        actor: Game.Query.read(Actor),
        body: Game.Query.read(Body),
        motion: Game.Query.write(Motion),
        health: Game.Query.write(Health),
        state: Game.Query.write(EnemyState),
        mark: Game.Query.write(HitMark),
        drill: Game.Query.optional(Drill),
        elite: Game.Query.optional(Elite),
        twin: Game.Query.optional(Twin)
      }
    }),
    bosses: Game.Query({ selection: { boss: Game.Query.write(Boss), fight: Game.Query.read(BossState) } }),
    orbs: Game.Query({ selection: { body: Game.Query.read(Body), projectile: Game.Query.write(Projectile) }, with: [Actor] }),
    darts: Game.Query({ selection: { body: Game.Query.read(Body), dart: Game.Query.read(Dart) }, with: [Actor] })
  },
  events: {
    strikes: Game.System.readEvent(Strikes),
    hazards: Game.System.readEvent(HazardHits),
    blows: Game.System.readEvent(Blows),
    moments: Game.System.writeEvent(Moments)
  },
  commands: Game.System.commands(Game.System.spawns(Actor, Body, PrevBody, Motion, Health, HitMark, EnemyState), Game.System.despawns(Actor))
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const time = resources.time.get()
  const current = resources.stage.get()
  const knockback = knockbackOf(current)
  const { players, enemies, orbs, darts } = queries
  const strikes = events.strikes.all()
  const player = players.each()[0]

  const addFocus = (amount: number) => {
    const gained = gainFocus(resources.run.get(), amount)
    resources.run.set(gained.run)
    if (gained.filled) events.moments.emit({ type: "focusFull" })
  }
  const hitStop = (duration: Duration) => {
    resources.tempo.update((tempo) => withHitStop(tempo, time, duration))
    events.moments.emit(hitStopMoment(duration))
  }

  const living = enemies.each().filter((enemy) => enemies.data.health.get(enemy).hp > 0)
  const waves = resources.waves.get()
  const lastSpawned = allSpawned(waves)
  let alive = living.length
  const gone = new Set<number>()

  /** A boss (or Sunder's half, through the boss it belongs to): its fight and the body that takes its blows. */
  const bossOf = (enemy: (typeof living)[number]) => {
    const host = enemies.data.twin.get(enemy)?.boss ?? enemy.id
    const entity = queries.bosses.each().find((each) => each.id === host)
    const body = living.find((each) => each.id === host)
    return entity === undefined || body === undefined ? undefined : { entity, body, boss: queries.bosses.data.boss.get(entity), fight: queries.bosses.data.fight.get(entity) }
  }

  const targetable = (enemy: (typeof living)[number]) => {
    if (gone.has(enemy.id) || untouchable.has(enemies.data.state.get(enemy)._tag) || enemies.data.health.get(enemy).hp <= 0) return false
    const boss = bossOf(enemy)
    return boss === undefined || bossOpen(boss.fight._tag)
  }

  const stagger = (enemy: (typeof living)[number], duration: Duration) => {
    const data = { endAt: Clock.deadline(play, duration) }
    const state = enemies.data.state.get(enemy)
    if (state._tag === "Stagger") enemies.data.state.update(enemy, { state: "Stagger", data: () => data })
    else if (state._tag !== "Spawning" && state._tag !== "Blink" && state._tag !== "Falling") enemies.data.state.transition(enemy, { from: state._tag, to: "Stagger", data })
  }

  /**
   * A blow on a boss (or Sunder's half): harder while it is broken or stunned open, never below its next phase's
   * threshold (the shift plays there), filling its balance; no knockback and no stagger. Its brain plays the defeat.
   */
  const bossBlow = (enemy: (typeof living)[number], kind: EnemyKind, landing: Landing): boolean => {
    const boss = bossOf(enemy)
    if (boss === undefined) return false
    const { body: host } = boss
    const health = enemies.data.health.get(host)
    const dummy = enemies.data.drill.get(host)?.mode === "dummy"
    const amount = bossDamage(boss.fight._tag, enemies.data.state.get(host)._tag, landing.amount, landing.source)
    const left = Math.max(healthFloor(boss.boss, health.max), health.hp - amount)
    enemies.data.health.set(host, { ...health, hp: dummy && left <= 0 ? health.max : left })
    queries.bosses.data.boss.set(boss.entity, withBalance(boss.boss, boss.fight._tag, landing.balance, play))
    const at = enemies.data.body.get(enemy)
    events.moments.emit({ type: "hit", id: enemy.id, kind, x: at.x, z: at.z, dirX: landing.dir.x, dirZ: landing.dir.z, damage: amount, source: landing.source, step: landing.step, killed: false })
    return true
  }

  /** Whether a boss's shell turns this blow aside (the Orrery's, all but the slam's). */
  const bossClanks = (enemy: (typeof living)[number]): boolean => {
    const boss = bossOf(enemy)
    return boss !== undefined && bossShelled(boss.boss, enemies.data.state.get(boss.body)._tag)
  }

  /** A splitter's death: two splitlings thrown out either side of the blow. */
  const split = (id: number, x: number, z: number, dir: Dir) => {
    const pieces = piecesOf(groundOf(current, resources.hazard.get()), x, z, dir).map((piece) => ({ ...piece, id: commands.spawn(splitlingDraft(piece, play)) }))
    alive += pieces.length
    events.moments.emit({ type: "split", id, x, z, pieces })
  }

  const damage = (enemy: (typeof living)[number], kind: EnemyKind, landing: Landing) => {
    if (bossBlow(enemy, kind, landing)) return
    const { amount, source, step, dir } = landing
    const body = enemies.data.body.get(enemy)
    const health = enemies.data.health.get(enemy)
    const dummy = enemies.data.drill.get(enemy)?.mode === "dummy"
    const left = health.hp - amount
    const killed = left <= 0 && !dummy
    enemies.data.health.set(enemy, { ...health, hp: killed ? 0 : left <= 0 ? health.max : left })
    events.moments.emit({ type: "hit", id: enemy.id, kind, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z, damage: amount, source, step, killed })
    if (killed) {
      gone.add(enemy.id)
      alive -= 1
      commands.despawn(enemy)
      resources.run.update((run) => ({ ...run, kills: run.kills + 1 }))
      addFocus(FOCUS.kill)
      hitStop(HIT_STOP.kill)
      if (kind === "splitter") split(enemy.id, body.x, body.z, dir)
      events.moments.emit({ type: "enemyKilled", id: enemy.id, kind, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z, source, lastOfWave: lastSpawned && alive === 0 })
      return
    }
    if (dummy) return
    const stats = ENEMY[kind]
    const push = landing.knockback * stats.knockbackTaken * knockback * (enemies.data.elite.get(enemy) === undefined ? 1 : ELITE.knockbackTaken)
    enemies.data.motion.set(enemy, { vx: dir.x * push, vz: dir.z * push })
    if (kind === "warden" && source === "reflect") stagger(enemy, WARDEN.reflectStagger)
    else if (!stats.armored) stagger(enemy, stats.hitStagger)
    else if (landing.breaks !== null && !isBoss(kind)) stagger(enemy, landing.breaks)
  }

  const enemyKind = (enemy: (typeof living)[number]): EnemyKind | undefined => enemyKindOf(enemies.data.actor.get(enemy).kind)
  const sizeOf = (enemy: (typeof living)[number], kind: EnemyKind): number => radiusOf(kind, enemies.data.elite.get(enemy) !== undefined)

  const clank = (enemy: (typeof living)[number], kind: EnemyKind, dir: Dir) => {
    const body = enemies.data.body.get(enemy)
    events.moments.emit({ type: "clank", id: enemy.id, kind, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z })
  }

  for (const blow of events.blows.all()) {
    const enemy = living.find((each) => each.id === blow.id)
    const kind = enemy === undefined ? undefined : enemyKind(enemy)
    if (enemy === undefined || kind === undefined || !targetable(enemy)) continue
    const body = enemies.data.body.get(enemy)
    const back = dirOf(body.facing + Math.PI)
    const from = player === undefined ? undefined : players.data.body.get(player)
    const dir = from === undefined ? back : normalize(body.x - from.x, body.z - from.z, back)
    const move = moveAt("blade", blow.step)
    damage(enemy, kind, landingOf(move, blow.step, dir, blow.damage))
    hitStop(MOVE[move].hitStop)
  }

  const hero = player === undefined ? undefined : players.data.body.get(player)

  const live = player === undefined || hero === undefined ? null : liveHit(players.data.state.get(player), hero, play)
  if (live !== null && hero !== undefined) {
    const spec = MOVE[live.move]
    const forward = dirOf(hero.facing)
    let landed = 0
    let clanked = false
    for (const enemy of living) {
      const kind = enemyKind(enemy)
      if (kind === undefined || !targetable(enemy) || enemies.data.mark.get(enemy).swing === live.swing) continue
      const body = enemies.data.body.get(enemy)
      if (!inShape(live.shape, body.x, body.z, sizeOf(enemy, kind))) continue
      enemies.data.mark.set(enemy, { swing: live.swing })
      const dir = normalize(body.x - hero.x, body.z - hero.z, forward)
      if (live.move !== "slam" && (shelled(kind, enemies.data.state.get(enemy)._tag) || bossClanks(enemy))) {
        clank(enemy, kind, dir)
        clanked = true
        continue
      }
      damage(enemy, kind, landingOf(live.move, live.step, dir))
      addFocus(spec.focus)
      landed += 1
    }
    if (landed > 0) hitStop(spec.hitStop)
    else if (clanked) hitStop(WARDEN.clankHitStop)
    if (live.move === "slam" && live.first) {
      events.moments.emit({ type: "burst", weapon: "breaker", move: "slam", mark: live.swing, x: hero.x, z: hero.z, radius: MOVE.slam.radius, hits: landed })
    }
  }

  for (const dart of darts.each()) {
    const flying = darts.data.dart.get(dart)
    const at = darts.data.body.get(dart)
    const spec = MOVE[flying.move]
    const dir = { x: flying.dirX, z: flying.dirZ }
    let stopped = false
    for (const enemy of living) {
      const kind = enemyKind(enemy)
      if (stopped || kind === undefined || !targetable(enemy) || enemies.data.mark.get(enemy).swing === flying.swing) continue
      const body = enemies.data.body.get(enemy)
      if (!within(at.x, at.z, body.x, body.z, sizeOf(enemy, kind) + spec.radius)) continue
      enemies.data.mark.set(enemy, { swing: flying.swing })
      if (shelled(kind, enemies.data.state.get(enemy)._tag) || bossClanks(enemy)) {
        clank(enemy, kind, dir)
        hitStop(WARDEN.clankHitStop)
        stopped = true
        continue
      }
      const close = spec.close !== null && hero !== undefined && within(hero.x, hero.z, body.x, body.z, spec.close.range)
      damage(enemy, kind, landingOf(flying.move, 0, dir, close && spec.close !== null ? spec.close.damage : flying.damage))
      addFocus(spec.focus + (flying.perfect ? DARTS.perfectFocus : 0))
      hitStop(spec.hitStop)
      stopped = flying.move === "dart"
    }
    if (flying.move === "pierce") {
      for (const orb of orbs.each()) {
        const projectile = orbs.data.projectile.get(orb)
        const spot = orbs.data.body.get(orb)
        if (projectile.owner !== "enemy" || !within(at.x, at.z, spot.x, spot.z, ORB.radius + spec.radius)) continue
        commands.despawn(orb)
        events.moments.emit({ type: "projectileGone", id: orb.id, x: spot.x, z: spot.z, reason: "hit" })
      }
    }
    if (!stopped) continue
    commands.despawn(dart)
    events.moments.emit({ type: "projectileGone", id: dart.id, x: at.x, z: at.z, reason: "hit" })
  }

  /** A sigil bursts: everything in its ring takes the blow, thrown out from its centre; `bonus` adds to the damage. */
  const burst = (mark: Mark, bonus: number) => {
    const spec = MOVE[mark.move]
    const away = hero === undefined ? dirOf(0) : normalize(mark.x - hero.x, mark.z - hero.z, dirOf(hero.facing))
    let hits = 0
    let clanked = false
    for (const enemy of living) {
      const kind = enemyKind(enemy)
      if (kind === undefined || !targetable(enemy)) continue
      const body = enemies.data.body.get(enemy)
      if (!within(mark.x, mark.z, body.x, body.z, mark.radius + sizeOf(enemy, kind))) continue
      const dir = normalize(body.x - mark.x, body.z - mark.z, away)
      if (shelled(kind, enemies.data.state.get(enemy)._tag) || bossClanks(enemy)) {
        clank(enemy, kind, dir)
        clanked = true
        continue
      }
      damage(enemy, kind, landingOf(mark.move, 0, dir, spec.damage + bonus))
      addFocus(spec.focus)
      hits += 1
    }
    if (hits > 0) hitStop(spec.hitStop)
    else if (clanked) hitStop(WARDEN.clankHitStop)
    events.moments.emit({ type: "burst", weapon: "sigil", move: mark.move, mark: mark.id, x: mark.x, z: mark.z, radius: mark.radius, hits })
  }
  const crossed = new Set<number>()

  for (const orb of orbs.each()) {
    const projectile = orbs.data.projectile.get(orb)
    if (projectile.owner !== "player") continue
    const at = orbs.data.body.get(orb)
    for (const mark of resources.loadout.get().marks) {
      if (crossed.has(mark.id) || !within(at.x, at.z, mark.x, mark.z, mark.radius)) continue
      crossed.add(mark.id)
      burst(mark, SIGIL.orbBonus)
    }
    const struck = living.find((enemy) => {
      const kind = enemyKind(enemy)
      if (kind === undefined || !targetable(enemy)) return false
      const body = enemies.data.body.get(enemy)
      return within(at.x, at.z, body.x, body.z, sizeOf(enemy, kind) + ORB.radius)
    })
    const kind = struck === undefined ? undefined : enemyKind(struck)
    if (struck === undefined || kind === undefined) continue
    commands.despawn(orb)
    events.moments.emit({ type: "projectileGone", id: orb.id, x: at.x, z: at.z, reason: "hit" })
    const amount = kind === "warden" ? projectile.damage * WARDEN.reflectFactor : projectile.damage
    damage(struck, kind, { amount, source: "reflect", step: 0, dir: { x: projectile.dirX, z: projectile.dirZ }, knockback: PARRY.reflectKnockback, breaks: null, balance: BOSS.balance.reflect })
    addFocus(FOCUS.reflectHit)
  }

  const hand = resources.loadout.get()
  const landing = hand.marks.filter((mark) => !crossed.has(mark.id) && Clock.reached(play, mark.landAt))
  for (const mark of landing) burst(mark, 0)
  if (landing.length > 0 || crossed.size > 0) {
    resources.loadout.set({ ...hand, marks: hand.marks.filter((mark) => !crossed.has(mark.id) && !Clock.reached(play, mark.landAt)) })
  }

  if (player === undefined) return

  const resolve = (attack: Attack): void => {
    const state = players.data.state.get(player)
    if (state._tag === "Special" || state._tag === "Down" || resources.cheats.get().invulnerable) return
    const vitals = players.data.vitals.get(player)
    const body = players.data.body.get(player)
    const protectedNow = vitals.invulnerableUntil !== null && !Clock.reached(play, vitals.invulnerableUntil)

    if (state._tag === "Dash" || protectedNow) {
      if (state._tag === "Dash" && !state.nearMiss) {
        players.data.state.update(player, { state: "Dash", data: (dash) => ({ ...dash, nearMiss: true }) })
        addFocus(FOCUS.nearMiss)
        events.moments.emit({ type: "nearMiss", x: body.x, z: body.z })
      }
      return
    }

    if ((attack.kind === "projectile" || (attack.kind === "melee" && attack.parryable)) && state._tag === "Parry" && !Clock.reached(play, state.windowEnd)) {
      players.data.state.transition(player, { from: "Parry", to: "Free" })
      players.data.vitals.set(player, { ...vitals, parryReadyAt: null })
      addFocus(FOCUS.parry)
      hitStop(PARRY.hitStop)
      events.moments.emit({ type: "parry", x: body.x, z: body.z, against: attack.kind, dirX: -attack.dir.x, dirZ: -attack.dir.z })
      if (attack.kind === "melee") {
        const attacker = living.find((enemy) => enemy.id === attack.enemy)
        const boss = attacker === undefined ? undefined : bossOf(attacker)
        if (boss !== undefined) queries.bosses.data.boss.set(boss.entity, withBalance(boss.boss, boss.fight._tag, BOSS.balance.parry, play))
        else if (attacker !== undefined) stagger(attacker, PARRY.stagger)
        return
      }
      const orb = orbs.each().find((entity) => entity.id === attack.orb)
      if (orb === undefined) return
      const targets = living.flatMap((enemy) => {
        const kind = enemyKind(enemy)
        if (kind === undefined || !targetable(enemy)) return []
        const at = enemies.data.body.get(enemy)
        return [{ kind, x: at.x, z: at.z }]
      })
      const target = reflectTarget(targets, body.x, body.z)
      const back = { x: -attack.dir.x, z: -attack.dir.z }
      const dir = target === undefined ? back : normalize(target.x - attack.x, target.z - attack.z, back)
      const projectile = orbs.data.projectile.get(orb)
      orbs.data.projectile.set(orb, {
        owner: "player",
        dirX: dir.x,
        dirZ: dir.z,
        speed: projectile.speed * PARRY.reflectSpeedFactor,
        damage: PARRY.reflectDamage,
        expiresAt: Clock.deadline(play, ORB.life)
      })
      events.moments.emit({ type: "reflect", id: orb.id, x: attack.x, z: attack.z, dirX: dir.x, dirZ: dir.z })
      return
    }

    const cause: HurtCause = attack.kind === "hazard" ? attack.hazard : "attack"
    const run = resources.run.get()
    const lives = Math.max(0, run.lives - 1)
    resources.run.set({ ...run, lives })
    hitStop(HIT_STOP.hurt)
    const away = normalize(body.x - attack.x, body.z - attack.z, attack.dir)
    players.data.motion.set(player, { vx: away.x * PLAYER.hurtKnockback, vz: away.z * PLAYER.hurtKnockback })
    players.data.vitals.set(player, { ...vitals, invulnerableUntil: Clock.deadline(play, PLAYER.hurtInvulnerability) })
    events.moments.emit({ type: "playerHurt", x: body.x, z: body.z, dirX: away.x, dirZ: away.z, lives, cause })
    if (attack.kind === "projectile") {
      const orb = orbs.each().find((entity) => entity.id === attack.orb)
      if (orb !== undefined) commands.despawn(orb)
      events.moments.emit({ type: "projectileGone", id: attack.orb, x: attack.x, z: attack.z, reason: "hit" })
    }
    if (lives <= 0) {
      const down = { until: Clock.deadline(time, PLAYER.downFor) }
      players.data.state.transition(player, { from: state._tag, to: "Down", data: down })
      resources.tempo.update((tempo) => withSlowMotion(tempo, time, SLOW.down, SLOW.downPeriod))
      events.moments.emit(slowMoment(SLOW.down, SLOW.downPeriod))
      events.moments.emit({ type: "playerDown", x: body.x, z: body.z })
      return
    }
    if (state._tag !== "Free") players.data.state.transition(player, { from: state._tag, to: "Free" })
  }

  const reach = (x: number, z: number, radius: number): boolean => {
    const body = players.data.body.get(player)
    return within(body.x, body.z, x, z, radius + PLAYER.radius)
  }

  for (const strike of strikes) {
    if (gone.has(strike.id) || !reach(strike.x, strike.z, strike.radius)) continue
    const toPlayer = normalize(players.data.body.get(player).x - strike.x, players.data.body.get(player).z - strike.z, { x: strike.dirX, z: strike.dirZ })
    resolve({ kind: "melee", enemy: strike.id, x: strike.x, z: strike.z, dir: toPlayer, parryable: strike.melee })
  }

  for (const orb of orbs.each()) {
    const projectile = orbs.data.projectile.get(orb)
    if (projectile.owner !== "enemy") continue
    const at = orbs.data.body.get(orb)
    if (!reach(at.x, at.z, ORB.radius)) continue
    resolve({ kind: "projectile", orb: orb.id, x: at.x, z: at.z, dir: { x: projectile.dirX, z: projectile.dirZ } })
  }

  for (const hit of events.hazards.all()) resolve({ kind: "hazard", hazard: hit.hazard, x: hit.x, z: hit.z, dir: { x: hit.dirX, z: hit.dirZ } })
})
