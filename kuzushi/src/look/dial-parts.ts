import { CylinderGeometry, Mesh3D } from "@pixi/3d"
import type { BaseMaterial3D, Container3D, FlatMaterial, Geometry3D } from "@pixi/3d"

import { PALETTE } from "../art/palette.ts"
import type { ArenaLayout, GameView, Pillar } from "../sim/index.ts"
import { propBetween } from "./occlusion.ts"
import type { Occluders } from "./occlusion.ts"
import { KERB, SUNKEN } from "./parts.ts"
import type { Parts } from "./parts.ts"
import { setInkCut, setInkGlow } from "./shaders/ink.ts"
import type { InkFade, InkGlow, InkOptions } from "./shaders/ink.ts"
import { lampMaterial, spriteMaterial } from "./shaders/sprite.ts"
import type { LookTextures } from "./textures.ts"
import { DRAWINGS } from "./twos.ts"

/**
 * The Spiral's stonework, shared by its classic arena (./spiral.ts) and its rooms (./rooms/dial.ts): columns with a
 * plinth, banded tapering shaft, flared cap and abacus; the spire of stepped drums with the beam's slit, an obelisk and
 * its lamp; and the thinning that dithers a tall solid away while it hides the action from the camera.
 */

/**
 * A spire or pillar hides the floor behind it from the play camera. While an actor, the far end of an enemy's
 * telegraph line or any part of a telegraph ring stands in that shadow (within `margin` of the solid's side), the
 * solid thins to a dithered fifth of itself; its shadow stays.
 */
const SHROUD = { margin: 0.5, cut: 0.8, rate: 12 } as const

const RING_POINTS = 8

interface Spot {
  readonly x: number
  readonly z: number
}

/** The ground points a tall solid must never hide: the player, every enemy, each telegraph line's far end and points round each ring. */
const actionSpots = (view: GameView): ReadonlyArray<Spot> => {
  const spots: Array<Spot> = view.player === null ? [] : [view.player]
  for (const enemy of view.enemies) {
    spots.push(enemy)
    const telegraph = enemy.telegraph
    if (telegraph === null) continue
    if (telegraph.shape === "line") {
      spots.push({ x: enemy.x + telegraph.dirX * telegraph.size, z: enemy.z + telegraph.dirZ * telegraph.size })
      continue
    }
    for (let index = 0; index < RING_POINTS; index++) {
      const angle = (index / RING_POINTS) * Math.PI * 2
      spots.push({ x: enemy.x + Math.cos(angle) * telegraph.size, z: enemy.z + Math.sin(angle) * telegraph.size })
    }
  }
  return spots
}

/** The ground point `hides` tests, reused for every spot. */
const target = { x: 0, y: 0.15, z: 0 }

/** Whether `shroud` stands between `eye` and any of `spots`. */
const hides = (shroud: Occluders, eye: { readonly x: number; readonly y: number; readonly z: number }, spots: ReadonlyArray<Spot>): boolean =>
  spots.some((spot) => {
    target.x = spot.x
    target.z = spot.z
    return propBetween(shroud, eye, target)
  })

/** A solid's thinning, eased toward `goal`. */
const ease = (amount: number, goal: number, dt: number): number => amount + (goal - amount) * (1 - Math.exp(-dt * SHROUD.rate))

/** How the Spiral's surfaces fade into the dark round a floor of these half sizes and corner radius: slowly. */
export const dialFade = (halfWidth: number, halfDepth: number, corner: number): InkFade => ({ halfWidth, halfDepth, corner, start: 1.5, end: 20, depth: 2, high: 0.75, strength: 0.94 })

/**
 * A ring wall of `segments` stones round a floor of `radius` under a coping, its south arc a low kerb that never hides
 * the player; no stone where `gap` holds for its angle, such as a doorway.
 */
export const addRingWall = (node: Container3D, parts: Parts, layout: Pick<ArenaLayout, "wall" | "wallHeight">, radius: number, segments: number, stone: BaseMaterial3D, coping: BaseMaterial3D, gap: (angle: number) => boolean = () => false): void => {
  const middle = radius + layout.wall / 2
  const length = (Math.PI * 2 * middle) / segments + 0.1
  for (let index = 0; index < segments; index += 1) {
    const angle = ((index + 0.5) / segments) * Math.PI * 2
    if (gap(angle)) continue
    const south = Math.sin(angle)
    const top = south > 0.5 ? KERB : south > 0.2 ? KERB + (layout.wallHeight - KERB) * ((0.5 - south) / 0.3) : layout.wallHeight
    const x = Math.cos(angle) * middle
    const z = Math.sin(angle) * middle
    node.addChild(parts.box(x, z, layout.wall / 2, length / 2, -SUNKEN, top, stone, -angle))
    node.addChild(parts.box(x, z, layout.wall / 2 + 0.08, length / 2, top, top + 0.12, coping, -angle))
  }
}

