import { Descriptor, Random, Schema } from "@typeonce/ritmo"
import type { InputCapture } from "@typeonce/ritmo-browser"
import { z } from "zod"

import type { ControlsInput } from "./controls.ts"
import { drillModes, playerActions } from "./moments.ts"
import type { Intent, Moment } from "./moments.ts"
import { stageIds } from "./stages.ts"
import { deadline, PlayTime, Time } from "./time.ts"
import { bossPatterns } from "./bosses.ts"
import { Dungeon, roomGround, Transition } from "./dungeon/schema.ts"
import { bossIds, enemyKinds, FOCUS } from "./tuning.ts"
import type { EnemyKind } from "./tuning.ts"
import { weaponIds, weaponMoves } from "./weapons.ts"
import { zoneIds } from "./zones.ts"

const actorKinds = ["player", ...enemyKinds, "orb", "dart", "needle"] as const
export type ActorKind = (typeof actorKinds)[number]

/** The enemy kind an actor is, or undefined for the player, an orb or a dart. */
export const enemyKindOf = (kind: ActorKind): EnemyKind | undefined => enemyKinds.find((each) => each === kind)

const unit = z.number().min(-1).max(1)
const comboStep = z.union([z.literal(1), z.literal(2), z.literal(3)])

/** What an entity is; decides which visual the renderer makes for it. */
export const Actor = Descriptor.ConstructedComponent(z.object({ kind: z.enum(actorKinds) }))("Game/Actor", { immutable: true })

/** Where an actor stands on the ground plane and which way it faces (radians, 0 is +x, π/2 is +z). */
export const Body = Descriptor.ConstructedComponent(z.object({ x: z.number(), z: z.number(), facing: z.number() }))("Game/Body")

/** `Body` at the start of the latest gameplay step, for drawing between steps. */
export const PrevBody = Descriptor.ConstructedComponent(z.object({ x: z.number(), z: z.number(), facing: z.number() }))("Game/PrevBody")

/** Velocity in units per second: the player's run and every actor's knockback. */
export const Motion = Descriptor.ConstructedComponent(z.object({ vx: z.number(), vz: z.number() }))("Game/Motion")

export const Health = Descriptor.ConstructedComponent(z.object({ hp: z.number(), max: z.number() }))("Game/Health")

/** The last swing that hit this enemy, so one swing hits it once. */
export const HitMark = Descriptor.ConstructedComponent(z.object({ swing: z.int() }))("Game/HitMark")

/** What the player is doing. Each state holds the deadlines only it needs (on the gameplay clock unless noted). */
export const PlayerState = Descriptor.EntityState("Game/PlayerState", {
  Free: {},
  /** One move of the weapon in hand, `step` of its chain, aimed along (dirX, dirZ); `swing` names it to the enemies it hits. */
  Attack: z.object({
    move: z.enum(weaponMoves),
    step: comboStep,
    swing: z.int(),
    dirX: unit,
    dirZ: unit,
    activeAt: deadline,
    recoverAt: deadline,
    cancelAt: deadline,
    endAt: deadline
  }),
  /** The breaker's slam: through the windup a hop from (fromX, fromZ) onto its mark at (toX, toZ), then the slam where it lands. */
  Slam: z.object({
    swing: z.int(),
    dirX: unit,
    dirZ: unit,
    fromX: z.number(),
    fromZ: z.number(),
    toX: z.number(),
    toZ: z.number(),
    activeAt: deadline,
    recoverAt: deadline,
    endAt: deadline
  }),
  /** Darts: the attack held on after a dart, charging the pierce: full at `fullAt`, a perfect release until `perfectUntil`. */
  Charge: z.object({ fullAt: deadline, perfectUntil: deadline }),
  Dash: z.object({ dirX: unit, dirZ: unit, endAt: deadline, nearMiss: z.boolean() }),
  Parry: z.object({ windowEnd: deadline, endAt: deadline }),
  /** On the run clock: the world is frozen while the finisher plays. */
  Special: z.object({ x: z.number(), z: z.number(), nextHitAt: deadline, hits: z.int(), kills: z.int(), endAt: deadline.nullable() }),
  /** On the run clock: the beat before the game over screen. */
  Down: z.object({ until: deadline })
}, {
  transitions: {
    Free: ["Attack", "Slam", "Dash", "Parry", "Special", "Down"],
    Attack: ["Attack", "Slam", "Charge", "Free", "Dash", "Special", "Down"],
    Slam: ["Free", "Dash", "Special", "Down"],
    Charge: ["Attack", "Free", "Dash", "Special", "Down"],
    Dash: ["Free", "Special"],
    Parry: ["Free", "Dash", "Special", "Down"],
    Special: ["Free"],
    Down: []
  }
})

