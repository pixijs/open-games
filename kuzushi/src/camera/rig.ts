import {
  BasicMultiChannelPerlinNoise,
  BlendCurves,
  CameraOffsetExtension,
  cameraState,
  hardLookAt,
  HardLookAtAim,
  ImpulseField,
  ImpulseListenerNoise,
  ImpulseShapes,
  LensExtension,
  PositionComposerBody,
  RecomposerExtension,
  RotationComposerAim,
  targetPose,
  VirtualCamera
} from "@pmndrs/klipp"
import type { BodyPiece, CameraState, TargetPose } from "@pmndrs/klipp"
import type { View3D } from "@pixi/3d"
import { clamp, quat, vec3 } from "math"
import type { Quat, Vec3 } from "math"

import { settings } from "../art/settings.ts"
import { KlippPixi } from "./klipp-pixi.ts"
import { titlePan, titleShotAt } from "./title-pan.ts"

/** The rig's named shots. */
export type ShotName = "title" | "play" | "pause" | "special" | "boss"

const shotNames = ["title", "play", "pause", "special", "boss"] as const satisfies ReadonlyArray<ShotName>

/** The play camera's framing: looking straight up the screen (-z), tilted down from the horizon. */
const PLAY_SHOT = {
  pitchDegrees: 60,
  distance: 24,
  fov: 40,
  deadZone: [0.05, 0.05] as [number, number],
  hardLimit: [0.2, 0.17] as [number, number],
  damping: 0.18,
  lookaheadTime: 0.12
} as const

/** How far the play frame leads toward where the player aims, in ground units. */
const LEAD = 0.7

/**
 * The special's cut-in: how far from the player it starts and ends its push, how high, and where it puts the player
 * on screen (a third of the way in from one side, a little low, so the marked enemies fill the rest).
 */
export const CUT_IN = { from: 3.3, to: 2.5, height: 1.75, rise: 0.3, drift: 0.2, screenX: 1 / 3, screenY: -0.18 } as const

/**
 * The special's strike shot: how steeply it looks down, the ground margin it keeps round the player and targets for
 * the crescents, how far it pushes in while held, and the share of the height between the cinema bars it frames in.
 */
const STRIKE = { pitch: (56 * Math.PI) / 180, margin: 1.8, push: 0.8, letterbox: 0.78 } as const

export interface ShakeOptions {
  /** Where the shake comes from on the ground; the camera's focus when left out. */
  readonly x?: number
  readonly z?: number
  /** Which way the camera is kicked on the ground plane, unit length; straight down when left out. */
  readonly dirX?: number
  readonly dirZ?: number
  /** Seconds the shake lasts. */
  readonly duration?: number
  readonly shape?: keyof typeof ImpulseShapes
}

/**
 * How far the play frame may reach on a stage: the edges of the frame stay within `halfWidth` of `centerX`, and the
 * follow target within `minZ` to `maxZ`, so the frame shows the floor and a little of what lies beyond it, never
 * mostly dark.
 */
export interface PlayBounds {
  readonly centerX: number
  readonly halfWidth: number
  readonly minZ: number
  readonly maxZ: number
}

/** The Courtyard's: its walls plus a margin of the dark beyond. The rig starts with them, before a stage sets its own. */
export const COURTYARD_BOUNDS: PlayBounds = { centerX: 0, halfWidth: 22, minZ: -7, maxZ: 8 }

const PRIORITY: Readonly<Record<ShotName, number>> = { title: 30, play: 20, pause: 40, special: 50, boss: 45 }

/**
 * A boss's name card: a low three-quarter shot from the player's side, turned `turn` off the line between them, the
 * boss's centre `height` up at the right two thirds of the frame, pushing `push` units in over the card.
 */
const BOSS_SHOT = { distance: 8.6, height: 2.3, aim: 1.3, turn: 0.62, push: 1.4, fov: 44, screenX: 0.3, dutch: -4 } as const

/**
 * One designed shot of the title: the lens glides from `from` to `to`, aimed from `lookFrom` to `lookTo`, over
 * `seconds` with an ease-out, then holds. A new shot cuts at once.
 */
