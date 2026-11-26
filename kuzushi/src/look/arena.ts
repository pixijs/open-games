import { Container3D, Mesh3D } from "@pixi/3d"
import type { BaseMaterial3D } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../art/palette.ts"
import { ARENA } from "../sim/index.ts"
import type { Block, Pillar } from "../sim/index.ts"
import { FLOOR } from "./floor.ts"
import { makeParts, SUNKEN } from "./parts.ts"
import type { LookTextures } from "./textures.ts"

/**
 * The Courtyard from the simulation's layout: the tiled floor, low boundary walls with a coping, the blocks and
 * pillars, and beyond the walls a sunken ground with the backdrop monoliths, extra spires and rubble, all fading
 * into the ink-black void.
 */

/** The wall nearest the camera is a low kerb, so it never hides the player standing against it. */
const NEAR_WALL_HEIGHT = 0.22

interface Solid {
  readonly x: number
  readonly z: number
  readonly halfWidth: number
  readonly halfDepth: number
  /** Bottom and top heights. */
  readonly bottom: number
  readonly top: number
}

interface Column {
  readonly x: number
  readonly z: number
  readonly radius: number
  readonly bottom: number
  readonly top: number
}

/** Scenery outside the walls beyond the simulation's backdrop: spires behind the far wall and on the flanks, kept low to the south so they never block the play camera. */
const SPIRES: ReadonlyArray<Solid | Column> = [
  { x: 0.5, z: -24, halfWidth: 4.5, halfDepth: 1.2, bottom: -SUNKEN, top: 15 },
  { x: -16, z: -22, radius: 1.4, bottom: -SUNKEN, top: 13 },
  { x: 16.5, z: -22.5, radius: 1.1, bottom: -SUNKEN, top: 9.5 },
  { x: -29, z: -5, halfWidth: 1.6, halfDepth: 2.6, bottom: -SUNKEN, top: 13 },
  { x: 29.5, z: -4, halfWidth: 2.2, halfDepth: 2, bottom: -SUNKEN, top: 14 },
  { x: 31, z: 11, radius: 1.3, bottom: -SUNKEN, top: 8.5 },
  { x: -31, z: 15, halfWidth: 2.2, halfDepth: 2.2, bottom: -SUNKEN, top: 7.5 },
  { x: -36, z: -16, halfWidth: 3, halfDepth: 3, bottom: -SUNKEN, top: 18 },
  { x: 36, z: -18, halfWidth: 2.5, halfDepth: 3.5, bottom: -SUNKEN, top: 16 },
  { x: -7, z: 21, halfWidth: 2, halfDepth: 1, bottom: -SUNKEN, top: 2.2 },
  { x: 5, z: 22.5, halfWidth: 3, halfDepth: 1, bottom: -SUNKEN, top: 3 },
  { x: 26, z: 20, halfWidth: 2.5, halfDepth: 1.5, bottom: -SUNKEN, top: 4.5 }
]

const isColumn = (shape: Solid | Column): shape is Column => "radius" in shape

/** Low stones scattered along the outside of the walls. */
const rubble = (): ReadonlyArray<Solid> => {
  const random = mulberry32.create(0x7a61)
  const next = () => mulberry32.sample(random)
  const outerX = ARENA.halfWidth + ARENA.wall
  const outerZ = ARENA.halfDepth + ARENA.wall
  return Array.from({ length: 26 }, () => {
    const side = Math.floor(next() * 4)
    const along = next() * 2 - 1
    const out = 0.8 + next() * 3.5
    const x = side < 2 ? along * outerX : (side === 2 ? -1 : 1) * (outerX + out)
    const z = side < 2 ? (side === 0 ? -1 : 1) * (outerZ + out) : along * outerZ
    const size = 0.25 + next() * next() * 0.9
    return { x, z, halfWidth: size * (0.7 + next() * 0.6), halfDepth: size * (0.7 + next() * 0.6), bottom: -SUNKEN, top: -SUNKEN + size * (0.6 + next() * 1.6) }
  })
}

const fromBlock = (block: Block, bottom = 0): Solid => ({ ...block, bottom, top: block.height })
const fromPillar = (pillar: Pillar): Column => ({ ...pillar, bottom: 0, top: pillar.height })

