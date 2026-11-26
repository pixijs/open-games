import { Box, Mesh3D } from "@pixi/3d"
import type { BaseMaterial3D, DirectionalLight } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../../art/palette.ts"
import { doorLine, DOORWAY, onSide, sides } from "../../sim/index.ts"
import type { Block, Pillar } from "../../sim/index.ts"
import { aimSun, COURTYARD_SUN } from "../lighting.ts"
import { KERB, SUNKEN } from "../parts.ts"
import { lampMaterial, spriteMaterial } from "../shaders/sprite.ts"
import type { RoomBuild, ZoneLook } from "./build.ts"
import { doorwaysOf, mirroredSurface, whenDrawn } from "./build.ts"
import { addYardPieces } from "./yard-pieces.ts"
import { seedOf } from "./seed.ts"

/**
 * A Courtyard room: its drawn floor of worn tiles inside a wall with a coping, pilasters along its outer face, blocks
 * and pillars with capitals, and beyond the wall a sunken ground with stone lanterns lit behind the far wall and down
 * the flanks, monoliths (tall to the north, low to the south so they never block the camera) and rubble, all fading
 * into the dark, under the Courtyard's low sun, and each template's own set pieces (`yard-pieces.ts`). The great
 * court, the boss's room, stands its pillars on plinths with bands and a heavy capital, and its monoliths taller.
 */

const COPING = 0.09

/** The props, in the same greys as The Courtyard's: blocks alternate two shades, pillars wear a lighter capital. */
const SHADES = { wall: PALETTE.concrete600, coping: PALETTE.concrete400, blockA: PALETTE.concrete500, blockB: PALETTE.concrete600, pillar: PALETTE.concrete500, capital: PALETTE.concrete400, far: PALETTE.concrete600, rubble: PALETTE.concrete700 } as const

const boxShape = (block: Block, bottom: number) => ({ kind: "box" as const, x: block.x, y: (bottom + block.height) / 2, z: block.z, halfWidth: block.halfWidth, halfHeight: (block.height - bottom) / 2, halfDepth: block.halfDepth })