export interface TitleShot {
  readonly from: Vec3
  readonly to: Vec3
  readonly lookFrom: Vec3
  readonly lookTo: Vec3
  readonly fov: number
  readonly seconds: number
  /** Dutch roll in degrees. */
  readonly roll: number
}

/** Where the title opens before its scene picks a shot: high over the courtyard's south side, looking north. */
const TITLE_OPENING: TitleShot = { from: [0, 9, 20], to: [0, 9, 20], lookFrom: [0, 1, 0], lookTo: [0, 1, 0], fov: 42, seconds: 1, roll: 0 }

export const SPECIAL_FOV = 50

const _forward: Vec3 = [0, 0, -1]
const _scratch: Vec3 = [0, 0, 0]

/** A camera state at `position` looking at `target`. */
const lookingAt = (position: Vec3, target: Vec3, fov: number): CameraState => {
  const state = cameraState.create()
  vec3.copy(state.position, position)
  state.fov = fov
  hardLookAt.update(state, target)
  return state
}

const PLAY_OFFSET: Vec3 = [
  0,
  Math.sin((PLAY_SHOT.pitchDegrees * Math.PI) / 180) * PLAY_SHOT.distance,
  Math.cos((PLAY_SHOT.pitchDegrees * Math.PI) / 180) * PLAY_SHOT.distance
]
const PLAY_ROTATION: Quat = lookingAt(PLAY_OFFSET, [0, 0, 0], PLAY_SHOT.fov).quaternion

/**
 * Every camera of the game, run by one Klipp. Each shot is a virtual camera:
 *
 * - `title`: the title's designed shots, cut on its beats (`cutTitle`) and slid aside for menus (`frameTitle`).
 * - `play`: high three-quarter top-down follow, 60° down, with a dead zone and lookahead (a PositionComposer),
 *   led a little toward where the player aims (`lead`).
 * - `pause`: a gentle push-in from wherever play was.
 * - `special`: a low cut-in over the player's shoulder that pushes in while time is frozen (`setSpecial`), then a
 *   cut wide and high over the strike (`specialStrike`), rolled to a dutch angle between beats (`dutch`).
 * - `boss`: a boss's name card, low and three-quarter on from the player's side (`setBoss`), pushing in slowly.
 *
 * Shakes are impulses: `shake()` kicks every listening camera; `punch()` narrows the lens for a beat.
 */
export class CameraRig {
  readonly klipp: KlippPixi
  readonly impulses = new ImpulseField()
  private readonly cameras: Readonly<Record<ShotName, VirtualCamera>>

  private readonly player: TargetPose = targetPose.create()
  private readonly specialTarget: TargetPose = targetPose.create()
  private readonly bossTarget: TargetPose = targetPose.create()
  private readonly bossFrame = { x: 0, z: 0, angle: 0, time: 0 }
  private readonly arenaCenter: TargetPose = targetPose.create()
  private readonly playLens = new LensExtension({ fov: PLAY_SHOT.fov, fovDamping: 0.12 })
  private readonly playLead = new CameraOffsetExtension()
  private readonly specialFrame = new RecomposerExtension()
  private readonly specialAim = new RotationComposerAim(this.specialTarget)
  private readonly composer: PositionComposerBody
  private _shot: ShotName = "title"
  private override: { readonly shot: ShotName; remaining: number } | null = null
  private specialAzimuth = 0
  private specialPhase: "cutIn" | "strike" = "cutIn"
  private readonly strike = { x: 0, z: 0, distance: 10, time: 0 }
  private aspect = 16 / 9
  private punchAmount = 0
  private bounds: PlayBounds = COURTYARD_BOUNDS
  private followBounds = { minX: -8, maxX: 8, minZ: -7, maxZ: 8 }
  private titleShot: TitleShot = TITLE_OPENING
  private titleTime = 0
  private titleSide = 0
  private titleSideGoal = 0
  private readonly titleLens = new LensExtension({ fov: TITLE_OPENING.fov, fovDamping: 0 })
  private readonly titleRoll = new RecomposerExtension()
  private pauseTime = 0
  private specialTime = 0
  /** Shares of the screen the play camera's subject keeps clear of: a panel docked right and a strip along the bottom (`inset`), bands of the HUD along the top and right (`reserve`). */
  private readonly clearOf = { right: 0, bottom: 0, top: 0, hud: 0 }
  private distance: number = PLAY_SHOT.distance
  private pull = 1