export type PlayerStateValue = Descriptor.EntityStateOf<typeof PlayerState>

/** The player's cooldowns and protection, all on the gameplay clock. */
export const Vitals = Descriptor.ConstructedComponent(z.object({
  invulnerableUntil: deadline.nullable(),
  dashReadyAt: deadline.nullable(),
  parryReadyAt: deadline.nullable(),
  comboNext: comboStep,
  comboUntil: deadline.nullable()
}))("Game/Vitals")

const turn = z.union([z.literal(1), z.literal(-1)])

/**
 * How a windup's telegraph is drawn: a line along `dir`, a ring round the attacker, an arc of `halfAngle` either side
 * of `dir` that sweeps the way `turn` says (0: it doesn't sweep, as a pulsar's ring with its gap behind `dir`), or a
 * spot on the ground at (x, z).
 */
export const Tell = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("line") }),
  z.object({ shape: z.literal("ring") }),
  z.object({ shape: z.literal("arc"), halfAngle: z.number(), turn: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }),
  z.object({ shape: z.literal("spot"), x: z.number(), z: z.number() })
])
export type TellValue = z.infer<typeof Tell>

const point = z.object({ x: z.number(), z: z.number() })
const aimLine = z.object({ x: z.number(), z: z.number(), dirX: unit, dirZ: unit })

/**
 * What an enemy is doing. Every kind shares these states and uses the ones its behaviour needs; a boss plays its
 * patterns through them too (src/sim/bosses/). A state's numbers beyond its deadlines come from its kind's tuning.
 */
