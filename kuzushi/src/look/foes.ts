import { Container3D, Mesh3D } from "@pixi/3d"
import type { FlatMaterial, Geometry3D } from "@pixi/3d"
import { spring } from "math/time"

import { PALETTE, paletteOfKind } from "../art/palette.ts"
import type { FrameTime } from "../host/types.ts"
import { step, Tuning } from "../sim/index.ts"
import type { EnemyKind, EnemyView } from "../sim/index.ts"
import { useKit } from "./actors.ts"
import type { Quirks } from "./actors.ts"
import { extrude, grow, polygon } from "./geometry.ts"
import type { Point } from "./geometry.ts"
import { lampMaterial } from "./shaders/sprite.ts"
import { SHAPES } from "./shapes.ts"
import { DRAWINGS, onTwos } from "./twos.ts"

/**
 * What the shared enemy pose leaves to the Spiral's and the Void's kinds: the sweeper's clock hand ticking, its arm
 * reaching out to the arc it marked and sweeping it; the pulsar's cog spinning up into its wave; the leaper's crouch,
 * its leap arcing high and spinning, its landing; the cutter's slanted bar hovering, drawing back, and slashing forward
 * as its seam runs. And the elite's white crown.
 */

/** Seconds through a timed state of `total` seconds that `left` remain of, 0 to 1. */
export const through = (left: number, total: number) => Math.min(1, Math.max(0, 1 - left / total))

/** Seconds a leap stays in the air: the leaper's and Sunder's. */
export const AIR = { leaper: Tuning.LEAPER.air.steps / step.hz, sunder: Tuning.SUNDER.leap.air.steps / step.hz } as const

/** How high a leap arcs at `t` (0 to 1): up fast, a held hang at the top, down hard. */
export const leapHeight = (t: number, peak: number) => peak * Math.sin(Math.PI * Math.min(1, Math.max(0, t)) ** 0.85)

/** The sweeper's arm, built along +x from its pivot: a tapered blade the length of its reach. */
const armOutline = (reach: number, width: number): ReadonlyArray<Point> => [[reach, 0], [reach * 0.18, width], [0.1, width * 0.6], [0.1, -width * 0.6], [reach * 0.18, -width]]

interface ArmParts {
  readonly blade: Geometry3D
  readonly rim: Geometry3D
  readonly glow: FlatMaterial
}

let arm: ArmParts | undefined

/** The sweeper's arm parts, made once and kept: shared by every sweeper. */
const armParts = (): ArmParts => {
  if (arm !== undefined) return arm
  const outline = armOutline(Tuning.SWEEPER.radius, 0.11)
  arm = {
    blade: extrude(outline, 0.14, Tuning.SWEEPER.radius, 0.06),
    rim: extrude(grow(outline, 0.04), 0.1, Tuning.SWEEPER.radius, 0.05),
    glow: lampMaterial(paletteOfKind("sweeper").danger, 1.8, true)
  }
  return arm
}

const sweeper = (pose: Container3D, spin: Container3D): Quirks => {
  const parts = useKit()
  const { blade, rim, glow } = armParts()
  const reach = new Container3D({ label: "sweeper-arm" })
  const rimMesh = new Mesh3D({ geometry: rim, material: parts.ink, castShadow: false, receiveShadow: false })
  reach.addChild(rimMesh, new Mesh3D({ geometry: blade, material: glow, castShadow: true, receiveShadow: false }))
  pose.addChild(reach)
  const out = spring.create(0)
  let tick = 0
  return {
    update: (enemy, frame, _glow, _flash, behind) => {
      const windup = enemy.state === "Windup" ? (enemy.telegraph?.progress ?? 0) : 0
      const sweeping = enemy.state === "Sweep"
      const target = sweeping ? 1 : windup > 0 ? Math.min(1, windup * 1.4) : 0
      spring.update(out, target, sweeping ? 0.02 : 0.07, 0.6, frame.dt)
      const shown = Math.max(0.001, out.value)
      reach.scale.set(shown, 1, 0.6 + 0.4 * shown)
      reach.visible = out.value > 0.02
      rimMesh.material = behind ? parts.xrayInk : parts.ink
      if (enemy.state === "Move") {
        tick += frame.gameDt
        spin.rotation.y = Math.floor(tick * 2) % 2 === 0 ? 0.12 : -0.12
      } else {
        spin.rotation.y = windup > 0 && onTwos(frame) ? 0.05 : 0
      }
    },
    destroy: () => reach.destroy({ children: true })
  }
}

const pulsar = (pose: Container3D, spin: Container3D): Quirks => {
  const rate = spring.create(1.2)
  return {
    update: (enemy, frame) => {
      const windup = enemy.state === "Windup" ? (enemy.telegraph?.progress ?? 0) : 0
      const target = enemy.state === "Pulse" ? 22 : windup > 0 ? 2 + windup * windup * 16 : enemy.state === "Recover" ? 0.4 : 1.2
      spring.update(rate, target, 0.12, 0.8, frame.dt)
      spin.rotation.y -= rate.value * frame.gameDt
      const swell = 1 + (enemy.state === "Pulse" ? 0.18 : windup * 0.08 * (onTwos(frame) ? 1 : 0.4))
      pose.scale.set(pose.scale.x * swell, pose.scale.y, pose.scale.z * swell)
    },
    destroy: () => {}
  }
}

