import { Container3D, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { FlatMaterial } from "@pixi/3d"
import { mulberry32 } from "math/random"

import { PALETTE } from "../art/palette.ts"
import type { FrameTime, HostContext } from "../host/types.ts"
import type { ZoneId } from "../sim/index.ts"
import { spriteMaterial } from "./shaders/sprite.ts"
import type { LookTextures } from "./textures.ts"
import { DRAWINGS } from "./twos.ts"

/**
 * The air over the room or stage: torn paper flecks and a few embers in the accent, drawn on twos (their positions
 * step about twelve times a second) like the effects, over the floor on screen. In The Courtyard they drift on a slow
 * wind and the embers rise; in The Spiral the air turns slowly round the dial; in The Void the flecks sink toward the
 * dark below. They stop with game time, so a freeze holds them still in the air.
 */

const FLECKS = 64
const EMBERS = 20
const VOLUME = { margin: 5, low: 0.25, high: 6 } as const

/** How each zone's air moves: the wind's share, a turn round the floor's centre (units a second at 10 units out), and a sink. */
const AIRS: Readonly<Record<ZoneId, { readonly wind: number; readonly turn: number; readonly sink: number }>> = {
  courtyard: { wind: 1, turn: 0, sink: 0 },
  spiral: { wind: 0.25, turn: 0.55, sink: 0 },
  void: { wind: 0.15, turn: 0, sink: 0.45 }
}

interface Mote {
  readonly mesh: Mesh3D
  readonly size: number
  readonly drift: readonly [number, number, number]
  readonly sway: number
  readonly phase: number
  x: number
  y: number
  z: number
}

const wrap = (value: number, half: number) => (value > half ? value - half * 2 : value < -half ? value + half * 2 : value)

export const addAtmosphere = (context: HostContext, textures: LookTextures) => {
  const node = new Container3D({ label: "atmosphere" })
  const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })
  const paper = spriteMaterial(textures.fleck, PALETTE.paper, 0.85, "normal")
  const paperDim = spriteMaterial(textures.fleck, PALETTE.concrete300, 0.7, "normal")
  const ember = spriteMaterial(textures.glow, PALETTE.red, 3.2, "add")
  const random = mulberry32.create(0xa7a5)
  const next = () => mulberry32.sample(random)
  const motes: Array<Mote> = []
  const spawn = (count: number, make: () => Omit<Mote, "x" | "y" | "z">) => {
    for (let index = 0; index < count; index += 1) {
      const mote = { ...make(), x: (next() * 2 - 1) * reach.halfWidth, y: VOLUME.low + next() * (VOLUME.high - VOLUME.low), z: (next() * 2 - 1) * reach.halfDepth }
      node.addChild(mote.mesh)
      motes.push(mote)
    }
  }
  const billboard = (material: FlatMaterial) =>
    new Mesh3D({ geometry: quad, material, billboardMode: "spherical", position: { x: 0, y: 0, z: 0 }, castShadow: false, receiveShadow: false })
  const reach = { halfWidth: 23, halfDepth: 17 }
  spawn(FLECKS, () => ({
    mesh: billboard(next() < 0.6 ? paper : paperDim),
    size: 0.05 + next() * 0.07,
    drift: [0.35 + next() * 0.3, -0.04 + next() * 0.12, 0.1 + next() * 0.15],
    sway: 0.2 + next() * 0.35,
    phase: next() * Math.PI * 2
  }))
  spawn(EMBERS, () => ({
    mesh: billboard(ember),
    size: 0.07 + next() * 0.07,
    drift: [0.12 + next() * 0.15, 0.18 + next() * 0.3, -0.05 + next() * 0.1],
    sway: 0.35 + next() * 0.4,
    phase: next() * Math.PI * 2
  }))
  context.layers.world.addChild(node)

  let time = 0
  let drawing = -1
  const place = () => {
    for (const mote of motes) {
      const turn = Math.sin(time * 1.3 + mote.phase)
      mote.mesh.position.set(mote.x + turn * mote.sway, mote.y, mote.z + Math.cos(time * 0.9 + mote.phase) * mote.sway * 0.5)
      const size = mote.size * (mote.mesh.material === ember ? 0.6 + ((Math.floor(mote.phase * 7) + drawing) % 3) * 0.3 : 1)
      mote.mesh.scale.set(size, size * (0.7 + 0.3 * Math.abs(turn)), 1)
    }
  }
  return {
    update: (frame: FrameTime) => {
      const view = context.game.view()
      // The air holds while loading, so the title's first frame starts its drift as on a page with no loader.
      const running = context.loading ? 0 : view.flow === "Playing" ? frame.gameScale : 1
      const dt = frame.dt * running
      time += dt
      const floor = view.flow === "Title" ? null : context.game.arena
      reach.halfWidth = floor === null ? 23 : floor.halfWidth + VOLUME.margin
      reach.halfDepth = floor === null ? 17 : floor.halfDepth + VOLUME.margin
      const air = AIRS[view.flow === "Title" ? "courtyard" : view.zone]
      for (const mote of motes) {
        const rising = mote.mesh.material === ember
        const out = Math.max(Math.hypot(mote.x, mote.z), 3)
        const swirl = air.turn * 10 / out
        mote.x = wrap(mote.x + (mote.drift[0] * air.wind - (mote.z / out) * swirl) * dt, reach.halfWidth)
        mote.z = wrap(mote.z + (mote.drift[2] * air.wind + (mote.x / out) * swirl) * dt, reach.halfDepth)
        mote.y += (rising ? mote.drift[1] : mote.drift[1] * air.wind - air.sink) * dt
        if (mote.y > VOLUME.high) mote.y = VOLUME.low
        if (mote.y < VOLUME.low) mote.y = VOLUME.high
      }
      const now = Math.floor(time * DRAWINGS)
      if (now !== drawing) {
        drawing = now
        place()
      }
    },
    dispose: () => {
      node.destroy({ children: true })
      quad.destroy()
      paper.destroy()
      paperDim.destroy()
      ember.destroy()
    }
  }
}