export const EnemyState = Descriptor.EntityState("Game/EnemyState", {
  Spawning: z.object({ readyAt: deadline }),
  Move: z.object({ attackAt: deadline, strafe: turn, switchAt: deadline }),
  /** `size` is the telegraph's line length or ring radius; `steps` the windup's whole length, for its progress. */
  Windup: z.object({ endAt: deadline, dirX: unit, dirZ: unit, feint: z.boolean(), size: z.number(), steps: z.int().min(1), tell: Tell }),
  Lunge: z.object({ endAt: deadline, dirX: unit, dirZ: unit }),
  /** Shots one after another: the shooter re-aims each, a boss's fan fires round `angle`. */
  Burst: z.object({ shotsLeft: z.int(), nextShotAt: deadline, angle: z.number() }),
  /** The warden's spiral: each shot fires its arms from `angle`, which turns by `turn` between shots. */
  Volley: z.object({ shotsLeft: z.int(), nextShotAt: deadline, angle: z.number(), turn }),
  /** An arm (two for the Orrery's hands) sweeping round the attacker from `from` the way `turn` says. */
  Sweep: z.object({ endAt: deadline, steps: z.int().min(1), from: z.number(), turn }),
  /** Ring waves running out from the body, one leaving every interval, each with a gap centred on its angle in `gaps`. */
  Pulse: z.object({ endAt: deadline, steps: z.int().min(1), gaps: z.array(z.number()).readonly() }),
  /** Airborne from (fromX, fromZ) to the spot, which follows the player until `followUntil`, then holds. */
  Leap: z.object({ endAt: deadline, steps: z.int().min(1), fromX: z.number(), fromZ: z.number(), spotX: z.number(), spotZ: z.number(), followUntil: deadline }),
  /** Drawing seams: held still while they run out. */
  Cut: z.object({ endAt: deadline }),
  /** The Gatekeeper's slam: its second ring strikes at `endAt`. */
  Quake: z.object({ endAt: deadline }),
  /** The Orrery's moons hunting the player: the circle's centre, its turn, and each moon's locked cut once it aims. */
  Moons: z.object({ endAt: deadline, steps: z.int().min(1), centerX: z.number(), centerZ: z.number(), spin: turn, lines: z.array(aimLine.nullable()).readonly() }),
  /** Carried in a straight line from one point to another: Sunder's halves rejoining. */
  Glide: z.object({ endAt: deadline, steps: z.int().min(1), from: point, to: point }),
  Recover: z.object({ endAt: deadline }),
  Stagger: z.object({ endAt: deadline }),
  Blink: z.object({ endAt: deadline, toX: z.number(), toZ: z.number() }),
  /** Off the floor: dead, drifting down until it is gone. */
  Falling: z.object({ endAt: deadline })
}, {
  transitions: {
    Spawning: ["Move", "Falling"],
    Move: ["Windup", "Blink", "Moons", "Glide", "Recover", "Stagger", "Falling"],
    Windup: ["Windup", "Lunge", "Burst", "Volley", "Sweep", "Pulse", "Leap", "Cut", "Quake", "Recover", "Stagger", "Falling"],
    Lunge: ["Recover", "Stagger", "Falling"],
    Burst: ["Recover", "Stagger", "Falling"],
    Volley: ["Recover", "Stagger", "Falling"],
    Sweep: ["Recover", "Stagger", "Falling"],
    Pulse: ["Recover", "Stagger", "Falling"],
    Leap: ["Recover", "Stagger", "Falling"],
    Cut: ["Recover", "Stagger", "Falling"],
    Quake: ["Recover", "Stagger", "Falling"],
    Moons: ["Recover", "Stagger", "Falling"],
    Glide: ["Recover", "Stagger", "Falling"],
    Recover: ["Move", "Stagger", "Falling"],
    Stagger: ["Move", "Recover", "Falling"],
    Blink: ["Windup", "Recover", "Falling"],
    Falling: []
  }
})

export type EnemyStateValue = Descriptor.Descriptor.Value<typeof EnemyState>

/** An elite: three times the health, larger, quicker to attack, harder to knock back. */
export const Elite = Descriptor.ConstructedComponent(z.object({}))("Game/Elite", { immutable: true })

/**
 * Where a boss fight is. `Arrived`: its name card is next. The card holds the gameplay clock, so `Intro` and `Felled`
 * (its defeat's slow motion) end on the run clock; `Shift` (between phases, invulnerable) and `Broken` on the gameplay
 * clock. `startedAt` is the shift's first gameplay step, for its roar.
 */
export const BossState = Descriptor.EntityState("Game/BossState", {
  Arrived: {},
  Intro: z.object({ until: deadline }),
  Fighting: {},
  Shift: z.object({ until: deadline, startedAt: z.int() }),
  Broken: z.object({ until: deadline }),
  Felled: z.object({ until: deadline })
}, {
  transitions: {
    Arrived: ["Intro", "Fighting", "Shift"],
    Intro: ["Fighting", "Shift"],
    Fighting: ["Shift", "Broken", "Felled"],
    Shift: ["Fighting", "Felled"],
    Broken: ["Fighting", "Shift", "Felled"],
    Felled: []
  }
})

export type BossStateValue = Descriptor.Descriptor.Value<typeof BossState>

/**
 * A boss's run of its fight: its phase (1-based), its balance meter (0 to 100) and when it starts to drain, where it is
 * in its phase's patterns, the one it plays now and the one before, a pattern the debug hooks asked for next, and
 * (Sunder) when its split ends.
 */
export const Boss = Descriptor.ConstructedComponent(z.object({
  boss: z.enum(bossIds),
  phase: z.int().min(1),
  balance: z.number().min(0),
  calmAt: deadline.nullable(),
  cursor: z.int().min(0),
  pattern: z.enum(bossPatterns).nullable(),
  last: z.enum(bossPatterns).nullable(),
  forced: z.enum(bossPatterns).nullable(),
  split: deadline.nullable()
}))("Game/Boss")

