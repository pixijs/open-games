import { Container3D, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { FlatMaterial } from "@pixi/3d"

import { PALETTE, paletteOfKind } from "../art/palette.ts"
import type { EnemyKind, MomentOf, SeamView } from "../sim/index.ts"
import { overlayMaterial } from "./bands.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, pick, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })

/** The last share of a seam's burn over which it heals back to stone. */
const HEAL = 0.25

interface Drawn {
  readonly kind: EnemyKind
  readonly node: Container3D
  readonly parts: ReadonlyArray<{ readonly mesh: Mesh3D; readonly material: FlatMaterial; readonly width: number }>
  readonly cracked: Set<number>
  drawing: number
}

/**
 * Seams (a cutter's, Sunder's) drawn from the view: a crack running out along its line, a white core in a glow of the
 * accent over an ink edge, flickering on twos and spitting sparks at its running tip, ink cracks left in the stone as
 * it goes; in the last quarter of its burn it narrows and dims back to stone, and the cracks stay a while.
 */
export const installSeams = (fx: Fx) => {
  const layer = new Container3D({ label: "seams" })
  fx.context.layers.effects.addChild(layer)
  const shown = new Map<number, Drawn>()
  const owners = new Map<number, EnemyKind>()
  const live = new Set<number>()

  const make = (seam: SeamView): Drawn => {
    const kind = owners.get(seam.id) ?? "cutter"
    const accent = paletteOfKind(kind).danger
    const node = new Container3D({ label: `seam-${seam.id}`, position: { x: seam.x, y: 0.085, z: seam.z }, rotation: { x: 0, y: -angleOf(seam.dirX, seam.dirZ), z: 0 } })
    const part = (color: number, width: number, alpha: number, add: boolean, lift: number) => {
      const material = overlayMaterial(color, alpha, add)
      const mesh = new Mesh3D({ geometry: quad, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: 0, y: lift, z: 0 }, castShadow: false, receiveShadow: false })
      node.addChild(mesh)
      return { mesh, material, width }
    }
    const parts = [part(PALETTE.ink, seam.halfWidth * 1.7, 0.7, false, 0), part(accent, seam.halfWidth * 2.2, 0.75, true, 0.004), part(0xffffff, seam.halfWidth * 0.4, 1, false, 0.008)]
    layer.addChild(node)
    return { kind, node, parts, cracked: new Set(), drawing: -1 }
  }

  const drop = (id: number, drawn: Drawn) => {
    drawn.node.destroy({ children: true })
    for (const part of drawn.parts) part.material.destroy()
    shown.delete(id)
    owners.delete(id)
  }

  const draw = (seam: SeamView, drawn: Drawn, drawing: number) => {
    const healing = Math.max(0, (seam.burn - (1 - HEAL)) / HEAL)
    const flicker = drawing % 2 === 0 ? 1 : 0.7
    drawn.parts.forEach(({ mesh, material, width }, index) => {
      const core = index === drawn.parts.length - 1
      mesh.position.x = seam.length / 2
      mesh.scale.set(Math.max(0.01, seam.length), width * (1 - healing * 0.8) * (flicker === 1 ? 1 : 0.85), 1)
      material.alpha = (core ? 1 : flicker * 0.75) * (1 - healing)
    })
    const growing = seam.length < seam.reach - 1e-3
    const accent = paletteOfKind(drawn.kind).danger
    if (growing) {
      const tipX = seam.x + seam.dirX * seam.length
      const tipZ = seam.z + seam.dirZ * seam.length
      const back = angleOf(-seam.dirX, -seam.dirZ)
      for (let index = 0; index < 3; index++) {
        const direction = back + spread(fx.rng, 1.1)
        const speed = 4 + fx.rng() * 6
        fx.layers.flat.spawn({ frames: index === 0 ? fx.f.spark : fx.f.sparkWhite, x: tipX, y: 0.3, z: tipZ, vx: Math.cos(direction) * speed, vz: Math.sin(direction) * speed, vy: 2, size: 0.45, sizeEnd: 0.15, rotation: direction, color: index === 0 ? 0xffffff : accent, gravity: 12, drag: 4, life: 0.25, alphaEnd: 0 })
      }
      fx.layers.glow.spawn({ frames: fx.f.glint, x: tipX, y: 0.35, z: tipZ, size: 1.2, sizeEnd: 0.4, rotation: 0.78, color: 0xffffff, life: 1 / ON_TWOS })
    }
    for (let at = 0.8; at < seam.length; at += 1.6) {
      const slot = Math.floor(at)
      if (drawn.cracked.has(slot)) continue
      drawn.cracked.add(slot)
      fx.layers.floor.spawn({ frames: pick(fx.rng, fx.f.cracks, fx.f.inkDrop), x: seam.x + seam.dirX * at, y: 0.022, z: seam.z + seam.dirZ * at, size: 1.4 + fx.rng() * 0.6, rotation: angleOf(seam.dirX, seam.dirZ) + spread(fx.rng, 0.4), life: 8, hold: 0.75, alpha: 0.7, alphaEnd: 0, fps: 0 })
    }
  }

  const onDrawn = (drawn: MomentOf<"seamDrawn">) => {
    const owner = fx.context.game.view().enemies.find((enemy) => enemy.id === drawn.owner)
    owners.set(drawn.id, owner?.kind ?? "cutter")
    const accent = paletteOfKind(owner?.kind ?? "cutter").danger
    fx.layers.flat.spawn({ frames: fx.f.cutline, x: drawn.x + drawn.dirX * 0.6, y: 0.4, z: drawn.z + drawn.dirZ * 0.6, size: 2.2, sizeEnd: 3, rotation: angleOf(drawn.dirX, drawn.dirZ), life: 2 / ON_TWOS, alpha: 1, alphaEnd: 0.4 })
    fx.layers.flatGlow.spawn({ frames: fx.f.halo, x: drawn.x, y: 0.2, z: drawn.z, size: 2.2, sizeEnd: 0.6, color: accent, life: 0.2, alpha: 0.9, fps: 0 })
  }

  const offs = [fx.context.moments.on("seamDrawn", onDrawn)]

  return {
    update: (gameElapsed: number) => {
      const seams = fx.context.game.view().seams
      live.clear()
      const drawing = Math.floor(gameElapsed * ON_TWOS)
      for (const seam of seams) {
        live.add(seam.id)
        const drawn = shown.get(seam.id) ?? make(seam)
        shown.set(seam.id, drawn)
        if (drawn.drawing === drawing) continue
        drawn.drawing = drawing
        draw(seam, drawn, drawing)
      }
      for (const [id, drawn] of shown) if (!live.has(id)) drop(id, drawn)
    },
    clear: () => {
      for (const [id, drawn] of shown) drop(id, drawn)
    },
    dispose: () => {
      for (const off of offs) off()
      for (const [id, drawn] of shown) drop(id, drawn)
      layer.destroy({ children: true })
    }
  }
}
