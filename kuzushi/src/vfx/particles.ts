import { ParticleContainer3D } from "@pixi/3d"
import type { ParticleBillboardMode, ParticleBlendMode } from "@pixi/3d"
import type { Container3D } from "@pixi/3d"
import type { Texture } from "pixi.js"

import { OVERLAY_BAND } from "../art/depth.ts"
import { ON_TWOS } from "./cues.ts"
import type { ClockKind, Clocks } from "./cues.ts"

/** One hand-drawn sprite thrown into the world: where, how it moves, how it fades, which drawings it plays. */
export interface Spawn {
  /** An atlas frame, or a flipbook played one drawing per step of `fps`, holding the last. */
  readonly frames: number | ReadonlyArray<number>
  readonly x: number
  readonly y: number
  readonly z: number
  readonly vx?: number
  readonly vy?: number
  readonly vz?: number
  /** World units across. */
  readonly size: number
  readonly sizeEnd?: number
  /** Radians: on the ground (horizontal layers) the sim's facing, on screen (facing layers) counter-clockwise. */
  readonly rotation?: number
  readonly spin?: number
  readonly color?: number
  readonly alpha?: number
  readonly alphaEnd?: number
  /** Share of the life held at full alpha before fading toward `alphaEnd`. */
  readonly hold?: number
  readonly life: number
  readonly drag?: number
  readonly gravity?: number
  /** Lands on the floor and skids, instead of falling through it. */
  readonly ground?: boolean
  readonly clock?: ClockKind
  /** Drawings a second: the sprite moves and changes only on new drawings. 0 draws every frame. */
  readonly fps?: number
}

const FLOOR = 0.03

class Particle {
  x = 0
  y = 0
  z = 0
  vx = 0
  vy = 0
  vz = 0
  size = 0
  sizeEnd = 0
  rotation = 0
  spin = 0
  color = 0xffffff
  alpha = 1
  alphaEnd = 0
  hold = 0
  life = 1
  age = 0
  drag = 0
  gravity = 0
  ground = false
  clock: ClockKind = "game"
  fps = ON_TWOS
  frames: number | ReadonlyArray<number> = 0
  shown = -1
}

export interface LayerOptions {
  readonly frames: ReadonlyArray<Texture>
  readonly capacity: number
  readonly billboard: ParticleBillboardMode
  readonly blendMode: ParticleBlendMode
  readonly label: string
  readonly parent: Container3D
  /** Draws over the world instead of behind it, still under the player: for marks and glows the low special camera must always see. */
  readonly onTop?: boolean
  /**
   * Where this layer sorts among the scene's blended meshes, as a distance from the camera: blended meshes draw
   * far to near by their origin, and a world-space particle container's origin moves nothing but its turn.
   */
  readonly order: number
}

/** A pool of hand-driven sprites on one ParticleContainer3D: one draw call, every frame of the atlas. */
export class SpriteLayer {
  readonly container: ParticleContainer3D
  private readonly pool: Array<Particle>
  private count = 0
  private dirty = false
  private readonly order: number

  constructor(options: LayerOptions) {
    this.container = new ParticleContainer3D({
      texture: options.frames,
      capacity: options.capacity,
      billboard: options.billboard,
      blendMode: options.blendMode,
      label: options.label,
      parent: options.parent,
      extraBits: options.onTop === true ? [OVERLAY_BAND] : []
    })
    this.pool = Array.from({ length: options.capacity }, () => new Particle())
    this.order = options.order
  }

  /** Keeps the layer's draw turn: `order` units from the camera, so it sorts before or after the world's blended meshes. */
  sortFrom(camera: { readonly x: number; readonly y: number; readonly z: number }): void {
    this.container.position.set(camera.x, camera.y - this.order, camera.z)
  }

