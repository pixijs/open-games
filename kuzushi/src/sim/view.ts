import { Clock } from "@typeonce/ritmo"

import { beamAngleOf, beamReach, leadAngle, sweepTime } from "./beam.ts"
import type { BossView } from "./bosses.ts"
import { bossShelled } from "./bosses/rules.ts"
import { bossViewOf, told } from "./bosses/view.ts"
import type { BossBody } from "./bosses/view.ts"
import { shelled } from "./foes.ts"
import { seamFront } from "./seams.ts"
import type { ArenaLayout } from "./arena.ts"
import { Dungeon, Transition } from "./dungeon/schema.ts"
import { mapView, roomView, roomWaves, runView, transitionView } from "./dungeon/view.ts"
import type { RunView, WaveMix } from "./dungeon/view.ts"
import { fallenOf, hazardLive, hazardOf, layoutOf } from "./ground.ts"
import type { DrillMode, PlayerMoves, TelegraphShape } from "./moments.ts"
import type { MapView, RoomView, TransitionView } from "./rooms.ts"
import { attackFrame, dartView, weaponView } from "./arsenal/view.ts"
import type { AttackPhase } from "./arsenal/view.ts"
import { Actor, Body, Boss, BossState, Cheats, CurrentStage, Dart, Drill, Elite, enemyKindOf, EnemyState, Flow, Game, Hazard, Health, Loadout, Motion, Moves, PlayerState, Projectile, Run, Seam, Steer, Tempo, Twin, Vitals, Waves } from "./schema.ts"
import type { EnemyStateValue, FlowState, HazardValue, MovesValue, PlayerStateValue, SteerValue } from "./schema.ts"
import { fallenSlabs, slabGroupsOf } from "./stages.ts"
import type { StageHazard } from "./stages.ts"
import { PlayTime, progressTo, step, Time } from "./time.ts"
import * as Tuning from "./tuning.ts"
import { FOCUS, isBoss, PLAYER } from "./tuning.ts"
import type { EnemyKind } from "./tuning.ts"
import type { DartView, WeaponMove, WeaponView } from "./weapons.ts"
import type { ZoneId } from "./zones.ts"

export type PlayerStateName = PlayerStateValue["_tag"]
export type EnemyStateName = EnemyStateValue["_tag"]

export interface PlayerView {
  readonly id: number
  readonly x: number
  readonly z: number
  readonly facing: number
  readonly vx: number
  readonly vz: number
  readonly state: PlayerStateName
  /** The weapon move playing while attacking (Attack, Slam, or Charge's pierce), else null. */
  readonly move: WeaponMove | null
  /** The step of the weapon's chain while attacking (the blade's 1 and 2 are its cuts, 3 its spin), else 0. */
  readonly step: 0 | 1 | 2 | 3
  /** While attacking: which part of the move is playing; a charge is a windup. */
  readonly attackPhase: AttackPhase | null
  /** 0 to 1 through that part (through the charge while charging), else 0. */
  readonly progress: number
  /** Seconds left in the current timed state (an attack, a charge until full, dash, parry window, special beat), else 0. */
  readonly timeLeft: number
  readonly invulnerable: boolean
  /** While parrying: whether the deflecting window is still open. */
  readonly parryOpen: boolean
  readonly dashReady: boolean
}

export interface TelegraphView {
  readonly shape: TelegraphShape
  readonly dirX: number
  readonly dirZ: number
  readonly size: number
  /** 0 when the windup starts, 1 when the attack lands. */
  readonly progress: number
  readonly feint: boolean
  /** An arc's half angle and the way it sweeps (1 clockwise on screen). */
  readonly halfAngle?: number
  readonly turn?: 1 | -1
  /** A spot's centre on the ground. */
  readonly spot?: { readonly x: number; readonly z: number }
}

export interface EnemyView {
  readonly id: number
  readonly kind: EnemyKind
  readonly x: number
  readonly z: number
  readonly facing: number
  readonly hp: number
  readonly maxHp: number
  readonly state: EnemyStateName
  readonly timeLeft: number
  /** Present while winding up an attack. */
  readonly telegraph: TelegraphView | null
  /** While blinking: where the trickster reappears. */
  readonly blinkTo: { readonly x: number; readonly z: number } | null
  /** A warden's shell is up (winding up or firing a volley): blows clank off it. The simulation always sets it. */
  readonly shielded?: boolean
  /** A training enemy from the debug hooks, or null. The simulation always sets it. */
  readonly drill?: DrillMode | null
  /** An elite: three times the health, larger, quicker to attack. */
  readonly elite?: boolean
}

