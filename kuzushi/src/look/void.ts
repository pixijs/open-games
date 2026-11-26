import { Container3D } from "@pixi/3d"
import type { DirectionalLight, Mesh3D } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../art/palette.ts"
import type { FrameTime } from "../host/types.ts"
import type { GameView } from "../sim/index.ts"
import { stageOf } from "../sim/index.ts"
import { aimSun } from "./lighting.ts"
import { makeParts } from "./parts.ts"
import { ZONE_FILL } from "./shaders/ink.ts"
import type { InkOptions } from "./shaders/ink.ts"
import { spriteMaterial } from "./shaders/sprite.ts"
import { SLABS, VOID_FLOOR } from "./void-floor.ts"
import { addBeacon, addDrift, addFarScenery, addSlabBody, columnLight, farFade, liveScenery, liveSlabs, nearFade, shownSlab, spikeGeometry, topShape, VOID_SUN } from "./void-parts.ts"
import type { ShownSlab } from "./void-parts.ts"
import type { LookTextures } from "./textures.ts"
import type { World } from "./worlds.ts"

/**
 * The Void: pale slabs of stone floating in ink-black space, each a thick tablet whose sides drop away into the dark
 * with broken rock hanging under it, lit from high above and tinted red by the column of light standing beyond the
 * north edge. Far off and far below, other broken slabs and monoliths hang in the dark, and debris drifts down past
 * them. A slab about to fall shakes on twos while its cracks glow red, then drops and tips away into the dark. The
 * stonework is ./void-parts.ts, shared with the Void's rooms.
 */

const LAYOUT = stageOf("void").layout
const BEACON = LAYOUT.beacon ?? { x: 2, z: -15 }

const FILL = ZONE_FILL.void
const NEAR_FADE = nearFade(LAYOUT.halfWidth, LAYOUT.halfDepth)
const FAR_FADE = farFade(LAYOUT.halfWidth, LAYOUT.halfDepth)
const COLUMN_LIGHT = columnLight(BEACON)

export const buildVoid = (textures: LookTextures, sun: DirectionalLight): World => {
  const kit = makeParts(textures)
  const node = new Container3D({ label: "void" })
  const random = mulberry32.create(0x7016)
  const next = () => mulberry32.sample(random)
  const spike = spikeGeometry(kit)
  const rock = kit.ink({ color: PALETTE.concrete500, fade: NEAR_FADE, fill: FILL, glow: COLUMN_LIGHT, grainAmount: 0.6, mottling: 0.45, streaks: 0.6, grainScale: 0.4 })
  const under = kit.ink({ color: PALETTE.concrete600, fade: NEAR_FADE, fill: FILL, glow: COLUMN_LIGHT, grainAmount: 0.6, mottling: 0.5, grainScale: 0.4 })

  const slabs = SLABS.map((slab, index): ShownSlab => {
    const holder = new Container3D({ label: `slab-${index}`, position: { x: slab.x, y: 0, z: slab.z } })
    const built: Pick<InkOptions, "surface" | "shape"> = {
      surface: { texture: textures.voidFloor, x: VOID_FLOOR.x, z: VOID_FLOOR.z, width: VOID_FLOOR.width, depth: VOID_FLOOR.depth },
      shape: topShape(slab)
    }
    const top = kit.ink({
      color: 0xffffff,
      ...built,
      wear: 0.14,
      streaks: 0.2,
      grainAmount: 0.28,
      mottling: 0.1,
      brush: 0.3,
      shade: 0.1,
      fade: NEAR_FADE,
      fill: FILL,
      glow: COLUMN_LIGHT
    })
    addSlabBody(kit, holder, slab, top, { rock, under, spike }, next)
    const seams = kit.keep(spriteMaterial(textures.slabCracks[index] ?? textures.glow, PALETTE.red, 0, "add"))
    const seamMesh = kit.flat(0, 0.018, 0, slab.halfWidth * 2, slab.halfDepth * 2, seams)
    seamMesh.visible = false
    holder.addChild(seamMesh)
    node.addChild(holder)
    return shownSlab(slab, holder, top, built, seams, seamMesh)
  })

  const far = kit.ink({ color: PALETTE.concrete400, fade: FAR_FADE, fill: FILL, glow: { ...COLUMN_LIGHT, radius: 30, strength: 1.2 }, grainAmount: 0.5, mottling: 0.35, wear: 0.1, streaks: 0.4, grainScale: 0.4 })
  const farUnder = kit.ink({ color: PALETTE.concrete600, fade: FAR_FADE, fill: FILL, grainAmount: 0.5, mottling: 0.4, grainScale: 0.4 })
  const scenery: Array<Mesh3D> = []
  addFarScenery(kit, scenery, far, farUnder, spike, next, 24)

  const chips = kit.ink({ color: PALETTE.concrete600, fade: FAR_FADE, fill: FILL, glow: COLUMN_LIGHT, grainAmount: 0.4, grainScale: 0.4 })
  const drifting = addDrift(scenery, chips, spike, next, 10, 30)
  const beacon = addBeacon(kit, scenery, textures.glow, BEACON)
  for (const mesh of scenery) {
    mesh.castShadow = false
    node.addChild(mesh)
  }

  aimSun(sun, VOID_SUN)

  const update = (view: GameView, frame: FrameTime) => {
    liveScenery(beacon, drifting, frame)
    if (view.hazard.kind !== "slabs") return
    liveSlabs(slabs, view.hazard, frame, false)
  }

  return {
    node,
    occluders: { blocks: [], pillars: [] },
    pale: true,
    update,
    dispose: () => {
      node.destroy({ children: true })
      kit.dispose()
    }
  }
}
