import { Clock } from "@typeonce/ritmo"

import { radians } from "./geometry.ts"
import { step } from "./time.ts"
import type { Duration } from "./time.ts"
import type { WeaponId, WeaponMove } from "./weapons.ts"

/** Every number of the design (docs/DESIGN.md). Distances are world units, speeds units per second. */

export const PLAYER = {
  radius: 0.42,
  speed: 7.5,
  acceleration: 70,
  deceleration: 90,
  /** Fraction of the run speed kept while slashing or parrying. */
  attackMoveFactor: 0.3,
  lives: 5,
  hurtInvulnerability: Clock.duration(step, 1.2),
  hurtKnockback: 8,
  downFor: Clock.duration(step, 1.2),
  start: { x: 0, z: 2 }
} as const

export interface SlashStep {
  readonly windup: Duration
  readonly active: Duration
  readonly recover: Duration
  /** Steps after the active frames end before the next combo step may start. */
  readonly cancel: Duration
  readonly range: number
  /** Half the arc's angle in radians; π is the full spin. */
  readonly halfAngle: number
  readonly damage: number
  readonly lunge: number
  readonly knockback: number
  readonly hitStop: Duration
  /** Which way the arc sweeps across the facing: 1 right to left, -1 left to right, 0 a spin. */
  readonly sweep: 1 | -1 | 0
}

export const SLASH: Readonly<Record<1 | 2 | 3, SlashStep>> = {
  1: {
    windup: Clock.durationOfSteps(step, 3),
    active: Clock.durationOfSteps(step, 5),
    recover: Clock.durationOfSteps(step, 12),
    cancel: Clock.durationOfSteps(step, 2),
    range: 2.3,
    halfAngle: radians(75),
    damage: 1,
    lunge: 9,
    knockback: 5,
    hitStop: Clock.durationOfSteps(step, 3),
    sweep: 1
  },
  2: {
    windup: Clock.durationOfSteps(step, 3),
    active: Clock.durationOfSteps(step, 5),
    recover: Clock.durationOfSteps(step, 12),
    cancel: Clock.durationOfSteps(step, 2),
    range: 2.4,
    halfAngle: radians(80),
    damage: 1,
    lunge: 9,
    knockback: 5,
    hitStop: Clock.durationOfSteps(step, 3),
    sweep: -1
  },
  3: {
    windup: Clock.durationOfSteps(step, 5),
    active: Clock.durationOfSteps(step, 8),
    recover: Clock.durationOfSteps(step, 18),
    cancel: Clock.durationOfSteps(step, 18),
    range: 2.8,
    halfAngle: Math.PI,
    damage: 2,
    lunge: 4,
    knockback: 9,
    hitStop: Clock.durationOfSteps(step, 5),
    sweep: 0
  }
}

export const COMBO = {
  /** How long after a slash ends the next press still continues the combo. */
  grace: Clock.duration(step, 0.3)
} as const

/** What one weapon move does to each enemy it hits (docs/DESIGN.md, Weapons). */
export interface MoveHit {
  readonly damage: number
  readonly knockback: number
  readonly hitStop: Duration
  /** What a boss's balance meter gains per hit. */
  readonly balance: number
  readonly focus: number
  /** How long it staggers an armoured enemy; null when armour only takes the damage. */
  readonly breaks: Duration | null
}

/** A move's frames on the gameplay clock. `cancel`: steps after the active frames end before the chain's next move may start. */
export interface MoveFrames {
  readonly windup: Duration
  readonly active: Duration
  readonly recover: Duration
  readonly cancel: Duration
}

/** A sweep round the hero: the blade's cuts and spin, the breaker's cleave. */
export interface ArcMove extends MoveHit, MoveFrames {
  readonly kind: "arc"
  readonly range: number
  readonly halfAngle: number
  readonly lunge: number
  readonly sweep: 1 | -1 | 0
}

/** The breaker's slam: a hop onto a mark `reach.aim` along the aim (the cursor's spot clamped to `min`..`max`), then a circle round where it lands. */
export interface SlamMove extends MoveHit, MoveFrames {
  readonly kind: "slam"
  readonly radius: number
  readonly reach: { readonly min: number; readonly aim: number; readonly max: number }
}

/** A dart or the pierce: a needle from the hero's tip. `close`: the damage within `range` of the hero, for a point-blank hit. */
export interface ShotMove extends MoveHit, MoveFrames {
  readonly kind: "shot"
  readonly speed: number
  readonly reach: number
  readonly radius: number
  readonly ammo: number
  readonly close: { readonly range: number; readonly damage: number } | null
}