export const buildArena = (textures: LookTextures): { readonly node: Container3D; readonly dispose: () => void } => {
  const node = new Container3D({ label: "arena" })
  const parts = makeParts(textures)

  const ground = (label: string, width: number, depth: number, y: number, material: BaseMaterial3D) =>
    new Mesh3D({ label, geometry: parts.plane, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: 0, y, z: 0 }, scale: { x: width, y: depth, z: 1 }, castShadow: false })

  node.addChild(
    ground("void", 320, 320, -SUNKEN, parts.ink({ color: PALETTE.concrete800, grainAmount: 0.6, mottling: 0.5, brush: 0.4, shade: 0.15 })),
    ground("floor", FLOOR.width, FLOOR.depth, 0, parts.ink({
      color: 0xffffff,
      surface: { texture: textures.floor, x: -ARENA.halfWidth, z: -ARENA.halfDepth, width: FLOOR.width, depth: FLOOR.depth },
      grainAmount: 0.32,
      mottling: 0.12,
      brush: 0.32,
      shade: 0.06
    }))
  )

  const box = (solid: Solid, color: number, label: string, wear = 0.07, streaks = 0.3) => {
    const halfHeight = (solid.top - solid.bottom) / 2
    const y = solid.bottom + halfHeight
    node.addChild(new Mesh3D({
      label,
      geometry: parts.cube,
      material: parts.ink({
        color,
        shape: { kind: "box", x: solid.x, y, z: solid.z, halfWidth: solid.halfWidth, halfHeight, halfDepth: solid.halfDepth },
        wear,
        streaks,
        grainScale: 0.45
      }),
      position: { x: solid.x, y, z: solid.z },
      scale: { x: solid.halfWidth * 2, y: halfHeight * 2, z: solid.halfDepth * 2 }
    }))
  }

  const column = (shape: Column, color: number, label: string) => {
    const halfHeight = (shape.top - shape.bottom) / 2
    const y = shape.bottom + halfHeight
    node.addChild(new Mesh3D({
      label,
      geometry: parts.cylinder,
      material: parts.ink({ color, shape: { kind: "cylinder", x: shape.x, y, z: shape.z, radius: shape.radius, halfHeight }, wear: 0.07, streaks: 0.35, grainScale: 0.45 }),
      position: { x: shape.x, y, z: shape.z },
      scale: { x: shape.radius, y: halfHeight * 2, z: shape.radius }
    }))
  }

  const { halfWidth: hw, halfDepth: hd, wall, wallHeight } = ARENA
  const walls: ReadonlyArray<Solid> = [
    { x: 0, z: -hd - wall / 2, halfWidth: hw + wall, halfDepth: wall / 2, bottom: -SUNKEN, top: wallHeight },
    { x: 0, z: hd + wall / 2, halfWidth: hw + wall, halfDepth: wall / 2, bottom: -SUNKEN, top: NEAR_WALL_HEIGHT },
    { x: -hw - wall / 2, z: 0, halfWidth: wall / 2, halfDepth: hd, bottom: -SUNKEN, top: wallHeight },
    { x: hw + wall / 2, z: 0, halfWidth: wall / 2, halfDepth: hd, bottom: -SUNKEN, top: wallHeight }
  ]
  for (const each of walls) box(each, PALETTE.concrete600, "wall", 0.06, 0.2)
  const coping = 0.09
  for (const each of walls) {
    const long = each.halfWidth > each.halfDepth
    box({ ...each, halfWidth: each.halfWidth + (long ? 0 : coping), halfDepth: each.halfDepth + (long ? coping : 0), bottom: each.top, top: each.top + 0.14 }, PALETTE.concrete500, "coping", 0.05, 0)
  }

  ARENA.blocks.forEach((block, index) => box(fromBlock(block), index % 2 === 0 ? PALETTE.concrete500 : PALETTE.concrete600, "block"))
  for (const pillar of ARENA.pillars) {
    column(fromPillar(pillar), PALETTE.concrete500, "pillar")
    column({ x: pillar.x, z: pillar.z, radius: pillar.radius + 0.1, bottom: pillar.height, top: pillar.height + 0.22 }, PALETTE.concrete400, "capital")
  }
  for (const each of ARENA.backdrop) box(fromBlock(each, -SUNKEN), PALETTE.concrete600, "backdrop", 0.09, 0.45)
  for (const each of SPIRES) {
    if (isColumn(each)) column(each, PALETTE.concrete600, "spire")
    else box(each, PALETTE.concrete600, "spire", 0.09, 0.45)
  }
  for (const each of rubble()) box(each, PALETTE.concrete700, "rubble", 0.05, 0.2)

  return {
    node,
    dispose: () => {
      node.destroy({ children: true })
      parts.dispose()
    }
  }
}
