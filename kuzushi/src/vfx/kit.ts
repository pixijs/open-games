import { Rectangle, Texture } from "pixi.js"

import { svgTextures } from "../art/svg.ts"
import { hex, paletteOf } from "../art/palette.ts"
import type { EnemyKind, ZoneId } from "../sim/index.ts"
import { ATLAS_CELLS, ATLAS_SIZE, atlasSvg } from "./draw/atlas.ts"
import { focusLinesSvg, noiseSvg, SCREEN_SLASH_SIZE, screenSlashSvg, STROKE_SIZE, strokeGlowSvg, strokeSvg, telegraphLinePaleSvg, telegraphLineSvg, telegraphRingSvg, vignetteSvg } from "./draw/strips.ts"

/** A zone's telegraph drawings: the line, the line on a pale floor (solid accent edged in ink), and the ring. */
export interface TelegraphTextures {
  readonly line: Texture
  readonly linePale: Texture
  readonly ring: Texture
}

const telegraphTextures = async (): Promise<Readonly<Record<ZoneId, TelegraphTextures>>> => {
  const set = (zone: ZoneId): Promise<TelegraphTextures> => {
    const accent = hex(paletteOf(zone).danger)
    return svgTextures({
      line: [telegraphLineSvg(accent), { width: 512, height: 64, label: `vfx-telegraph-line-${zone}` }],
      linePale: [telegraphLinePaleSvg(accent), { width: 512, height: 64, label: `vfx-telegraph-line-pale-${zone}` }],
      ring: [telegraphRingSvg(accent), { width: 512, label: `vfx-telegraph-ring-${zone}`, mipmaps: true }]
    })
  }
  const [courtyard, spiral, voidSet] = await Promise.all([set("courtyard"), set("spiral"), set("void")])
  return { courtyard, spiral, void: voidSet }
}

/** Every texture the effects draw with, rasterised once at install from the SVG drawings in ./draw. */
export interface Kit {
  /** The atlas cut into one texture per cell, in cell order: what the particle layers take. */
  readonly frames: ReadonlyArray<Texture>
  /** The frame index of a named atlas cell. Throws on a name the atlas lacks, at install. */
  frame(name: string): number
  readonly strokes: ReadonlyArray<Texture>
  readonly strokeGlow: Texture
  readonly noise: Texture
  /** Telegraph lines and rings in each zone's danger accent. */
  readonly telegraphs: Readonly<Record<ZoneId, TelegraphTextures>>
  readonly focusLines: ReadonlyArray<Texture>
  readonly screenSlashes: ReadonlyArray<Texture>
  readonly vignette: Texture
  /** Every texture the kit rasterised, for loading to hand to the GPU. */
  readonly all: ReadonlyArray<Texture>
  destroy(): void
}

/** The one kit, while it lives. */
let shared: Promise<Kit> | null = null

const rasterise = async (): Promise<Kit> => {
  const textures = await svgTextures({
    atlas: [atlasSvg(), { width: ATLAS_SIZE, label: "vfx-atlas" }],
    stroke0: [strokeSvg(11), { ...STROKE_SIZE, label: "vfx-stroke0" }],
    stroke1: [strokeSvg(23), { ...STROKE_SIZE, label: "vfx-stroke1" }],
    stroke2: [strokeSvg(37), { ...STROKE_SIZE, label: "vfx-stroke2" }],
    strokeGlow: [strokeGlowSvg(), { width: 512, height: 64, label: "vfx-stroke-glow" }],
    noise: [noiseSvg(), { width: 256, repeat: true, label: "vfx-noise" }],
    focus0: [focusLinesSvg(5), { width: 1024, label: "vfx-focus0" }],
    focus1: [focusLinesSvg(17), { width: 1024, label: "vfx-focus1" }],
    focus2: [focusLinesSvg(29), { width: 1024, label: "vfx-focus2" }],
    slash0: [screenSlashSvg(3), { ...SCREEN_SLASH_SIZE, label: "vfx-slash0" }],
    slash1: [screenSlashSvg(8), { ...SCREEN_SLASH_SIZE, label: "vfx-slash1" }],
    vignette: [vignetteSvg(), { width: 256, label: "vfx-vignette" }]
  })
  const telegraphs = await telegraphTextures()
  const source = textures.atlas.source
  const frames = ATLAS_CELLS.map((cell) => new Texture({ source, frame: new Rectangle(cell.x, cell.y, cell.size, cell.size), label: cell.name }))
  const index = new Map(ATLAS_CELLS.map((cell, at) => [cell.name, at]))
  return {
    frames,
    frame: (name) => {
      const at = index.get(name)
      if (at === undefined) throw new Error(`vfx atlas has no cell "${name}"`)
      return at
    },
    strokes: [textures.stroke0, textures.stroke1, textures.stroke2],
    strokeGlow: textures.strokeGlow,
    noise: textures.noise,
    telegraphs,
    focusLines: [textures.focus0, textures.focus1, textures.focus2],
    screenSlashes: [textures.slash0, textures.slash1],
    vignette: textures.vignette,
    all: [...Object.values(textures), ...Object.values(telegraphs).flatMap((set) => Object.values(set))],
    destroy: () => {
      shared = null
      for (const frame of frames) frame.destroy(false)
      for (const texture of Object.values(textures)) texture.destroy(true)
      for (const set of Object.values(telegraphs)) for (const texture of Object.values(set)) texture.destroy(true)
    }
  }
}

