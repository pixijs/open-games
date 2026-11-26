import { Tuning } from "../sim/index.ts"
import type { BossView, EnemyView, GameView, HitShape, PlayerView, SeamView, TelegraphShape, WeaponView } from "../sim/index.ts"
import type { MomentBus } from "../host/types.ts"
import { toSteps } from "./frames.ts"
import { INK } from "./sketch.ts"
import type { Ink, Sketch } from "./sketch.ts"

const { MOVE, ORB, PLAYER, SLASH } = Tuning

/** The ring drawn round the player while parrying: bold while the window is open (any hit that lands then is parried). */
const GUARD = 0.28
/** Gameplay steps a hit shape stays drawn at least, so a one-step hit still shows. */
const SHAPE_STEPS = 6

/** Any telegraph, an enemy's or one of a boss's: its origin, shape, direction, size, progress and extras. */
interface Tell {
  readonly x: number
  readonly z: number
  readonly shape: TelegraphShape
  readonly dirX: number
  readonly dirZ: number
  readonly size: number
  readonly progress: number
  readonly feint: boolean
  readonly halfAngle?: number
  readonly spot?: { readonly x: number; readonly z: number }
}

/** A hit shape the player's weapon put live, kept until gameplay step `until`. */
interface Live {
  readonly shape: HitShape
  readonly until: number
}

const filled = (ink: Ink, fill: number): Ink => ({ ...ink, fill })

const drawShape = (sketch: Sketch, shape: HitShape, ink: Ink) => {
  switch (shape.kind) {
    case "arc": return sketch.wedge(shape.x, shape.z, shape.facing, shape.range, shape.halfAngle, ink)
    case "circle": return sketch.circle(shape.x, shape.z, shape.radius, ink)
    case "line": return sketch.capsule(shape.x, shape.z, shape.dirX, shape.dirZ, shape.length, shape.halfWidth, ink)
  }
}

const player = (sketch: Sketch, view: PlayerView) => {
  sketch.circle(view.x, view.z, PLAYER.radius, view.invulnerable ? INK.faint : INK.paper)
  if (view.move !== null) {
    const spec = MOVE[view.move]
    const phase = view.attackPhase
    const ink = phase === "active" ? { ...INK.paper, width: 2, fill: 0.14 } : phase === "windup" ? { ...INK.faint, fill: 0.05 } : INK.faint
    if (spec.kind === "arc") sketch.wedge(view.x, view.z, view.facing, spec.range, spec.halfAngle, ink)
    else if (spec.kind === "slam" && phase !== "windup") sketch.circle(view.x, view.z, spec.radius, ink)
    else if (spec.kind === "shot" && phase === "windup") sketch.capsule(view.x, view.z, Math.cos(view.facing), Math.sin(view.facing), spec.reach, spec.radius, { ...INK.faint, alpha: 0.25 })
    return
  }
  if (view.state === "Parry") {
    sketch.circle(view.x, view.z, PLAYER.radius + GUARD, view.parryOpen ? { ...INK.paper, width: 2.5, fill: 0.12 } : INK.faint)
    return
  }
  if (view.state === "Free") sketch.wedge(view.x, view.z, view.facing, SLASH[1].range, SLASH[1].halfAngle, { ...INK.faint, alpha: 0.18 })
}

/** A telegraph's reach on the ground: a line's strip, a ring, an arc's wedge (a pulsar's gapped ring), a leap's landing spot. */
const telegraph = (sketch: Sketch, tell: Tell, bodyRadius: number) => {
  const ink = tell.feint ? INK.redFaint : INK.red
  switch (tell.shape) {
    case "ring":
      sketch.circle(tell.x, tell.z, tell.size, filled(ink, 0.04 + tell.progress * 0.12))
      return
    case "arc": {
      const facing = Math.atan2(tell.dirZ, tell.dirX)
      const half = tell.halfAngle ?? Math.PI / 4
      sketch.wedge(tell.x, tell.z, facing, tell.size, half, filled(ink, 0.04))
      sketch.wedge(tell.x, tell.z, facing, tell.size * tell.progress, half, { ...ink, alpha: 0, fill: 0.16 })
      return
    }
    case "spot": {
      const spot = tell.spot ?? { x: tell.x, z: tell.z }
      sketch.circle(spot.x, spot.z, tell.size, filled(ink, 0.06))
      sketch.circle(spot.x, spot.z, tell.size * (2 - tell.progress), { ...ink, alpha: 0.4 })
      sketch.path([{ x: tell.x, z: tell.z }, spot], { ...ink, alpha: 0.35 })
      return
    }
    case "line": {
      const reach = bodyRadius + 0.1
      sketch.capsule(tell.x, tell.z, tell.dirX, tell.dirZ, tell.size, reach, filled(ink, 0.04))
      sketch.capsule(tell.x, tell.z, tell.dirX, tell.dirZ, tell.size * tell.progress, reach * 0.5, { ...ink, alpha: 0, fill: 0.3 })
    }
  }
}