/** A sigil or the seal: a mark placed at the aim as the windup ends, bursting in a circle `delay` later. */
export interface CastMove extends MoveHit, MoveFrames {
  readonly kind: "cast"
  readonly radius: number
  readonly delay: Duration
}

export type MoveSpec = ArcMove | SlamMove | ShotMove | CastMove

const steps = <const N extends number>(count: Clock.ValidSteps<N>): Duration => Clock.durationOfSteps(step, count)
const armourBreak = Clock.duration(step, 0.6)

const bladeMove = (slash: SlashStep, balance: number, breaks: Duration | null): ArcMove => ({ kind: "arc", ...slash, balance, focus: 5, breaks })

/** Every weapon move's frame data and blow. The blade's are the combo's `SLASH` steps. */
export const MOVE = {
  cut: bladeMove(SLASH[1], 2, null),
  crosscut: bladeMove(SLASH[2], 2, null),
  spin: bladeMove(SLASH[3], 6, Clock.duration(step, 0.2)),
  cleave: {
    kind: "arc", windup: steps(9), active: steps(6), recover: steps(16), cancel: steps(4),
    range: 3.0, halfAngle: radians(100), lunge: 6, sweep: 1,
    damage: 2, knockback: 9, hitStop: steps(5), balance: 6, focus: 5, breaks: null
  },
  slam: {
    kind: "slam", windup: steps(18), active: steps(4), recover: steps(24), cancel: steps(24),
    radius: 2.2, reach: { min: 1.5, aim: 2.6, max: 3.5 },
    damage: 4, knockback: 12, hitStop: steps(8), balance: 14, focus: 8, breaks: armourBreak
  },
  dart: {
    kind: "shot", windup: steps(2), active: steps(1), recover: steps(6), cancel: steps(6),
    speed: 26, reach: 14, radius: 0.18, ammo: 1, close: { range: 3, damage: 2 },
    damage: 1, knockback: 3, hitStop: steps(2), balance: 1, focus: 3, breaks: null
  },
  pierce: {
    kind: "shot", windup: steps(1), active: steps(1), recover: steps(12), cancel: steps(12),
    speed: 36, reach: 18, radius: 0.24, ammo: 2, close: null,
    damage: 3, knockback: 7, hitStop: steps(4), balance: 6, focus: 6, breaks: null
  },
  sigil: {
    kind: "cast", windup: steps(6), active: steps(1), recover: steps(7), cancel: steps(7),
    radius: 1.6, delay: steps(25),
    damage: 2, knockback: 6, hitStop: steps(3), balance: 4, focus: 4, breaks: null
  },
  seal: {
    kind: "cast", windup: steps(9), active: steps(1), recover: steps(4), cancel: steps(4),
    radius: 2.4, delay: steps(30),
    damage: 3, knockback: 9, hitStop: steps(5), balance: 10, focus: 6, breaks: armourBreak
  }
} as const satisfies Record<WeaponMove, MoveSpec>

/**
 * How fast each weapon lets the hero move while it attacks (a share of the run speed), and how long the next press
 * still continues its chain: after the move ends, or for the sigil after the cast.
 */
export const WEAPON = {
  blade: { moveFactor: PLAYER.attackMoveFactor, grace: COMBO.grace },
  breaker: { moveFactor: 0.15, grace: Clock.duration(step, 0.35) },
  darts: { moveFactor: 0.7, grace: steps(1) },
  sigil: { moveFactor: 0.5, grace: Clock.duration(step, 1.0) }
} as const satisfies Record<WeaponId, { readonly moveFactor: number; readonly grace: Duration }>

export const DARTS = {
  clip: 6,
  /** The first dart loads after this long without firing, then one every `reloadEvery`. */
  reloadAfter: steps(30),
  reloadEvery: steps(18),
  /** A charge needs this many loaded; it starts as a dart's move ends with the button still held. */
  chargeNeeds: 2,
  charge: steps(27),
  /** A release within this long after the charge is full is perfect. */
  perfect: steps(9),
  perfectDamage: 1,
  perfectFocus: 5,
  chargeFactor: 0.4,
  /** How far ahead of the hero's centre a dart leaves. */
  muzzle: 0.5
} as const

