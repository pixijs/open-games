import { Container3D, CylinderGeometry, Mesh3D } from "@pixi/3d"
import type { FlatMaterial } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE, paletteOf } from "../../art/palette.ts"
import type { InkFade, InkGlow } from "../shaders/ink.ts"
import { spriteMaterial } from "../shaders/sprite.ts"
import { DRAWINGS } from "../twos.ts"
import type { RoomBuild } from "./build.ts"
import { seedOf } from "./seed.ts"

/** A Void room's set pieces: what hangs in the dark beside its slabs, and what moves. */
export interface IslandPieces {
  update(elapsed: number): void
}

type Piece = "stumps" | "debris" | "rift"

/**
 * Each Void template's own landmark in the dark beside its slabs, where the play frame shows past the floor at its
 * sides, so rooms of the zone read apart (docs/DESIGN.md, Look: The Void): the threshold and the collapse a far slab
 * with the broken stumps of columns standing on it, the islet, the shards and the collapse a cluster of broken rock
 * hanging and slowly turning, the shrine, the causeway and the shards a rift of the zone's light torn down through the
 * dark, its edges in the accent. The rift takes the west; what shares its room stands east, south of the HUD's column.
 * Sunder's room has its ring of needles. None stands on the floor, so none changes how a room plays or hides an actor.
 */
const PIECES: Readonly<Record<string, ReadonlyArray<Piece>>> = {
  "void.threshold": ["stumps"],
  "void.shrine": ["rift"],
  "void.islet": ["debris"],
  "void.causeway": ["stumps", "rift"],
  "void.shards": ["debris", "rift"],
  "void.collapse": ["stumps", "debris"]
}