  constructor(view: View3D) {
    const camera = view.camera
    camera.fov = PLAY_SHOT.fov
    camera.near = 0.5
    camera.far = 160
    camera.position.set(PLAY_OFFSET[0], PLAY_OFFSET[1], PLAY_OFFSET[2])
    camera.lookAt({ x: 0, y: 0, z: 0 })

    this.klipp = new KlippPixi(camera, {
      defaultBlend: { curve: BlendCurves.easeInOut, time: 0.9 },
      customBlends: [
        { from: "title", to: "play", blend: { curve: BlendCurves.cut, time: 0 } },
        { to: "pause", blend: { curve: BlendCurves.easeInOut, time: 1.1 } },
        { to: "special", blend: { curve: BlendCurves.cut, time: 0 } },
        { from: "special", blend: { curve: BlendCurves.cubicOut, time: 0.55 } },
        { to: "boss", blend: { curve: BlendCurves.cut, time: 0 } },
        { from: "boss", blend: { curve: BlendCurves.easeInOut, time: 0.6 } }
      ]
    })
    this.player.extent.radius = 0.6

    const title = new VirtualCamera("title", { priority: PRIORITY.title, initialState: { fov: TITLE_OPENING.fov } })
    title.body = this.titleBody()
    title.aim = new HardLookAtAim(this.arenaCenter)
    title.addExtension(this.titleLens)
    title.addExtension(this.titleRoll)
    title.addNoise(this.listener(0.8))

    const play = new VirtualCamera("play", { priority: PRIORITY.play, standbyUpdate: "always", initialState: { fov: PLAY_SHOT.fov, quaternion: PLAY_ROTATION } })
    this.composer = new PositionComposerBody(this.player, {
      cameraDistance: PLAY_SHOT.distance,
      screenPosition: [0, 0],
      deadZone: PLAY_SHOT.deadZone,
      hardLimit: PLAY_SHOT.hardLimit,
      damping: PLAY_SHOT.damping,
      lookaheadTime: PLAY_SHOT.lookaheadTime,
      lookaheadSmoothing: 0.3,
      lookaheadIgnoreY: true
    })
    play.body = this.composer
    play.addExtension(this.playLens)
    play.addExtension(this.playLead)
    play.addNoise(this.listener(1))

    const pause = new VirtualCamera("pause", { priority: PRIORITY.pause, active: false, initialState: { fov: PLAY_SHOT.fov - 4 } })
    pause.body = this.pauseBody(play)
    pause.addNoise(this.listener(0.4))

    const special = new VirtualCamera("special", { priority: PRIORITY.special, active: false, initialState: { fov: SPECIAL_FOV } })
    special.body = this.specialBody()
    special.aim = this.specialAim
    special.addExtension(this.specialFrame)
    special.addNoise(this.listener(1.2))

    const boss = new VirtualCamera("boss", { priority: PRIORITY.boss, active: false, initialState: { fov: BOSS_SHOT.fov } })
    boss.body = this.bossBody()
    const bossAim = new RotationComposerAim(this.bossTarget)
    bossAim.screenPosition = [BOSS_SHOT.screenX, 0.04]
    boss.aim = bossAim
    const bossRoll = new RecomposerExtension()
    bossRoll.dutch = BOSS_SHOT.dutch
    boss.addExtension(bossRoll)
    boss.addNoise(this.listener(0.8))

    this.cameras = { title, play, pause, special, boss }
    for (const each of shotNames) this.klipp.add(this.cameras[each])
    this.apply()
  }

  /** The shot asked for: an override from `hold`, else the last `setShot`. */
  get shot(): ShotName {
    return this.override?.shot ?? this._shot
  }

  /** The shot on screen once blends settle. */
  get live(): string | null {
    return this.klipp.liveCameraName
  }