export interface ProjectileView {
  readonly id: number
  readonly x: number
  readonly z: number
  readonly dirX: number
  readonly dirZ: number
  readonly owner: "enemy" | "player"
}

/** The room's waves: which (0 before the first, or in a room without a fight), of how many, its phase, its mix. */
export interface WaveView {
  readonly index: number
  readonly total: number
  readonly phase: "idle" | "intro" | "fighting" | "cleared" | "done"
  /** The kinds and counts of the wave showing (the next one while waiting or between waves), the elite marked. */
  readonly mix: ReadonlyArray<WaveMix>
  readonly enemiesLeft: number
}

export interface TempoView {
  /** The run clock's step. */
  readonly step: number
  /** The gameplay clock's step: it stands still in hit-stop and skips beats in slow motion. */
  readonly playStep: number
  readonly hitStop: boolean
  /** 1 at full speed, 1/period in slow motion. */
  readonly slowScale: number
  /** The world is frozen for the special. */
  readonly frozen: boolean
}

/** One of The Void's slabs: its rectangle and whether it stands, cracks or has fallen. */
export interface SlabView {
  /** Its index in the layout's slabs, as moments name it. */
  readonly index: number
  readonly x: number
  readonly z: number
  readonly halfWidth: number
  readonly halfDepth: number
  readonly state: "standing" | "cracking" | "fallen"
}

/** The stage hazard as the art needs it. Angles in the simulation's convention; the beam turns clockwise on screen. */
export type HazardView =
  | { readonly kind: "none" }
  | {
    readonly kind: "beam"
    readonly on: boolean
    readonly phase: "rest" | "warn" | "sweep"
    /** The spire's centre, and its radius, where the beam and the telegraph start. */
    readonly x: number
    readonly z: number
    readonly from: number
    readonly halfWidth: number
    /** The beam's direction while sweeping; where the next sweep starts while resting or warning. */
    readonly angle: number
    /** How far the beam reaches along `angle`: the first pillar it meets, else the wall. */
    readonly reach: number
    /** The thin telegraph line: where the beam starts (warn) or runs ahead of it (sweep); null at rest. */
    readonly telegraph: { readonly angle: number; readonly reach: number } | null
    /** 0 to 1 through the current phase. */
    readonly progress: number
    /** Seconds left in the current phase (at rest: until the next telegraph, 0 while switched off). */
    readonly timeLeft: number
  }
  | {
    readonly kind: "slabs"
    readonly on: boolean
    readonly slabs: ReadonlyArray<SlabView>
    /** While slabs crack: 0 when the crack starts, 1 when they fall. */
    readonly crack: number
  }

/** What the debug hooks have set. */
export interface DebugView {
  readonly invulnerable: boolean
  readonly moves: PlayerMoves
  /** The held move direction, or null. */
  readonly steer: { readonly x: number; readonly z: number } | null
  /** The run plays on the open floor (`OPEN_FLOOR`) instead of the stage's. */
  readonly openFloor: boolean
}

/** Everything the host draws from, read once per frame. */
export interface GameView {
  readonly flow: FlowState
  /** The zone this run is in (also its classic arena's, `stageOf(zone)`); `zoneOf(zone)` has its number, name, kanji, roster and boss, `paletteOf(zone)` its colours. */
  readonly zone: ZoneId
  /** The zone's dungeon for the map, or null outside a dungeon (the sandbox). */
  readonly map: MapView | null
  /** The room the player is in, or null outside a dungeon. */
  readonly room: RoomView | null
  /** The door or zone transition playing, or null. */
  readonly transition: TransitionView | null
  /** The boss in the room, or null. */
  readonly boss: BossView | null
  /** The weapon in hand. */
  readonly weapon: WeaponView
  readonly hazard: HazardView
  readonly wave: WaveView
  /** The run's tally for the results: where it began, rooms cleared, hits taken, a won full run's rank. */
  readonly run: RunView
  /** Seconds since the run started, stopped at the end. */
  readonly timer: number
  readonly lives: number
  readonly maxLives: number
  /** 0 to 1. */
  readonly focus: number
  readonly focusFull: boolean
  readonly kills: number
  readonly seed: number
  readonly tempo: TempoView
  readonly player: PlayerView | null
  readonly enemies: ReadonlyArray<EnemyView>
  readonly projectiles: ReadonlyArray<ProjectileView>
  /** The player's darts in flight. */
  readonly darts: ReadonlyArray<DartView>
  /** Seams burning on the floor. */
  readonly seams: ReadonlyArray<SeamView>
  readonly debug: DebugView
}