export const SIGIL = {
  /** The cursor's spot is clamped to between `near` and `far` from the hero; with no cursor a sigil goes `free` along the facing. */
  near: 2,
  far: 9,
  free: 5,
  /** At most this many marks wait at once; a cast beyond them waits for one to land. */
  most: 3,
  /** What a reflected orb crossing a waiting mark adds to its burst. */
  orbBonus: 1
} as const

export const DASH = {
  speed: 24,
  time: Clock.duration(step, 0.15),
  /** Invulnerability kept after the dash ends. */
  afterglow: Clock.durationOfSteps(step, 3),
  cooldown: Clock.duration(step, 0.35)
} as const

/** The player's movement numbers the `Moves` resource starts from; the debug hooks may override them. */
export const MOVES = {
  speed: PLAYER.speed,
  acceleration: PLAYER.acceleration,
  deceleration: PLAYER.deceleration,
  dashSpeed: DASH.speed,
  dashSteps: DASH.time.steps
} as const

export const PARRY = {
  window: Clock.duration(step, 0.18),
  time: Clock.duration(step, 0.4),
  cooldown: Clock.duration(step, 0.5),
  reflectSpeedFactor: 1.6,
  reflectDamage: 2,
  /** How far a reflected orb knocks back the enemy it strikes. */
  reflectKnockback: 6,
  stagger: Clock.duration(step, 1.4),
  hitStop: Clock.durationOfSteps(step, 6)
} as const

export const SPECIAL = {
  radius: 9,
  freeze: Clock.duration(step, 0.5),
  hits: 6,
  interval: Clock.durationOfSteps(step, 5),
  hitDamage: 1,
  finalDamage: 3,
  /** The pause after the final blow before control returns. */
  release: Clock.duration(step, 0.35),
  slowFor: Clock.duration(step, 0.7),
  slowPeriod: 3
} as const

export const FOCUS = {
  max: 100,
  slashHit: 5,
  kill: 8,
  parry: 15,
  nearMiss: 10,
  reflectHit: 6
} as const

export const BUFFER = {
  /** How long a pressed action waits for the player to be able to act on it. */
  time: Clock.duration(step, 0.2)
} as const

export const HIT_STOP = {
  kill: Clock.durationOfSteps(step, 6),
  hurt: Clock.durationOfSteps(step, 8)
} as const

export const SLOW = {
  lastKill: Clock.duration(step, 1.0),
  lastKillPeriod: 4,
  down: Clock.duration(step, 1.0),
  downPeriod: 4
} as const

/**
 * Every enemy, in the order a wave's roster takes them in turn: the Courtyard's four, the Spiral's, the Void's (with
 * the splitlings only splitters bring), then the three zone bosses, which only their boss rooms bring in.
 */
export const enemyKinds = [
  "chaser", "shooter", "bruiser", "trickster",
  "orbiter", "warden", "lancer", "splitter", "splitling",
  "sweeper", "pulsar", "leaper", "cutter",
  "gatekeeper", "orrery", "sunder"
] as const
export type EnemyKind = (typeof enemyKinds)[number]

/** Each zone's boss, in zone order (docs/DESIGN.md, Bosses). */
export const bossIds = ["gatekeeper", "orrery", "sunder"] as const satisfies ReadonlyArray<EnemyKind>
export type BossId = (typeof bossIds)[number]

export const isBoss = (kind: EnemyKind): kind is BossId => bossIds.some((boss) => boss === kind)

export interface EnemyStats {
  readonly radius: number
  readonly hp: number
  readonly speed: number
  /** Whether slash hits interrupt it (stagger) or only damage it. */
  readonly armored: boolean
  readonly hitStagger: Duration
  readonly knockbackTaken: number
  /** Whether touching the player while it walks hurts. */
  readonly contact: boolean
}

const hitStagger = Clock.duration(step, 0.2)

