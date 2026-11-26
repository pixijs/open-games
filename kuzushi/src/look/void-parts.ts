import { Box, Container3D, CylinderGeometry, Mesh3D } from "@pixi/3d"
import type { BaseMaterial3D, FlatMaterial, Geometry3D } from "@pixi/3d"
import type { Texture } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import type { FrameTime } from "../host/types.ts"
import type { GameView, Point, Slab } from "../sim/index.ts"
import type { SunSetup } from "./lighting.ts"
import type { Parts } from "./parts.ts"
import { shiftInk } from "./shaders/ink.ts"
import type { InkFade, InkGlow, InkOptions } from "./shaders/ink.ts"
import { lampMaterial, spriteMaterial } from "./shaders/sprite.ts"
import { onTwos } from "./twos.ts"

/**
 * The Void's stonework, shared by its classic arena (./void.ts) and its rooms (./rooms/islands.ts): slabs, each a thick
 * tablet with its drawn top and broken rock hanging under it, that shake on twos while they crack and drop and tip away
 * once they fall; broken slabs and monoliths hanging far off and far below, and debris drifting down past them; the
 * column of light standing beyond the north edge; and the sun and fades they are seen in.
 */

/** How thick the pale top of a slab is, how deep its rock goes, and the gap drawn between neighbours. */
const TOP = 0.34
const BODY = 2.6
const GAP = 0.05
/** Seconds a fallen slab takes to drop out of sight, how far it falls by then, and how far it tips. */
const DROP = { seconds: 1.6, depth: 30, tilt: 0.55 } as const

/** The Void's sun, high over the classic arena; a room widens its bounds to fit. */
export const VOID_SUN: SunSetup = { azimuth: -2.35, elevation: 1.0, intensity: 3, bounds: Box.fromCenterSize({ x: 0, y: -3, z: -1 }, { x: 44, y: 16, z: 36 }) }

/** Slab sides drop into the dark within a few units of a floor of these half sizes. */
export const nearFade = (halfWidth: number, halfDepth: number): InkFade => ({ halfWidth, halfDepth, corner: 0, start: 0.2, end: 4.5, depth: 3, high: 0.6, strength: 0.97 })

/** Far scenery fades slower, so it reads as distance. */
export const farFade = (halfWidth: number, halfDepth: number): InkFade => ({ halfWidth, halfDepth, corner: 0, start: 4, end: 70, depth: 0.9, high: 0.6, strength: 0.9 })

/** The light the column standing at `at` throws on the stone near it. */
export const columnLight = (at: Point): InkGlow => ({ x: at.x, y: 0, z: at.z, radius: 24, strength: 3.4, column: true })

/** The broken rock hanging under slabs and drifting past them: a four-sided point. */
export const spikeGeometry = (parts: Parts): CylinderGeometry => parts.keep(new CylinderGeometry({ radiusTop: 1, radiusBottom: 0, height: 1, radialSegments: 4 }))

/** A slab as drawn: its holder, which shakes and falls, its top's ink and where that was built, and its seams' glow. */
export interface ShownSlab {
  readonly holder: Container3D
  readonly top: BaseMaterial3D
  readonly built: Pick<InkOptions, "surface" | "shape">
  /** Null on a slab that never falls. */
  readonly seams: FlatMaterial | null
  readonly seamMesh: Mesh3D | null
  readonly x: number
  readonly z: number
  /** Game seconds when it fell, or null while it stands. */
  fellAt: number | null
  /** Which way it tips as it falls: away from the middle. */
  readonly tipX: number
  readonly tipZ: number
}

/** The box a slab's pale top fills at rest, for its ink's worn edges. */
export const topShape = (slab: Slab) => ({ kind: "box" as const, x: slab.x, y: -TOP / 2, z: slab.z, halfWidth: slab.halfWidth - GAP, halfHeight: TOP / 2, halfDepth: slab.halfDepth - GAP })

/** What a slab's rock is drawn with: the rock under its top, and the broken rock hanging below it and its shape. */
export interface SlabStone {
  readonly rock: BaseMaterial3D
  readonly under: BaseMaterial3D
  readonly spike: Geometry3D
}

