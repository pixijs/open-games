import type { FrameControls } from "../art/frame.ts"
import type { HostContext } from "../host/types.ts"
import type { Point } from "../sim/index.ts"
import type { ArcPool } from "./arcs.ts"
import type { ClockKind, Cues } from "./cues.ts"
import { rngOf } from "./draw/pen.ts"
import type { Rng } from "./draw/pen.ts"
import type { Impacts } from "./impacts.ts"
import type { Frames, Kit } from "./kit.ts"
import type { SpriteLayer } from "./particles.ts"
import type { Screen } from "./screen.ts"

/** The particle layers, drawn in this order. */
export interface Layers {
  /** Flat on the floor, normal blend: ink splatters, cracks, dash dots. */
  readonly floor: SpriteLayer
  /** Flat, normal blend: bursts, sparks, shards, fragments, afterimages. */
  readonly flat: SpriteLayer
  /** Flat, added light: shock glows, halos under strikes. */
  readonly flatGlow: SpriteLayer
  /** Facing the camera, added light, over the world: halos, glints, embers. */
  readonly glow: SpriteLayer
  /** Facing the camera, normal blend, over everything: lock-on marks, the parry's X, bursts the low special camera must see. */
  readonly face: SpriteLayer
}

/** Everything an effect module draws with. */
export interface Fx {
  readonly context: HostContext
  readonly kit: Kit
  readonly f: Frames
  readonly cues: Cues
  readonly arcs: ArcPool
  readonly layers: Layers
  readonly screen: Screen
  readonly frame: FrameControls
  /** Full-screen impact frames, rationed, and the vignette pulses that stand in for them on small blows. */
  readonly impacts: Impacts
  /** Cosmetic randomness, never the world's. */
  readonly rng: Rng
}

export const cosmeticRng = rngOf

/** Where actor `id` is drawn now, else `fallback`, where its moment or view put it. The drawn position is live: read it at once. */
export const drawnAt = (fx: Fx, id: number, fallback: Point): Point => fx.context.actor(id)?.node.position ?? fallback


export const angleOf = (dx: number, dz: number): number => Math.atan2(dz, dx)

export const spread = (rng: Rng, amount: number): number => (rng() - 0.5) * 2 * amount

export const pick = <T>(rng: Rng, items: ReadonlyArray<T>, fallback: T): T => items[Math.floor(rng() * items.length)] ?? fallback

/** A spray of streaks thrown flat from a point: sparks off a blow, shards off a parry. */
export interface Spray {
  readonly count: number
  readonly x: number
  readonly y: number
  readonly z: number
  /** The cone's centre (simulation radians) and its half-width; π throws all round. */
  readonly angle: number
  readonly cone: number
  readonly speed: readonly [number, number]
  readonly size: readonly [number, number]
  /** The drawing for streak `index`. */
  readonly frame: (index: number) => number
  readonly life: number
  readonly clock?: ClockKind
}

export const spray = (fx: Fx, spec: Spray): void => {
  for (let index = 0; index < spec.count; index++) {
    const direction = spec.angle + spread(fx.rng, spec.cone)
    const speed = spec.speed[0] + (spec.speed[1] - spec.speed[0]) * fx.rng()
    fx.layers.flat.spawn({
      frames: spec.frame(index),
      x: spec.x,
      y: spec.y,
      z: spec.z,
      vx: Math.cos(direction) * speed,
      vz: Math.sin(direction) * speed,
      rotation: direction,
      size: spec.size[0] + (spec.size[1] - spec.size[0]) * fx.rng(),
      sizeEnd: 0.18,
      drag: 6,
      life: spec.life,
      hold: 0.4,
      alphaEnd: 0,
      clock: spec.clock ?? "game"
    })
  }
}
