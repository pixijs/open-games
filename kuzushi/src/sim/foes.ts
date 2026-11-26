import { Clock } from "@typeonce/ritmo"
import type { Random } from "@typeonce/ritmo"

import type { Point } from "./arena.ts"
import { angleOf, dirOf, normalize } from "./geometry.ts"
import type { Dir } from "./geometry.ts"
import type { MomentOf } from "./moments.ts"
import type { Route } from "./paths.ts"
import { Actor, Body, Game, PrevBody, Projectile } from "./schema.ts"
import type { TellValue } from "./schema.ts"
import { inSteps, seconds, secondsOf, step } from "./time.ts"
import type { Duration } from "./time.ts"
import { BRUISER, CHASER, CUTTER, ENEMY, LANCER, LEAPER, ORB, ORBITER, PULSAR, SHOOTER, SPLITLING, SPLITTER, SWEEPER, TRICKSTER, WARDEN } from "./tuning.ts"
import type { BossId, EnemyKind } from "./tuning.ts"

/**
 * Each kind's decisions, as data the enemy state machine in enemies.ts plays: how it walks while waiting, how it
 * opens its attack, what the attack is, and how long it rests after. Bosses decide through src/sim/bosses/.
 */

/** A kind the enemy state machine drives: every kind but the bosses. */
export type FoeKind = Exclude<EnemyKind, BossId>

/** Whether a warden's shell is up: while it winds up and fires a volley, blows clank off it. */
export const shelled = (kind: EnemyKind, state: string): boolean => kind === "warden" && (state === "Windup" || state === "Volley")

/** What an enemy sees of the player this step. */
export interface Sight {
  /** A live player to act on. */
  readonly hunting: boolean
  /** Unit vector to the player, or along the facing when there is none. */
  readonly toward: Dir
  readonly distance: number
  /** Unit vector across `toward`, to the side the enemy strafes or circles. */
  readonly side: Dir
}

export interface Stride {
  readonly desired: Dir
  readonly speed: number
  /** Start the attack this step. */
  readonly attack: boolean
}

const still: Dir = { x: 0, z: 0 }
const away = (dir: Dir): Dir => ({ x: -dir.x, z: -dir.z })

/** Circles at `radius`, steering in or out to hold it. */
const circle = (sight: Sight, radius: number, speed: number, pull: number): Omit<Stride, "attack"> => {
  const radial = (sight.distance - radius) * pull
  const x = sight.side.x + sight.toward.x * radial
  const z = sight.side.z + sight.toward.z * radial
  return { desired: normalize(x, z, sight.side), speed }
}

/**
 * How a kind walks toward its attack. `route` is its way to the player: with a wall or prop between them, every kind
 * walks it round and holds its attack (the trickster blinks past); across an edge it sees them, so it attacks as ever
 * and only walks the way round. `ready` is whether its cooldown is over; `closing` (0 to 1) is how far the orbiter's
 * orbit has tightened.
 */
export const strideOf = (kind: FoeKind, sight: Sight, route: Route, ready: boolean, closing: number): Stride => {
  const { speed } = ENEMY[kind]
  if (!route.sight) return { desired: route.way, speed, attack: ready && kind === "trickster" }
  const rush = (range: number): Stride =>
    ready && sight.distance <= range ? { desired: still, speed: 0, attack: true } : { desired: route.way, speed, attack: false }
  /** Holds a band of distance: backs off inside `near`, closes in past `far` along the route, strafes at `strafe` of its speed between. */
  const band = (near: number, far: number, strafe: number): Omit<Stride, "attack"> => {
    if (sight.distance < near) return { desired: away(sight.toward), speed }
    if (sight.distance > far) return { desired: route.way, speed }
    return { desired: strafe > 0 ? sight.side : still, speed: speed * strafe }
  }
  const within = (min: number, max: number) => sight.distance >= min && sight.distance <= max
  switch (kind) {
    case "chaser": return rush(CHASER.lungeRange)
    case "bruiser": return rush(BRUISER.slamRange)
    case "splitter": return rush(SPLITTER.lungeRange)
    case "splitling": return rush(SPLITLING.lungeRange)
    case "sweeper": return rush(SWEEPER.reach)
    case "shooter": return { ...band(SHOOTER.near, SHOOTER.far, 0.6), attack: ready && within(SHOOTER.minRange, SHOOTER.maxRange) }
    case "lancer": return { ...band(LANCER.near, LANCER.far, 0.5), attack: ready && within(LANCER.minRange, LANCER.maxRange) }
    case "warden": return { ...band(WARDEN.near, WARDEN.far, 0), attack: ready && sight.distance <= WARDEN.range }
    case "pulsar": return { ...band(PULSAR.near, PULSAR.far, 0.4), attack: ready && sight.distance <= PULSAR.range }
    case "cutter": return { ...band(CUTTER.near, CUTTER.far, 0.5), attack: ready && sight.distance <= CUTTER.range }
    case "leaper": return { ...band(0, LEAPER.reach, 0.4), attack: ready && sight.distance <= LEAPER.reach + 1 }
    case "trickster": return { ...circle(sight, TRICKSTER.orbitRadius, speed, 0.5), attack: ready }
    case "orbiter": {
      if (sight.distance > ORBITER.far + 2) return { desired: route.way, speed, attack: false }
      const radius = ORBITER.far + (ORBITER.near - ORBITER.far) * closing
      return { ...circle(sight, radius, speed, 0.6), attack: ready && sight.distance <= ORBITER.far + 1 }
    }
  }
}

