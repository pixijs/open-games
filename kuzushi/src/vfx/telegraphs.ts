import { Container3D, FlatMaterial, Mesh3D, PlaneGeometry } from "@pixi/3d"

import { OVERLAY_BAND } from "../art/depth.ts"
import { linearOf } from "../art/color.ts"
import { PALETTE, paletteOfKind } from "../art/palette.ts"
import type { FrameTime } from "../host/types.ts"
import { homeOf, isBoss, Tuning } from "../sim/index.ts"
import type { EnemyKind, TelegraphShape, TelegraphView } from "../sim/index.ts"
import { Band, overlayMaterial } from "./bands.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, drawnAt } from "./fx.ts"
import type { Fx } from "./fx.ts"
import { telegraphBit } from "./shaders.ts"

/** How much of a line shows ahead of its fill; more on a pale floor, where a faint line is lost. */
const DIM = 0.3
const PALE_DIM = 0.65
const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })

/** One telegraph to draw this frame: whose it is (an enemy, or a part of a boss's pattern), where it starts, and its view. */
interface Entry {
  readonly key: string
  readonly kind: EnemyKind
  readonly x: number
  readonly z: number
  readonly radius: number
  readonly telegraph: TelegraphView
}

/** A line or ring drawn from the telegraph textures, the line in the textures' fill mode. */
interface Strip {
  readonly shape: Exclude<TelegraphShape, "arc">
  readonly node: Container3D
  readonly mesh: Mesh3D
  readonly material: FlatMaterial
  readonly dim: number
}

/** An arc: its outline (over an ink edge and a soft glow), the fill sweeping across it, and its two edges. */
interface Sector {
  readonly shape: "arc"
  readonly node: Container3D
  readonly bands: { readonly ink: Band; readonly glow: Band; readonly outline: Band; readonly fill: Band; readonly front: Band; readonly start: Band; readonly end: Band }
  readonly materials: { readonly ink: FlatMaterial; readonly glow: FlatMaterial; readonly outline: FlatMaterial; readonly fill: FlatMaterial; readonly edge: FlatMaterial }
}

type Drawn = (Strip | Sector) & {
  /** Drawings left of the release flash after the windup ends; -1 while winding up. */
  releasing: number
  progress: number
  feint: boolean
}

/**
 * Every telegraph drawn from the view, in the accent of the zone its attacker belongs to: a line along the attack that
 * fills toward its tip with a chevron at the front, a slam ring that fills from the centre, an arc (a sector round the
 * attacker) whose fill sweeps the way the attack will turn with an arrowhead at its leading end, or a gapped ring that
 * fills outward to where its wave will run, and a spot on the ground where a leap will land, an ink ring closing on it.
 * Bosses' patterns show several at once. Feints flicker thin and vanish; a real attack flashes white for a few drawings.
 */