/** Radii and half sizes are shares of the pillar's radius, heights units. */
const COLUMN = { taper: 0.84, cap: 0.96, capHeight: 0.16, abacus: 0.98, abacusHeight: 0.1, plinth: 1.14, plinthHeight: 0.18, bands: [0.12, 0.88], band: 0.07 } as const

/** Builds a material for one solid: `ink(color, options)` with the dial's fade, fill and glow. */
export type DialInk = (color: number, options: Partial<Omit<InkOptions, "grain" | "color">>) => BaseMaterial3D

/** A column as it hides what stands behind it, the materials that thin while it does, and how thin it is now. */
export interface Column {
  readonly shape: Pillar
  readonly shroud: Occluders
  readonly thinning: ReadonlyArray<BaseMaterial3D>
  cut: number
  /** The cut its materials show, so an unchanged one isn't written again. */
  drawn: number
}

/** Shapes the columns share: the tapering shaft and the cap flaring out of it. */
export const columnGeometry = (parts: Parts) => ({
  tapered: parts.keep(new CylinderGeometry({ radiusTop: COLUMN.taper, radiusBottom: 1, height: 1, radialSegments: 48 })),
  flare: parts.keep(new CylinderGeometry({ radiusTop: 1, radiusBottom: COLUMN.taper / COLUMN.cap, height: 1, radialSegments: 48 }))
})

const solidOf = (parts: Parts, ink: DialInk, x: number, z: number, radius: number, bottom: number, top: number, color: number, streaks = 0.3, geometry?: Geometry3D) =>
  parts.column(x, z, radius, bottom, top, ink(color, { wear: 0.07, streaks, shape: { kind: "cylinder", x, y: (bottom + top) / 2, z, radius, halfHeight: (top - bottom) / 2 } }), geometry)

const squareOf = (parts: Parts, ink: DialInk, x: number, z: number, half: number, bottom: number, top: number, color: number) =>
  parts.box(x, z, half, half, bottom, top, ink(color, { wear: 0.09, streaks: 0, shape: { kind: "box", x, y: (bottom + top) / 2, z, halfWidth: half, halfHeight: (top - bottom) / 2, halfDepth: half } }))

/** A stone column for `pillar`: a square plinth, a banded tapering shaft, a flared cap and a thin square abacus. */
export const addColumn = (node: Container3D, parts: Parts, ink: DialInk, geometry: ReturnType<typeof columnGeometry>, pillar: Pillar): Column => {
  const { x, z, radius, height } = pillar
  const across = (share: number) => radius * (1 - (1 - COLUMN.taper) * share)
  const top = height + COLUMN.capHeight + COLUMN.abacusHeight
  const shaft = [
    solidOf(parts, ink, x, z, radius, COLUMN.plinthHeight, height, PALETTE.concrete500, 0.4, geometry.tapered),
    ...COLUMN.bands.map((share) => {
      const at = COLUMN.plinthHeight + (height - COLUMN.plinthHeight) * share
      return solidOf(parts, ink, x, z, across(share) + 0.035, at - COLUMN.band / 2, at + COLUMN.band / 2, PALETTE.concrete300, 0)
    }),
    solidOf(parts, ink, x, z, radius * COLUMN.cap, height, height + COLUMN.capHeight, PALETTE.concrete400, 0, geometry.flare),
    squareOf(parts, ink, x, z, radius * COLUMN.abacus, height + COLUMN.capHeight, top, PALETTE.concrete400)
  ]
  node.addChild(squareOf(parts, ink, x, z, radius * COLUMN.plinth, 0, COLUMN.plinthHeight, PALETTE.concrete400), ...shaft)
  const reach = radius * COLUMN.abacus * Math.SQRT2
  return {
    shape: { x, z, radius: reach, height: top },
    shroud: { blocks: [], pillars: [{ x, z, radius: reach + SHROUD.margin, height: top }] },
    thinning: shaft.map((mesh) => mesh.material),
    cut: 0,
    drawn: 0
  }
}

/** How deep the paler coping round the top of each of the spire's drums is. */
const SPIRE_COPING = 0.1

