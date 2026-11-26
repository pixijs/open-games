import { Container3D, Mesh3D, SphereGeometry, TorusGeometry } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE, paletteOf } from "../../art/palette.ts"
import { DOORWAY } from "../../sim/index.ts"
import type { Block } from "../../sim/index.ts"
import { SUNKEN } from "../parts.ts"
import { lampMaterial, spriteMaterial } from "../shaders/sprite.ts"
import { DRAWINGS } from "../twos.ts"
import type { RoomBuild } from "./build.ts"
import { doorwaysOf } from "./build.ts"
import { seedOf } from "./seed.ts"

/** A Spiral room's set pieces: what stands beyond its ring wall, and what turns. */
export interface DialPieces {
  /** The pieces that can hide an actor from the camera. */
  readonly blocks: ReadonlyArray<Block>
  update(elapsed: number): void
}

type Piece = "armillary" | "gnomons" | "faces"

/**
 * Each Spiral template's own landmark beyond its ring wall, where the play frame shows past the round floor at its
 * sides, so rooms of the zone read apart (docs/DESIGN.md, Look: The Spiral). The tall ones stand west, clear of the
 * HUD's column: the gnomon's room and the well a dial face on a post, square to the camera, its hand ticking; the
 * shrine and the colonnade an armillary of nested rings on a post, turning. The ring has a row of bronze gnomon blades
 * to the east, square to the camera with a lit edge, the dial room (too wide to show past its sides) to the south-east,
 * their shadows sweeping as the sun wheels. The Orrery's room has its own great armillary. None stands on the floor, so
 * none changes how a room plays.
 */
const PIECES: Readonly<Record<string, ReadonlyArray<Piece>>> = {
  "spiral.gnomon": ["faces"],
  "spiral.shrine": ["armillary"],
  "spiral.ring": ["gnomons"],
  "spiral.colonnade": ["armillary"],
  "spiral.well": ["faces"],
  "spiral.dial": ["gnomons"]
}

/** Rooms whose ring reaches past `large` stand their gnomons to the south-east, the only side the frame shows past their floor. */
const GNOMON = { large: 14 } as const

/** How far the hand of a dial face moves at each tick, and how many drawings apart its ticks fall. */
const TICK = { turn: Math.PI / 30, every: 12 } as const

/** A dial face leans back this far from upright (radians), square to the play camera's 60° look down. */
const FACE_TILT = Math.PI / 3

/** Where the pieces start to fade into the dark past the room, and where they are gone: further out than the room's own stone. */
const PIECE_FADE = { start: 6, end: 30 } as const

/** Ground directions (radians, 0 east, -π/2 north). */
const EAST = 0
const WEST = Math.PI
const NORTH = -Math.PI / 2
const SOUTH = Math.PI / 2