export const ENEMY: Readonly<Record<EnemyKind, EnemyStats>> = {
  chaser: { radius: 0.45, hp: 3, speed: 4.2, armored: false, hitStagger, knockbackTaken: 1, contact: true },
  shooter: { radius: 0.45, hp: 2, speed: 3.0, armored: false, hitStagger, knockbackTaken: 1, contact: false },
  bruiser: { radius: 0.7, hp: 8, speed: 2.2, armored: true, hitStagger, knockbackTaken: 0.25, contact: false },
  trickster: { radius: 0.4, hp: 3, speed: 4.8, armored: false, hitStagger, knockbackTaken: 1.2, contact: false },
  orbiter: { radius: 0.5, hp: 3, speed: 5.4, armored: false, hitStagger, knockbackTaken: 1.1, contact: false },
  warden: { radius: 1.0, hp: 14, speed: 1.1, armored: true, hitStagger, knockbackTaken: 0.15, contact: false },
  lancer: { radius: 0.35, hp: 2, speed: 3.2, armored: false, hitStagger, knockbackTaken: 1.3, contact: false },
  splitter: { radius: 0.55, hp: 4, speed: 3.2, armored: false, hitStagger, knockbackTaken: 0.9, contact: false },
  splitling: { radius: 0.3, hp: 1, speed: 6.0, armored: false, hitStagger, knockbackTaken: 1.5, contact: true },
  sweeper: { radius: 0.5, hp: 4, speed: 3.4, armored: false, hitStagger, knockbackTaken: 0.8, contact: false },
  pulsar: { radius: 0.55, hp: 5, speed: 2.0, armored: false, hitStagger, knockbackTaken: 0.6, contact: false },
  leaper: { radius: 0.45, hp: 3, speed: 3.6, armored: false, hitStagger, knockbackTaken: 1.4, contact: false },
  cutter: { radius: 0.45, hp: 3, speed: 3.0, armored: false, hitStagger, knockbackTaken: 1.2, contact: false },
  gatekeeper: { radius: 1.7, hp: 60, speed: 2.4, armored: true, hitStagger, knockbackTaken: 0, contact: false },
  orrery: { radius: 1.6, hp: 90, speed: 0, armored: true, hitStagger, knockbackTaken: 0, contact: false },
  sunder: { radius: 1.8, hp: 120, speed: 3.0, armored: true, hitStagger, knockbackTaken: 0, contact: false }
}

export const SPAWN = {
  /** The time an enemy takes to appear, untouchable and harmless. */
  time: Clock.duration(step, 0.7),
  minDistanceFromPlayer: 7
} as const

export const CHASER = {
  lungeRange: 3.4,
  windup: Clock.duration(step, 0.45),
  telegraphLength: 4.2,
  lungeSpeed: 17,
  lungeTime: Clock.duration(step, 0.22),
  recover: Clock.duration(step, 0.55),
  cooldown: Clock.duration(step, 0.9),
  firstMin: 0.4,
  firstMax: 1.0
} as const

export const SHOOTER = {
  near: 6,
  far: 9.5,
  minRange: 3,
  maxRange: 13,
  windup: Clock.duration(step, 0.6),
  shots: 3,
  shotInterval: Clock.duration(step, 0.12),
  spread: radians(6),
  recover: Clock.duration(step, 0.4),
  cooldownMin: 2.4,
  cooldownMax: 3.2,
  firstShotMin: 1.0,
  firstShotMax: 2.0,
  strafeSwitch: Clock.duration(step, 1.6)
} as const

export const BRUISER = {
  slamRange: 2.6,
  slamRadius: 2.8,
  windup: Clock.duration(step, 0.85),
  recover: Clock.duration(step, 1.0),
  cooldown: Clock.duration(step, 1.2),
  /** Seconds before a fresh bruiser's first slam. */
  first: 0.8
} as const

export const TRICKSTER = {
  orbitRadius: 5,
  blinkTime: Clock.duration(step, 0.3),
  blinkDistanceMin: 3.5,
  blinkDistanceMax: 4.5,
  feintChance: 0.45,
  feint: Clock.duration(step, 0.35),
  windup: Clock.duration(step, 0.38),
  telegraphLength: 4.5,
  dashSpeed: 20,
  dashTime: Clock.duration(step, 0.2),
  recover: Clock.duration(step, 0.7),
  orbitMin: 1.6,
  orbitMax: 2.4
} as const

export const ORBITER = {
  /** The orbit opens at `far` and tightens to `near` over `tighten`, then the cut comes. */
  far: 5,
  near: 2.6,
  tighten: Clock.duration(step, 2.2),
  firstMin: 1.6,
  firstMax: 2.4,
  windup: Clock.duration(step, 0.42),
  /** How far past the player the cut runs. */
  overshoot: 2.5,
  cutSpeed: 18,
  recover: Clock.duration(step, 0.6)
} as const

