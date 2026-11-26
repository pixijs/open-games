import { Box, Container3D, CylinderGeometry, Mesh3D } from "@pixi/3d"
import { Texture } from "pixi.js"
import type { DirectionalLight } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../../art/palette.ts"
import type { FrameTime } from "../../host/types.ts"
import type { GameView, Slab } from "../../sim/index.ts"
import { aimSun } from "../lighting.ts"
import type { InkOptions } from "../shaders/ink.ts"
import { spriteMaterial } from "../shaders/sprite.ts"
import { addBeacon, addDrift, addFarScenery, addSlabBody, columnLight, farFade, liveScenery, liveSlabs, shownSlab, spikeGeometry, topShape, VOID_SUN } from "../void-parts.ts"
import type { ShownSlab } from "../void-parts.ts"
import type { RoomBuild, ZoneLook } from "./build.ts"
import { mirroredSurface, whenDrawn } from "./build.ts"
import { addIslandPieces } from "./island-pieces.ts"
import { islandArea } from "./islands-floor.ts"
import { seedOf } from "./seed.ts"

/**
 * A Void room: slabs of grey stone over nothing, each a thick tablet with its drawn top, a worn lip, sides that drop
 * into the dark within a few units and broken rock hanging under it; a landing out to every door; a column of the
 * zone's light standing beyond the north edge and tinting the slabs near it; broken slabs and monoliths hanging far
 * off and far below, and debris drifting down past them; every other room has its own landmark beside its slabs
 * (`island-pieces.ts`). A slab about to fall shakes on twos while its cracks glow in the accent, then drops and tips
 * away. Sunder's room is ringed by great stone needles hanging in the dark. The stonework is ../void-parts.ts, shared
 * with the classic arena.
 */

export const buildIslands = (build: RoomBuild, sun: DirectionalLight): ZoneLook => {
  const { parts, layout, node, room, template } = build
  const random = mulberry32.create(seedOf(build.id) ^ 0x7016)
  const next = () => mulberry32.sample(random)
  const spike = spikeGeometry(parts)
  const beacon = layout.beacon ?? { x: 0, z: -layout.halfDepth - 8 }
  const distant = farFade(layout.halfWidth, layout.halfDepth)
  const light = columnLight(beacon)
  const rock = build.ink(PALETTE.concrete500, { glow: light, grainAmount: 0.6, mottling: 0.45, streaks: 0.6, grainScale: 0.4 })
  const under = build.ink(PALETTE.concrete600, { glow: light, grainAmount: 0.6, mottling: 0.5, grainScale: 0.4 })
  const area = islandArea(template)
  const drawn = build.art.floor(build.id)
  const slabs = layout.floor.kind === "slabs" ? layout.floor.slabs : []
  const cracks = build.art.cracks(build.id)

  const shown = slabs.map((slab: Slab, index): ShownSlab => {
    const holder = new Container3D({ label: `slab-${index}`, position: { x: slab.x, y: 0, z: slab.z } })
    const built: Pick<InkOptions, "surface" | "shape"> = {
      surface: mirroredSurface(drawn ?? build.kit.grey, area.x, area.z, area.width, area.depth, room.mirror),
      shape: topShape(slab)
    }
    const top = build.ink(0xffffff, { ...built, wear: 0.14, streaks: 0.2, grainAmount: 0.28, mottling: 0.1, brush: 0.3, shade: 0.1, glow: light })
    addSlabBody(parts, holder, slab, top, { rock, under, spike }, next)
    const seams = slab.fallsAfter === null ? null : parts.keep(spriteMaterial(cracks[index] ?? Texture.EMPTY, PALETTE.red, 0, "add", [], room.mirror.x !== room.mirror.z))
    const seamMesh = seams === null ? null : parts.flat(0, 0.018, 0, slab.halfWidth * 2 * (room.mirror.x ? -1 : 1), slab.halfDepth * 2 * (room.mirror.z ? -1 : 1), seams)
    if (seamMesh !== null) {
      seamMesh.visible = false
      holder.addChild(seamMesh)
    }
    node.addChild(holder)
    return shownSlab(slab, holder, top, built, seams, seamMesh)
  })
  whenDrawn(build, drawn === null || shown.some((slab, index) => slab.seams !== null && cracks[index] === null), (late) => {
    const glows = build.art.cracks(build.id)
    shown.forEach((slab, index) => {
      slab.top.textures.surface = late
      const glow = glows[index]
      if (slab.seams !== null && glow !== null && glow !== undefined) slab.seams.textures.baseColor = glow
    })
  })

  const far = build.ink(PALETTE.concrete400, { fade: distant, glow: { ...light, radius: 30, strength: 1.2 }, grainAmount: 0.5, mottling: 0.35, wear: 0.1, streaks: 0.4, grainScale: 0.4 })
  const farUnder = build.ink(PALETTE.concrete600, { fade: distant, grainAmount: 0.5, mottling: 0.4, grainScale: 0.4 })
  const scenery: Array<Mesh3D> = []
  const reach = Math.max(layout.halfWidth, layout.halfDepth)
  addFarScenery(parts, scenery, far, farUnder, spike, next, reach + 12)

  const needles: Array<{ readonly mesh: Mesh3D; readonly y: number; readonly phase: number }> = []
  if (room.kind === "boss") {
    const point = parts.keep(new CylinderGeometry({ radiusTop: 0, radiusBottom: 1, height: 1, radialSegments: 6 }))
    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2 + 0.13
      const north = Math.max(0, -Math.sin(angle))
      const distance = reach + 5 + next() * 4
      const tall = 7 + north * 9 + next() * 4
      const y = -tall * 0.55 - (1 - north) * 5
      const mesh = new Mesh3D({ geometry: point, material: far, position: { x: Math.cos(angle) * distance * 1.1, y, z: Math.sin(angle) * distance * 0.9 }, scale: { x: 0.9 + next() * 0.6, y: tall, z: 0.9 + next() * 0.6 }, rotation: { x: Math.sin(angle) * 0.25, y: next() * Math.PI, z: -Math.cos(angle) * 0.25 } })
      scenery.push(mesh)
      needles.push({ mesh, y, phase: next() * Math.PI * 2 })
    }
  }

  const chips = build.ink(PALETTE.concrete600, { fade: distant, glow: light, grainAmount: 0.4, grainScale: 0.4 })
  const drifting = addDrift(scenery, chips, spike, next, reach + 2, 26)
  const lit = addBeacon(parts, scenery, build.textures.glow, beacon)
  for (const mesh of scenery) {
    mesh.castShadow = false
    node.addChild(mesh)
  }
  const pieces = addIslandPieces(build, distant, light)

  aimSun(sun, { ...VOID_SUN, bounds: Box.fromCenterSize({ x: 0, y: -3, z: -1 }, { x: layout.halfWidth * 2 + 20, y: 16, z: layout.halfDepth * 2 + 16 }) })

  let first = true
  return {
    occluders: { blocks: [], pillars: [] },
    pale: true,
    update: (view: GameView, frame: FrameTime) => {
      liveScenery(lit, drifting, frame)
      for (const needle of needles) needle.mesh.position.y = needle.y + Math.sin(frame.gameElapsed * 0.4 + needle.phase) * 0.6
      pieces.update(frame.elapsed)
      if (view.hazard.kind !== "slabs") return
      liveSlabs(shown, view.hazard, frame, first)
      first = false
    }
  }
}
