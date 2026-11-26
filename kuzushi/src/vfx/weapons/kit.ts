import type { Geometry3D } from "@pixi/3d"
import { Texture } from "pixi.js"

import { hex, paletteOf, ZONE_PALETTES } from "../../art/palette.ts"
import type { ZonePalette } from "../../art/palette.ts"
import { svgTextures } from "../../art/svg.ts"
import { zoneIds } from "../../sim/index.ts"
import type { ZoneId } from "../../sim/index.ts"
import { buildStrip } from "../arcs.ts"
import type { ArcShape, StrokeKit } from "../arcs.ts"
import { PAPER } from "../draw/pen.ts"
import { strokeGlowSvg } from "../draw/strips.ts"
import { AIM_LINE_SIZE, aimLineSvg, HEAVY_STROKE_SIZE, heavyStrokeSvg, inkRingSvg, pierceStreakSvg, RING_STROKE_SIZE, STREAK_SIZE } from "../draw/weapons.ts"
import type { Fx } from "../fx.ts"

/** The cleave's crescent: wider and fatter than the blade's cuts. */
export const CLEAVE_SHAPE: ArcShape = { span: (215 * Math.PI) / 180, thickness: 0.6, peak: 0.55, spiral: 0.14 }

/** A sigil's ring: one stroke round and a little past where it started, fullest just after the brush lands. */
const RING_SHAPE: ArcShape = { span: Math.PI * 2 + 0.4, thickness: 0.13, peak: 0.18, spiral: 0.05 }

export interface WeaponKit {
  /** The cleave's strokes in each zone's colours. */
  readonly cleave: Readonly<Record<ZoneId, StrokeKit>>
  /** The sigil's white ring strokes. */
  readonly ring: StrokeKit
  readonly streak: Texture
  readonly aim: Texture
  /** 印 brush-lettered in white, framed as a seal; tint it. */
  readonly seal: Texture
  readonly cleaveStrip: Geometry3D
  readonly ringStrip: Geometry3D
  /** Every texture above, for loading to hand to the GPU. */
  readonly all: ReadonlyArray<Texture>
  destroy(): void
}

const SEAL_FONT = '"Yuji Boku", "Hiragino Mincho ProN", "Yu Mincho", serif'
const FONT_WAIT = 2500

/**
 * 印 inside a rough square frame, white on clear, from the UI's brush face once it has loaded (or a system mincho
 * if it never does).
 */
const sealTexture = async (size: number): Promise<Texture> => {
  const font = `${Math.round(size * 0.62)}px ${SEAL_FONT}`
  await Promise.race([document.fonts.load(font, "印").catch(() => []), new Promise((resolve) => window.setTimeout(resolve, FONT_WAIT))])
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext("2d")
  if (context === null) return Texture.WHITE
  context.strokeStyle = "#fff"
  context.fillStyle = "#fff"
  context.lineJoin = "round"
  context.lineWidth = size * 0.06
  const inset = size * 0.1
  context.beginPath()
  context.moveTo(inset, inset + size * 0.01)
  context.lineTo(size - inset - size * 0.01, inset)
  context.lineTo(size - inset, size - inset - size * 0.015)
  context.lineTo(inset + size * 0.012, size - inset)
  context.closePath()
  context.stroke()
  context.font = font
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText("印", size / 2, size * 0.53)
  const texture = Texture.from(canvas)
  texture.label = "vfx-seal"
  texture.source.autoGenerateMipmaps = true
  texture.source.updateMipmaps()
  return texture
}

export const loadWeaponKit = async (noise: Texture): Promise<WeaponKit> => {
  const cleaveSources = Object.fromEntries(zoneIds.flatMap((zone) => [0, 1, 2].map((variant) =>
    [`${zone}${variant}`, [heavyStrokeSvg(1201 + variant * 13, paletteOf(zone)), { ...HEAVY_STROKE_SIZE, label: `vfx-cleave-${zone}${variant}` }] as const])))
  const glowSources = Object.fromEntries(zoneIds.map((zone) => [`glow-${zone}`, [strokeGlowSvg(hex(ZONE_PALETTES[zone].danger)), { width: 512, height: 64, label: `vfx-cleave-glow-${zone}` }] as const]))
  const [textures, seal] = await Promise.all([
    svgTextures({
      ...cleaveSources,
      ...glowSources,
      ring0: [inkRingSvg(1301), { ...RING_STROKE_SIZE, label: "vfx-ring0" }],
      ring1: [inkRingSvg(1307), { ...RING_STROKE_SIZE, label: "vfx-ring1" }],
      ringGlow: [strokeGlowSvg(PAPER), { width: 512, height: 64, label: "vfx-ring-glow" }],
      streak: [pierceStreakSvg(), { ...STREAK_SIZE, label: "vfx-pierce" }],
      aim: [aimLineSvg(), { ...AIM_LINE_SIZE, label: "vfx-aim" }]
    }),
    sealTexture(256)
  ])
  const named: Readonly<Record<string, Texture>> = textures
  const texture = (name: string): Texture => named[name] ?? Texture.WHITE
  const strokeKit = (zone: ZoneId): StrokeKit => ({
    strokes: [0, 1, 2].map((variant) => texture(`${zone}${variant}`)),
    strokeGlow: texture(`glow-${zone}`),
    noise
  })
  const cleave = { courtyard: strokeKit("courtyard"), spiral: strokeKit("spiral"), void: strokeKit("void") }
  const cleaveStrip = buildStrip(CLEAVE_SHAPE)
  const ringStrip = buildStrip(RING_SHAPE)
  return {
    cleave,
    ring: { strokes: [texture("ring0"), texture("ring1")], strokeGlow: texture("ringGlow"), noise },
    streak: texture("streak"),
    aim: texture("aim"),
    seal,
    cleaveStrip,
    ringStrip,
    all: [...Object.values(textures), seal],
    destroy: () => {
      for (const each of Object.values(textures)) each.destroy(true)
      seal.destroy(true)
      cleaveStrip.destroy()
      ringStrip.destroy()
    }
  }
}

/** The zone the run is in now, and its colours. */
export const paletteNow = (fx: Fx): ZonePalette => paletteOf(fx.context.game.view().zone)