export const WARDEN = {
  near: 5.5,
  far: 9.5,
  range: 14,
  firstMin: 1.2,
  firstMax: 2.0,
  windup: Clock.duration(step, 0.9),
  telegraphRadius: 2.2,
  shots: 14,
  shotInterval: Clock.duration(step, 0.11),
  arms: 3,
  /** How far the spiral turns between shots, radians. */
  spin: radians(13),
  orbSpeed: 5.5,
  /** The open window after a volley. */
  open: Clock.duration(step, 2.2),
  cooldown: Clock.duration(step, 1.6),
  clankHitStop: Clock.durationOfSteps(step, 2),
  /** Reflected orbs hit it this many times harder, through the shell, and stagger it. */
  reflectFactor: 3,
  reflectStagger: Clock.duration(step, 0.8)
} as const

export const LANCER = {
  near: 6,
  far: 10,
  minRange: 3,
  maxRange: 14,
  firstMin: 1.2,
  firstMax: 2.0,
  cooldownMin: 2.4,
  cooldownMax: 3.2,
  windup: Clock.duration(step, 0.8),
  /** The charge runs this far past the player, clamped between `reachMin` and `reachMax`. */
  overshoot: 4,
  reachMin: 8,
  reachMax: 15,
  chargeSpeed: 22,
  recover: Clock.duration(step, 1.0)
} as const

export const SPLITTER = {
  lungeRange: 3,
  firstMin: 0.5,
  firstMax: 1.0,
  windup: Clock.duration(step, 0.5),
  telegraphLength: 3.8,
  lungeSpeed: 14,
  lungeTime: Clock.duration(step, 0.24),
  recover: Clock.duration(step, 0.6),
  cooldown: Clock.duration(step, 1.0),
  /** Where the two splitlings appear, either side of the killing blow, and how fast they are thrown out. */
  splitOffset: 0.6,
  splitSpeed: 6,
  splitRecover: Clock.duration(step, 0.35)
} as const

export const SPLITLING = {
  lungeRange: 2.4,
  windup: Clock.duration(step, 0.3),
  telegraphLength: 3.0,
  lungeSpeed: 15,
  lungeTime: Clock.duration(step, 0.18),
  recover: Clock.duration(step, 0.45),
  cooldown: Clock.duration(step, 0.8)
} as const

export const SWEEPER = {
  /** It plants this close, then marks its arc. */
  reach: 2.4,
  firstMin: 0.6,
  firstMax: 1.2,
  windup: Clock.duration(step, 0.55),
  /** The arm's length, and the whole arc it sweeps, centred on the player. */
  radius: 2.9,
  span: radians(200),
  /** Radians per second. */
  speed: radians(600),
  recover: Clock.duration(step, 0.6),
  cooldown: Clock.duration(step, 1.0)
} as const

export const PULSAR = {
  near: 6,
  far: 9,
  range: 12,
  firstMin: 1.5,
  firstMax: 2.5,
  cooldownMin: 3.0,
  cooldownMax: 3.8,
  windup: Clock.duration(step, 0.8),
  /** The wave runs from its body out to `reach`, broken by a gap `gap` wide. */
  reach: 6,
  gap: radians(60),
  speed: 10,
  halfWidth: 0.25,
  recover: Clock.duration(step, 0.7)
} as const

export const LEAPER = {
  reach: 7,
  firstMin: 1.0,
  firstMax: 1.8,
  crouch: Clock.duration(step, 0.5),
  /** The ring its crouch draws round it. */
  crouchRing: 1.1,
  air: Clock.duration(step, 0.9),
  /** The landing spot under the player: its radius, how fast it follows them, and for how long before it stops. */
  spot: 1.4,
  follow: 5,
  followFor: Clock.duration(step, 0.6),
  /** Stuck after landing. */
  recover: Clock.duration(step, 0.9),
  cooldown: Clock.duration(step, 1.4)
} as const

export const CUTTER = {
  near: 5,
  far: 9,
  range: 12,
  firstMin: 1.2,
  firstMax: 2.0,
  cooldownMin: 2.8,
  cooldownMax: 3.6,
  windup: Clock.duration(step, 0.7),
  /** The seam runs out along the telegraph to `reach` (or the first wall or edge) at `speed`, and burns for `live`. */
  reach: 10,
  speed: 20,
  live: Clock.duration(step, 2.0),
  halfWidth: 0.2,
  /** Seams one cutter keeps burning at once; a new one closes its oldest. */
  most: 2,
  recover: Clock.duration(step, 0.8)
} as const

