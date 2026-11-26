import { Clock, Random } from "@typeonce/ritmo"
import { Collide2 } from "@typeonce/ritmo-math"

import { ground } from "./arena.ts"
import { BOSS_START, bossDraft, bossDrillDraft, eliteDraft } from "./bosses/spawn.ts"
import { beamAngleOf } from "./beam.ts"
import { angleOf, lengthOf } from "./geometry.ts"
import { groundOf, hazardOf, layoutOf } from "./ground.ts"
import { crackSlabs, warnBeam } from "./hazards.ts"
import type { PlayerMoves } from "./moments.ts"
import {
  Actor,
  Blows,
  Body,
  Boss,
  BossState,
  Buffer,
  Cheats,
  CurrentStage,
  Drill,
  Elite,
  enemyKindOf,
  EnemyState,
  Game,
  Hazard,
  Health,
  HitMark,
  Intents,
  Loadout,
  Moments,
  Motion,
  Moves,
  Orders,
  PlayerState,
  PrevBody,
  Projectile,
  Rng,
  Run,
  Steer,
  Trigger,
  Vitals
} from "./schema.ts"
import type { MovesValue } from "./schema.ts"
import { drillDraft, enemyDraft, pickSpawnPoint, spawnPointsOf } from "./spawning.ts"
import { slabGroupsOf } from "./stages.ts"
import { playing } from "./tempo.ts"
import { PlayTime, seconds, secondsOf, step, Time } from "./time.ts"
import { BUFFER, COMBO, ENEMY, FOCUS, isBoss, MOVES, PLAYER, SPAWN } from "./tuning.ts"
import { loadoutFor } from "./weapons.ts"

/** The movement numbers after `moves` overrides some of them; dash distance and time are kept together. */
const tuned = (current: MovesValue, moves: Partial<PlayerMoves>): MovesValue => {
  const dashSteps = moves.dashTime === undefined ? current.dashSteps : Math.max(1, Math.round(moves.dashTime * step.hz))
  const dashDistance = moves.dashDistance ?? current.dashSpeed * (current.dashSteps / step.hz)
  return {
    speed: moves.speed ?? current.speed,
    acceleration: moves.acceleration ?? current.acceleration,
    deceleration: moves.deceleration ?? current.deceleration,
    dashSpeed: dashDistance / (dashSteps / step.hz),
    dashSteps
  }
}

/**
 * The debug requests that last across runs, taken on any screen: the player's invulnerability and movement numbers.
 * The debug scenes switch them off as they leave for the title, when no run is playing.
 */
export const DebugCheats = Game.System("Game/DebugCheats", {
  events: { intents: Game.System.readEvent(Intents) },
  resources: { cheats: Game.System.writeResource(Cheats), moves: Game.System.writeResource(Moves) }
}, ({ events, resources }) => {
  for (const intent of events.intents.all()) {
    if (intent.type === "invulnerable") resources.cheats.set({ invulnerable: intent.on })
    else if (intent.type === "tune") resources.moves.set(intent.moves === null ? { ...MOVES } : tuned(resources.moves.get(), intent.moves))
  }
})

/**
 * Debug, test and debug-scene requests during play, in any stage and in the sandbox: fill FOCUS and fire the special,
 * spawn any enemy (normal, AI off, or a dummy) at a point and facing, order attacks, land blows, remove one or clear
 * the field, refill or set the player's lives, put a weapon in their hand, teleport them or an enemy, press their
 * actions (a slash at any combo step), hold a move direction, swap in the open floor, and switch, sweep or collapse
 * the stage hazard.
 */