/** Builds `slab`'s tablet in `holder`: its pale top in `top`, the rock under it, and broken rock hanging below, drawn from `next`. */
export const addSlabBody = (parts: Parts, holder: Container3D, slab: Slab, top: BaseMaterial3D, stone: SlabStone, next: () => number): void => {
  const halfWidth = slab.halfWidth - GAP
  const halfDepth = slab.halfDepth - GAP
  holder.addChild(parts.box(0, 0, halfWidth, halfDepth, -TOP, 0, top), parts.box(0, 0, halfWidth - 0.08, halfDepth - 0.08, -BODY, -TOP + 0.01, stone.rock))
  const count = 2 + Math.floor(slab.halfWidth * slab.halfDepth * 0.25)
  for (let each = 0; each < count; each += 1) {
    const width = Math.min(halfWidth, halfDepth) * (0.35 + next() * 0.45)
    const length = 1.4 + next() * 3.4
    const x = (next() * 2 - 1) * Math.max(0, halfWidth - width * 0.6)
    const z = (next() * 2 - 1) * Math.max(0, halfDepth - width * 0.6)
    holder.addChild(new Mesh3D({ geometry: stone.spike, material: stone.under, position: { x, y: -BODY - length / 2 + 0.05, z }, scale: { x: width, y: length, z: width * (0.7 + next() * 0.5) }, rotation: { x: 0, y: next() * Math.PI, z: 0 }, castShadow: false }))
  }
}

/** `slab` as drawn, standing, tipping away from the middle when it falls. */
export const shownSlab = (slab: Slab, holder: Container3D, top: BaseMaterial3D, built: Pick<InkOptions, "surface" | "shape">, seams: FlatMaterial | null, seamMesh: Mesh3D | null): ShownSlab => {
  const tip = Math.atan2(slab.z, slab.x)
  return { holder, top, built, seams, seamMesh, x: slab.x, z: slab.z, fellAt: null, tipX: Math.cos(tip), tipZ: Math.sin(tip) }
}

/** Broken slabs and monoliths hanging far off and far below, 18 round the floor from `from` out, into `scenery`. */
export const addFarScenery = (parts: Parts, scenery: Array<Mesh3D>, far: BaseMaterial3D, farUnder: BaseMaterial3D, spike: Geometry3D, next: () => number, from: number): void => {
  for (let index = 0; index < 18; index += 1) {
    const angle = (index / 18) * Math.PI * 2 + (next() - 0.5) * 0.3
    const north = Math.max(0, -Math.sin(angle))
    const distance = from + next() * 26 + north * 10
    const x = Math.cos(angle) * distance * 1.15
    const z = Math.sin(angle) * distance
    const y = -2 - next() * 14 - (1 - north) * 6
    const half = 1.2 + next() * 3.2
    const depth = half * (0.5 + next() * 0.8)
    const thick = 0.6 + next() * 1.2
    scenery.push(
      parts.box(x, z, half, depth, y - thick, y, far, next() * Math.PI),
      new Mesh3D({ geometry: spike, material: farUnder, position: { x, y: y - thick - half * 0.9, z }, scale: { x: half * 0.8, y: half * 1.8, z: depth * 0.8 }, rotation: { x: 0, y: next() * Math.PI, z: 0 } })
    )
    if (next() < 0.45) {
      const tall = 2 + next() * 7
      scenery.push(parts.box(x + (next() - 0.5) * half, z + (next() - 0.5) * depth, 0.4 + next() * 0.6, 0.4 + next() * 0.6, y, y + tall, far))
    }
  }
}

/** A chip of debris drifting down past the far scenery, and how it falls and turns. */
export interface Chip {
  readonly mesh: Mesh3D
  readonly fall: number
  readonly spin: number
  readonly top: number
}

/** 40 chips of debris in `chips`, between `from` and `from + spread` out, into `scenery`. */
export const addDrift = (scenery: Array<Mesh3D>, chips: BaseMaterial3D, spike: Geometry3D, next: () => number, from: number, spread: number): ReadonlyArray<Chip> =>
  Array.from({ length: 40 }, () => {
    const size = 0.08 + next() * next() * 0.5
    const angle = next() * Math.PI * 2
    const distance = from + next() * spread
    const mesh = new Mesh3D({ geometry: spike, material: chips, position: { x: Math.cos(angle) * distance * 1.2, y: -4 - next() * 30, z: Math.sin(angle) * distance }, scale: { x: size, y: size * (1 + next() * 2), z: size * 0.7 }, rotation: { x: next() * 3, y: next() * 3, z: next() * 3 } })
    scenery.push(mesh)
    return { mesh, fall: 0.2 + next() * 0.6, spin: (next() - 0.5) * 1.2, top: -3 - next() * 3 }
  })