  setShot(name: ShotName): void {
    if (this._shot === name) return
    this._shot = name
    this.apply()
  }

  /** Forces `name` for `seconds` of real time whatever `setShot` asks, for choreography. */
  hold(name: ShotName, seconds: number): void {
    this.override = { shot: name, remaining: seconds }
    this.apply()
  }

  /** Ends a `hold` early. */
  release(): void {
    this.override = null
    this.apply()
  }

  /**
   * Feeds the play camera's follow target: the player's ground position, held inside the stage's bounds
   * (`setBounds`) so the frame shows the floor and a little of what lies beyond it, never mostly void.
   */
  setPlayer(x: number, z: number): void {
    const { minX, maxX, minZ, maxZ } = this.followBounds
    vec3.set(this.player.position, clamp(x, minX, maxX), 0, clamp(z, minZ, maxZ))
  }

  /**
   * Moves the play camera's subject to the middle of what a panel docked along the right (`right`) and a strip
   * along the bottom (`bottom`) leave of the screen, each a share of its width or height. 0 and 0 centre it again.
   */
  inset(right: number, bottom: number): void {
    this.clearOf.right = right
    this.clearOf.bottom = bottom
    this.compose()
  }

  /**
   * Keeps the HUD's bands clear of the play camera's subject: a band along the top (`top`, a share of the height: a
   * boss's bar) on top of any `inset`, and a column along the right (`right`, a share of the width) unless a docked
   * panel already takes more.
   */
  reserve(top: number, right: number): void {
    if (top === this.clearOf.top && right === this.clearOf.hud) return
    this.clearOf.top = top
    this.clearOf.hud = right
    this.compose()
  }

  /** Stands the play camera `scale` times its distance back, 1 for its usual framing. */
  pullBack(scale: number): void {
    if (scale === this.pull) return
    this.pull = scale
    this.composer.cameraDistance = this.distance * scale
    this.fitFollow()
  }

  /** The play frame's half width in ground units at its subject's distance. */
  get frameHalfWidth(): number {
    return this.composer.cameraDistance * Math.tan((PLAY_SHOT.fov * Math.PI) / 360) * this.aspect
  }

  private compose(): void {
    const { right, bottom, top, hud } = this.clearOf
    this.composer.screenPosition[0] = -Math.max(right, hud)
    this.composer.screenPosition[1] = bottom - top
  }

  /** Sets how far the play frame may reach, for the stage being played. */
  setBounds(bounds: PlayBounds): void {
    this.bounds = bounds
    this.fitFollow()
  }

  /**
   * Where the special cut-in frames from: the player at the moment of the special, the ground direction (simulation
   * radians) the camera stands in from them, and which side of the frame the player takes (-1 left, 1 right). It
   * pushes in slowly from there while time is frozen.
   */
  setSpecial(x: number, z: number, azimuth: number, side: -1 | 1): void {
    vec3.set(this.specialTarget.position, x, 0.15, z)
    this.specialAzimuth = azimuth
    this.specialTime = 0
    this.specialPhase = "cutIn"
    this.specialAim.screenPosition = [side * (1 - 2 * CUT_IN.screenX), CUT_IN.screenY]
    this.specialFrame.dutch = -5 * side
  }

  /**
   * Cuts the special shot wide and high over the strike: centred on (x, z), standing far enough back that ground
   * within `reach` of it (plus a margin for the crescents) fits between the cinema bars.
   */
  specialStrike(x: number, z: number, reach: number): void {
    vec3.set(this.specialTarget.position, x, 0.3, z)
    this.specialAim.screenPosition = [0, 0]
    const radius = reach + STRIKE.margin
    const halfHeight = Math.tan((SPECIAL_FOV * Math.PI) / 360)
    const tall = (radius * Math.sin(STRIKE.pitch)) / (halfHeight * STRIKE.letterbox)
    const wide = (radius * 1.1) / (halfHeight * this.aspect)
    this.strike.x = x
    this.strike.z = z
    this.strike.distance = Math.max(tall, wide) + STRIKE.push
    this.strike.time = 0
    this.specialPhase = "strike"
  }