/** An elite: any wave kind, tougher, larger and quicker to attack, under a white crown. */
export const ELITE = {
  health: 3,
  radius: 1.3,
  knockbackTaken: 0.5,
  windup: 0.85
} as const

/** A body's radius on the ground: its kind's, larger for an elite. */
export const radiusOf = (kind: EnemyKind, elite = false): number => ENEMY[kind].radius * (elite ? ELITE.radius : 1)

/** What every boss shares (docs/DESIGN.md, Bosses). Balance runs 0 to 100. */
export const BOSS = {
  /** The name card: the gameplay clock holds this long. */
  intro: Clock.duration(step, 2.0),
  shift: Clock.duration(step, 1.6),
  /** The roar at a shift: a ring out to `roarReach` over `roarTime` that pushes the player back at `roarPush`. */
  roarReach: 9,
  roarTime: Clock.duration(step, 0.5),
  roarPush: 6,
  /** Rest between patterns, by phase. */
  rest: [Clock.duration(step, 0.9), Clock.duration(step, 0.7), Clock.duration(step, 0.5)],
  /** The least a pattern leaves the boss open after it. */
  open: Clock.duration(step, 0.6),
  balance: {
    max: 100,
    parry: 25,
    reflect: 12,
    decay: 8,
    calm: Clock.duration(step, 2.5)
  },
  broken: Clock.duration(step, 3.0),
  brokenDamage: 1.5,
  brokenSpecial: 2,
  /** Open after a stun or a split's rejoin: blows land harder. */
  stunnedDamage: 1.5,
  /** The defeat: slow motion while it breaks apart, then it is gone. */
  defeat: Clock.duration(step, 1.5),
  defeatPeriod: 4,
  /** How close a walking boss comes to the player before it stops. */
  standOff: 1.6,
  /** The hit-stop as a boss shifts to its next phase, and as its balance breaks. */
  shiftHitStop: Clock.durationOfSteps(step, 8),
  breakHitStop: Clock.durationOfSteps(step, 6)
} as const

export const GATEKEEPER = {
  start: { x: 0, z: -4 },
  slam: { windup: Clock.duration(step, 1.0), inner: 3.6, outer: 6.0, echo: Clock.duration(step, 0.35), recover: Clock.duration(step, 0.8) },
  charge: { windup: Clock.duration(step, 0.8), length: 16, speed: 20, stun: Clock.duration(step, 1.5), recover: Clock.duration(step, 0.8) },
  fan: {
    windup: Clock.duration(step, 0.7),
    spread: radians(60),
    lines: 5,
    telegraph: 9,
    bursts: 4,
    interval: Clock.duration(step, 0.25),
    orbs: 5,
    recover: Clock.duration(step, 0.6)
  },
  blink: {
    out: Clock.duration(step, 0.3),
    beside: 4.5,
    feintChance: 0.4,
    feint: Clock.duration(step, 0.35),
    windup: Clock.duration(step, 0.45),
    length: 9,
    halfWidth: 0.6,
    recover: Clock.duration(step, 0.7)
  },
  /** What its shift summons, by the phase it starts. */
  summons: [["chaser", "chaser", "shooter"]]
} as const

export const ORRERY = {
  start: { x: 0, z: 0 },
  /** Its three moons' orbit while they rest. */
  orbit: 3,
  /** Radians per second the moons turn round the Orrery while they rest. */
  orbitSpin: 0.9,
  moonRadius: 0.5,
  volley: {
    windup: Clock.duration(step, 0.9),
    telegraph: 2.6,
    shots: 20,
    interval: Clock.duration(step, 0.1),
    arms: 4,
    spin: radians(11),
    orbSpeed: 5.5,
    open: Clock.duration(step, 1.8)
  },
  moons: {
    /** Out of orbit to the circle round the player. */
    leave: Clock.duration(step, 0.4),
    far: 5,
    near: 2.6,
    tighten: Clock.duration(step, 1.6),
    /** Radians per second round the player. */
    spin: 2.4,
    /** How fast the circle's centre follows the player. */
    chase: 6,
    stagger: Clock.duration(step, 0.25),
    aim: Clock.duration(step, 0.42),
    overshoot: 2.5,
    speed: 18,
    back: Clock.duration(step, 0.5),
    recover: Clock.duration(step, 0.6)
  },
  hands: { windup: Clock.duration(step, 0.8), radius: 7, safe: 2.2, span: radians(180), speed: radians(300), recover: Clock.duration(step, 0.7) },
  pulse: { windup: Clock.duration(step, 0.8), waves: 3, interval: Clock.duration(step, 0.6), reach: 12, gap: radians(60), speed: 10, halfWidth: 0.3, recover: Clock.duration(step, 0.6) },
  summons: [["orbiter", "orbiter"]],
  /** The beam it becomes the spire of from phase 2. */
  beam: { from: 1.6, speed: radians(40), sweep: radians(270), rest: Clock.duration(step, 3) }
} as const