const enemy = (sketch: Sketch, view: EnemyView) => {
  if (view.state === "Falling") return
  const radius = Tuning.radiusOf(view.kind, view.elite === true)
  sketch.circle(view.x, view.z, radius, view.state === "Spawning" ? { ...INK.grey, alpha: 0.3 } : view.elite === true ? { ...INK.grey, width: 2 } : INK.grey)
  if (view.telegraph !== null) {
    telegraph(sketch, { ...view.telegraph, x: view.x, z: view.z }, radius)
    return
  }
  if (view.state === "Lunge") sketch.circle(view.x, view.z, radius + 0.1, { ...INK.red, width: 2, fill: 0.3 })
  if (view.shielded === true) sketch.circle(view.x, view.z, radius + 0.18, INK.redFaint)
}

/** A boss's every telegraph at once (its halves' and moons' too), its moons, the Orrery's hands, and whether it is open or shelled. */
const boss = (sketch: Sketch, view: BossView, bodies: ReadonlyArray<EnemyView>) => {
  const radius = Tuning.ENEMY[view.boss].radius
  for (const each of bodies) {
    sketch.circle(each.x, each.z, radius, { ...INK.grey, width: 2 })
    if (view.open) sketch.circle(each.x, each.z, radius + 0.25, { ...INK.paper, width: 2.5 })
    if (view.shelled) sketch.circle(each.x, each.z, radius + 0.2, INK.redFaint)
  }
  for (const tell of view.telegraphs) telegraph(sketch, tell, radius)
  for (const moon of view.moons) sketch.circle(moon.x, moon.z, 0.45, moon.phase === "cut" ? { ...INK.red, width: 2, fill: 0.3 } : INK.grey)
  const main = bodies.find((each) => each.id === view.id)
  if (main === undefined) return
  for (const arm of view.arms) sketch.wedge(main.x, main.z, arm.angle, arm.reach, 0.06, { ...INK.red, width: 2, fill: 0.3 })
}

const seam = (sketch: Sketch, view: SeamView) => {
  sketch.capsule(view.x, view.z, view.dirX, view.dirZ, view.reach, view.halfWidth, { ...INK.redFaint, alpha: 0.3 })
  sketch.capsule(view.x, view.z, view.dirX, view.dirZ, view.length, view.halfWidth, { ...INK.red, fill: 0.3 * (1 - view.burn) })
}

/** The weapon's marks waiting on the ground (the slam's landing, sigils), filling as they come due. */
const marks = (sketch: Sketch, weapon: WeaponView) => {
  for (const mark of weapon.marks) {
    sketch.circle(mark.x, mark.z, mark.radius, { ...INK.faint, fill: 0.04 })
    sketch.circle(mark.x, mark.z, mark.radius * mark.progress, { ...INK.paper, alpha: 0, fill: 0.12 })
  }
}

export interface Hitboxes {
  draw(sketch: Sketch, view: GameView): void
  dispose(): void
}

/**
 * The game's hit shapes: the player's body, its weapon's reach, guard, marks and darts, and the shape each of its hits
 * put live (from the `attack` and `burst` moments, held a few steps); each enemy's body (an elite's larger), telegraphed
 * strike and lunge; a boss's telegraphs, moons, hands and open or shelled state; seams; every orb.
 */
export const createHitboxes = (moments: MomentBus): Hitboxes => {
  let live: Array<Live> = []
  let step = 0
  const keep = (shape: HitShape, seconds: number) => live.push({ shape, until: step + Math.max(SHAPE_STEPS, toSteps(seconds)) })
  const offs = [
    moments.on("attack", (moment) => keep(moment.shape, moment.duration)),
    moments.on("burst", (moment) => keep({ kind: "circle", x: moment.x, z: moment.z, radius: moment.radius }, 0)),
    moments.on("runStarted", () => {
      live = []
    }),
    moments.on("roomSwapped", () => {
      live = []
    })
  ]
  return {
    draw: (sketch, view) => {
      step = view.tempo.playStep
      live = live.filter((each) => each.until >= step)
      for (const each of view.seams) seam(sketch, each)
      const fight = view.boss
      for (const each of view.enemies) {
        if (fight === null || (each.id !== fight.id && each.id !== fight.twin)) enemy(sketch, each)
      }
      if (fight !== null) boss(sketch, fight, view.enemies.filter((each) => each.id === fight.id || each.id === fight.twin))
      for (const orb of view.projectiles) sketch.circle(orb.x, orb.z, ORB.radius, orb.owner === "enemy" ? { ...INK.red, fill: 0.25 } : { ...INK.paper, fill: 0.25 })
      for (const dart of view.darts) sketch.capsule(dart.x, dart.z, -dart.dirX, -dart.dirZ, 0.5, MOVE[dart.move].radius, { ...INK.paper, fill: 0.3 })
      for (const each of live) drawShape(sketch, each.shape, { ...INK.paper, width: 2, fill: 0.16 })
      marks(sketch, view.weapon)
      if (view.player !== null) player(sketch, view.player)
    },
    dispose: () => {
      for (const off of offs) off()
    }
  }
}
