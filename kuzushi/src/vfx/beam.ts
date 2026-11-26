import { Container3D, FlatMaterial, Mesh3D, PlaneGeometry } from "@pixi/3d"

import { PALETTE } from "../art/palette.ts"
import type { FrameTime } from "../host/types.ts"
import type { ArenaLayout, HazardView, MomentOf } from "../sim/index.ts"
import { beamRibbonBit, COVER_SLOTS, coverSlot, sweepFloorBit } from "./beam-shaders.ts"
import { ON_TWOS } from "./cues.ts"
import { spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

/**
 * The Spiral's beam, drawn from the view each frame over the room's own floor, its cover the room's pillars. A
 * second before a sweep a crisp line marks where it starts, chevrons pointing the way it will turn, and the fan of
 * floor it will cross in that second washes in the accent with the ground each pillar shelters hatched in paper. Then
 * the beam blazes out of the spire's slit: a white-hot core in an accent glow whose edges waver with heat, laid over
 * a burning strip of floor, throwing sparks where it strikes a pillar or the wall, the fan running a second ahead of
 * it and a scorch fading behind. It is drawn in the Courtyard's red; the grade repaints it as the Spiral's amber.
 */

type Beam = Extract<HazardView, { readonly kind: "beam" }>

const RED = [1, 0.18, 0.247, 1] as const
const PAPER = [0.949, 0.937, 0.91, 1] as const
/** The beam's height above the floor: the middle of the spire's slit. */
const HEIGHT = 0.47
/** Units between the chevrons along the telegraph line. */
const CHEVRON_GAP = 2.2

/** How far the beam's dial reaches: the round floor's radius, or the floor's box on any other. */
const radiusOf = (layout: ArenaLayout): number => (layout.floor.kind === "round" ? layout.floor.radius : Math.max(layout.halfWidth, layout.halfDepth))

/** A layer of the beam's body. It shows only while the beam sweeps, and show() sets its ribbon and time on each of those frames. */
const ribbon = () => {
  const material = new FlatMaterial({ alphaMode: "blend", doubleSided: true, extraBits: [beamRibbonBit] })
  material.data.ribbonRed = RED
  material.state.blendMode = "add"
  return material
}

interface Parts {
  readonly root: Container3D
  readonly floor: FlatMaterial
  readonly dial: Mesh3D
  readonly beam: Container3D
  readonly body: ReadonlyArray<FlatMaterial>
  readonly strip: Mesh3D
  readonly flat: Mesh3D
  readonly upright: Mesh3D
  readonly line: Container3D
  readonly lineMesh: Mesh3D
  readonly lineMaterial: FlatMaterial
  destroy(): void
}

const build = (fx: Fx): Parts => {
  const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })
  const root = new Container3D({ label: "beam" })
  fx.context.layers.effects.addChild(root)
  const floor = new FlatMaterial({ alphaMode: "blend", extraBits: [sweepFloorBit] })
  floor.data.sweep = [0, 0, 0, 0]
  floor.data.dial = [15, 2, 15, 0]
  for (let slot = 0; slot < COVER_SLOTS; slot++) floor.data[`cover${slot}`] = [0, 0, 0, 0]
  floor.data.sweepRed = RED
  floor.data.sweepCover = PAPER
  const dial = new Mesh3D({ geometry: quad, material: floor, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: 0, y: 0.03, z: 0 }, scale: { x: 30, y: 30, z: 1 }, castShadow: false, receiveShadow: false })
  const glow = ribbon()
  const core = ribbon()
  const beam = new Container3D({ label: "beam-body" })
  const strip = new Mesh3D({ geometry: quad, material: glow, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: 0, y: 0.05, z: 0 }, castShadow: false, receiveShadow: false })
  const flat = new Mesh3D({ geometry: quad, material: core, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: 0, y: HEIGHT, z: 0 }, castShadow: false, receiveShadow: false })
  const upright = new Mesh3D({ geometry: quad, material: core, position: { x: 0, y: HEIGHT, z: 0 }, castShadow: false, receiveShadow: false })
  beam.addChild(strip, flat, upright)
  const lineMaterial = new FlatMaterial({ baseColor: PALETTE.red, alphaMode: "blend", extraBits: [] })
  lineMaterial.state.blendMode = "add"
  const line = new Container3D({ label: "beam-telegraph" })
  const lineMesh = new Mesh3D({ geometry: quad, material: lineMaterial, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: 0, y: 0.06, z: 0 }, castShadow: false, receiveShadow: false })
  line.addChild(lineMesh)
  root.addChild(dial, beam, line)
  return {
    root,
    floor,
    dial,
    beam,
    body: [glow, core],
    strip,
    flat,
    upright,
    line,
    lineMesh,
    lineMaterial,
    destroy: () => {
      root.destroy({ children: true })
      for (const material of [floor, glow, core, lineMaterial]) material.destroy()
      quad.destroy()
    }
  }
}