/** A seam burning on the floor (a cutter's, Sunder's): from (x, z) along its direction, run out `length` of `reach`. */
export interface SeamView {
  readonly id: number
  readonly owner: number
  readonly x: number
  readonly z: number
  readonly dirX: number
  readonly dirZ: number
  readonly length: number
  readonly reach: number
  readonly halfWidth: number
  /** 0 to 1 through its burn once it has run out; 0 while it runs. */
  readonly burn: number
}

/** An enemy's telegraph from its state: its windup's tell, or a leap's landing spot. Bosses show theirs in `BossView`. */
const telegraphOf = (state: EnemyStateValue, size: number, play: Clock.Time<60>): TelegraphView | null => {
  switch (state._tag) {
    case "Windup":
      return { shape: state.tell.shape, dirX: state.dirX, dirZ: state.dirZ, size: state.size, progress: progressTo(play, state.endAt, state.steps), feint: state.feint, ...told(state.tell) }
    case "Leap":
      return { shape: "spot", dirX: 1, dirZ: 0, size, progress: progressTo(play, state.endAt, state.steps), feint: false, spot: { x: state.spotX, z: state.spotZ } }
    default:
      return null
  }
}

const hazardView = (spec: StageHazard, layout: ArenaLayout, on: boolean, hazard: HazardValue, play: Clock.Time<60>): HazardView => {
  const left = (at: Clock.Deadline<60>) => Clock.remaining(play, at) / play.hz
  switch (spec.kind) {
    case "none": return { kind: "none" }
    case "beam": {
      const angle = beamAngleOf(spec, hazard, play) ?? spec.startAngle
      const base = { kind: "beam" as const, on, x: spec.x, z: spec.z, from: spec.from, halfWidth: spec.halfWidth, angle, reach: beamReach(spec, layout, angle) }
      const line = (at: number) => ({ angle: at, reach: beamReach(spec, layout, at) })
      switch (hazard._tag) {
        case "BeamWarn": return { ...base, phase: "warn", telegraph: line(angle), progress: progressTo(play, hazard.until, Clock.steps(spec.lead)), timeLeft: left(hazard.until) }
        case "BeamSweep": {
          return { ...base, phase: "sweep", telegraph: line(leadAngle(spec, hazard.from, angle)), progress: progressTo(play, hazard.until, Clock.steps(sweepTime(spec))), timeLeft: left(hazard.until) }
        }
        case "BeamRest": return { ...base, phase: "rest", telegraph: null, progress: progressTo(play, hazard.until, Clock.steps(spec.rest)), timeLeft: on ? left(hazard.until) : 0 }
        default: return { ...base, phase: "rest", telegraph: null, progress: 0, timeLeft: 0 }
      }
    }
    case "collapse": {
      const groups = slabGroupsOf(layout)
      const fallen = fallenOf(hazard)
      const gone = fallenSlabs(layout, fallen)
      const cracking = new Set(hazard._tag === "FloorCracking" ? groups[hazard.fallen]?.slabs ?? [] : [])
      const slabs = layout.floor.kind === "slabs" ? layout.floor.slabs : []
      return {
        kind: "slabs",
        on,
        slabs: slabs.map((slab, index): SlabView => ({
          index,
          x: slab.x,
          z: slab.z,
          halfWidth: slab.halfWidth,
          halfDepth: slab.halfDepth,
          state: gone.has(index) ? "fallen" : cracking.has(index) ? "cracking" : "standing"
        })),
        crack: hazard._tag === "FloorCracking" ? progressTo(play, hazard.until, Clock.steps(spec.crack)) : 0
      }
    }
  }
}