export const SUNDER = {
  start: { x: 0, z: -3 },
  /** `lifePad`: how far past `length` a needle flies before it is gone. */
  needles: { windup: Clock.duration(step, 0.8), spread: radians(25), length: 16, speed: 26, open: Clock.duration(step, 0.8), lifePad: 4 },
  lunge: { windup: Clock.duration(step, 0.6), length: 7, speed: 16, time: Clock.duration(step, 0.4), recover: Clock.duration(step, 0.6) },
  leap: {
    crouch: Clock.duration(step, 0.4),
    air: Clock.duration(step, 1.1),
    spot: 2.6,
    follow: 5.5,
    followFor: Clock.duration(step, 0.7),
    recover: Clock.duration(step, 0.8),
    /** The crouch's ring telegraph: this far past Sunder's body. */
    ring: 0.9
  },
  seams: { windup: Clock.duration(step, 0.7), count: 4, reach: 14, speed: 20, live: Clock.duration(step, 2.0), halfWidth: 0.25, recover: Clock.duration(step, 0.6) },
  /** `ring`: the windup's ring telegraph, this far past Sunder's body. */
  split: { time: Clock.duration(step, 8), rejoin: Clock.duration(step, 1.0), open: Clock.duration(step, 1.6), rest: Clock.duration(step, 0.5), offset: 1.6, windup: Clock.duration(step, 0.6), ring: 1.4 },
  /** What each shift summons, by the phase it starts. */
  summons: [["lancer", "lancer"], ["splitter", "splitter"]]
} as const

/** A needle Sunder fires: a projectile drawn as a needle, flying off into the void. */
export const NEEDLE = { radius: 0.18, damage: 1 } as const

export const RING_OUT = {
  /** How long an enemy falls after leaving the floor before it is gone. */
  fall: Clock.duration(step, 0.8),
  /** Knockback faster than this carries an enemy over an edge. */
  knockedSpeed: 1,
  /** How fast a falling enemy's drift fades, per second. */
  driftDecay: 2
} as const

export const ORB = {
  radius: 0.22,
  speed: 8.5,
  damage: 1,
  life: Clock.duration(step, 3),
  /** How fast a reflected orb turns toward the nearest enemy, radians per second. */
  homing: 6
} as const

export const ENEMY_BODY = {
  /** How fast hit knockback fades, per second. */
  knockbackDecay: 10,
  /** How long after a stagger before an enemy may attack again. */
  staggerCooldown: Clock.duration(step, 0.6)
} as const

/** How many of each kind a wave sends. */
export type WaveEntry = Readonly<Record<EnemyKind, number>>

const NONE: WaveEntry = {
  chaser: 0, shooter: 0, bruiser: 0, trickster: 0, orbiter: 0, warden: 0, lancer: 0, splitter: 0, splitling: 0,
  sweeper: 0, pulsar: 0, leaper: 0, cutter: 0, gatekeeper: 0, orrery: 0, sunder: 0
}

/** A wave from the kinds it sends; every other kind sends none. */
export const wave = (counts: Partial<WaveEntry>): WaveEntry => ({ ...NONE, ...counts })

/** How many enemies a wave sends; 0 for a wave that does not exist. */
export const sizeOf = (entry: WaveEntry | undefined): number =>
  entry === undefined ? 0 : enemyKinds.reduce((sum, kind) => sum + entry[kind], 0)

/** A room's waves (docs/DESIGN.md, Waves in rooms): each zone's pools of entries are in src/sim/dungeon/pools.ts. */
export const WAVE = {
  /** The banner before a wave's first enemy. */
  intro: Clock.duration(step, 1.0),
  spawnInterval: Clock.duration(step, 0.25),
  /** The pause after a wave's last kill before the next wave's banner. */
  breath: Clock.duration(step, 1.0)
} as const