export const buildYard = (build: RoomBuild, sun: DirectionalLight): ZoneLook => {
  const { parts, layout, node, room, template } = build
  const hw = layout.halfWidth
  const hd = layout.halfDepth
  const wall = layout.wall
  const random = mulberry32.create(seedOf(build.id) ^ 0x9a11)
  const next = () => mulberry32.sample(random)
  const boss = room.kind === "boss"

  const ground = parts.flat(0, -SUNKEN, 0, 320, 320, build.ink(PALETTE.concrete800, { grainAmount: 0.6, mottling: 0.5, brush: 0.4, shade: 0.15 }))
  ground.receiveShadow = true
  const drawn = build.art.floor(build.id)
  const surface = mirroredSurface(drawn ?? build.kit.grey, -template.halfWidth, -template.halfDepth, template.halfWidth * 2, template.halfDepth * 2, room.mirror)
  const floorMaterial = build.ink(0xffffff, { surface, grainAmount: 0.32, mottling: 0.12, brush: 0.32, shade: 0.06 })
  const floor = parts.flat(0, 0, 0, hw * 2, hd * 2, floorMaterial)
  floor.receiveShadow = true
  node.addChild(ground, floor)
  whenDrawn(build, drawn === null, (late) => {
    floorMaterial.textures.surface = late
  })

  const wallInk = build.ink(SHADES.wall, { wear: 0.06, streaks: 0.2 })
  const copingInk = build.ink(SHADES.coping, { wear: 0.05, streaks: 0 })
  const pilasterInk = build.ink(PALETTE.concrete500, { wear: 0.08, streaks: 0.35 })
  const doorways = doorwaysOf(build)
  for (const side of sides) {
    const south = side === "south"
    const top = south ? KERB : layout.wallHeight
    const wide = side === "north" || side === "south"
    const line = doorLine(layout, side) + wall / 2
    const span = wide ? hw + wall : hd
    const runs: ReadonlyArray<readonly [number, number]> = doorways.has(side) ? [[-span, -DOORWAY.width / 2], [DOORWAY.width / 2, span]] : [[-span, span]]
    for (const [from, to] of runs) {
      const centre = onSide(side, line, (from + to) / 2)
      const half = (to - from) / 2
      node.addChild(parts.box(centre.x, centre.z, wide ? half : wall / 2, wide ? wall / 2 : half, -SUNKEN, top, wallInk))
      node.addChild(parts.box(centre.x, centre.z, wide ? half : wall / 2 + COPING, wide ? wall / 2 + COPING : half, top, top + 0.14, copingInk))
      if (south) continue
      const count = Math.floor(half / 3.2)
      for (let index = 0; index < count; index += 1) {
        const across = from + ((index + 0.5) / count) * (to - from)
        if (doorways.has(side) && Math.abs(across) < DOORWAY.width / 2 + 1.4) continue
        const at = onSide(side, line + wall / 2 + 0.22, across)
        node.addChild(parts.box(at.x, at.z, wide ? 0.4 : 0.22, wide ? 0.22 : 0.4, -SUNKEN, top + 0.06, pilasterInk))
      }
    }
  }

  const blockInk = (block: Block, color: number) => build.ink(color, { shape: boxShape(block, 0), wear: 0.07, streaks: 0.3, grainScale: 0.45 })
  layout.blocks.forEach((block, index) => node.addChild(parts.box(block.x, block.z, block.halfWidth, block.halfDepth, 0, block.height, blockInk(block, index % 2 === 0 ? SHADES.blockA : SHADES.blockB))))

  const column = (pillar: Pillar, radius: number, bottom: number, top: number, color: number, streaks = 0.35): BaseMaterial3D =>
    build.ink(color, { shape: { kind: "cylinder", x: pillar.x, y: (bottom + top) / 2, z: pillar.z, radius, halfHeight: (top - bottom) / 2 }, wear: 0.07, streaks, grainScale: 0.45 })
  for (const pillar of layout.pillars) {
    const { x, z, radius, height } = pillar
    if (boss) {
      node.addChild(
        parts.box(x, z, radius * 1.3, radius * 1.3, 0, 0.32, build.ink(PALETTE.concrete400, { wear: 0.1, streaks: 0 })),
        parts.column(x, z, radius, 0.32, height, column(pillar, radius, 0.32, height, SHADES.pillar)),
        ...[0.22, 0.78].map((share) => {
          const at = 0.32 + (height - 0.32) * share
          return parts.column(x, z, radius + 0.06, at - 0.08, at + 0.08, column(pillar, radius + 0.06, at - 0.08, at + 0.08, PALETTE.concrete300, 0))
        }),
        parts.column(x, z, radius + 0.16, height, height + 0.3, column(pillar, radius + 0.16, height, height + 0.3, SHADES.capital, 0)),
        parts.box(x, z, radius + 0.24, radius + 0.24, height + 0.3, height + 0.44, build.ink(PALETTE.concrete300, { wear: 0.1, streaks: 0 }))
      )
      continue
    }
    node.addChild(
      parts.column(x, z, radius, 0, height, column(pillar, radius, 0, height, SHADES.pillar)),
      parts.column(x, z, radius + 0.1, height, height + 0.22, column(pillar, radius + 0.1, height, height + 0.22, SHADES.capital, 0))
    )
  }

  const outerX = hw + wall
  const outerZ = hd + wall
  const far = build.ink(SHADES.far, { wear: 0.09, streaks: 0.45, grainScale: 0.45 })
  const monoliths: Array<Block> = []
  const placeMonolith = (x: number, z: number, halfWidth: number, halfDepth: number, height: number) => {
    monoliths.push({ x, z, halfWidth, halfDepth, height })
    const mesh = parts.box(x, z, halfWidth, halfDepth, -SUNKEN, height, far)
    mesh.castShadow = height < 10
    node.addChild(mesh)
  }
  const northCount = Math.round(outerX / 3.2)
  for (let index = 0; index < northCount; index += 1) {
    const x = -outerX - 2 + ((index + next() * 0.8) / northCount) * (outerX * 2 + 4)
    const z = -outerZ - 4 - next() * 7
    const tall = (boss ? 7 : 4) + next() * next() * (boss ? 14 : 11)
    placeMonolith(x, z, 0.7 + next() * 2, 0.6 + next() * 1.4, tall)
  }
  for (const sideOf of [-1, 1]) {
    const count = Math.round(outerZ / 4.5)
    for (let index = 0; index < count; index += 1) {
      const z = -outerZ - 2 + ((index + next() * 0.6) / count) * outerZ * 1.5
      const north = Math.max(0, -z / outerZ)
      placeMonolith(sideOf * (outerX + 3 + next() * 7), z, 0.6 + next() * 1.4, 0.6 + next() * 1.6, 1.2 + north * (5 + next() * 8) + next() * 1.5)
    }
  }
  for (let index = 0; index < Math.round(outerX / 7); index += 1) {
    placeMonolith(-outerX + next() * outerX * 2, outerZ + 5 + next() * 5, 0.5 + next() * 1.1, 0.4 + next() * 0.6, -SUNKEN + 0.4 + next() * 0.7)
  }
  const rubble = build.ink(SHADES.rubble, { wear: 0.05, streaks: 0.2, grainScale: 0.45 })
  for (let index = 0; index < Math.round((outerX + outerZ) * 0.6); index += 1) {
    const side = Math.floor(next() * 4)
    const along = next() * 2 - 1
    const out = 0.8 + next() * 3.5
    const x = side < 2 ? along * outerX : (side === 2 ? -1 : 1) * (outerX + out)
    const z = side < 2 ? (side === 0 ? -1 : 1) * (outerZ + out) : along * outerZ
    const size = 0.25 + next() * next() * 0.9
    node.addChild(parts.box(x, z, size * (0.7 + next() * 0.6), size * (0.7 + next() * 0.6), -SUNKEN, -SUNKEN + size * (0.6 + next() * 1.6), rubble, next() * 3))
  }

  const lanternStone = build.ink(PALETTE.concrete500, { wear: 0.1, streaks: 0.3 })
  const lanternRoof = build.ink(PALETTE.concrete400, { wear: 0.12, streaks: 0.1 })
  const flame = parts.keep(lampMaterial(PALETTE.paper, 1.7))
  const halo = parts.keep(spriteMaterial(build.textures.glow, PALETTE.paper, 0.5, "add"))
  const lanterns: Array<Block> = []
  const lantern = (x: number, z: number) => {
    lanterns.push({ x, z, halfWidth: 0.5, halfDepth: 0.5, height: 2.3 })
    node.addChild(
      parts.box(x, z, 0.5, 0.5, -SUNKEN, 0.2, lanternStone),
      parts.column(x, z, 0.17, 0.2, 1.1, lanternStone),
      parts.box(x, z, 0.42, 0.42, 1.1, 1.24, lanternRoof),
      ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx = 0, dz = 0]) => parts.box(x + dx * 0.27, z + dz * 0.27, 0.05, 0.05, 1.24, 1.74, lanternStone)),
      parts.box(x, z, 0.22, 0.22, 1.3, 1.68, flame),
      parts.box(x, z, 0.64, 0.64, 1.74, 1.88, lanternRoof),
      parts.box(x, z, 0.4, 0.4, 1.88, 2.0, lanternRoof),
      parts.column(x, z, 0.08, 2.0, 2.3, lanternRoof),
      new Mesh3D({ geometry: parts.plane, material: halo, billboardMode: "spherical", position: { x, y: 1.5, z }, scale: { x: 2.6, y: 2.6, z: 1 }, castShadow: false, receiveShadow: false })
    )
  }
  const behind = -outerZ - 1.6
  for (const x of [-outerX + 1.5, -DOORWAY.width / 2 - 2.2, DOORWAY.width / 2 + 2.2, outerX - 1.5]) lantern(x, behind)
  for (const sideOf of [-1, 1]) lantern(sideOf * (outerX + 1.6), -hd * 0.45)

  const pieces = addYardPieces(build)

  aimSun(sun, { ...COURTYARD_SUN, bounds: Box.fromCenterSize({ x: 0, y: 6, z: -2 }, { x: outerX * 2 + 30, y: 22, z: outerZ * 2 + 22 }) })
  return {
    occluders: { blocks: [...layout.blocks, ...monoliths, ...lanterns, ...pieces.blocks], pillars: layout.pillars },
    pale: false,
    update: (_view, frame) => pieces.update(frame.elapsed)
  }
}