/** The one projection of the world the host reads: screens, run, tempo, and every actor. */
export const ReadGame = Game.Inspector("Game/ReadGame", {
  resources: {
    time: Game.System.readResource(Time),
    play: Game.System.readResource(PlayTime),
    run: Game.System.readResource(Run),
    waves: Game.System.readResource(Waves),
    tempo: Game.System.readResource(Tempo),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard),
    loadout: Game.System.readResource(Loadout),
    cheats: Game.System.readResource(Cheats),
    steer: Game.System.readResource(Steer),
    moves: Game.System.readResource(Moves),
    dungeon: Game.System.readResource(Dungeon),
    transition: Game.System.readResource(Transition)
  },
  machines: { flow: Game.System.machine(Flow) },
  queries: {
    players: Game.Query({ selection: { body: Game.Query.read(Body), motion: Game.Query.read(Motion), state: Game.Query.read(PlayerState), vitals: Game.Query.read(Vitals) } }),
    enemies: Game.Query({
      selection: {
        actor: Game.Query.read(Actor),
        body: Game.Query.read(Body),
        health: Game.Query.read(Health),
        state: Game.Query.read(EnemyState),
        drill: Game.Query.optional(Drill),
        elite: Game.Query.optional(Elite),
        boss: Game.Query.optional(Boss),
        fight: Game.Query.optional(BossState),
        twin: Game.Query.optional(Twin)
      }
    }),
    seams: Game.Query({ selection: { seam: Game.Query.read(Seam) } }),
    orbs: Game.Query({ selection: { body: Game.Query.read(Body), projectile: Game.Query.read(Projectile) } }),
    darts: Game.Query({ selection: { body: Game.Query.read(Body), dart: Game.Query.read(Dart) } })
  }
}, ({ resources, machines, queries }): GameView => {
  const time = resources.time.get()
  const play = resources.play.get()
  const run = resources.run.get()
  const waves = resources.waves.get()
  const tempo = resources.tempo.get()
  const current = resources.stage.get()
  const left = (at: Clock.Deadline<60>, clock: Clock.Time<60> = play) => Clock.remaining(clock, at) / clock.hz

  const player = queries.players.each().map((entity): PlayerView => {
    const { data } = queries.players
    const body = data.body.get(entity)
    const state = data.state.get(entity)
    const vitals = data.vitals.get(entity)
    const motion = data.motion.get(entity)
    const attack = attackFrame(state, play)
    const timeLeft = state._tag === "Attack" || state._tag === "Slam" ? left(state.endAt)
      : state._tag === "Charge" ? left(state.fullAt)
      : state._tag === "Dash" ? left(state.endAt)
      : state._tag === "Parry" ? left(state.endAt)
      : state._tag === "Special" ? left(state.endAt ?? state.nextHitAt, time)
      : state._tag === "Down" ? left(state.until, time)
      : 0
    return {
      id: entity.id,
      x: body.x,
      z: body.z,
      facing: body.facing,
      vx: motion.vx,
      vz: motion.vz,
      state: state._tag,
      move: attack?.move ?? null,
      step: attack?.step ?? 0,
      attackPhase: attack?.phase ?? null,
      progress: attack?.progress ?? 0,
      timeLeft,
      invulnerable: state._tag === "Dash" || state._tag === "Special" || (vitals.invulnerableUntil !== null && !Clock.reached(play, vitals.invulnerableUntil)),
      parryOpen: state._tag === "Parry" && !Clock.reached(play, state.windowEnd),
      dashReady: vitals.dashReadyAt === null || Clock.reached(play, vitals.dashReadyAt)
    }
  })[0] ?? null

  const enemies = queries.enemies.each().flatMap((entity): ReadonlyArray<EnemyView> => {
    const { data } = queries.enemies
    const kind = enemyKindOf(data.actor.get(entity).kind)
    if (kind === undefined) return []
    const body = data.body.get(entity)
    const health = data.health.get(entity)
    const state = data.state.get(entity)
    const timed = "endAt" in state ? left(state.endAt) : state._tag === "Spawning" ? left(state.readyAt) : 0
    const boss = data.boss.get(entity)
    const telegraph = isBoss(kind) ? null : telegraphOf(state, Tuning.LEAPER.spot, play)
    return [{
      id: entity.id,
      kind,
      x: body.x,
      z: body.z,
      facing: body.facing,
      hp: health.hp,
      maxHp: health.max,
      state: state._tag,
      timeLeft: timed,
      telegraph,
      blinkTo: state._tag === "Blink" ? { x: state.toX, z: state.toZ } : null,
      shielded: shelled(kind, state._tag) || (boss !== undefined && bossShelled(boss, state._tag)),
      drill: data.drill.get(entity)?.mode ?? null,
      elite: data.elite.get(entity) !== undefined
    }]
  })

  const projectiles = queries.orbs.each().map((entity): ProjectileView => {
    const body = queries.orbs.data.body.get(entity)
    const projectile = queries.orbs.data.projectile.get(entity)
    return { id: entity.id, x: body.x, z: body.z, dirX: projectile.dirX, dirZ: projectile.dirZ, owner: projectile.owner }
  })

  /** The boss in the room and Sunder's second half while it is split. */
  const bossOf = (): BossView | null => {
    const { data } = queries.enemies
    const bodies = queries.enemies.each().flatMap((entity): ReadonlyArray<BossBody & { readonly twin: number | null }> => {
      const boss = data.boss.get(entity)
      const fight = data.fight.get(entity)
      if (boss === undefined || fight === undefined) return []
      const body = data.body.get(entity)
      const health = data.health.get(entity)
      return [{ id: entity.id, x: body.x, z: body.z, facing: body.facing, state: data.state.get(entity), boss, fight, hp: health.hp, maxHp: health.max, twin: data.twin.get(entity)?.boss ?? null }]
    })
    const main = bodies.find((body) => body.twin === null)
    return main === undefined ? null : bossViewOf(main, bodies.filter((body) => body.twin === main.id), play, time)
  }

  const dungeon = resources.dungeon.get()
  const wave: WaveView = { ...roomWaves(waves, dungeon, current), enemiesLeft: enemies.filter((enemy) => enemy.hp > 0).length }
  const flow = machines.flow.get()._tag
  const timer = ((run.endedAt ?? time.step) - run.startedAt) / time.hz

  return {
    flow,
    zone: current.id,
    map: mapView(dungeon),
    room: roomView(dungeon, current, player),
    transition: transitionView(resources.transition.get(), dungeon, time),
    boss: bossOf(),
    weapon: weaponView(resources.loadout.get(), queries.players.each().map((entity) => queries.players.data.state.get(entity))[0] ?? { _tag: "Free" }, play),
    hazard: hazardView(hazardOf(current), layoutOf(current), hazardLive(current), resources.hazard.get(), play),
    wave,
    run: runView(run, dungeon, flow === "RunClear", timer),
    timer,
    lives: run.lives,
    maxLives: PLAYER.lives,
    focus: run.focus / FOCUS.max,
    focusFull: run.focus >= FOCUS.max,
    kills: run.kills,
    seed: run.seed,
    tempo: {
      step: time.step,
      playStep: play.step,
      hitStop: tempo.hitStopUntil !== null && !Clock.reached(time, tempo.hitStopUntil),
      slowScale: tempo.slowUntil !== null && !Clock.reached(time, tempo.slowUntil) ? 1 / tempo.slowPeriod : 1,
      frozen: player?.state === "Special"
    },
    player,
    enemies,
    projectiles,
    seams: queries.seams.each().map((entity): SeamView => {
      const seam = queries.seams.data.seam.get(entity)
      return {
        id: entity.id,
        owner: seam.owner,
        x: seam.x,
        z: seam.z,
        dirX: seam.dirX,
        dirZ: seam.dirZ,
        length: seamFront(seam, play),
        reach: seam.length,
        halfWidth: seam.halfWidth,
        burn: progressTo(play, seam.endAt, seam.liveSteps)
      }
    }),
    darts: queries.darts.each().map((entity) => {
      const body = queries.darts.data.body.get(entity)
      return dartView(entity.id, body.x, body.z, queries.darts.data.dart.get(entity))
    }),
    debug: debugView(resources.cheats.get().invulnerable, resources.moves.get(), resources.steer.get(), current.open)
  }
})

const debugView = (invulnerable: boolean, moves: MovesValue, steer: SteerValue, openFloor: boolean): DebugView => {
  const dashTime = moves.dashSteps / step.hz
  return {
    invulnerable,
    moves: { speed: moves.speed, acceleration: moves.acceleration, deceleration: moves.deceleration, dashDistance: moves.dashSpeed * dashTime, dashTime },
    steer: steer._tag === "Held" ? { x: steer.x, z: steer.z } : null,
    openFloor
  }
}