  /**
   * Where a boss's name card frames from: the boss on the ground at (x, z), seen from the side of `fromX`/`fromZ` (the
   * player), a three-quarter turn off the line between them.
   */
  setBoss(x: number, z: number, fromX: number, fromZ: number): void {
    vec3.set(this.bossTarget.position, x, BOSS_SHOT.aim, z)
    const toward = Math.atan2(fromZ - z, fromX - x)
    this.bossFrame.x = x
    this.bossFrame.z = z
    this.bossFrame.angle = toward + (Math.cos(toward) >= 0 ? -BOSS_SHOT.turn : BOSS_SHOT.turn)
    this.bossFrame.time = 0
  }

  /**
   * Cuts the play camera to its framing of the player at once, dropping its damping and lookahead: under a
   * transition's full cover, when the next room replaces the last.
   */
  cutPlay(): void {
    this.composer.state.activationPending = true
    this.composer.state.activationPrimed = false
  }

  /** Cuts the title camera to `shot` at once. */
  cutTitle(shot: TitleShot): void {
    this.titleShot = shot
    this.titleTime = 0
    this.titleLens.fov = shot.fov
    this.titleRoll.dutch = shot.roll
  }

  /**
   * Pans the title shot so what it aims at sits `side` of the half-width right of centre (negative is left), eased,
   * so a menu or a panel on one side leaves the subject in view on the other.
   */
  frameTitle(side: number): void {
    this.titleSideGoal = side
  }

  /** Rolls the special shot by `degrees`, at once: a snap between drawings. */
  dutch(degrees: number): void {
    this.specialFrame.dutch = degrees
  }

  /** Leads the play frame toward ground direction (x, z), length 0 to 1. */
  lead(x: number, z: number): void {
    const offset = this.playLead.offset
    offset[0] = x * LEAD
    offset[1] = (-z * LEAD) / 1.155
    offset[2] = 0
  }

  /**
   * Kicks every listening camera; `strength` is roughly world units of kick at the peak (0.1 a tap, 0.6 a slam),
   * scaled by the player's screen-shake setting.
   */
  shake(strength: number, options: ShakeOptions = {}): void {
    const scale = settings.get().shake
    if (scale <= 0) return
    strength *= scale
    const dirX = options.dirX ?? 0
    const dirZ = options.dirZ ?? 0
    this.impulses.generate({
      position: [options.x ?? this.player.position[0], 0, options.z ?? this.player.position[2]],
      direction: [dirX * strength, -strength * 0.6, dirZ * strength],
      shape: ImpulseShapes[options.shape ?? "bump"],
      duration: options.duration ?? 0.25,
      radius: 60,
      dissipationDistance: 0
    })
  }

  /** Narrows the play lens by `degrees` for a beat; it springs back. */
  punch(degrees: number): void {
    this.punchAmount = Math.max(this.punchAmount, degrees)
  }

  /** The viewport in CSS pixels. */
  setSize(width: number, height: number): void {
    this.klipp.setSize(width, height)
    const wide = width / Math.max(1, height)
    this.aspect = wide
    this.specialAim.aspect = wide
    this.distance = PLAY_SHOT.distance * (wide < 1.4 ? 1 + (1.4 - wide) * 0.6 : 1)
    this.composer.cameraDistance = this.distance * this.pull
    this.fitFollow()
  }

  /** The follow target's limits: the frame's half width at the target kept inside the stage's bounds. */
  private fitFollow(): void {
    const { centerX, halfWidth, minZ, maxZ } = this.bounds
    const reach = Math.max(0, halfWidth - this.frameHalfWidth)
    this.followBounds = { minX: centerX - reach, maxX: centerX + reach, minZ, maxZ }
  }

  /** Advances one drawn frame of `dt` real seconds. */
  update(dt: number): void {
    if (this.override !== null) {
      this.override.remaining -= dt
      if (this.override.remaining <= 0) {
        this.override = null
        this.apply()
      }
    }
    this.punchAmount *= Math.exp(-dt * 6)
    this.playLens.fov = PLAY_SHOT.fov - this.punchAmount
    this.klipp.update(dt)
  }