/** The pieces are drawn with `fade` (the far scenery's, so they don't sink into the dark with the slabs' edges) and lit by the column's `glow`. */
export const addIslandPieces = (build: RoomBuild, fade: InkFade, glow: InkGlow): IslandPieces => {
  const { parts, layout, node, id, kit } = build
  const pieces = PIECES[id] ?? []
  const random = mulberry32.create(seedOf(id) ^ 0x3b0d)
  const next = () => mulberry32.sample(random)
  const rift = pieces.includes("rift")
  /** Which side the stumps stand: west, east (south of the HUD's column) when the rift has the west. */
  const stumpSide = rift ? 1 : -1
  const hw = layout.halfWidth
  const hd = layout.halfDepth
  const stone = build.ink(PALETTE.concrete400, { fade, glow, grainAmount: 0.55, mottling: 0.4, wear: 0.12, streaks: 0.45, grainScale: 0.4 })
  const deep = build.ink(PALETTE.concrete600, { fade, glow, grainAmount: 0.55, mottling: 0.45, grainScale: 0.4 })
  const shaft = parts.keep(new CylinderGeometry({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 10 }))
  const spike = parts.keep(new CylinderGeometry({ radiusTop: 1, radiusBottom: 0, height: 1, radialSegments: 4 }))
  const floating: Array<{ readonly mesh: Container3D; readonly y: number; readonly turn: number; readonly phase: number; readonly spin: number }> = []
  const rifts: Array<{ readonly glow: FlatMaterial; readonly core: FlatMaterial }> = []

  if (pieces.includes("stumps")) {
    const x = stumpSide * (hw + 5.5)
    const z = stumpSide > 0 ? hd * 0.3 : -hd * 0.45
    const top = -0.9
    const slab = new Container3D({ position: { x, y: 0, z } })
    slab.addChild(parts.box(0, 0, 2.6, 2, top - 0.9, top, stone), new Mesh3D({ geometry: spike, material: deep, position: { x: 0, y: top - 0.9 - 2.2, z: 0 }, scale: { x: 2, y: 4.4, z: 1.5 }, rotation: { x: 0, y: 0.4, z: 0 } }))
    for (const [index, spot] of [{ x: -1.3, z: -0.8 }, { x: 1.1, z: -0.4 }, { x: 0.1, z: 1 }].entries()) {
      const radius = 0.62 - index * 0.08
      const tall = 3.2 - index * 0.9 + next() * 0.4
      slab.addChild(
        parts.box(spot.x, spot.z, radius + 0.18, radius + 0.18, top, top + 0.3, stone),
        new Mesh3D({ geometry: shaft, material: stone, position: { x: spot.x, y: top + 0.3 + tall / 2, z: spot.z }, scale: { x: radius, y: tall, z: radius } }),
        parts.box(spot.x, spot.z, radius * 0.9, radius * 0.7, top + tall, top + tall + 0.35, deep, next() * Math.PI)
      )
    }
    const fallen = new Mesh3D({ geometry: shaft, material: stone, position: { x: stumpSide * 1.2, y: top + 0.45, z: 1.5 }, rotation: { x: Math.PI / 2, y: 0, z: 0.5 * stumpSide }, scale: { x: 0.45, y: 2.4, z: 0.45 } })
    slab.addChild(fallen)
    node.addChild(slab)
    floating.push({ mesh: slab, y: 0, turn: 0, phase: next() * Math.PI * 2, spin: 0 })
  }

  if (pieces.includes("debris")) {
    const east = rift || pieces.includes("stumps")
    const cx = (east ? 1 : -1) * (hw + 4.2)
    const cz = east ? hd * 0.35 : hd * 0.15 - 1
    for (let index = 0; index < 7; index += 1) {
      const angle = (index / 7) * Math.PI * 2 + next()
      const reach = 0.6 + next() * 2.2
      const size = 0.35 + next() * next() * 1.3
      const y = -1.2 + next() * 3.4
      const rock = new Container3D({ position: { x: cx + Math.cos(angle) * reach, y, z: cz + Math.sin(angle) * reach * 0.8 }, rotation: { x: next() * 3, y: next() * 3, z: next() * 3 } })
      rock.addChild(parts.box(0, 0, size, size * (0.5 + next() * 0.5), -size * 0.6, size * 0.6, index % 3 === 0 ? deep : stone), new Mesh3D({ geometry: spike, material: deep, position: { x: 0, y: -size * 1.3, z: 0 }, scale: { x: size * 0.8, y: size * 1.4, z: size * 0.6 } }))
      node.addChild(rock)
      floating.push({ mesh: rock, y, turn: rock.rotation.y, phase: next() * Math.PI * 2, spin: (next() - 0.5) * 0.5 })
    }
  }

  if (rift) {
    const { light, danger } = paletteOf(build.zone)
    const x = -(hw + 3.4)
    const z = -hd * 0.3
    const glowMaterial = parts.keep(spriteMaterial(kit.rift.glow, danger, 1, "add"))
    const coreMaterial = parts.keep(spriteMaterial(kit.rift.core, light, 2, "add"))
    for (const [material, width] of [[glowMaterial, 2.2], [coreMaterial, 1.1]] as const) {
      node.addChild(new Mesh3D({ geometry: parts.plane, material, billboardMode: "cylindrical", position: { x, y: -2, z }, scale: { x: width, y: 10, z: 1 }, castShadow: false, receiveShadow: false }))
    }
    rifts.push({ glow: glowMaterial, core: coreMaterial })
  }

  return {
    update: (elapsed) => {
      const drawing = Math.floor(elapsed * DRAWINGS)
      const held = drawing / DRAWINGS
      for (const each of floating) {
        each.mesh.position.y = each.y + Math.sin(held * 0.6 + each.phase) * 0.18
        each.mesh.rotation.y = each.turn + held * each.spin
      }
      const flicker = drawing % 2 === 0 ? 1 : 0.82
      for (const rift of rifts) {
        rift.glow.data.boost = 0.7 * flicker
        rift.core.data.boost = 2 * (drawing % 4 === 0 ? 1.15 : 1)
      }
    }
  }
}