export type BossValue = Descriptor.Descriptor.Value<typeof Boss>

/** Sunder's second half while it is split: blows on it land on the boss. */
export const Twin = Descriptor.ConstructedComponent(z.object({ boss: z.int() }))("Game/Twin", { immutable: true })

/**
 * A burning seam on the floor (a cutter's, Sunder's): it runs out from (x, z) along its direction to `length` by
 * `grownAt`, over `growSteps`, and burns until `endAt`. `owner` is the enemy that drew it.
 */
export const Seam = Descriptor.ConstructedComponent(z.object({
  owner: z.int(),
  x: z.number(),
  z: z.number(),
  dirX: unit,
  dirZ: unit,
  length: z.number(),
  halfWidth: z.number(),
  grownAt: deadline,
  growSteps: z.int().min(1),
  endAt: deadline,
  liveSteps: z.int().min(1)
}))("Game/Seam")

/** A training enemy from the debug hooks: `idle` has its AI off; a `dummy` also never dies and is never moved. */
export const Drill = Descriptor.ConstructedComponent(z.object({ mode: z.enum(drillModes) }))("Game/Drill", { immutable: true })

/** A flying orb: who it can hurt, where it is going, and when it fades. */
export const Projectile = Descriptor.ConstructedComponent(z.object({
  owner: z.enum(["enemy", "player"]),
  dirX: unit,
  dirZ: unit,
  speed: z.number(),
  damage: z.number(),
  expiresAt: deadline
}))("Game/Projectile")

/**
 * A dart in flight from the player: a dart or the charged pierce, which passes through every enemy on its line.
 * `swing` marks the enemies it hit, so a pierce hits each once; `damage` already holds a perfect release's bonus.
 */
export const Dart = Descriptor.ConstructedComponent(z.object({
  move: z.enum(["dart", "pierce"]),
  dirX: unit,
  dirZ: unit,
  damage: z.number(),
  perfect: z.boolean(),
  swing: z.int(),
  expiresAt: deadline
}))("Game/Dart")

export const Rng = Descriptor.ConstructedResource(Random.codec)("Game/Rng")

/**
 * The run's score sheet. Steps are on the run clock. `from` is the zone the run started in; `rooms` counts the rooms
 * cleared and `hits` the hits taken, for its rank.
 */
export const Run = Descriptor.ConstructedResource(z.object({
  lives: z.int().min(0),
  focus: z.number().min(0),
  startedAt: z.int(),
  endedAt: z.int().nullable(),
  swings: z.int(),
  kills: z.int(),
  seed: z.int(),
  from: z.enum(zoneIds),
  rooms: z.int().min(0),
  hits: z.int().min(0)
}))("Game/Run")

export type RunValue = Descriptor.Descriptor.Value<typeof Run>

/** `run` with `amount` more FOCUS, up to full; `filled` when this gain is the one that filled it. */
export const gainFocus = (run: RunValue, amount: number): { readonly run: RunValue; readonly filled: boolean } => {
  const focus = Math.min(FOCUS.max, run.focus + amount)
  return { run: { ...run, focus }, filled: run.focus < FOCUS.max && focus >= FOCUS.max }
}

/**
 * Where the current room's fight is (src/sim/waves.ts). `Idle`: nothing to fight (a room without a fight, one
 * already cleared, the sandbox). `Arming`: the doors lock once the player stands inside and `until` passes (null while
 * a transition holds control). Then each of `total` waves: its banner (`Intro`), its enemies appearing and fought
 * (`Fighting`, `size` of them), the breath after it (`Breath`). `Clearing`: the room's last kill, its seals breaking at
 * `until`; `Won`: the last boss is down and the results come at `until`. Intro, Fighting and Breath deadlines are on
 * the gameplay clock, Clearing and Won on the run clock.
 */