  private apply(): void {
    const shot = this.shot
    const { title, pause, special, boss } = this.cameras
    title.priority = shot === "title" ? PRIORITY.title : 0
    pause.active = shot === "pause"
    special.active = shot === "special"
    boss.active = shot === "boss"
  }

  private bossBody(): BodyPiece {
    return {
      update: (out, dt, justActivated) => {
        if (justActivated) this.bossFrame.time = 0
        this.bossFrame.time += dt
        const push = 1 - Math.exp(-this.bossFrame.time * 1.1)
        const distance = BOSS_SHOT.distance - BOSS_SHOT.push * push
        const { x, z, angle } = this.bossFrame
        vec3.set(out.position, x + Math.cos(angle) * distance, BOSS_SHOT.height - push * 0.3, z + Math.sin(angle) * distance)
      }
    }
  }

  private listener(gain: number): ImpulseListenerNoise {
    return new ImpulseListenerNoise({
      field: this.impulses,
      gain,
      shake: new BasicMultiChannelPerlinNoise({
        positionAmplitude: [0.06, 0.06, 0],
        positionFrequency: [22, 19, 1],
        rotationAmplitude: [1.2, 1.2, 2.2],
        rotationFrequency: [18, 16, 11]
      })
    })
  }

  /**
   * The title's designed shots (`cutTitle`): the lens glides along the shot with its aim, and the aim pans about
   * the lens by `frameTitle` so the subject keeps its place beside the menu or an open panel.
   */
  private titleBody(): BodyPiece {
    const target: Vec3 = [0, 0, 0]
    return {
      update: (out, dt) => {
        const shot = this.titleShot
        this.titleTime += dt
        titleShotAt(shot, this.titleTime, out.position, target)
        this.titleSide += (this.titleSideGoal - this.titleSide) * (1 - Math.exp(-dt * 5))
        const pan = titlePan(this.titleSide, shot.fov, this.aspect, out.position, target)
        const dx = target[0] - out.position[0]
        const dz = target[2] - out.position[2]
        const cos = Math.cos(pan)
        const sin = Math.sin(pan)
        vec3.set(this.arenaCenter.position, out.position[0] + dx * cos + dz * sin, target[1], out.position[2] - dx * sin + dz * cos)
      }
    }
  }

  private pauseBody(play: VirtualCamera): BodyPiece {
    const base: Vec3 = [0, 0, 0]
    const rotation: Quat = [0, 0, 0, 1]
    return {
      update: (out, dt, justActivated) => {
        if (justActivated) {
          vec3.copy(base, play.state.position)
          quat.copy(rotation, play.state.quaternion)
          this.pauseTime = 0
        }
        this.pauseTime += dt
        const push = 4.5 * (1 - Math.exp(-this.pauseTime * 0.9))
        vec3.transformQuat(_scratch, _forward, rotation)
        vec3.scaleAndAdd(out.position, base, _scratch, push)
        quat.copy(out.quaternion, rotation)
      }
    }
  }

  private specialBody(): BodyPiece {
    return {
      update: (out, dt) => {
        if (this.specialPhase === "strike") {
          const { x, z } = this.strike
          this.strike.time += dt
          const angle = this.specialAzimuth + 0.45 + this.strike.time * 0.12
          const distance = this.strike.distance - STRIKE.push * Math.min(1, this.strike.time * 1.5)
          const across = Math.cos(STRIKE.pitch) * distance
          vec3.set(out.position, x + Math.cos(angle) * across, 0.3 + Math.sin(STRIKE.pitch) * distance, z + Math.sin(angle) * across)
          return
        }
        this.specialTime += dt
        const push = 1 - Math.exp(-this.specialTime * 2)
        const angle = this.specialAzimuth + this.specialTime * CUT_IN.drift
        const radius = CUT_IN.from + (CUT_IN.to - CUT_IN.from) * push
        const [x, , z] = this.specialTarget.position
        vec3.set(out.position, x + Math.cos(angle) * radius, CUT_IN.height + CUT_IN.rise * push, z + Math.sin(angle) * radius)
      }
    }
  }
}