/** The spire, bottom to top: three stepped drums sized from its base, the obelisk and its cap, the slit where the beam leaves. */
const spireShape = (spire: Pillar) => {
  const scale = spire.radius / 2
  const tall = spire.height / 16
  const top = 0.95 + 1.45 * tall
  return {
    drums: [
      { radius: spire.radius, top: 0.95 },
      { radius: 1.6 * scale, top: 0.95 + 0.7 * tall },
      { radius: 1.22 * scale, top }
    ],
    obelisk: { bottom: top, top: top + 7.2 * tall, base: 0.85 * scale, tip: 0.5 * scale },
    slit: { bottom: 0.34, top: 0.6 }
  } as const
}

/** The spire as built: what thins, what glows, and its shapes solid and thinned. */
export interface Spire {
  readonly upper: ReadonlyArray<BaseMaterial3D>
  readonly slit: FlatMaterial
  readonly pool: FlatMaterial
  readonly halo: FlatMaterial
  readonly lampRing: Mesh3D
  readonly solid: ReadonlyArray<Pillar>
  readonly thin: ReadonlyArray<Pillar>
  /** The ground it hides from the camera above its lowest drum. */
  readonly shroud: Occluders
  /** Where its slit's light comes from. */
  readonly glow: InkGlow
}

/**
 * The spire for `spire` (its base radius and height): three stepped drums, an accent slit round the lowest where the
 * beam leaves, an obelisk with an accent lamp near its top, and a pool of the slit's light on the stones at its foot.
 */
export const addSpire = (node: Container3D, parts: Parts, ink: DialInk, textures: LookTextures, spire: Pillar): Spire => {
  const { drums, obelisk, slit: slitAt } = spireShape(spire)
  const upper: Array<BaseMaterial3D> = []
  drums.forEach((drum, index) => {
    const bottom = index === 0 ? 0 : (drums[index - 1]?.top ?? 0)
    const coping = drum.top - SPIRE_COPING
    // The drum stops under its coping: two capped tops at one height z-fight.
    const meshes = [
      solidOf(parts, ink, spire.x, spire.z, drum.radius, bottom, coping, index === 1 ? PALETTE.concrete400 : PALETTE.concrete500),
      solidOf(parts, ink, spire.x, spire.z, drum.radius + 0.06, coping, drum.top, PALETTE.concrete300, 0)
    ]
    node.addChild(...meshes)
    if (index > 0) upper.push(...meshes.map((mesh) => mesh.material))
  })
  const slitShadow = parts.keep(lampMaterial(PALETTE.ink, 1))
  const slit = parts.keep(lampMaterial(PALETTE.red, 1.6))
  node.addChild(
    parts.column(spire.x, spire.z, spire.radius + 0.012, slitAt.bottom - 0.05, slitAt.top + 0.05, slitShadow, parts.tube),
    parts.column(spire.x, spire.z, spire.radius + 0.02, slitAt.bottom, slitAt.top, slit, parts.tube)
  )
  const taper = parts.keep(new CylinderGeometry({ radiusTop: obelisk.tip, radiusBottom: obelisk.base, height: 1, radialSegments: 8 }))
  const shaft = ink(PALETTE.concrete500, { wear: 0.07, streaks: 0.5 })
  const cap = ink(PALETTE.concrete400, { wear: 0.05, streaks: 0 })
  upper.push(shaft, cap)
  const lamp = parts.keep(lampMaterial(PALETTE.red, 2.6))
  const tip = parts.keep(new CylinderGeometry({ radiusTop: 0, radiusBottom: obelisk.tip, height: 1, radialSegments: 8 }))
  const lampRing = parts.column(spire.x, spire.z, obelisk.tip + 0.04, obelisk.top - 0.55, obelisk.top - 0.35, lamp, parts.tube)
  node.addChild(
    new Mesh3D({ geometry: taper, material: shaft, position: { x: spire.x, y: (obelisk.bottom + obelisk.top) / 2, z: spire.z }, scale: { x: 1, y: obelisk.top - obelisk.bottom, z: 1 }, rotation: { x: 0, y: Math.PI / 8, z: 0 } }),
    lampRing,
    new Mesh3D({ geometry: tip, material: cap, position: { x: spire.x, y: obelisk.top + 0.6, z: spire.z }, scale: { x: 1, y: 1.2, z: 1 }, rotation: { x: 0, y: Math.PI / 8, z: 0 } })
  )
  const halo = parts.keep(spriteMaterial(textures.glow, PALETTE.red, 1.6, "add"))
  const pool = parts.keep(spriteMaterial(textures.glow, PALETTE.red, 0.55, "add"))
  node.addChild(
    new Mesh3D({ geometry: parts.plane, material: halo, billboardMode: "spherical", position: { x: spire.x, y: obelisk.top - 0.45, z: spire.z }, scale: { x: 4.5, y: 4.5, z: 1 }, castShadow: false, receiveShadow: false }),
    parts.flat(spire.x, 0.02, spire.z, spire.radius * 5.5, spire.radius * 5.5, pool)
  )
  const lowest = drums[0]
  return {
    upper,
    slit,
    pool,
    halo,
    lampRing,
    solid: [...drums.map((drum) => ({ x: spire.x, z: spire.z, radius: drum.radius, height: drum.top })), { x: spire.x, z: spire.z, radius: (obelisk.base + obelisk.tip) / 2, height: obelisk.top }],
    thin: [{ x: spire.x, z: spire.z, radius: lowest.radius, height: lowest.top }],
    shroud: { blocks: [], pillars: [{ x: spire.x, z: spire.z, radius: spire.radius + SHROUD.margin, height: obelisk.top + 1.8 }] },
    glow: { x: spire.x, y: 0.5, z: spire.z, radius: spire.radius * 4.25, strength: 0.9, column: false }
  }
}

