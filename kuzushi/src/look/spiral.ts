import { Box, Container3D } from "@pixi/3d"
import type { BaseMaterial3D, Camera3D, DirectionalLight } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../art/palette.ts"
import { stageOf } from "../sim/index.ts"
import type { Block, GameView, Pillar } from "../sim/index.ts"
import { addColumn, addRingWall, addSpire, columnGeometry, dialFade, liveSpire, spireLife } from "./dial-parts.ts"
import type { DialInk } from "./dial-parts.ts"
import { aimSun } from "./lighting.ts"
import type { SunSetup } from "./lighting.ts"
import type { Occluders } from "./occlusion.ts"
import { makeParts, SUNKEN } from "./parts.ts"
import { ZONE_FILL } from "./shaders/ink.ts"
import { SPIRAL_FLOOR } from "./spiral-floor.ts"
import type { LookTextures } from "./textures.ts"
import type { World } from "./worlds.ts"

/**
 * The Spiral's classic arena (the sandbox's): a round dial of stone at dusk. Rings of pale and dark flagstones round a
 * stepped spire whose obelisk rises with a lamp near its top, the spiral of pillars rising toward it, a ring wall with
 * stele every hour and needles of stone standing round outside. A low sun wheels slowly round, so the long shadows
 * sweep the dial like the hands of a clock, and the slit at the spire's foot, where the beam comes from, throws its
 * light across the stones near it. The stonework is ./dial-parts.ts, shared with the Spiral's rooms.
 */

const LAYOUT = stageOf("spiral").layout
const RADIUS = LAYOUT.floor.kind === "round" ? LAYOUT.floor.radius : LAYOUT.halfWidth
const OUTER = RADIUS + LAYOUT.wall
const SPIRE = LAYOUT.pillars.find((pillar) => pillar.x === 0 && pillar.z === 0) ?? { x: 0, z: 0, radius: 2, height: 16 }
const PILLARS = LAYOUT.pillars.filter((pillar) => pillar !== SPIRE)

/** A low sun that wheels round once every 96 seconds of play. */
export const SPIRAL_SUN: SunSetup = { azimuth: -2.2, elevation: 0.56, intensity: 2.8, bounds: Box.fromCenterSize({ x: 0, y: 6, z: 0 }, { x: 84, y: 28, z: 84 }) }
export const SUN_TURN = (Math.PI * 2) / 96

const FADE = dialFade(OUTER, OUTER, OUTER)
const FILL = ZONE_FILL.spiral

/** Needles of stone outside a ring wall of `outer` radius: tall to the north, low to the south so they never block the play camera. */
export const needles = (outer: number, seed: number, count = 22): ReadonlyArray<Pillar | Block> => {
  const random = mulberry32.create(seed)
  const next = () => mulberry32.sample(random)
  const shapes: Array<Pillar | Block> = []
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + (next() - 0.5) * 0.2
    const distance = outer + 6.3 + next() * 12
    const north = Math.max(0, -Math.sin(angle))
    const height = 1.5 + north * (8 + next() * 14) + next() * 1.5
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance
    shapes.push(index % 3 === 0 ? { x, z, radius: 0.7 + next() * 1.1, height } : { x, z, halfWidth: 0.6 + next() * 1.4, halfDepth: 0.6 + next() * 1.4, height })
  }
  return shapes
}

export const isPillar = (shape: Pillar | Block): shape is Pillar => "radius" in shape

export const buildSpiral = (textures: LookTextures, sun: DirectionalLight, camera: Camera3D): World => {
  const kit = makeParts(textures)
  const node = new Container3D({ label: "spiral" })
  const plain = (color: number, wear: number, streaks: number) => kit.ink({ color, fade: FADE, fill: FILL, wear, streaks, grainScale: 0.45 })
  const glowing: Array<BaseMaterial3D> = []
  const ink: DialInk = (color, options) => {
    const material = kit.ink({ color, fade: FADE, fill: FILL, grainScale: 0.45, ...options })
    glowing.push(material)
    return material
  }

  const floorMaterial = ink(0xffffff, {
    surface: { texture: textures.spiralFloor, x: -RADIUS, z: -RADIUS, width: SPIRAL_FLOOR.size, depth: SPIRAL_FLOOR.size },
    grainAmount: 0.3,
    mottling: 0.12,
    brush: 0.34,
    shade: 0.08
  })
  const floor = kit.column(0, 0, RADIUS, -0.4, 0, floorMaterial)
  floor.castShadow = false
  const ground = kit.flat(0, -SUNKEN, 0, 320, 320, kit.ink({ color: PALETTE.concrete800, grainAmount: 0.6, mottling: 0.5, brush: 0.4, shade: 0.15, fade: FADE, fill: FILL }))
  ground.receiveShadow = true
  node.addChild(ground, floor)

  const wallStone = plain(PALETTE.concrete600, 0.06, 0.2)
  const coping = plain(PALETTE.concrete400, 0.05, 0)
  const stele = plain(PALETTE.concrete500, 0.08, 0.4)
  addRingWall(node, kit, LAYOUT, RADIUS, 72, wallStone, coping)
  const steleShapes: Array<Block> = []
  for (let hour = 0; hour < 12; hour += 1) {
    const angle = (hour / 12) * Math.PI * 2
    const north = -Math.sin(angle)
    if (north < -0.3) continue
    const height = LAYOUT.wallHeight + 0.6 + Math.max(0, north) * 3.4 + (hour % 3 === 0 ? 1.2 : 0)
    const x = Math.cos(angle) * (OUTER + 0.45)
    const z = Math.sin(angle) * (OUTER + 0.45)
    node.addChild(kit.box(x, z, 0.42, 0.3, -SUNKEN, height, stele, -angle))
    steleShapes.push({ x, z, halfWidth: 0.45, halfDepth: 0.45, height })
  }

  const geometry = columnGeometry(kit)
  const columns = PILLARS.map((pillar) => addColumn(node, kit, ink, geometry, pillar))
  const spire = addSpire(node, kit, ink, textures, SPIRE)

  const far = plain(PALETTE.concrete600, 0.09, 0.45)
  const scenery = [
    ...LAYOUT.backdrop.map((block) => kit.box(block.x, block.z, block.halfWidth, block.halfDepth, -SUNKEN, block.height, far)),
    ...needles(OUTER, 0x5e1d).map((shape) => isPillar(shape)
      ? kit.column(shape.x, shape.z, shape.radius, -SUNKEN, shape.height, far)
      : kit.box(shape.x, shape.z, shape.halfWidth, shape.halfDepth, -SUNKEN, shape.height, far, Math.atan2(shape.z, shape.x)))
  ]
  for (const mesh of scenery) {
    mesh.castShadow = false
    node.addChild(mesh)
  }

  const blocks = [...LAYOUT.backdrop, ...steleShapes]
  const life = spireLife()
  aimSun(sun, SPIRAL_SUN)
  let occluders: Occluders = { blocks, pillars: [...columns.map((column) => column.shape), ...spire.solid] }
  return {
    node,
    get occluders() {
      return occluders
    },
    pale: false,
    update: (view: GameView, frame) => {
      occluders = { blocks, pillars: liveSpire(spire, columns, glowing, life, view, camera.position, frame.dt, frame.elapsed) }
      aimSun(sun, SPIRAL_SUN, SPIRAL_SUN.azimuth + frame.gameElapsed * SUN_TURN)
    },
    dispose: () => {
      node.destroy({ children: true })
      kit.dispose()
    }
  }
}