const leaper = (lift: Container3D, pose: Container3D, spin: Container3D, peak: number): Quirks => {
  let turn = 0
  return {
    update: (enemy, frame) => {
      if (enemy.state !== "Leap") {
        spin.rotation.y += ((enemy.state === "Recover" ? (onTwos(frame) ? 0.06 : -0.06) : 0) - spin.rotation.y) * Math.min(1, frame.dt * 18)
        turn = 0
        return
      }
      const t = through(enemy.timeLeft, AIR.leaper)
      lift.position.y += leapHeight(t, peak)
      turn += frame.gameDt * (t < 0.5 ? 9 : 4)
      spin.rotation.y = turn
      const stretch = t > 0.82 ? 1.35 : t < 0.15 ? 1.25 : 1
      pose.scale.set(pose.scale.x / stretch, pose.scale.y * stretch, pose.scale.z / stretch)
    },
    destroy: () => {}
  }
}

const cutter = (lift: Container3D, pose: Container3D, spin: Container3D, id: () => number): Quirks => ({
  update: (enemy: EnemyView, frame: FrameTime) => {
    const windup = enemy.state === "Windup" ? (enemy.telegraph?.progress ?? 0) : 0
    const cutting = enemy.state === "Cut"
    pose.position.set(cutting ? 0.28 : -0.3 * windup, 0, windup > 0 && onTwos(frame) ? 0.025 : 0)
    spin.rotation.z = Math.sin(frame.elapsed * 2.1 + id()) * 0.1 - windup * 0.25 + (cutting ? 0.3 : 0)
    if (enemy.state !== "Falling" && enemy.state !== "Spawning") lift.position.y += 0.05 + Math.sin(frame.elapsed * 2.8 + id()) * 0.025
  },
  destroy: () => {}
})

/** The quirks of the kinds actors.ts doesn't animate itself; undefined for the rest. */
export const foeQuirks = (kind: EnemyKind, lift: Container3D, pose: Container3D, spin: Container3D, id: () => number): Quirks | undefined => {
  switch (kind) {
    case "sweeper": return sweeper(pose, spin)
    case "pulsar": return pulsar(pose, spin)
    case "leaper": return leaper(lift, pose, spin, 2.6)
    case "cutter": return cutter(lift, pose, spin, id)
    default: return undefined
  }
}

let crownParts: { readonly point: Geometry3D; readonly rim: Geometry3D; readonly white: FlatMaterial } | undefined

/** An elite's crown: three small white triangles round a ring over its body, turning slowly, on twos. */
export const eliteCrown = (kind: EnemyKind) => {
  const parts = useKit()
  crownParts ??= (() => {
    const outline = polygon(0.16, 3)
    return { point: extrude(outline, 0.05, 0.16), rim: extrude(grow(outline, 0.035), 0.045, 0.2, -0.005), white: lampMaterial(PALETTE.paper, 2.2) }
  })()
  const made = crownParts
  const node = new Container3D({ label: "elite-crown", position: { x: 0, y: SHAPES[kind].height + 0.42, z: 0 } })
  const turner = new Container3D()
  node.addChild(turner)
  const rims: Array<Mesh3D> = []
  for (let index = 0; index < 3; index++) {
    const holder = new Container3D({ rotation: { x: 0, y: (index / 3) * Math.PI * 2, z: 0 } })
    const point = new Container3D({ position: { x: Tuning.ENEMY[kind].radius * 0.55, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.7 } })
    const rim = new Mesh3D({ geometry: made.rim, material: parts.ink, castShadow: false, receiveShadow: false })
    rims.push(rim)
    point.addChild(rim, new Mesh3D({ geometry: made.point, material: made.white, castShadow: false, receiveShadow: false }))
    holder.addChild(point)
    turner.addChild(holder)
  }
  let drawn = -1
  return {
    node,
    update: (frame: FrameTime, behind: boolean) => {
      const drawing = Math.floor(frame.gameElapsed * DRAWINGS)
      if (drawing !== drawn) {
        drawn = drawing
        turner.rotation.y = drawing * 0.18
        node.position.y = SHAPES[kind].height + 0.42 + (drawing % 2 === 0 ? 0.03 : 0)
      }
      for (const rim of rims) rim.material = behind ? parts.xrayInk : parts.ink
    }
  }
}

/** Shared parts made on first use; released with the actors. */
export const releaseFoes = () => {
  if (arm !== undefined) {
    arm.blade.destroy()
    arm.rim.destroy()
    arm.glow.destroy()
    arm = undefined
  }
  if (crownParts !== undefined) {
    crownParts.point.destroy()
    crownParts.rim.destroy()
    crownParts.white.destroy()
    crownParts = undefined
  }
}