/**
 * The spire's life: the beam's heat on it (its slit, pool and the stones' glow brighten while the beam is warned or
 * sweeps) and its thinning, with the cut its materials show and the glow strength the stones last took, so neither is
 * written again unchanged.
 */
export interface SpireLife {
  heat: number
  cut: number
  drawn: number
  glow: number
}

/** A spire at rest: cold and whole, its stones not yet lit. */
export const spireLife = (): SpireLife => ({ heat: 0, cut: 0, drawn: 0, glow: Number.NaN })

/** Thins `materials` to `cut` (whole under 0.01), unless they already show it. Returns the cut they show. */
const thin = (materials: ReadonlyArray<BaseMaterial3D>, cut: number, drawn: number): number => {
  const shown = cut < 0.01 ? 0 : cut
  if (shown !== drawn) for (const material of materials) setInkCut(material, shown)
  return shown
}

/**
 * Thins the spire and the columns while they hide the action, and warms the slit, its pool of light and the stones
 * round it with the beam. Returns the solids that hide an actor this frame.
 */
export const liveSpire = (spire: Spire | null, columns: ReadonlyArray<Column>, glowing: ReadonlyArray<BaseMaterial3D>, life: SpireLife, view: GameView, eye: { readonly x: number; readonly y: number; readonly z: number }, dt: number, elapsed: number): ReadonlyArray<Pillar> => {
  const spots = actionSpots(view)
  for (const column of columns) {
    column.cut = ease(column.cut, hides(column.shroud, eye, spots) ? SHROUD.cut : 0, dt)
    column.drawn = thin(column.thinning, column.cut, column.drawn)
  }
  const standing = columns.filter((column) => column.cut < SHROUD.cut / 2).map((column) => column.shape)
  if (spire === null) return standing
  life.cut = ease(life.cut, hides(spire.shroud, eye, spots) ? SHROUD.cut : 0, dt)
  life.drawn = thin(spire.upper, life.cut, life.drawn)
  spire.lampRing.visible = life.cut < SHROUD.cut / 2
  spire.halo.data.boost = 1.6 * (1 - life.cut)
  const beam = view.hazard.kind === "beam" ? view.hazard : null
  const goal = beam === null || beam.phase === "rest" ? 0 : beam.phase === "warn" ? 0.5 + beam.progress * 0.5 : 1
  life.heat += (goal - life.heat) * (1 - Math.exp(-dt * 6))
  const flicker = Math.floor(elapsed * DRAWINGS) % 2 === 0 ? 1 : 0.92
  spire.slit.data.boost = (1.6 + life.heat * 2.4) * flicker
  spire.pool.data.boost = (0.5 + life.heat * 0.9) * flicker
  const strength = spire.glow.strength * (1 + life.heat * 1.3) * flicker
  if (strength !== life.glow) {
    life.glow = strength
    const glow: InkGlow = { ...spire.glow, strength }
    for (const material of glowing) setInkGlow(material, glow)
  }
  return [...standing, ...(life.cut > SHROUD.cut / 2 ? spire.thin : spire.solid)]
}
