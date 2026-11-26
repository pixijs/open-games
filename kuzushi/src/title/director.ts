import { clamp } from "math"

import { PALETTE } from "../art/palette.ts"
import { NARROW_WIDTH } from "../art/title-cues.ts"
import type { TitleCue } from "../art/title-cues.ts"
import type { FrameTime, HostContext } from "../host/types.ts"
import type { PlayerStateName } from "../sim/index.ts"
import { ON_TWOS } from "../vfx/cues.ts"
import { spray, spread } from "../vfx/fx.ts"
import type { Fx } from "../vfx/fx.ts"
import { flashShape, shatter } from "../vfx/shards.ts"
import type { Cast, Pose } from "./cast.ts"
import { REFORM_SECONDS } from "./cast.ts"
import type { TitleFx } from "./effects.ts"
import type { TitleSet } from "./set.ts"
import { clashShot, DASH, dashAngle, FRAMING, HERO, heroShot, launchShot, MENU_COLUMN, outOfShot, RING, SUN_FACING, wideShot } from "./staging.ts"
import type { Shot } from "./staging.ts"

/**
 * One loop of the title's key art, in seconds: the ring re-forms under the hero shot, the hero standing against the
 * red sun; the wide shot looks down as the ring closes in and winds up; then the clash: a cut, the hero flashes
 * through, one impact frame, a held pose, and every shape shatters into ink.
 */
const BEAT = { wide: 2.5, windup: 3.9, clash: 4.45, impact: 4.55, shatter: 4.69, loop: 6.3 } as const

/** Seconds the hero takes to cross the ring. Between the impact and the shatter every effect holds its drawing. */
const DASH_SECONDS = 0.1

/** When the launch dash starts, how long it takes to reach the lens, and the impact as it arrives. */
const LAUNCH = { dash: 0.1, reach: 0.16, impact: 0.27 } as const
/** The hero turns to the lens on the side away from the sun, so the sun stands behind it as it comes. */
const LAUNCH_FACING = SUN_FACING + Math.PI

/** The crescent's drawings: tail, head, erosion, brightness (as the game's spin slash). */
const SPIN = [[0, 0.42, 0, 2.6], [0, 0.8, 0, 2.1], [0.04, 1, 0.08, 1.8], [0.26, 1, 0.34, 1.5], [0.5, 1, 0.6, 1.25], [0.74, 1, 0.84, 1.05]] as const

/** How high the crescent sweeps, nearly level: under the tops of the shapes it cuts through, so they read inside the stroke. */
const CRESCENT_HEIGHT = 0.14

/** Wind streaks a second, and how the wind blows across the courtyard. */
const WIND = { rate: 9, x: 8, z: 1.2 } as const

export interface Director {
  /** Seconds into the current loop; see `BEAT` for what happens when. */
  readonly time: number
  /** Starts the loop over from the hero shot, the menu framing restored. */
  reset(): void
  /** Stops cutting and starting beats; effects already playing run out. */
  stop(): void
  cue(cue: TitleCue): void
  update(frame: FrameTime): void
}

const ease = (t: number) => t * t * (3 - 2 * t)
const crossed = (from: number, to: number, at: number) => from < at && at <= to

/** Plays one crescent: a spin of `radius` round (x, z), starting toward `facing`, on the title's clock. */
const crescent = (fx: Fx, x: number, z: number, facing: number, radius: number) => {
  const arc = fx.arcs.take("spin")
  arc.place(x, CRESCENT_HEIGHT, z, facing, radius, false, 0.02, 0)
  const variant = Math.floor(fx.rng() * 3)
  fx.cues.play({
    clock: "real",
    life: SPIN.length / ON_TWOS,
    fps: ON_TWOS,
    draw: (drawing) => {
      const pose = SPIN[drawing]
      if (pose !== undefined) arc.pose(pose[0], pose[1], pose[2], pose[3], variant + drawing)
    },
    end: () => fx.arcs.give("spin", arc)
  })
}

