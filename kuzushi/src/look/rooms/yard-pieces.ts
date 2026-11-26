import { Container3D, Mesh3D } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../../art/palette.ts"
import { DOORWAY } from "../../sim/index.ts"
import type { Block } from "../../sim/index.ts"
import { SUNKEN } from "../parts.ts"
import { lampMaterial, spriteMaterial } from "../shaders/sprite.ts"
import { DRAWINGS } from "../twos.ts"
import type { RoomBuild } from "./build.ts"
import { doorwaysOf } from "./build.ts"
import { seedOf } from "./seed.ts"

/** A Courtyard room's set pieces: what stands in its walls and beyond them, and what sways. */
export interface YardPieces {
  /** The pieces that can hide an actor from the camera. */
  readonly blocks: ReadonlyArray<Block>
  update(elapsed: number): void
}

type Piece = "banners" | "wallLamps" | "fallen"

/**
 * Each Courtyard template's own set pieces, so rooms of one zone read apart (docs/DESIGN.md, Look: The Courtyard):
 * the forecourt and the great court hang tall ink banners on poles in the north wall, the cloister a row of them; the
 * shrine and the court burn stone lamps along the top of the north wall; the yard and the gate have a column fallen
 * outside the wall in pieces. None stands on the floor, so none changes how a room plays.
 */
const PIECES: Readonly<Record<string, ReadonlyArray<Piece>>> = {
  "courtyard.forecourt": ["banners"],
  "courtyard.shrine": ["wallLamps"],
  "courtyard.yard": ["fallen"],
  "courtyard.cloister": ["banners", "wallLamps"],
  "courtyard.gate": ["fallen"],
  "courtyard.court": ["wallLamps", "fallen"],
  "courtyard.great": ["banners"]
}

export const addYardPieces = (build: RoomBuild): YardPieces => {
  const { parts, layout, node, id, kit } = build
  const hw = layout.halfWidth
  const hd = layout.halfDepth
  const wall = layout.wall
  const top = layout.wallHeight
  const north = -hd - wall / 2
  const random = mulberry32.create(seedOf(id) ^ 0x7e1c)
  const next = () => mulberry32.sample(random)
  const pieces = PIECES[id] ?? []
  const doorways = doorwaysOf(build)
  const clearOfDoor = (x: number) => !doorways.has("north") || Math.abs(x) > DOORWAY.width / 2 + 1.6
  const blocks: Array<Block> = []
  const cloths: Array<{ readonly cloth: Container3D; readonly phase: number }> = []

  if (pieces.includes("banners")) {
    const pole = build.ink(PALETTE.concrete400, { wear: 0.1, streaks: 0.2 })
    const cloth = build.ink(0x2a2a2e, { wear: 0.05, streaks: 0.7, brush: 0.6, shade: 0.25 })
    const hem = build.ink(PALETTE.concrete300, { wear: 0.05, streaks: 0 })
    const emblem = parts.keep(spriteMaterial(kit.ward, 0xffffff, 0.9, "normal"))
    const tall = build.room.kind === "boss" ? 6.4 : 4.6
    const count = id === "courtyard.cloister" ? 4 : 2
    const spots = Array.from({ length: count }, (_, index) => (count === 2 ? (index === 0 ? -1 : 1) * Math.min(hw - 2.5, DOORWAY.width / 2 + 3) : -hw + 3 + (index * (hw * 2 - 6)) / (count - 1))).filter(clearOfDoor)
    spots.forEach((x, index) => {
      node.addChild(parts.column(x, north, 0.09, top, top + tall + 0.3, pole), parts.box(x, north + 0.05, 0.75, 0.05, top + tall - 0.08, top + tall + 0.04, pole))
      const hang = new Container3D({ position: { x, y: top + tall - 0.1, z: north + 0.14 } })
      const length = tall - 1.3
      hang.addChild(
        parts.box(0, 0, 0.62, 0.025, -length, 0, cloth),
        parts.box(0, 0, 0.66, 0.035, -length - 0.12, -length, hem),
        new Mesh3D({ geometry: parts.plane, material: emblem, position: { x: 0, y: -length * 0.42, z: 0.035 }, scale: { x: 0.9, y: 0.9, z: 1 }, castShadow: false, receiveShadow: false })
      )
      node.addChild(hang)
      cloths.push({ cloth: hang, phase: index * 1.7 + next() })
      blocks.push({ x, z: north, halfWidth: 0.7, halfDepth: 0.2, height: top + tall })
    })
  }

  if (pieces.includes("wallLamps")) {
    const stone = build.ink(PALETTE.concrete500, { wear: 0.1, streaks: 0.3 })
    const roof = build.ink(PALETTE.concrete400, { wear: 0.12, streaks: 0.1 })
    const flame = parts.keep(lampMaterial(PALETTE.paper, 1.6))
    const halo = parts.keep(spriteMaterial(build.textures.glow, PALETTE.paper, 0.4, "add"))
    const count = Math.max(2, Math.round(hw / 4))
    for (let index = 0; index < count; index++) {
      const x = -hw + 1.2 + (index * (hw * 2 - 2.4)) / (count - 1)
      if (!clearOfDoor(x)) continue
      const base = top + 0.14
      node.addChild(
        parts.box(x, north, 0.26, 0.26, base, base + 0.12, stone),
        parts.box(x, north, 0.17, 0.17, base + 0.12, base + 0.44, flame),
        parts.box(x, north, 0.33, 0.33, base + 0.44, base + 0.56, roof),
        parts.box(x, north, 0.08, 0.08, base + 0.56, base + 0.74, roof),
        new Mesh3D({ geometry: parts.plane, material: halo, billboardMode: "spherical", position: { x, y: base + 0.3, z: north + 0.3 }, scale: { x: 1.9, y: 1.9, z: 1 }, castShadow: false, receiveShadow: false })
      )
    }
  }

  if (pieces.includes("fallen")) {
    const drum = build.ink(PALETTE.concrete500, { wear: 0.12, streaks: 0.35 })
    const broken = build.ink(PALETTE.concrete600, { wear: 0.14, streaks: 0.2 })
    const sideOf = next() < 0.5 ? -1 : 1
    const x = sideOf * (hw + wall + 1.9)
    const z = -hd * 0.25
    const radius = 0.75
    const length = Math.min(hd * 1.1, 7)
    const lying = parts.column(0, 0, radius, -length / 2, length / 2, drum)
    const shaft = new Container3D({ position: { x, y: -SUNKEN + radius, z }, rotation: { x: Math.PI / 2, y: 0, z: 0.18 * sideOf } })
    shaft.addChild(lying)
    node.addChild(shaft)
    for (let index = 0; index < 3; index++) {
      const at = { x: x + sideOf * (0.6 + next() * 1.6), z: z + length / 2 + 0.8 + index * 1.3 }
      node.addChild(parts.column(at.x, at.z, radius * (0.9 - index * 0.1), -SUNKEN, -SUNKEN + 0.5 + next() * 0.4, broken))
    }
    node.addChild(parts.box(x - sideOf * 0.4, z - length / 2 - 0.9, 0.95, 0.95, -SUNKEN, -SUNKEN + 0.42, broken, next()))
    blocks.push({ x, z, halfWidth: radius, halfDepth: length / 2, height: radius * 2 - SUNKEN })
  }

  return {
    blocks,
    update: (elapsed) => {
      const drawing = Math.floor(elapsed * DRAWINGS)
      for (const each of cloths) each.cloth.rotation.x = Math.sin(drawing * 0.5 + each.phase) * 0.045
    }
  }
}