  spawn(spawn: Spawn): void {
    const particle = this.pool[this.count]
    if (particle === undefined) return
    particle.x = spawn.x
    particle.y = spawn.y
    particle.z = spawn.z
    particle.vx = spawn.vx ?? 0
    particle.vy = spawn.vy ?? 0
    particle.vz = spawn.vz ?? 0
    particle.size = spawn.size
    particle.sizeEnd = spawn.sizeEnd ?? spawn.size
    particle.rotation = spawn.rotation ?? 0
    particle.spin = spawn.spin ?? 0
    particle.color = spawn.color ?? 0xffffff
    particle.alpha = spawn.alpha ?? 1
    particle.alphaEnd = spawn.alphaEnd ?? 0
    particle.hold = spawn.hold ?? 0
    particle.life = spawn.life
    particle.age = 0
    particle.drag = spawn.drag ?? 0
    particle.gravity = spawn.gravity ?? 0
    particle.ground = spawn.ground ?? false
    particle.clock = spawn.clock ?? "game"
    particle.fps = spawn.fps ?? ON_TWOS
    particle.frames = spawn.frames
    particle.shown = -1
    this.write(this.count, particle, 0)
    this.count += 1
  }

  update(clocks: Clocks): void {
    for (let index = this.count - 1; index >= 0; index--) {
      const particle = this.pool[index]
      if (particle === undefined) continue
      const dt = clocks[particle.clock]
      if (dt === 0) continue
      particle.age += dt
      if (particle.age >= particle.life) {
        this.remove(index)
        continue
      }
      if (particle.drag > 0) {
        const keep = Math.exp(-particle.drag * dt)
        particle.vx *= keep
        particle.vy *= keep
        particle.vz *= keep
      }
      particle.vy -= particle.gravity * dt
      particle.x += particle.vx * dt
      particle.y += particle.vy * dt
      particle.z += particle.vz * dt
      particle.rotation += particle.spin * dt
      if (particle.ground && particle.y < FLOOR) {
        particle.y = FLOOR
        particle.vy = 0
        const skid = Math.exp(-7 * dt)
        particle.vx *= skid
        particle.vz *= skid
        particle.spin *= skid
      }
      const drawing = particle.fps > 0 ? Math.floor(particle.age * particle.fps) : -2
      if (drawing === particle.shown && particle.fps > 0) continue
      this.write(index, particle, drawing)
    }
    this.flush()
  }

  clear(): void {
    for (let index = 0; index < this.count; index++) this.container.setParticleAt(index, 0, 0, 0, 0)
    this.count = 0
    this.dirty = true
    this.flush()
  }

  flush(): void {
    if (!this.dirty) return
    this.container.upload()
    this.dirty = false
  }

  destroy(): void {
    this.container.destroy()
  }

  private remove(index: number): void {
    const last = this.count - 1
    const gone = this.pool[index]
    const moved = this.pool[last]
    if (gone === undefined || moved === undefined) return
    if (index !== last) {
      this.pool[index] = moved
      this.pool[last] = gone
      moved.shown = -1
      this.write(index, moved, moved.fps > 0 ? Math.floor(moved.age * moved.fps) : -2)
    }
    this.container.setParticleAt(last, 0, 0, 0, 0)
    this.count = last
    this.dirty = true
  }

  private write(index: number, particle: Particle, drawing: number): void {
    particle.shown = drawing
    const age = particle.fps > 0 ? Math.max(0, drawing) / particle.fps : particle.age
    const t = Math.min(1, age / particle.life)
    const fade = t <= particle.hold ? 0 : (t - particle.hold) / Math.max(0.0001, 1 - particle.hold)
    const size = particle.size + (particle.sizeEnd - particle.size) * t
    const alpha = particle.alpha + (particle.alphaEnd - particle.alpha) * fade
    const frames = particle.frames
    const frame = typeof frames === "number" ? frames : (frames[Math.min(frames.length - 1, Math.max(0, drawing))] ?? 0)
    this.container.setParticleAt(index, particle.x, particle.y, particle.z, size, particle.rotation, particle.color, alpha, frame)
    this.dirty = true
  }
}