/** Afterimages, speed lines and a dotted trail along a dash from (ax, az) to (bx, bz). */
const dashMarks = (fx: Fx, ax: number, az: number, bx: number, bz: number) => {
  const length = Math.hypot(bx - ax, bz - az) || 1
  const dirX = (bx - ax) / length
  const dirZ = (bz - az) / length
  const angle = Math.atan2(dirZ, dirX)
  fx.layers.flat.spawn({ frames: fx.f.dryRing, x: ax, y: 0.06, z: az, size: 1, sizeEnd: 2.6, alpha: 0.7, life: 3 / ON_TWOS, alphaEnd: 0, clock: "real" })
  for (let along = 0.6; along < length; along += 1.1) {
    const x = ax + dirX * along
    const z = az + dirZ * along
    fx.layers.flat.spawn({ frames: fx.f.ghost, x, y: 0.32, z, size: 1.55, rotation: angle, life: 0.3, hold: along / length * 0.5, alpha: 0.9, alphaEnd: 0, clock: "real" })
    fx.layers.floor.spawn({ frames: fx.f.dotSquare, x, y: 0.05, z, size: 0.2, rotation: angle, life: 1.2, hold: 0.6, alpha: 1, alphaEnd: 0, clock: "real" })
    const side = spread(fx.rng, 0.6)
    fx.layers.flat.spawn({ frames: fx.f.speedline, x: x - dirZ * side, y: 0.4, z: z + dirX * side, vx: dirX * 3, vz: dirZ * 3, rotation: angle, size: 3 + fx.rng() * 1.5, sizeEnd: 1.8, life: 0.3, hold: 0.3, alphaEnd: 0, clock: "real" })
  }
}

/**
 * The title's choreography: the beat loop cut between the hero, wide and clash shots, the scene's answers to the
 * menu (a turn and a glint when the highlight moves, a reframe when a panel opens), and the launch: the hero dashes
 * at the lens as the run starts. While a panel is open the loop holds the hero shot, short of the windup, so nothing
 * cuts or flashes behind what the player is reading. Shapes too near a shot's lens or in the menu's column are left
 * out of that shot.
 */