/**
 * The kit, rasterised once however many times it is asked for: vfx owns it and destroys it on dispose; the title
 * borrows it and never destroys it.
 */
export const loadKit = (): Promise<Kit> => (shared ??= rasterise())

/** The atlas frames the effects use, looked up once by name. */
export const framesOf = (kit: Kit) => {
  const f = kit.frame
  const shape = (kind: EnemyKind | "player") => ({
    flash: kind === "player" ? f("ghostSolid") : f(`${kind}-flash`),
    halves: kind === "player" ? [f("ghostSolid"), f("ghostSolid")] : [f(`${kind}-half0`), f(`${kind}-half1`)],
    fragments: [0, 1, 2, 3].map((index) => f(`${kind}-frag${index}`))
  })
  return {
    burst: [f("burst0"), f("burst1"), f("burst2")],
    radial: f("radial"),
    xflash: [f("xflash0"), f("xflash1")],
    shock: [f("shock0"), f("shock1")],
    splats: [f("splat0"), f("splat1")],
    redSplats: [f("splat2"), f("splat3")],
    cracks: [f("crack0"), f("crack1")],
    lockon: f("lockon"),
    summon: f("summon"),
    halo: f("halo"),
    haloRing: f("haloRing"),
    flare: f("flare"),
    glint: f("glint"),
    cutline: f("cutline"),
    speedline: f("speedline"),
    chevron: f("chevron"),
    /** A white chevron and spark, tinted to a zone's accent. */
    chevronWhite: f("chevronWhite"),
    sparkWhite: f("sparkWhite"),
    dryRing: f("dryRing"),
    ghost: f("ghost"),
    spark: f("spark"),
    sparkRed: f("sparkRed"),
    droplet: f("droplet"),
    shard: f("shard"),
    ember: f("ember"),
    dotSquare: f("dotSquare"),
    dotTriangle: f("dotTriangle"),
    inkDrop: f("inkDrop"),
    pebble: f("pebble"),
    ringSmall: f("ringSmall"),
    speck: f("speck"),
    star: f("star"),
    /** The weapons' own drawings, all paper white: tint them. */
    weapon: {
      slamRing: f("slamRing"),
      brushRing: f("brushRing"),
      sealSquare: f("sealSquare"),
      chevron: f("chevronPaper"),
      muzzle: f("muzzle")
    },
    shapes: {
      chaser: shape("chaser"),
      shooter: shape("shooter"),
      bruiser: shape("bruiser"),
      trickster: shape("trickster"),
      orbiter: shape("orbiter"),
      warden: shape("warden"),
      lancer: shape("lancer"),
      splitter: shape("splitter"),
      splitling: shape("splitling"),
      sweeper: shape("sweeper"),
      pulsar: shape("pulsar"),
      leaper: shape("leaper"),
      cutter: shape("cutter"),
      gatekeeper: shape("gatekeeper"),
      orrery: shape("orrery"),
      sunder: shape("sunder"),
      player: shape("player")
    }
  }
}

export type Frames = ReturnType<typeof framesOf>
