import { Container3D, Mesh3D } from "@pixi/3d"
import type { FlatMaterial } from "@pixi/3d"

import { PALETTE, paletteOfKind } from "../art/palette.ts"
import type { MomentOf } from "../sim/index.ts"
import { Band, overlayMaterial } from "./bands.ts"
import { ON_TWOS } from "./cues.ts"
import type { Fx } from "./fx.ts"

/** Seconds a wave holds at its full reach, thinning, after its front stops. */
const FADE = 3 / ON_TWOS

interface Wave {
  readonly moment: MomentOf<"wave">
  readonly node: Container3D
  readonly core: Band
  readonly glow: Band
  readonly ink: Band
  readonly materials: { readonly ink: FlatMaterial; readonly glow: FlatMaterial; readonly core: FlatMaterial }
  age: number
  drawing: number
}

/**
 * Ring waves (a pulsar's, the Orrery's pulse): a thin white-hot core in a band of the accent with an ink edge, running
 * out from the body on the game clock and broken by its gap, scorching the floor as it crosses, held for a few
 * drawings at its reach as it thins away. It moves on twos.
 */
export const installWaves = (fx: Fx) => {
  const layer = new Container3D({ label: "waves" })
  fx.context.layers.effects.addChild(layer)
  const waves: Array<Wave> = []

  const start = (moment: MomentOf<"wave">) => {
    const accent = paletteOfKind(moment.kind).danger
    const core = new Band(96)
    const glow = new Band(96)
    const ink = new Band(96)
    const materials = { ink: overlayMaterial(PALETTE.ink, 0.55), glow: overlayMaterial(accent, 0.75, true), core: overlayMaterial(0xffffff, 1) }
    const node = new Container3D({ label: "wave", position: { x: moment.x, y: 0.09, z: moment.z } })
    node.addChild(
      new Mesh3D({ geometry: ink.geometry, material: materials.ink, castShadow: false, receiveShadow: false }),
      new Mesh3D({ geometry: glow.geometry, material: materials.glow, position: { x: 0, y: 0.005, z: 0 }, castShadow: false, receiveShadow: false }),
      new Mesh3D({ geometry: core.geometry, material: materials.core, position: { x: 0, y: 0.01, z: 0 }, castShadow: false, receiveShadow: false })
    )
    layer.addChild(node)
    waves.push({ moment, node, core, glow, ink, materials, age: 0, drawing: -1 })
    fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: moment.x, y: 0.1, z: moment.z, size: moment.from * 2, sizeEnd: moment.from * 5, color: accent, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0 })
    fx.layers.glow.spawn({ frames: fx.f.glint, x: moment.x, y: 0.8, z: moment.z, size: 2.6, sizeEnd: 0.5, rotation: 0.78, color: 0xffffff, life: 0.18 })
  }

  const drop = (index: number) => {
    const wave = waves[index]
    if (wave === undefined) return
    waves.splice(index, 1)
    wave.node.destroy({ children: true })
    for (const band of [wave.core, wave.glow, wave.ink]) band.destroy()
    for (const material of Object.values(wave.materials)) material.destroy()
  }

  const draw = (wave: Wave) => {
    const { moment } = wave
    const run = (moment.reach - moment.from) / moment.speed
    const front = Math.min(moment.reach, moment.from + moment.speed * Math.min(wave.age, run))
    const fading = Math.max(0, (wave.age - run) / FADE)
    const from = moment.gapAngle + moment.gap / 2
    const to = moment.gapAngle + Math.PI * 2 - moment.gap / 2
    const thin = 1 - fading
    wave.ink.set(from, to, front - moment.halfWidth * 1.15 * thin, front + moment.halfWidth * 1.15 * thin)
    wave.glow.set(from, to, front - moment.halfWidth * thin, front + moment.halfWidth * thin)
    wave.core.set(from, to, front - 0.05 * thin, front + 0.05 * thin)
    const flicker = wave.drawing % 2 === 0 ? 1 : 0.8
    const { materials } = wave
    materials.ink.alpha = 0.55 * thin
    materials.glow.alpha = 0.8 * thin * flicker
    materials.core.alpha = thin
    if (fading > 0) return
    const accent = paletteOfKind(moment.kind).danger
    const span = to - from
    for (let index = 0; index < Math.ceil(front * 0.9); index++) {
      const angle = from + span * fx.rng()
      fx.layers.floor.spawn({ frames: fx.f.speck, x: moment.x + Math.cos(angle) * front, y: 0.025, z: moment.z + Math.sin(angle) * front, size: 0.3 + fx.rng() * 0.3, rotation: angle, color: PALETTE.ink, life: 3.5, hold: 0.4, alpha: 0.45, alphaEnd: 0, fps: 0 })
    }
    for (const edge of [from, to]) {
      fx.layers.flat.spawn({ frames: fx.f.sparkWhite, x: moment.x + Math.cos(edge) * front, y: 0.25, z: moment.z + Math.sin(edge) * front, size: 0.5, sizeEnd: 0.2, rotation: edge + Math.PI / 2, color: accent, life: 1 / ON_TWOS, alpha: 1, alphaEnd: 0.6 })
    }
  }

  const off = fx.context.moments.on("wave", start)

  return {
    update: (gameDt: number) => {
      for (let index = waves.length - 1; index >= 0; index--) {
        const wave = waves[index]
        if (wave === undefined) continue
        wave.age += gameDt
        const run = (wave.moment.reach - wave.moment.from) / wave.moment.speed
        if (wave.age > run + FADE) {
          drop(index)
          continue
        }
        const drawing = Math.floor(wave.age * ON_TWOS)
        if (drawing === wave.drawing) continue
        wave.drawing = drawing
        draw(wave)
      }
    },
    clear: () => {
      for (let index = waves.length - 1; index >= 0; index--) drop(index)
    },
    dispose: () => {
      off()
      for (let index = waves.length - 1; index >= 0; index--) drop(index)
      layer.destroy({ children: true })
    }
  }
}