export const makeDirector = (context: HostContext, cast: Cast, set: TitleSet, effects: TitleFx): Director => {
  const { fx } = effects
  const rig = context.rig
  let time = 0
  let side: 1 | -1 = 1
  let running = true
  let launch = -1
  let kick = 0
  let windCarry = 0
  let calm = false
  /** Under `NARROW_WIDTH` the title's UI covers the screen: the subject centres and nothing is left out for a column. */
  let narrow = context.app.screen.width < NARROW_WIDTH
  const framing = () => (narrow ? 0 : FRAMING[calm ? "panel" : "menu"])
  let shot: Shot = heroShot()
  let shotTime = 0
  /** The shapes left out of the shot on screen; a shape once left out stays out until the next cut. */
  const left = new Set<number>()

  const cut = (next: Shot) => {
    shot = next
    shotTime = 0
    left.clear()
    rig.cutTitle(next)
  }

  const shown = () => cast.members.filter((member) => !member.out)

  const dashEnd = () => {
    const angle = dashAngle(side)
    return { x: HERO.x + Math.cos(angle) * DASH, z: HERO.z + Math.sin(angle) * DASH }
  }

  const reform = () => {
    for (const member of shown()) {
      fx.layers.flat.spawn({ frames: fx.f.summon, x: member.x, y: 0.06, z: member.z, size: 3, sizeEnd: 0.9, rotation: fx.rng() * 6, spin: 2, life: REFORM_SECONDS, alpha: 0.25, alphaEnd: 1, fps: 12, clock: "real" })
      fx.layers.glow.spawn({ frames: fx.f.flare, x: member.x, y: 1.4, z: member.z, size: 3.6, sizeEnd: 1.6, rotation: Math.PI / 2, color: PALETTE.red, alpha: 0.7, alphaEnd: 0, life: REFORM_SECONDS * 0.8, fps: 12, clock: "real" })
    }
  }

  const windup = () => {
    for (const member of shown()) fx.layers.flatGlow.spawn({ frames: fx.f.dryRing, x: member.x, y: 0.07, z: member.z, size: 0.6, sizeEnd: 2, color: PALETTE.red, alpha: 0.9, alphaEnd: 0, life: 0.24, clock: "real" })
  }

  const clash = () => {
    const end = dashEnd()
    dashMarks(fx, HERO.x, HERO.z, end.x, end.z)
    crescent(fx, HERO.x, HERO.z, dashAngle(side) + Math.PI * 0.5, RING.close + 1.2)
  }

  const impact = () => {
    if (!calm) fx.impacts.frame(["stark", "ink"])
    for (const member of shown()) flashShape(fx, member.kind, member.x, member.z, Math.atan2(member.z - HERO.z, member.x - HERO.x), 1.25, 1 / ON_TWOS)
    fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: HERO.x, y: 0.1, z: HERO.z, size: 2, sizeEnd: 15, color: PALETTE.red, life: 0.55, alpha: 0.9, alphaEnd: 0, clock: "real" })
    rig.shake(0.3, { x: HERO.x, z: HERO.z, shape: "explosion", duration: 0.4 })
  }

  const shatterRing = () => {
    cast.members.forEach((member, index) => {
      if (member.out) return
      const away = Math.atan2(member.z - HERO.z, member.x - HERO.x)
      shatter(fx, member.kind, member.x, member.z, Math.cos(away), Math.sin(away), { big: index === 2 })
    })
    fx.layers.flat.spawn({ frames: fx.f.dryRing, x: HERO.x, y: 0.08, z: HERO.z, size: 2, sizeEnd: 12, life: 0.5, alpha: 0.6, alphaEnd: 0, clock: "real" })
  }

  /** Fires every beat whose time falls in (from, to]. */
  const beats = (from: number, to: number) => {
    if (crossed(from, to, BEAT.wide) && !calm) cut(wideShot())
    if (crossed(from, to, BEAT.windup)) windup()
    if (crossed(from, to, BEAT.clash)) {
      cut(clashShot(side))
      clash()
    }
    if (crossed(from, to, BEAT.impact)) impact()
    if (crossed(from, to, BEAT.shatter)) shatterRing()
  }

  const startLoop = () => {
    time = 0
    cut(heroShot())
    set.reset()
    cast.ring(HERO.x, HERO.z, RING.wide, { state: "Spawning", timeLeft: REFORM_SECONDS, telegraph: -1 }, true)
    leaveOut()
    reform()
  }

  /** Marks the shapes the shot on screen leaves out: too near its lens, or in the menu's column. */
  const leaveOut = () => {
    const { width, height } = context.app.screen
    const aspect = width / Math.max(1, height)
    cast.leaveOut((index, x, z) => {
      if (!left.has(index) && outOfShot(shot, shotTime, framing(), aspect, x, z, narrow ? 0 : MENU_COLUMN)) left.add(index)
      return left.has(index)
    })
  }

  /**
   * Where the hero is and how it stands: up on its tail facing the lens in the hero shot, and again from the impact
   * on (the impact frame hides the change), so the held pose after the shatter reads as a figure, not a sliver.
   */
  const pose = (): { readonly x: number; readonly z: number; readonly state: PlayerStateName; readonly facing: number; readonly standing: boolean } => {
    const standing = shot.kind === "hero"
    const facing = (standing ? SUN_FACING : dashAngle(side)) + kick
    if (time < BEAT.clash) return { ...HERO, state: time >= BEAT.windup ? "Special" : "Free", facing, standing }
    const end = dashEnd()
    const t = clamp((time - BEAT.clash) / DASH_SECONDS, 0, 1)
    if (t < 1) return { x: HERO.x + (end.x - HERO.x) * t, z: HERO.z + (end.z - HERO.z) * t, state: "Dash", facing, standing }
    if (time < BEAT.impact) return { ...end, state: "Attack", facing, standing }
    return { ...end, state: "Free", facing: Math.atan2(end.z - shot.to[2], end.x - shot.to[0]) + kick, standing: true }
  }

  const ringPose = (): { readonly radius: number; readonly pose: Pose; readonly visible: boolean } => {
    if (time < REFORM_SECONDS) return { radius: RING.wide, pose: { state: "Spawning", timeLeft: REFORM_SECONDS - time, telegraph: -1 }, visible: true }
    if (time < BEAT.windup) return { radius: RING.wide + (RING.close - RING.wide) * ease(clamp((time - REFORM_SECONDS) / (BEAT.windup - REFORM_SECONDS), 0, 1)), pose: { state: "Move", timeLeft: 0, telegraph: -1 }, visible: true }
    if (time < BEAT.clash) return { radius: RING.close, pose: { state: "Windup", timeLeft: 0, telegraph: (time - BEAT.windup) / (BEAT.clash - BEAT.windup) }, visible: true }
    if (time < BEAT.impact) return { radius: RING.close, pose: { state: "Windup", timeLeft: 0, telegraph: -1 }, visible: true }
    return { radius: RING.close, pose: { state: "Stagger", timeLeft: 0, telegraph: -1 }, visible: time < BEAT.shatter }
  }

  const wind = (dt: number) => {
    windCarry += dt * WIND.rate
    for (; windCarry >= 1; windCarry -= 1) {
      const x = HERO.x + (fx.rng() * 2 - 1) * 18
      const y = 0.4 + fx.rng() * 4.5
      const z = HERO.z - 12 + fx.rng() * 20
      const from = context.view.worldToScreen({ x, y, z })
      const to = context.view.worldToScreen({ x: x + WIND.x, y, z: z + WIND.z })
      const angle = from === null || to === null ? 0 : -Math.atan2(to.y - from.y, to.x - from.x)
      effects.air.spawn({ frames: fx.f.speedline, x, y, z, vx: WIND.x, vz: WIND.z, rotation: angle, size: 1.4 + fx.rng() * 2.4, life: 0.55 + fx.rng() * 0.4, alpha: 0.32, alphaEnd: 0, hold: 0.3, color: PALETTE.paper, clock: "real" })
    }
  }

  const launchStep = (from: number, to: number) => {
    if (crossed(from, to, LAUNCH.dash)) {
      const reach = { x: HERO.x + Math.cos(LAUNCH_FACING) * 5, z: HERO.z + Math.sin(LAUNCH_FACING) * 5 }
      dashMarks(fx, HERO.x, HERO.z, reach.x, reach.z)
      if (time < BEAT.shatter) shatterRing()
      cast.ring(HERO.x, HERO.z, RING.close, { state: "Stagger", timeLeft: 0, telegraph: -1 }, false)
    }
    if (crossed(from, to, LAUNCH.impact)) {
      fx.impacts.frame(["stark"])
      cast.showHero(false)
      rig.shake(0.25, { x: HERO.x, z: HERO.z, duration: 0.3 })
    }
  }

  const launchPose = () => {
    const t = clamp((launch - LAUNCH.dash) / (LAUNCH.reach), 0, 1)
    const state: PlayerStateName = launch < LAUNCH.dash ? "Parry" : "Dash"
    return { x: HERO.x + Math.cos(LAUNCH_FACING) * 5.2 * t * t, z: HERO.z + Math.sin(LAUNCH_FACING) * 5.2 * t * t, state, facing: LAUNCH_FACING }
  }

  return {
    get time() {
      return time
    },
    reset: () => {
      running = true
      launch = -1
      side = 1
      kick = 0
      calm = false
      rig.frameTitle(framing())
      cast.showHero(true)
      effects.clear()
      startLoop()
    },
    stop: () => {
      running = false
    },
    cue: (cue) => {
      switch (cue.type) {
        case "select": {
          kick = (cue.index % 2 === 0 ? 1 : -1) * (0.35 + (cue.index % 3) * 0.12)
          const hero = pose()
          fx.layers.glow.spawn({ frames: fx.f.glint, x: hero.x + Math.cos(hero.facing) * 0.5, y: 0.6, z: hero.z + Math.sin(hero.facing) * 0.5, size: 1.4, sizeEnd: 0.2, rotation: 0.3, life: 0.14, alpha: 1, clock: "real" })
          const member = cast.members[cue.index % cast.members.length]
          if (member !== undefined && !member.out && time > REFORM_SECONDS && time < BEAT.shatter) flashShape(fx, member.kind, member.x, member.z, 0, 1.2, 2 / ON_TWOS)
          rig.shake(0.04, { x: hero.x, z: hero.z, duration: 0.15, shape: "recoil" })
          return
        }
        case "panel":
          calm = cue.open
          rig.frameTitle(framing())
          if (!calm || launch >= 0) return
          if (time >= BEAT.windup) {
            cast.showHero(true)
            startLoop()
          } else if (shot.kind !== "hero") cut(heroShot())
          return
        case "launch":
          launch = 0
          cut(launchShot(LAUNCH_FACING))
          spray(fx, { count: 8, x: HERO.x, y: 0.5, z: HERO.z, angle: LAUNCH_FACING + Math.PI, cone: 0.8, speed: [6, 12], size: [0.5, 0.9], frame: () => fx.f.shard, life: 0.3, clock: "real" })
          return
      }
    },
    update: (frame) => {
      const dt = frame.dt
      if ((context.app.screen.width < NARROW_WIDTH) !== narrow) {
        narrow = !narrow
        rig.frameTitle(framing())
      }
      kick *= Math.exp(-dt * 3)
      if (launch >= 0) {
        const before = launch
        launch += dt
        launchStep(before, launch)
        const hero = launchPose()
        cast.hero(hero.x, hero.z, hero.facing, hero.state)
      } else if (running) {
        const before = time
        time = calm ? Math.min(time + dt, BEAT.windup - 0.05) : time + dt
        beats(before, time)
        if (time >= BEAT.loop) {
          side = side === 1 ? -1 : 1
          cast.showHero(true)
          startLoop()
        }
        const hero = pose()
        cast.hero(hero.x, hero.z, hero.facing, hero.state, { step: hero.state === "Attack" ? 1 : 0, standing: hero.standing })
        const ring = ringPose()
        cast.ring(HERO.x, HERO.z, ring.radius, ring.pose, ring.visible)
      }
      shotTime += dt
      leaveOut()
      const held = launch < 0 && time >= BEAT.impact && time < BEAT.shatter
      const effectDt = held ? 0 : dt
      cast.update(held ? { ...frame, dt: 0 } : frame)
      effects.update(effectDt)
      set.update(dt)
      if (running || launch >= 0) wind(dt)
    }
  }
}