export const Waves = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Idle") }),
  z.object({ _tag: z.literal("Arming"), until: deadline.nullable() }),
  z.object({ _tag: z.literal("Intro"), wave: z.int().min(1), total: z.int().min(1), until: deadline }),
  z.object({ _tag: z.literal("Fighting"), wave: z.int().min(1), total: z.int().min(1), spawned: z.int(), size: z.int(), nextSpawnAt: deadline }),
  z.object({ _tag: z.literal("Breath"), wave: z.int().min(1), total: z.int().min(1), until: deadline }),
  z.object({ _tag: z.literal("Clearing"), until: deadline }),
  z.object({ _tag: z.literal("Won"), until: deadline })
]))("Game/Waves")

/** Hit-stop and slow motion, on the run clock: the gameplay clock holds while hit-stop lasts and skips beats in slow motion. */
export const Tempo = Descriptor.ConstructedResource(z.object({
  hitStopUntil: deadline.nullable(),
  slowUntil: deadline.nullable(),
  slowPeriod: z.int().min(1)
}))("Game/Tempo")

/** Where the mouse points on the ground, or `Free` when the player steers by keys alone. */
export const Aim = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Free") }),
  z.object({ _tag: z.literal("Point"), x: z.number(), z: z.number() })
]))("Game/Aim")

/** One pressed action waiting until the player can act on it, on the run clock. */
export const Buffer = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Empty") }),
  z.object({ _tag: z.literal("Held"), action: z.enum(playerActions), until: deadline })
]))("Game/Buffer")

/**
 * The ground bodies stand on: the zone (`id`), the room of its dungeon the player is in (null on the zone's classic
 * arena, the sandbox), whether the hazard is switched on, and whether the debug scenes swapped the floor for the open
 * floor (its size, no props); a new run puts the floor back. `groundOf` in ground.ts turns it into terrain.
 */
export const CurrentStage = Descriptor.ConstructedResource(z.object({
  id: z.enum(stageIds),
  hazard: z.boolean(),
  open: z.boolean(),
  room: roomGround.nullable()
}))("Game/Stage")

/**
 * The stage's hazard, on the gameplay clock. The Spiral's beam rests, shows its telegraph, then sweeps from `from`
 * (its angle at any step follows from the deadline); The Void's floor stands with `fallen` slab groups gone, or cracks
 * before the next group falls.
 */
export const Hazard = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("None") }),
  z.object({ _tag: z.literal("BeamRest"), until: deadline, angle: z.number() }),
  z.object({ _tag: z.literal("BeamWarn"), until: deadline, angle: z.number() }),
  z.object({ _tag: z.literal("BeamSweep"), until: deadline, from: z.number() }),
  z.object({ _tag: z.literal("FloorSteady"), fallen: z.int().min(0) }),
  z.object({ _tag: z.literal("FloorCracking"), fallen: z.int().min(0), until: deadline })
]))("Game/Hazard")

/** The weapon in the player's hand. A new run starts with the blade unless it names another. */
export const Loadout = Descriptor.ConstructedResource(z.object({
  weapon: z.enum(weaponIds),
  /** Darts loaded, and when the next one loads (gameplay clock; null while the clip is full). Kept full for the other weapons. */
  loaded: z.int().min(0),
  reloadAt: deadline.nullable(),
  /** Sigils and seals waiting on the ground: each bursts at `landAt`, `steps` after its cast; `id` is the cast's swing. */
  marks: z.array(z.object({
    id: z.int(),
    move: z.enum(["sigil", "seal"]),
    x: z.number(),
    z: z.number(),
    radius: z.number(),
    landAt: deadline,
    steps: z.int().min(1)
  })).readonly()
}))("Game/Loadout")

/** Debug: the attack button held down as if by a finger, until `until` on the gameplay clock (for the darts' charge). */
export const Trigger = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Free") }),
  z.object({ _tag: z.literal("Held"), until: deadline })
]))("Game/Trigger")

/** Debug: the player takes no hits. Lasts across runs. */
export const Cheats = Descriptor.ConstructedResource(z.object({ invulnerable: z.boolean() }))("Game/Cheats")

/** Debug: a move direction held as if on the stick, until released. */
export const Steer = Descriptor.ConstructedResource(z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Free") }),
  z.object({ _tag: z.literal("Held"), x: unit, z: unit })
]))("Game/Steer")