/** How an attack opens: a windup with its telegraph, or (the trickster) a blink first. */
export type Opening =
  | { readonly to: "windup"; readonly tell: TellValue; readonly dir: Dir; readonly size: number; readonly windup: Duration }
  | { readonly to: "blink" }

/** What a kind needs to open its attack beyond what it sees: random draws, and how far a straight run gets before a wall or edge. */
export interface Ground {
  readonly random: Random.Random
  readonly reach: (dir: Dir, max: number) => number
}

export const LINE: TellValue = { shape: "line" }
export const RING: TellValue = { shape: "ring" }

export const openingOf = (kind: FoeKind, sight: Sight, ground: Ground): Opening => {
  const line = (size: number, windup: Duration): Opening => ({ to: "windup", tell: LINE, dir: sight.toward, size, windup })
  const ring = (size: number, windup: Duration): Opening => ({ to: "windup", tell: RING, dir: sight.toward, size, windup })
  switch (kind) {
    case "chaser": return line(CHASER.telegraphLength, CHASER.windup)
    case "shooter": return line(Math.min(sight.distance, SHOOTER.maxRange), SHOOTER.windup)
    case "bruiser": return ring(BRUISER.slamRadius, BRUISER.windup)
    case "trickster": return { to: "blink" }
    case "orbiter": return line(sight.distance + ORBITER.overshoot, ORBITER.windup)
    case "warden": return ring(WARDEN.telegraphRadius, WARDEN.windup)
    case "lancer": return line(Math.min(LANCER.reachMax, Math.max(LANCER.reachMin, sight.distance + LANCER.overshoot)), LANCER.windup)
    case "splitter": return line(SPLITTER.telegraphLength, SPLITTER.windup)
    case "splitling": return line(SPLITLING.telegraphLength, SPLITLING.windup)
    case "sweeper": {
      const turn = ground.random.next() < 0.5 ? 1 : -1
      return { to: "windup", tell: { shape: "arc", halfAngle: SWEEPER.span / 2, turn }, dir: sight.toward, size: SWEEPER.radius, windup: SWEEPER.windup }
    }
    case "pulsar": {
      const facing = dirOf(ground.random.range(-Math.PI, Math.PI))
      return { to: "windup", tell: { shape: "arc", halfAngle: Math.PI - PULSAR.gap / 2, turn: 0 }, dir: facing, size: PULSAR.reach, windup: PULSAR.windup }
    }
    case "leaper": return ring(LEAPER.crouchRing, LEAPER.crouch)
    case "cutter": return line(ground.reach(sight.toward, CUTTER.reach), CUTTER.windup)
  }
}

/** The angle of a ring wave's gap: opposite the way its windup's arc faces. */
export const gapOf = (dir: Dir): number => angleOf(dir.x, dir.z) + Math.PI

/** What follows a windup. A lunge runs along the telegraph at `speed` for `time`, then rests for `recover`. */
export type Strike =
  | { readonly to: "lunge"; readonly speed: number; readonly time: Duration; readonly recover: Duration }
  | { readonly to: "burst" }
  | { readonly to: "volley" }
  | { readonly to: "slam" }
  | { readonly to: "sweep" }
  | { readonly to: "pulse" }
  | { readonly to: "leap" }
  | { readonly to: "cut" }

/** The strike after a windup whose telegraph was `size` long: the orbiter's cut and the lancer's charge run its length. */
export const strikeOf = (kind: FoeKind, size: number): Strike => {
  switch (kind) {
    case "chaser": return { to: "lunge", speed: CHASER.lungeSpeed, time: CHASER.lungeTime, recover: CHASER.recover }
    case "trickster": return { to: "lunge", speed: TRICKSTER.dashSpeed, time: TRICKSTER.dashTime, recover: TRICKSTER.recover }
    case "orbiter": return { to: "lunge", speed: ORBITER.cutSpeed, time: seconds(size / ORBITER.cutSpeed), recover: ORBITER.recover }
    case "lancer": return { to: "lunge", speed: LANCER.chargeSpeed, time: seconds(size / LANCER.chargeSpeed), recover: LANCER.recover }
    case "splitter": return { to: "lunge", speed: SPLITTER.lungeSpeed, time: SPLITTER.lungeTime, recover: SPLITTER.recover }
    case "splitling": return { to: "lunge", speed: SPLITLING.lungeSpeed, time: SPLITLING.lungeTime, recover: SPLITLING.recover }
    case "shooter": return { to: "burst" }
    case "warden": return { to: "volley" }
    case "bruiser": return { to: "slam" }
    case "sweeper": return { to: "sweep" }
    case "pulsar": return { to: "pulse" }
    case "leaper": return { to: "leap" }
    case "cutter": return { to: "cut" }
  }
}

