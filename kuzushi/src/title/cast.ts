import { Container3D, FlatMaterial, Mesh3D, PlaneGeometry } from "@pixi/3d"

import { PALETTE } from "../art/palette.ts"
import type { ActorVisual, FrameTime } from "../host/types.ts"
import { arrowheadOutline, extrude, grow } from "../look/geometry.ts"
import { createActorVisual } from "../look/index.ts"
import { lampMaterial } from "../look/shaders/sprite.ts"
import { PLAYER_SIZE } from "../look/shapes.ts"
import { step, Tuning } from "../sim/index.ts"
import type { EnemyKind, EnemyStateName, PlayerStateName, PlayerView } from "../sim/index.ts"
import type { Kit } from "../vfx/kit.ts"
import { telegraphBit } from "../vfx/shaders.ts"
import { ringPlace, STAND } from "./staging.ts"

/** The ring, in the board's order of shapes round the hero. */
const RING_KINDS: ReadonlyArray<EnemyKind> = ["chaser", "shooter", "bruiser", "trickster", "chaser", "shooter", "trickster"]

/** How far the arrowhead's back reaches behind its centre: what it stands on in the hero shot. */
const ARROW_BACK = Tuning.PLAYER.radius * 0.8

/** Seconds an enemy takes to pop in from ink, as in play. */
export const REFORM_SECONDS = Tuning.SPAWN.time.steps / step.hz

const RED = [1, 0.18, 0.247, 1] as const

/** One shape of the ring and its telegraph line toward the hero. */
interface Member {
  readonly kind: EnemyKind
  readonly visual: ActorVisual
  readonly line: Mesh3D
  readonly lineNode: Container3D
  readonly material: FlatMaterial
  /** Its place round the ring, radians, and how far its radius leans off the ring's. */
  readonly angle: number
  readonly lean: number
  x: number
  z: number
  /** Left out of the shot on screen: too near its lens, or in the menu's column. */
  out: boolean
}

/** How a shape of the ring stands this frame. */
export interface Pose {
  readonly state: EnemyStateName
  /** Seconds left in the state: for Spawning, how far the pop-in has to go. */
  readonly timeLeft: number
  /** 0 to 1 while winding up: how far its telegraph has filled; -1 shows none. */
  readonly telegraph: number
}

export interface Cast {
  readonly node: Container3D
  readonly members: ReadonlyArray<{ readonly kind: EnemyKind; readonly x: number; readonly z: number; readonly out: boolean }>
  /**
   * Puts the hero at (x, z) facing `facing` (simulation radians), in `state`. `standing` stands it up on its tail
   * with its face turned away from `facing`, larger: the hero shot's pose against the sun.
   */
  hero(x: number, z: number, facing: number, state: PlayerStateName, options?: { readonly step?: 0 | 1 | 2 | 3; readonly standing?: boolean }): void
  /** Leaves out of the shot the shapes `out` names by their place in the ring. */
  leaveOut(out: (index: number, x: number, z: number) => boolean): void
  /** Spreads the ring at `radius` round (cx, cz), each shape posed by `pose`; `visible` false hides them all. */
  ring(cx: number, cz: number, radius: number, pose: Pose, visible: boolean): void
  showHero(on: boolean): void
  /** Draws the hero and the ring for this frame. */
  update(frame: FrameTime): void
  dispose(): void
}

const playerView = (x: number, z: number, facing: number, state: PlayerStateName, step: 0 | 1 | 2 | 3): PlayerView => ({
  id: -1,
  x,
  z,
  facing,
  vx: 0,
  vz: 0,
  state,
  move: state === "Attack" ? "cut" : null,
  step,
  attackPhase: state === "Attack" ? "active" : null,
  progress: 0,
  timeLeft: 0,
  invulnerable: false,
  parryOpen: false,
  dashReady: true
})

/**
 * The title's cast: the white arrowhead and a ring of red shapes, drawn by the game's own actor visuals (src/look)
 * from views the title writes at full health (so no health bars), and a red telegraph line on the floor from each
 * shape to the hero while they wind up.
 */