/** The player's movement numbers: tuning.ts unless the debug hooks override them. Lasts across runs. */
export const Moves = Descriptor.ConstructedResource(z.object({
  speed: z.number().positive(),
  acceleration: z.number().positive(),
  deceleration: z.number().positive(),
  dashSpeed: z.number().positive(),
  dashSteps: z.int().min(1)
}))("Game/Moves")

export const Input = Descriptor.TransientResource<InputCapture.SnapshotOf<typeof ControlsInput>>()("Game/Input")

/** Requests from the host: aim, flow and debug. */
export const Intents = Descriptor.Event<Intent>()("Game/Intents")

/** What happened this step, for effects, camera, UI and tests. */
export const Moments = Descriptor.Event<Moment>()("Game/Moments")

/**
 * Moves a hit asks of the combat system: an enemy's lunge, slam, sweep or contact reaching for the player, centred where
 * it reaches. `melee` blows can be parried; the rest (a pulsar's wave, a seam) can only be dashed through.
 */
export interface Strike {
  readonly id: number
  readonly x: number
  readonly z: number
  readonly radius: number
  readonly dirX: number
  readonly dirZ: number
  readonly melee: boolean
}
export const Strikes = Descriptor.Event<Strike>()("Game/Strikes")

/** A stage hazard reaching the player: the beam's line, or a slab falling from under them. */
export interface HazardHit {
  readonly hazard: "beam" | "fall"
  readonly x: number
  readonly z: number
  readonly dirX: number
  readonly dirZ: number
}
export const HazardHits = Descriptor.Event<HazardHit>()("Game/HazardHits")

/** Debug: start an attack now, for one enemy by id or every enemy. */
export const Orders = Descriptor.Event<{ readonly id: number | null }>()("Game/Orders")

/** Debug: a blow on one enemy, resolved as that step of the player's slash landing on it from the player's side. */
export interface Blow {
  readonly id: number
  readonly damage: number
  readonly step: 1 | 2 | 3
}
export const Blows = Descriptor.Event<Blow>()("Game/Blows")

const schema = Schema.fragment({
  components: { Actor, Body, PrevBody, Motion, Health, HitMark, PlayerState, Vitals, EnemyState, Drill, Projectile, Dart, Elite, BossState, Boss, Twin, Seam },
  resources: { Time, PlayTime, Rng, Run, Waves, Tempo, Aim, Buffer, CurrentStage, Hazard, Loadout, Trigger, Cheats, Steer, Moves, Input, Dungeon, Transition },
  events: { Intents, Moments, Strikes, HazardHits, Orders, Blows }
})
type SchemaOf = typeof schema
export interface GameSchema extends SchemaOf {}
const named: GameSchema = schema

export const Root = Schema.defineRoot("Game")
export const Game = Schema.bind(named, Root)

/**
 * The game's screens. Pause sits on top of a run; the run's state lives in resources, so it survives the pause.
 * RunClear is the won run's results; GameOver the lost run's.
 */
export const Flow = Game.StateMachine("Game/Flow", {
  Title: {},
  Playing: {},
  Paused: {},
  RunClear: {},
  GameOver: {}
}, {
  transitions: {
    Title: ["Playing"],
    Playing: ["Paused", "RunClear", "GameOver"],
    Paused: ["Playing", "Title"],
    RunClear: ["Playing", "Title"],
    GameOver: ["Playing", "Title"]
  }
})

export type FlowState = keyof typeof Flow.states

type ValueOf<D extends Descriptor.Descriptor.Any> = Descriptor.Descriptor.Value<D>
export type BodyValue = ValueOf<typeof Body>
export type TempoValue = ValueOf<typeof Tempo>
export type HazardValue = ValueOf<typeof Hazard>
export type WavesValue = ValueOf<typeof Waves>
export type StageValue = ValueOf<typeof CurrentStage>
export { Dungeon, Transition }
export type MovesValue = ValueOf<typeof Moves>
export type SteerValue = ValueOf<typeof Steer>
export type LoadoutValue = ValueOf<typeof Loadout>
export type AimValue = ValueOf<typeof Aim>
export type DartValue = ValueOf<typeof Dart>