/** Lays a strip from `from` to `to` along the holder's +x, `width` across. */
const lay = (mesh: Mesh3D, from: number, to: number, width: number) => {
  mesh.position.x = (from + to) / 2
  mesh.scale.set(Math.max(0.01, to - from), width, 1)
}

export const installBeam = (fx: Fx) => {
  let parts: Parts | null = null
  let drawing = -1
  let sinceSweep = 0

  const emitter = (beam: Beam, angle: number) => ({ x: beam.x + Math.cos(angle) * (beam.from + 0.05), z: beam.z + Math.sin(angle) * (beam.from + 0.05) })

  /** Sparks, a flash and embers where the beam strikes a pillar or the wall, and heat rising along it. */
  const strike = (beam: Beam, radius: number) => {
    const dirX = Math.cos(beam.angle)
    const dirZ = Math.sin(beam.angle)
    const x = beam.x + dirX * beam.reach
    const z = beam.z + dirZ * beam.reach
    const back = beam.angle + Math.PI
    const onPillar = beam.reach < radius - 0.4
    for (let index = 0; index < (onPillar ? 3 : 2); index++) {
      const direction = back + spread(fx.rng, 1.2)
      const speed = 5 + fx.rng() * 7
      fx.layers.flat.spawn({ frames: index === 0 ? fx.f.spark : fx.f.sparkRed, x, y: HEIGHT, z, vx: Math.cos(direction) * speed, vy: 2 + fx.rng() * 3, vz: Math.sin(direction) * speed, rotation: direction, size: 0.45 + fx.rng() * 0.35, sizeEnd: 0.1, gravity: 14, ground: true, drag: 2, life: 0.4, hold: 0.3, alphaEnd: 0 })
    }
    fx.layers.glow.spawn({ frames: fx.f.halo, x, y: HEIGHT, z, size: onPillar ? 2.6 : 1.8, sizeEnd: 1.2, color: PALETTE.red, alpha: 0.9, life: 2 / ON_TWOS, fps: 0 })
    if (drawing % 2 === 0) fx.layers.face.spawn({ frames: fx.f.burst, x, y: HEIGHT, z, size: onPillar ? 1.5 : 1.1, sizeEnd: 1.8, rotation: back + spread(fx.rng, 0.5), life: 2 / ON_TWOS, alpha: 1, alphaEnd: 0.4 })
    if (drawing % 4 === 0) fx.layers.floor.spawn({ frames: fx.f.inkDrop, x: x - dirX * 0.3, y: 0.024, z: z - dirZ * 0.3, size: 0.4 + fx.rng() * 0.3, rotation: fx.rng() * 6, alpha: 0.35, alphaEnd: 0, hold: 0.5, life: 4, fps: 0 })
    const along = beam.from + fx.rng() * (beam.reach - beam.from)
    fx.layers.glow.spawn({ frames: fx.f.ember, x: beam.x + dirX * along, y: HEIGHT, z: beam.z + dirZ * along, vy: 1.6 + fx.rng() * 1.4, vx: spread(fx.rng, 0.4), vz: spread(fx.rng, 0.4), size: 0.16, sizeEnd: 0.04, color: PALETTE.red, life: 0.7, alphaEnd: 0 })
    const at = emitter(beam, beam.angle)
    fx.layers.glow.spawn({ frames: fx.f.flare, x: at.x, y: HEIGHT, z: at.z, size: 2.6 + fx.rng() * 0.6, sizeEnd: 2, rotation: 0, color: 0xffffff, alpha: 0.8, life: 1 / ON_TWOS, fps: 0 })
  }

  /** Chevrons along the telegraph line, pointing the way the beam will turn. */
  const chevrons = (beam: Beam, angle: number, reach: number, strength: number) => {
    const turn = angle + Math.PI / 2
    for (let along = beam.from + 1.2; along < reach - 0.4; along += CHEVRON_GAP) {
      const x = beam.x + Math.cos(angle) * along + Math.cos(turn) * 0.35
      const z = beam.z + Math.sin(angle) * along + Math.sin(turn) * 0.35
      fx.layers.flat.spawn({ frames: fx.f.chevron, x, y: 0.08, z, size: 0.55, rotation: turn, color: 0xffffff, life: 1 / ON_TWOS, alpha: strength, alphaEnd: strength })
    }
  }

  /** Lays the dial over the floor round the beam's spire and fills its cover with the floor's pillars. */
  const fit = (beam: Beam, parts: Parts, layout: ArenaLayout, floorRadius: number): number => {
    const radius = floorRadius + Math.hypot(beam.x, beam.z)
    parts.dial.scale.set(radius * 2, radius * 2, 1)
    const pillars = layout.pillars.filter((pillar) => Math.hypot(pillar.x - beam.x, pillar.z - beam.z) > 0.5).slice(0, COVER_SLOTS)
    for (let slot = 0; slot < COVER_SLOTS; slot++) {
      const pillar = pillars[slot]
      parts.floor.data[`cover${slot}`] = pillar === undefined ? [0, 0, 0, 0] : coverSlot(pillar.x - beam.x, pillar.z - beam.z, pillar.radius)
    }
    return radius
  }

  const show = (beam: Beam, frame: FrameTime, parts: Parts) => {
    const now = Math.floor(frame.gameElapsed * ON_TWOS)
    const newDrawing = now !== drawing
    drawing = now
    const sweeping = beam.phase === "sweep"
    sinceSweep = sweeping ? 0 : sinceSweep + frame.gameDt
    const telegraph = beam.telegraph
    const warn = beam.phase === "warn"
    parts.root.position.set(beam.x, 0, beam.z)
    const arena = fx.context.game.arena
    const floorRadius = radiusOf(arena)
    const radius = fit(beam, parts, arena, floorRadius)
    const lead = telegraph?.angle ?? beam.angle
    const fan = warn ? 0.2 + beam.progress * 0.25 : sweeping ? 0.55 : 0
    const scorch = sweeping ? 0.5 : Math.max(0, 0.5 - sinceSweep * 1.2)
    parts.floor.data.sweep = [beam.angle, warn ? lead + 0.7 : lead, fan, warn || sweeping ? 0.55 : scorch]
    parts.floor.data.dial = [radius, beam.from, floorRadius, scorch]
    parts.beam.visible = sweeping
    parts.beam.rotation.y = -beam.angle
    if (sweeping) {
      lay(parts.strip, beam.from, beam.reach, 2.6)
      lay(parts.flat, beam.from, beam.reach, 0.95)
      lay(parts.upright, beam.from, beam.reach, 0.95)
      const time = drawing / ON_TWOS
      for (const material of parts.body) material.data.ribbonTime = [time, 0, 0, 0]
      const flicker = drawing % 2 === 0 ? 1 : 0.86
      const [glow, core] = parts.body
      if (glow !== undefined) glow.data.ribbon = [0, 1, 1.5 * flicker, 0.05]
      if (core !== undefined) core.data.ribbon = [0.3, 1, 2.8 * flicker, 0.09]
    }
    parts.line.visible = telegraph !== null
    if (telegraph !== null) {
      parts.line.rotation.y = -telegraph.angle
      lay(parts.lineMesh, beam.from, telegraph.reach, warn ? 0.06 + beam.progress * 0.05 : 0.05)
      const blink = warn && drawing % 2 === 1 ? 0.55 : 1
      parts.lineMaterial.alpha = (warn ? 0.6 + beam.progress * 0.4 : 0.75) * blink
    }
    if (!newDrawing || frame.gameDt === 0) return
    if (sweeping) strike(beam, floorRadius)
    if (telegraph !== null && drawing % 2 === 0) chevrons(beam, telegraph.angle, telegraph.reach, warn ? 0.85 : 0.5)
  }

  const onWarned = (warned: MomentOf<"beamWarned">) => {
    const at = { x: warned.x + Math.cos(warned.angle) * 2.05, z: warned.z + Math.sin(warned.angle) * 2.05 }
    fx.layers.glow.spawn({ frames: fx.f.glint, x: at.x, y: HEIGHT, z: at.z, size: 2.4, sizeEnd: 0.6, rotation: 0.78, color: 0xffffff, life: 0.25 })
    fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x: warned.x, y: 0.08, z: warned.z, size: 4.5, sizeEnd: 9, color: PALETTE.red, life: 0.5, alpha: 0.8, alphaEnd: 0 })
    fx.context.rig.shake(0.05, { x: warned.x, z: warned.z, shape: "rumble", duration: 0.6 })
  }

  const onStarted = (started: MomentOf<"beamStarted">) => {
    const at = { x: started.x + Math.cos(started.angle) * 2.1, z: started.z + Math.sin(started.angle) * 2.1 }
    fx.layers.face.spawn({ frames: fx.f.burst, x: at.x, y: HEIGHT, z: at.z, size: 2.6, sizeEnd: 3.2, rotation: started.angle, life: 3 / ON_TWOS, alphaEnd: 0.4 })
    fx.layers.flat.spawn({ frames: fx.f.shock, x: started.x, y: 0.1, z: started.z, size: 4, sizeEnd: 9, color: PALETTE.red, life: 4 / ON_TWOS, alpha: 1, alphaEnd: 0 })
    fx.impacts.pulse("red", 0.3)
    fx.context.rig.shake(0.12, { x: at.x, z: at.z, shape: "rumble", duration: 0.4 })
  }

  const onEnded = (ended: MomentOf<"beamEnded">) => {
    const at = { x: ended.x + Math.cos(ended.angle) * 2.1, z: ended.z + Math.sin(ended.angle) * 2.1 }
    fx.layers.flat.spawn({ frames: fx.f.dryRing, x: at.x, y: HEIGHT, z: at.z, size: 1, sizeEnd: 2.4, life: 3 / ON_TWOS, alpha: 0.7, alphaEnd: 0 })
    for (let index = 0; index < 5; index++) {
      fx.layers.glow.spawn({ frames: fx.f.ember, x: at.x + spread(fx.rng, 0.4), y: HEIGHT, z: at.z + spread(fx.rng, 0.4), vy: 1.5 + fx.rng() * 2, size: 0.2, sizeEnd: 0.05, color: PALETTE.red, life: 0.8, alphaEnd: 0 })
    }
  }

  const { moments } = fx.context
  const offs = [moments.on("beamWarned", onWarned), moments.on("beamStarted", onStarted), moments.on("beamEnded", onEnded)]

  return {
    update: (frame: FrameTime) => {
      const view = fx.context.game.view()
      const beam = view.hazard.kind === "beam" && view.flow !== "Title" ? view.hazard : null
      if (beam === null) {
        parts?.destroy()
        parts = null
        return
      }
      parts ??= build(fx)
      show(beam, frame, parts)
    },
    dispose: () => {
      for (const off of offs) off()
      parts?.destroy()
      parts = null
    }
  }
}