/** How long a fresh enemy waits before its first attack. */
export const firstAttackOf = (kind: FoeKind, random: Random.Random): Duration => {
  switch (kind) {
    case "chaser": return seconds(random.range(CHASER.firstMin, CHASER.firstMax))
    case "shooter": return seconds(random.range(SHOOTER.firstShotMin, SHOOTER.firstShotMax))
    case "bruiser": return seconds(BRUISER.first)
    case "trickster": return seconds(random.range(TRICKSTER.orbitMin, TRICKSTER.orbitMax))
    case "orbiter": return seconds(random.range(ORBITER.firstMin, ORBITER.firstMax))
    case "warden": return seconds(random.range(WARDEN.firstMin, WARDEN.firstMax))
    case "lancer": return seconds(random.range(LANCER.firstMin, LANCER.firstMax))
    case "splitter": return seconds(random.range(SPLITTER.firstMin, SPLITTER.firstMax))
    case "splitling": return SPLITLING.cooldown
    case "sweeper": return seconds(random.range(SWEEPER.firstMin, SWEEPER.firstMax))
    case "pulsar": return seconds(random.range(PULSAR.firstMin, PULSAR.firstMax))
    case "leaper": return seconds(random.range(LEAPER.firstMin, LEAPER.firstMax))
    case "cutter": return seconds(random.range(CUTTER.firstMin, CUTTER.firstMax))
  }
}

/** How long after an attack's recovery before the next one may start. */
export const cooldownOf = (kind: FoeKind, random: Random.Random): Duration => {
  switch (kind) {
    case "chaser": return CHASER.cooldown
    case "shooter": return seconds(random.range(SHOOTER.cooldownMin, SHOOTER.cooldownMax))
    case "bruiser": return BRUISER.cooldown
    case "trickster": return seconds(random.range(TRICKSTER.orbitMin, TRICKSTER.orbitMax))
    case "orbiter": return ORBITER.tighten
    case "warden": return WARDEN.cooldown
    case "lancer": return seconds(random.range(LANCER.cooldownMin, LANCER.cooldownMax))
    case "splitter": return SPLITTER.cooldown
    case "splitling": return SPLITLING.cooldown
    case "sweeper": return SWEEPER.cooldown
    case "pulsar": return seconds(random.range(PULSAR.cooldownMin, PULSAR.cooldownMax))
    case "leaper": return LEAPER.cooldown
    case "cutter": return seconds(random.range(CUTTER.cooldownMin, CUTTER.cooldownMax))
  }
}

/** What the enemy and boss brains share: their telegraph moments, their shots, and how far through a timed state they are. */

/** The telegraph moment's extra fields for a tell: an arc's half angle and turn, a spot's centre. */
export const tellFields = (tell: TellValue) => {
  switch (tell.shape) {
    case "arc": return tell.turn === 0 ? { halfAngle: tell.halfAngle } : { halfAngle: tell.halfAngle, turn: tell.turn }
    case "spot": return { spotX: tell.x, spotZ: tell.z }
    case "line":
    case "ring": return {}
  }
}

/** The moment enemy `id` of `kind` shows a telegraph from `from` along `dir`, for `duration`. */
export const telegraphMoment = (id: number, kind: EnemyKind, tell: TellValue, from: Point, dir: Dir, size: number, duration: Duration, feint: boolean): MomentOf<"telegraph"> =>
  ({ type: "telegraph", id, kind, shape: tell.shape, x: from.x, z: from.z, dirX: dir.x, dirZ: dir.z, size, duration: secondsOf(duration), feint, ...tellFields(tell) })

/** An enemy's shot along `aim` from the edge of its body (`radius` round `from`): its spawn, and where and which way it starts. */
export const shotDraft = (kind: "orb" | "needle", from: Point, radius: number, aim: number, speed: number, damage: number, life: Duration, play: Clock.Time<60>) => {
  const dir = dirOf(aim)
  const reach = radius + ORB.radius
  const start = { x: from.x + dir.x * reach, z: from.z + dir.z * reach, facing: aim }
  const draft = Game.Command.spawn(
    [Actor, { kind }],
    [Body, start],
    [PrevBody, start],
    [Projectile, { owner: "enemy", dirX: dir.x, dirZ: dir.z, speed, damage, expiresAt: Clock.deadline(play, life) }]
  )
  return { draft, start, dir }
}

/** How far through a timed state of `steps` steps ending at `endAt` the gameplay clock is, from 0 to 1, now and a step before. */
export const through = (play: Clock.Time<60>, endAt: Clock.Deadline<60>, steps: number): { readonly now: number; readonly before: number } => {
  const elapsed = Math.max(0, steps - Clock.remaining(play, endAt))
  return { now: Math.min(1, elapsed / steps), before: Math.min(1, Math.max(0, elapsed - 1) / steps) }
}

/** How long an arm takes to sweep `span` at `speed` radians a second. */
export const armSweepTime = (span: number, speed: number): Duration => inSteps((span / speed) * step.hz)