export const DebugIntents = Game.System("Game/DebugIntents", {
  when: [playing],
  events: {
    intents: Game.System.readEvent(Intents),
    moments: Game.System.writeEvent(Moments),
    orders: Game.System.writeEvent(Orders),
    blows: Game.System.writeEvent(Blows)
  },
  resources: {
    time: Game.System.readResource(Time),
    play: Game.System.readResource(PlayTime),
    run: Game.System.writeResource(Run),
    buffer: Game.System.writeResource(Buffer),
    rng: Game.System.writeResource(Rng),
    stage: Game.System.writeResource(CurrentStage),
    hazard: Game.System.writeResource(Hazard),
    loadout: Game.System.writeResource(Loadout),
    trigger: Game.System.writeResource(Trigger),
    steer: Game.System.writeResource(Steer)
  },
  queries: {
    players: Game.Query({
      selection: { body: Game.Query.write(Body), prev: Game.Query.write(PrevBody), motion: Game.Query.write(Motion), vitals: Game.Query.write(Vitals) },
      with: [PlayerState]
    }),
    enemies: Game.Query({ selection: { body: Game.Query.write(Body), prev: Game.Query.write(PrevBody), motion: Game.Query.write(Motion), actor: Game.Query.read(Actor) }, with: [EnemyState] }),
    orbs: Game.Query({ selection: { projectile: Game.Query.read(Projectile) }, with: [Actor] })
  },
  commands: Game.System.commands(Game.System.spawns(Actor, Body, PrevBody, Motion, Health, HitMark, EnemyState, Drill, Elite, Boss, BossState), Game.System.despawns(Actor))
}, ({ events, resources, queries, commands }) => {
  const players = queries.players
  const playerEntity = players.each()[0]
  const play = resources.play.get()
  for (const intent of events.intents.all()) {
    const player = playerEntity === undefined ? undefined : players.data.body.get(playerEntity)
    const current = resources.stage.get()
    const stage = { hazard: hazardOf(current), layout: layoutOf(current) }
    switch (intent.type) {
      case "grantFocus":
      case "special": {
        resources.run.update((run) => ({ ...run, focus: FOCUS.max }))
        events.moments.emit({ type: "focusFull" })
        if (intent.type === "special") resources.buffer.set({ _tag: "Held", action: "special", until: Clock.deadline(resources.time.get(), BUFFER.time) })
        break
      }
      case "clearWave": {
        for (const entity of queries.enemies.each()) commands.despawn(entity)
        for (const entity of queries.orbs.each()) commands.despawn(entity)
        break
      }
      case "spawn": {
        const enemies = queries.enemies
        const taken = enemies.each().map((entity) => enemies.data.body.get(entity))
        const terrain = groundOf(current, resources.hazard.get())
        const clear = (x: number, z: number) => {
          const spot = Collide2.pushOut(ground(x, z), ENEMY[intent.kind].radius, terrain.bounded)
          return { x: spot.x, z: spot.y }
        }
        const at = intent.x !== null && intent.z !== null
          ? clear(intent.x, intent.z)
          : pickSpawnPoint(Random.draw(resources.rng), spawnPointsOf(stage.layout, terrain), player, taken)
        const facing = intent.facing ?? (player === undefined ? 0 : angleOf(player.x - at.x, player.z - at.z))
        const drill = intent.drill ?? null
        const kind = intent.kind
        if (isBoss(kind)) {
          const spot = intent.x !== null && intent.z !== null ? at : clear(BOSS_START[kind].x, BOSS_START[kind].z)
          const turned = intent.facing ?? (player === undefined ? 0 : angleOf(player.x - spot.x, player.z - spot.z))
          const id = commands.spawn(drill === null ? bossDraft(kind, spot, turned, play) : bossDrillDraft(kind, spot, turned, play, drill))
          events.moments.emit({ type: "enemySpawned", id, kind, x: spot.x, z: spot.z, duration: 0 })
          break
        }
        const id = intent.elite === true
          ? commands.spawn(drill === null ? eliteDraft(kind, at, facing, play) : Game.Command.extend(eliteDraft(kind, at, facing, play), [Drill, { mode: drill }]))
          : commands.spawn(drill === null ? enemyDraft(kind, at, facing, play) : drillDraft(kind, at, facing, play, drill))
        events.moments.emit({ type: "enemySpawned", id, kind, x: at.x, z: at.z, duration: secondsOf(SPAWN.time) })
        break
      }
      case "attack":
        events.orders.emit({ id: intent.id })
        break
      case "teleport": {
        const walls = groundOf(current, resources.hazard.get()).bounded
        const spotFor = (radius: number, facing: number) => {
          const spot = Collide2.pushOut(ground(intent.x, intent.z), radius, walls)
          return { x: spot.x, z: spot.y, facing: intent.facing ?? facing }
        }
        const id = intent.id ?? null
        if (id === null) {
          if (playerEntity === undefined || player === undefined) break
          const body = spotFor(PLAYER.radius, player.facing)
          players.data.body.set(playerEntity, body)
          players.data.prev.set(playerEntity, body)
          players.data.motion.set(playerEntity, { vx: 0, vz: 0 })
          break
        }
        const enemies = queries.enemies
        const enemy = enemies.each().find((entity) => entity.id === id)
        const kind = enemy === undefined ? undefined : enemyKindOf(enemies.data.actor.get(enemy).kind)
        if (enemy === undefined || kind === undefined) break
        const body = spotFor(ENEMY[kind].radius, enemies.data.body.get(enemy).facing)
        enemies.data.body.set(enemy, body)
        enemies.data.prev.set(enemy, body)
        enemies.data.motion.set(enemy, { vx: 0, vz: 0 })
        break
      }
      case "press": {
        resources.buffer.set({ _tag: "Held", action: intent.action, until: Clock.deadline(resources.time.get(), BUFFER.time) })
        const step = intent.step ?? null
        if (intent.action !== "slash" || step === null || playerEntity === undefined) break
        players.data.vitals.set(playerEntity, { ...players.data.vitals.get(playerEntity), comboNext: step, comboUntil: Clock.deadline(play, COMBO.grace) })
        break
      }
      case "hold":
        resources.buffer.set({ _tag: "Held", action: "slash", until: Clock.deadline(resources.time.get(), BUFFER.time) })
        resources.trigger.set({ _tag: "Held", until: Clock.deadline(play, seconds(intent.seconds)) })
        break
      case "remove": {
        const enemy = queries.enemies.each().find((entity) => entity.id === intent.id)
        if (enemy !== undefined) commands.despawn(enemy)
        break
      }
      case "blow":
        events.blows.emit({ id: intent.id, damage: intent.damage, step: intent.step })
        break
      case "heal":
        resources.run.update((run) => ({ ...run, lives: PLAYER.lives }))
        break
      case "lives":
        resources.run.update((run) => ({ ...run, lives: Math.min(PLAYER.lives, Math.max(1, Math.round(intent.lives))) }))
        break
      case "setWeapon":
        resources.loadout.set(loadoutFor(intent.weapon, resources.loadout.get().marks))
        break
      case "floor":
        resources.stage.set({ ...current, open: intent.open })
        break
      case "steer": {
        const length = lengthOf(intent.x, intent.z)
        const scale = length > 1 ? 1 / length : 1
        resources.steer.set(length < 1e-6 ? { _tag: "Free" } : { _tag: "Held", x: intent.x * scale, z: intent.z * scale })
        break
      }
      case "hazard": {
        resources.stage.set({ ...current, hazard: intent.on })
        const hazard = resources.hazard.get()
        if (intent.on || stage.hazard.kind !== "beam" || hazard._tag === "BeamRest") break
        const angle = beamAngleOf(stage.hazard, hazard, play) ?? stage.hazard.startAngle
        resources.hazard.set({ _tag: "BeamRest", until: Clock.deadline(play, stage.hazard.rest), angle })
        if (hazard._tag === "BeamSweep") events.moments.emit({ type: "beamEnded", x: stage.hazard.x, z: stage.hazard.z, angle })
        break
      }
      case "sweep": {
        const hazard = resources.hazard.get()
        if (stage.hazard.kind !== "beam" || hazard._tag !== "BeamRest") break
        resources.hazard.set(warnBeam(stage.hazard, play, hazard.angle))
        events.moments.emit({ type: "beamWarned", x: stage.hazard.x, z: stage.hazard.z, angle: hazard.angle, lead: secondsOf(stage.hazard.lead) })
        break
      }
      case "collapse": {
        const hazard = resources.hazard.get()
        const next = slabGroupsOf(stage.layout)[hazard._tag === "FloorSteady" ? hazard.fallen : -1]
        if (stage.hazard.kind !== "collapse" || hazard._tag !== "FloorSteady" || next === undefined) break
        resources.hazard.set(crackSlabs(stage.hazard, play, hazard.fallen))
        events.moments.emit({ type: "slabsCracking", slabs: next.slabs, duration: secondsOf(stage.hazard.crack) })
        break
      }
      default:
        break
    }
  }
})