/** The column of light's lamp core and its glow, which pulse. */
export interface Beacon {
  readonly core: FlatMaterial
  readonly columnGlow: FlatMaterial
}

/** The column of light at `at`: its lamp core rising out of the dark, its glow and two halos, into `scenery`. */
export const addBeacon = (parts: Parts, scenery: Array<Mesh3D>, glow: Texture, at: Point): Beacon => {
  const core = parts.keep(lampMaterial(PALETTE.red, 3))
  const columnGlow = parts.keep(spriteMaterial(glow, PALETTE.red, 0.85, "add"))
  const halo = parts.keep(spriteMaterial(glow, PALETTE.red, 1.3, "add"))
  scenery.push(
    parts.column(at.x, at.z, 0.28, -14, 90, core),
    new Mesh3D({ geometry: parts.plane, material: columnGlow, billboardMode: "cylindrical", position: { x: at.x, y: 38, z: at.z }, scale: { x: 4.2, y: 104, z: 1 }, receiveShadow: false }),
    new Mesh3D({ geometry: parts.plane, material: halo, billboardMode: "spherical", position: { x: at.x, y: 0.5, z: at.z }, scale: { x: 11, y: 11, z: 1 }, receiveShadow: false }),
    new Mesh3D({ geometry: parts.plane, material: halo, billboardMode: "spherical", position: { x: at.x, y: -14, z: at.z }, scale: { x: 9, y: 9, z: 1 }, receiveShadow: false })
  )
  return { core, columnGlow }
}

/** Pulses the column of light, with a flicker on twos, and drifts the debris down, turning. */
export const liveScenery = (beacon: Beacon, drifting: ReadonlyArray<Chip>, frame: FrameTime): void => {
  const pulse = 1 + Math.sin(frame.elapsed * 2.1) * 0.06 + (onTwos(frame) ? 0.04 : 0)
  beacon.core.data.boost = 3 * pulse
  beacon.columnGlow.data.boost = 0.85 * pulse
  for (const each of drifting) {
    each.mesh.position.y -= each.fall * frame.gameDt
    if (each.mesh.position.y < -42) each.mesh.position.y = each.top
    each.mesh.rotation.y += each.spin * frame.gameDt
    each.mesh.rotation.x += each.spin * 0.6 * frame.gameDt
  }
}

const place = (entry: ShownSlab, dx: number, dy: number, dz: number) => {
  entry.holder.position.set(entry.x + dx, dy, entry.z + dz)
  shiftInk(entry.top, entry.built, dx, dy, dz)
}

/**
 * Poses every slab from the hazard: one cracking shakes on 15 drawings a second while its seams glow, one fallen
 * drops and tips away. On the `first` frame a slab already fallen is shown gone.
 */
export const liveSlabs = (shown: ReadonlyArray<ShownSlab>, hazard: Extract<GameView["hazard"], { readonly kind: "slabs" }>, frame: FrameTime, first: boolean): void => {
  const twos = Math.floor(frame.gameElapsed * 15) % 2 === 0
  for (const slab of hazard.slabs) {
    const entry = shown[slab.index]
    if (entry === undefined) continue
    if (slab.state === "fallen") {
      entry.fellAt ??= first ? Number.NEGATIVE_INFINITY : frame.gameElapsed
      const t = Math.min(1, (frame.gameElapsed - entry.fellAt) / DROP.seconds)
      place(entry, entry.tipX * t * 2.5, -t * t * DROP.depth, entry.tipZ * t * 2.5)
      entry.holder.rotation.set(entry.tipZ * t * DROP.tilt, 0, -entry.tipX * t * DROP.tilt)
      entry.holder.visible = t < 1
      if (entry.seamMesh !== null && entry.seams !== null) {
        entry.seamMesh.visible = t < 0.6
        entry.seams.data.boost = 3.2 * (1 - t / 0.6)
      }
      continue
    }
    entry.fellAt = null
    entry.holder.visible = true
    entry.holder.rotation.set(0, 0, 0)
    const cracking = slab.state === "cracking"
    const crack = cracking ? hazard.crack : 0
    const shake = cracking ? (twos ? 1 : -1) * (0.015 + crack * 0.05) : 0
    place(entry, shake, cracking ? -crack * crack * 0.08 : 0, -shake * 0.6)
    if (entry.seamMesh !== null && entry.seams !== null) {
      entry.seamMesh.visible = cracking
      entry.seams.data.boost = cracking ? (0.5 + crack * 2.6) * (twos ? 1 : 0.7) : 0
    }
  }
}