export const installTelegraphs = (fx: Fx) => {
  const layer = new Container3D({ label: "telegraphs" })
  fx.context.layers.effects.addChild(layer)
  const shown = new Map<string, Drawn>()
  const live = new Set<string>()
  let drawing = -1

  const makeStrip = (entry: Entry, shape: Strip["shape"]): Strip => {
    const pale = fx.context.ground.pale
    const set = fx.kit.telegraphs[homeOf(entry.kind)]
    const round = shape !== "line"
    // A line draws over props, so a pillar or the spire never cuts it; a ring would draw over its own bruiser or warden.
    const material = new FlatMaterial({ baseColorTexture: round ? set.ring : pale ? set.linePale : set.line, extraBits: round ? [telegraphBit] : [telegraphBit, OVERLAY_BAND], alphaMode: "blend", doubleSided: true })
    material.data.tint = [...linearOf(paletteOfKind(entry.kind).danger), 1]
    const mesh = new Mesh3D({ geometry: quad, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, castShadow: false, receiveShadow: false })
    const node = new Container3D({ label: `telegraph-${entry.key}` })
    node.addChild(mesh)
    layer.addChild(node)
    return { shape, node, mesh, material, dim: pale ? PALE_DIM : DIM }
  }

  const makeSector = (entry: Entry): Sector => {
    const accent = paletteOfKind(entry.kind).danger
    const materials = { ink: overlayMaterial(PALETTE.ink, 0.75), glow: overlayMaterial(accent, 0.12), outline: overlayMaterial(accent, 0.95), fill: overlayMaterial(accent, 0.2), edge: overlayMaterial(accent, 0.9) }
    const bands = { ink: new Band(), glow: new Band(), outline: new Band(), fill: new Band(), front: new Band(4), start: new Band(4), end: new Band(4) }
    const node = new Container3D({ label: `telegraph-${entry.key}` })
    const mesh = (band: Band, material: FlatMaterial, y: number) => new Mesh3D({ geometry: band.geometry, material, position: { x: 0, y, z: 0 }, castShadow: false, receiveShadow: false })
    node.addChild(
      mesh(bands.glow, materials.glow, 0.05),
      mesh(bands.fill, materials.fill, 0.055),
      mesh(bands.ink, materials.ink, 0.06),
      mesh(bands.outline, materials.outline, 0.065),
      mesh(bands.front, materials.edge, 0.065),
      mesh(bands.start, materials.edge, 0.065),
      mesh(bands.end, materials.edge, 0.065)
    )
    layer.addChild(node)
    return { shape: "arc", node, bands, materials }
  }

  const make = (entry: Entry): Drawn => {
    const shape = entry.telegraph.shape
    const made = shape === "arc" ? makeSector(entry) : makeStrip(entry, shape)
    return Object.assign(made, { releasing: -1, progress: 0, feint: false })
  }

  /** A radial edge of an arc: a thin band along `angle` from `from` out to `to`. */
  const radial = (band: Band, angle: number, from: number, to: number, width: number) => {
    const half = width / Math.max(0.5, (from + to) / 2) / 2
    band.set(angle - half, angle + half, from, to)
  }

  /** Lays out an arc for this drawing: the outline over its span, the fill swept to `stepped` of it, its edges. */
  const placeSector = (drawn: Sector, entry: Entry, stepped: number, newDrawing: boolean) => {
    const { telegraph } = entry
    const size = telegraph.size
    const half = telegraph.halfAngle ?? Math.PI / 2
    const centre = angleOf(telegraph.dirX, telegraph.dirZ)
    const from = centre - half
    const to = centre + half
    const turn = telegraph.turn ?? 0
    const { bands } = drawn
    drawn.node.position.set(entry.x, 0, entry.z)
    if (!newDrawing) return
    bands.glow.set(from, to, size - 0.16, size + 0.16)
    bands.ink.set(from, to, size - 0.085, size + 0.085)
    bands.outline.set(from, to, size - 0.045, size + 0.045)
    const inner = entry.radius + 0.1
    if (turn === 0) {
      const front = inner + (size - inner) * stepped
      bands.fill.set(from, to, Math.max(inner, front - 0.35), front)
      bands.front.set(from, from, 0, 0)
    } else {
      const start = turn === 1 ? from : to
      const reached = start + turn * (to - from) * stepped
      bands.fill.set(start, reached, inner, size - 0.05)
      radial(bands.front, reached, inner, size, 0.07)
    }
    radial(bands.start, from, inner, size + 0.1, 0.09)
    radial(bands.end, to, inner, size + 0.1, 0.09)
    drawn.materials.fill.alpha = turn === 0 ? 0.55 : 0.06 + stepped * 0.12
    if (turn === 0 || telegraph.feint) return
    const lead = turn === 1 ? to : from
    const color = paletteOfKind(entry.kind).danger
    fx.layers.flat.spawn({ frames: fx.f.chevronWhite, x: entry.x + Math.cos(lead) * size, y: 0.12, z: entry.z + Math.sin(lead) * size, size: 0.85, rotation: lead + turn * Math.PI / 2, color, life: 1 / ON_TWOS, alpha: 1, alphaEnd: 1 })
    const along = (turn === 1 ? from : to) + turn * (to - from) * stepped
    fx.layers.flat.spawn({ frames: fx.f.chevronWhite, x: entry.x + Math.cos(along) * size * 0.72, y: 0.12, z: entry.z + Math.sin(along) * size * 0.72, size: 0.55, rotation: along + turn * Math.PI / 2, color, life: 1 / ON_TWOS, alpha: 0.85, alphaEnd: 0.85 })
  }

  const placeStrip = (drawn: Strip, entry: Entry, stepped: number, newDrawing: boolean) => {
    const { telegraph } = entry
    if (drawn.shape === "line") {
      const start = entry.radius + 0.15
      const length = Math.max(0.5, telegraph.size - start)
      drawn.node.position.set(entry.x, 0.08, entry.z)
      drawn.node.rotation.y = -angleOf(telegraph.dirX, telegraph.dirZ)
      drawn.mesh.position.set(start + length / 2, 0, 0)
      drawn.mesh.scale.set(length, telegraph.feint ? 0.28 : 0.46, 1)
    } else {
      const at = drawn.shape === "spot" ? telegraph.spot ?? entry : entry
      drawn.node.position.set(at.x, 0.07, at.z)
      drawn.mesh.scale.set(telegraph.size * 2, telegraph.size * 2, 1)
    }
    if (!newDrawing) return
    const ring = drawn.shape !== "line"
    drawn.material.data.fill = [ring ? 0.12 + stepped * 0.88 : stepped, ring ? 1 : 0, 0, drawn.dim]
    if (drawn.shape === "spot") {
      const spot = telegraph.spot ?? entry
      const closing = 1 - stepped
      fx.layers.floor.spawn({ frames: fx.f.ringSmall, x: spot.x, y: 0.04, z: spot.z, size: telegraph.size * 2.78, color: paletteOfKind(entry.kind).danger, life: 1 / ON_TWOS, alpha: 0.6 + stepped * 0.4, alphaEnd: 0.6 + stepped * 0.4, fps: 0 })
      fx.layers.floor.spawn({ frames: fx.f.dryRing, x: spot.x, y: 0.035, z: spot.z, size: telegraph.size * (2 + closing * 2.6), rotation: drawing * 0.7, color: PALETTE.ink, life: 1 / ON_TWOS, alpha: 0.35 + stepped * 0.5, alphaEnd: 0.35 + stepped * 0.5, fps: 0 })
    }
    if (drawn.shape === "line" && !telegraph.feint) {
      const start = entry.radius + 0.15
      const front = start + (telegraph.size - start) * stepped
      fx.layers.flat.spawn({ frames: fx.f.chevronWhite, x: entry.x + telegraph.dirX * front, y: 0.12, z: entry.z + telegraph.dirZ * front, size: 0.7, rotation: angleOf(telegraph.dirX, telegraph.dirZ), color: paletteOfKind(entry.kind).danger, life: 1 / ON_TWOS, alpha: 1, alphaEnd: 1 })
    }
  }

  /** Fades a telegraph: an arc's materials keep their own weights under it. */
  const alphaOf = (drawn: Drawn, alpha: number) => {
    if (drawn.shape !== "arc") {
      drawn.material.alpha = alpha
      return
    }
    const { materials } = drawn
    materials.ink.alpha = 0.75 * alpha
    materials.glow.alpha = 0.12 * alpha
    materials.outline.alpha = 0.95 * alpha
    materials.edge.alpha = 0.9 * alpha
  }

  const place = (drawn: Drawn, entry: Entry, newDrawing: boolean) => {
    drawn.progress = entry.telegraph.progress
    drawn.feint = entry.telegraph.feint
    const stepped = Math.min(1, Math.ceil(entry.telegraph.progress * 8) / 8)
    if (drawn.shape === "arc") placeSector(drawn, entry, stepped, newDrawing)
    else placeStrip(drawn, entry, stepped, newDrawing)
    if (newDrawing) alphaOf(drawn, entry.telegraph.feint && drawing % 2 === 1 ? 0.35 : 1)
  }

  const release = (drawn: Drawn) => {
    drawn.releasing -= 1
    if (drawn.shape === "arc") {
      for (const material of [drawn.materials.outline, drawn.materials.edge, drawn.materials.fill]) material.baseColor = 0xffffff
      drawn.materials.fill.alpha = 0.22
    } else {
      drawn.material.data.fill = [1, drawn.shape === "line" ? 0 : 1, 1, 1]
    }
    alphaOf(drawn, drawn.releasing > 0 ? 1 : 0.5)
  }

  const drop = (key: string, drawn: Drawn) => {
    drawn.node.destroy({ children: true })
    if (drawn.shape === "arc") {
      for (const band of Object.values(drawn.bands)) band.destroy()
      for (const material of Object.values(drawn.materials)) material.destroy()
    } else {
      drawn.material.destroy()
    }
    shown.delete(key)
  }

  /** This frame's telegraphs: each enemy's, at its body as drawn, and every one the boss's patterns show. */
  const entries = (): ReadonlyArray<Entry> => {
    const view = fx.context.game.view()
    const list: Array<Entry> = []
    for (const enemy of view.enemies) {
      if (enemy.telegraph === null || isBoss(enemy.kind)) continue
      const at = drawnAt(fx, enemy.id, enemy)
      list.push({ key: `e${enemy.id}`, kind: enemy.kind, x: at.x, z: at.z, radius: Tuning.radiusOf(enemy.kind, enemy.elite === true), telegraph: enemy.telegraph })
    }
    const boss = view.boss
    if (boss === null) return list
    for (const telegraph of boss.telegraphs) {
      const own = view.enemies.find((enemy) => enemy.id === telegraph.id)
      const onBody = own !== undefined && Math.abs(own.x - telegraph.x) < 1e-4 && Math.abs(own.z - telegraph.z) < 1e-4
      const at = onBody ? drawnAt(fx, telegraph.id, telegraph) : telegraph
      list.push({ key: `b${telegraph.id}-${telegraph.key}`, kind: boss.boss, x: at.x, z: at.z, radius: onBody ? Tuning.ENEMY[boss.boss].radius : Tuning.ORRERY.moonRadius, telegraph })
    }
    return list
  }

  const offTelegraph = fx.context.moments.on("telegraph", (telegraph) => {
    fx.layers.glow.spawn({ frames: fx.f.glint, x: telegraph.x, y: 1.1, z: telegraph.z, size: telegraph.feint ? 0.8 : 1.3, sizeEnd: 0.3, color: paletteOfKind(telegraph.kind).danger, rotation: 0.78, life: 0.15 })
  })

  return {
    update: (frame: FrameTime) => {
      const now = Math.floor(frame.gameElapsed * ON_TWOS)
      const newDrawing = now !== drawing
      drawing = now
      live.clear()
      for (const entry of entries()) {
        live.add(entry.key)
        const existing = shown.get(entry.key)
        const drawn = existing !== undefined && existing.shape === entry.telegraph.shape ? existing : make(entry)
        if (existing !== undefined && existing !== drawn) drop(entry.key, existing)
        shown.set(entry.key, drawn)
        drawn.releasing = -1
        place(drawn, entry, newDrawing || existing !== drawn)
      }
      for (const [key, drawn] of shown) {
        if (live.has(key)) continue
        if (drawn.releasing < 0) drawn.releasing = drawn.feint ? 0 : drawn.progress > 0.85 ? 3 : 1
        if (newDrawing) release(drawn)
        if (drawn.releasing <= 0) drop(key, drawn)
      }
    },
    clear: () => {
      for (const [key, drawn] of shown) drop(key, drawn)
    },
    dispose: () => {
      offTelegraph()
      for (const [key, drawn] of shown) drop(key, drawn)
      layer.destroy({ children: true })
    }
  }
}