export const addDialPieces = (build: RoomBuild, outer: number): DialPieces => {
  const { parts, layout, node, id } = build
  const pieces = PIECES[id] ?? []
  const random = mulberry32.create(seedOf(id) ^ 0x61a1)
  const next = () => mulberry32.sample(random)
  const doorways = doorwaysOf(build)
  const light = paletteOf(build.zone).light
  const blocks: Array<Block> = []
  const turning: Array<{ readonly ring: Container3D; readonly speed: number; readonly phase: number }> = []
  const hands: Array<{ readonly hand: Container3D; readonly phase: number }> = []
  const fade = { ...build.fade, start: PIECE_FADE.start, end: PIECE_FADE.end }
  const bronze = build.ink(PALETTE.concrete300, { fade, wear: 0.16, streaks: 0.2, grainAmount: 0.4, shade: 0.05 })
  const dark = build.ink(PALETTE.concrete500, { fade, wear: 0.12, streaks: 0.35 })
  const lamp = parts.keep(lampMaterial(light, 1.6))
  const gleam = parts.keep(lampMaterial(light, 0.9))
  /** Whether a piece at ground direction `angle` stands clear of every doorway's mouth. */
  const clear = (angle: number) => [...doorways].every((each) => {
    const gap = each === "north" ? NORTH : each === "south" ? SOUTH : each === "east" ? EAST : WEST
    return Math.abs(Math.atan2(Math.sin(angle - gap), Math.cos(angle - gap))) > Math.asin(Math.min(1, (DOORWAY.width / 2 + 2.5) / outer)) + 0.1
  })
  /** The first of `angles` clear of the doorways, nudged a little at a time, south first (where the frame shows most); null when none is. */
  const spot = (angles: ReadonlyArray<number>): number | null => {
    for (const angle of angles) {
      for (const nudge of [0, 0.3, -0.3, 0.6, -0.6]) {
        const turned = angle + (Math.cos(angle) >= 0 ? nudge : -nudge)
        if (clear(turned)) return turned
      }
    }
    return null
  }
  const at = (angle: number, distance: number) => ({ x: Math.cos(angle) * distance, z: Math.sin(angle) * distance })

  if (pieces.includes("armillary")) {
    const angle = spot([WEST - 0.1, EAST + 0.1])
    if (angle !== null) {
      const { x, z } = at(angle, outer + 2.6)
      const rise = 3
      node.addChild(parts.box(x, z, 0.55, 0.55, -SUNKEN, 0.35, dark), parts.box(x, z, 0.14, 0.14, -SUNKEN, rise - 1.5, dark))
      const holder = new Container3D({ position: { x, y: rise, z } })
      const sphere = parts.keep(new SphereGeometry({ radius: 1, widthSegments: 18, heightSegments: 12 }))
      holder.addChild(new Mesh3D({ geometry: sphere, material: lamp, scale: { x: 0.3, y: 0.3, z: 0.3 }, castShadow: false }))
      for (const [index, radius] of [2, 1.6, 1.2].entries()) {
        const torus = parts.keep(new TorusGeometry({ radius, tube: 0.09, radialSegments: 8, tubularSegments: 80 }))
        const tilt = new Container3D({ rotation: { x: 0.45 + index * 0.6, y: 0, z: 0.25 * index } })
        const ring = new Container3D()
        ring.addChild(new Mesh3D({ geometry: torus, material: index === 1 ? gleam : bronze }))
        tilt.addChild(ring)
        holder.addChild(tilt)
        turning.push({ ring, speed: (index % 2 === 0 ? 1 : -1) * (0.06 + index * 0.04), phase: next() * Math.PI * 2 })
      }
      const band = parts.keep(new TorusGeometry({ radius: 2.35, tube: 0.06, radialSegments: 6, tubularSegments: 80 }))
      holder.addChild(new Mesh3D({ geometry: band, material: bronze, rotation: { x: Math.PI / 2 - 0.35, y: 0, z: 0 } }))
      node.addChild(holder)
      blocks.push({ x, z, halfWidth: 2.4, halfDepth: 2.4, height: rise + 2.4 })
    }
  }

  if (pieces.includes("gnomons")) {
    const large = outer > GNOMON.large
    const along = large ? [SOUTH - 0.55, SOUTH - 0.85, SOUTH - 1.15] : [EAST + 0.5, EAST + 0.08, EAST - 0.34]
    for (const [index, angle] of along.filter(clear).entries()) {
      const { x, z } = at(angle, outer + 1.9 + index * 0.3)
      const tall = (large ? 2.6 : 3.6) + index * 0.8
      const half = tall * 0.32
      const blade = new Container3D({ position: { x, y: -SUNKEN, z }, scale: { x: 1, y: tall / (half * Math.SQRT2), z: 1 } })
      blade.addChild(
        new Mesh3D({ geometry: parts.cube, material: bronze, rotation: { x: 0, y: 0, z: Math.PI / 4 }, scale: { x: half * 2, y: half * 2, z: 0.16 } }),
        new Mesh3D({ geometry: parts.cube, material: gleam, position: { x: half * Math.SQRT1_2, y: half * Math.SQRT1_2, z: 0 }, rotation: { x: 0, y: 0, z: Math.PI / 4 }, scale: { x: 0.1, y: half * 2, z: 0.2 }, castShadow: false })
      )
      node.addChild(blade, parts.box(x, z, half * 1.6, 0.45, -SUNKEN, 0.3, dark))
      blocks.push({ x, z, halfWidth: half * 1.6, halfDepth: 0.5, height: tall })
    }
  }

  const faceAt = pieces.includes("faces") ? spot([WEST - 0.1]) : null
  if (faceAt !== null) {
    const radius = id === "spiral.gnomon" ? 2.6 : 2.2
    const { x, z } = at(faceAt, outer + radius * 0.5 + 1.4)
    const height = layout.wallHeight + radius * 0.85 + 0.4
    node.addChild(parts.box(x, z, 0.3, 0.3, -SUNKEN, height - radius * 0.5, dark), parts.box(x, z, 0.7, 0.7, -SUNKEN, 0.3, dark))
    const facing = new Container3D({ position: { x, y: height, z }, rotation: { x: -FACE_TILT, y: -Math.sign(x) * 0.35, z: 0 } })
    const plate = parts.keep(spriteMaterial(build.kit.dial.face, PALETTE.concrete300, 1, "normal", [], true))
    const needle = parts.keep(spriteMaterial(build.kit.dial.hand, 0xffffff, 1, "normal", [], true))
    const hand = new Mesh3D({ geometry: parts.plane, material: needle, position: { x: 0, y: 0, z: 0.03 }, scale: { x: radius * 2, y: radius * 2, z: 1 }, castShadow: false, receiveShadow: false })
    facing.addChild(
      parts.box(0, -0.12, radius * 0.96, 0.08, -radius * 0.96, radius * 0.96, dark),
      new Mesh3D({ geometry: parts.plane, material: plate, position: { x: 0, y: 0, z: 0.01 }, scale: { x: radius * 2, y: radius * 2, z: 1 }, castShadow: false, receiveShadow: false }),
      hand
    )
    node.addChild(facing)
    hands.push({ hand, phase: next() * Math.PI * 2 })
    blocks.push({ x, z, halfWidth: radius, halfDepth: radius, height: height + radius })
  }

  return {
    blocks,
    update: (elapsed) => {
      const drawing = Math.floor(elapsed * DRAWINGS)
      const held = drawing / DRAWINGS
      for (const each of turning) each.ring.rotation.y = each.phase + held * each.speed * Math.PI * 2
      for (const each of hands) each.hand.rotation.z = each.phase - Math.floor(drawing / TICK.every) * TICK.turn
    }
  }
}