export const makeCast = (kit: Kit, parent: Container3D): Cast => {
  const node = new Container3D({ label: "title-cast" })
  parent.addChild(node)
  const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })
  const hero = createActorVisual("player")
  const stand = new Container3D({ label: "title-hero-stand" })
  const lean = new Container3D({ rotation: { x: STAND.lean, y: 0, z: 0 } })
  const tilt = new Container3D()
  const backlight = lampMaterial(PALETTE.red, 2.4)
  const rimGeometry = extrude(grow(arrowheadOutline(PLAYER_SIZE), STAND.backlight), 0.01, PLAYER_SIZE * 1.4, -0.03)
  const rimLight = new Mesh3D({ geometry: rimGeometry, material: backlight, castShadow: false, receiveShadow: false })
  tilt.addChild(rimLight, hero.node)
  lean.addChild(tilt)
  stand.addChild(lean)
  node.addChild(stand)
  let player = playerView(0, 0, -Math.PI / 2, "Free", 0)
  let standing = false

  const members: Array<Member> = RING_KINDS.map((kind, index) => {
    const visual = createActorVisual(kind)
    const material = new FlatMaterial({ baseColorTexture: kit.telegraphs.courtyard.line, extraBits: [telegraphBit], alphaMode: "blend", doubleSided: true })
    material.data.tint = [...RED]
    const line = new Mesh3D({ geometry: quad, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, castShadow: false, receiveShadow: false })
    const lineNode = new Container3D({ label: `title-telegraph-${index}` })
    lineNode.addChild(line)
    node.addChild(lineNode, visual.node)
    return { kind, visual, line, lineNode, material, ...ringPlace(index, RING_KINDS.length), x: 0, z: 0, out: false }
  })

  let pose: Pose = { state: "Move", timeLeft: 0, telegraph: -1 }
  let ringShown = true
  let heroShown = true

  return {
    node,
    members,
    hero: (x, z, facing, state, options = {}) => {
      player = playerView(x, z, facing, state, options.step ?? 0)
      standing = options.standing ?? false
    },
    leaveOut: (out) => {
      members.forEach((member, index) => {
        member.out = out(index, member.x, member.z)
      })
    },
    ring: (cx, cz, radius, next, visible) => {
      pose = next
      ringShown = visible
      for (const member of members) {
        const reach = radius + member.lean
        member.x = cx + Math.cos(member.angle) * reach
        member.z = cz + Math.sin(member.angle) * reach
      }
    },
    showHero: (on) => {
      heroShown = on
      hero.node.visible = on
    },
    update: (frame) => {
      if (heroShown) {
        const scale = standing ? STAND.scale : 1
        stand.position.set(standing ? player.x : 0, standing ? ARROW_BACK * scale : 0, standing ? player.z : 0)
        stand.rotation.y = standing ? -player.facing + STAND.turn : 0
        lean.rotation.x = standing ? STAND.lean : 0
        tilt.rotation.z = standing ? Math.PI / 2 : 0
        rimLight.visible = standing
        tilt.scale.set(scale, scale, scale)
        if (standing) hero.place(0, 0, 0)
        else hero.place(player.x, player.z, player.facing)
        hero.update({ role: "player", player }, frame)
      }
      members.forEach((member, index) => {
        const shown = ringShown && !member.out
        member.visual.node.visible = shown
        member.lineNode.visible = shown && pose.telegraph >= 0
        if (!shown) return
        const toX = player.x - member.x
        const toZ = player.z - member.z
        const distance = Math.hypot(toX, toZ) || 1
        const dirX = toX / distance
        const dirZ = toZ / distance
        const facing = Math.atan2(dirZ, dirX)
        member.visual.place(member.x, member.z, facing)
        member.visual.update({
          role: "enemy",
          enemy: {
            id: -2 - index,
            kind: member.kind,
            x: member.x,
            z: member.z,
            facing,
            hp: Tuning.ENEMY[member.kind].hp,
            maxHp: Tuning.ENEMY[member.kind].hp,
            state: pose.state,
            timeLeft: pose.timeLeft,
            telegraph: pose.telegraph >= 0 ? { shape: "line", dirX, dirZ, size: distance, progress: pose.telegraph, feint: false } : null,
            blinkTo: null
          }
        }, frame)
        if (pose.telegraph < 0) return
        const start = Tuning.ENEMY[member.kind].radius + 0.15
        const length = Math.max(0.5, distance - start - 0.4)
        member.lineNode.position.set(member.x, 0.08, member.z)
        member.lineNode.rotation.y = -facing
        member.line.position.set(start + length / 2, 0, 0)
        member.line.scale.set(length, 0.4, 1)
        member.material.data.fill = [Math.min(1, Math.ceil(pose.telegraph * 8) / 8), 0, pose.telegraph >= 1 ? 1 : 0, 0.3]
      })
    },
    dispose: () => {
      hero.destroy()
      backlight.destroy()
      rimGeometry.destroy()
      for (const member of members) {
        member.visual.destroy()
        member.material.destroy()
      }
      node.destroy({ children: true })
      quad.destroy()
    }
  }
}
