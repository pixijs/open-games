import type { Texture } from "pixi.js"

import { svgTexture, svgTextures } from "../art/svg.ts"
import type { SvgEntry } from "../art/svg.ts"
import { paletteOf } from "../art/palette.ts"
import { enemyKinds } from "../sim/index.ts"
import type { EnemyKind, ZoneId } from "../sim/index.ts"
import { arrowheadOutline } from "./geometry.ts"
import { DASH_KEYS, PLAYER_SIZE, SHAPES } from "./shapes.ts"
import { CONCRETE_SIZE, concreteSvg } from "./concrete.ts"
import { FLOOR, floorSvg } from "./floor.ts"
import { SPIRAL_FLOOR, spiralFloorSvg } from "./spiral-floor.ts"
import { CRACK_PIXELS, SLABS, slabCrackSvg, VOID_FLOOR, voidFloorSvg } from "./void-floor.ts"
import { enemyGlyphSvg, fleckSvg, glowSvg, orbPaleSvg, orbSvg, playerGlyphSvg, shadowSvg, streakSvg } from "./glyphs.ts"

type Named = "floor" | "spiralFloor" | "voidFloor" | "concrete" | "shadow" | "glow" | "orb" | "streak" | "fleck" | "player" | EnemyKind

export type LookTextures = Readonly<Record<Named, Texture>> & {
  /** Each Void slab's red seams, by slab index. */
  readonly slabCracks: ReadonlyArray<Texture>
  /** Each zone's enemy shot, over a dark floor and over a pale one, in its danger accent. */
  readonly zoneOrbs: Readonly<Record<ZoneId, { readonly orb: Texture; readonly pale: Texture }>>
  /** The player's top art for each of its dash drawings (DASH_KEYS); the first is `player`. */
  readonly playerKeys: ReadonlyArray<Texture>
  /** Releases every texture. */
  destroy(): void
}

const GLYPH = { width: 256, mipmaps: true } as const

/** A zone's enemy shot in its danger accent, over a dark floor and over a pale one. */
const zoneOrbs = (zone: ZoneId) => {
  const { danger, dangerDeep } = paletteOf(zone)
  return svgTextures({
    orb: [orbSvg(danger, dangerDeep), { width: 128, label: `orb-${zone}` }],
    pale: [orbPaleSvg(danger, dangerDeep), { width: 128, label: `orb-pale-${zone}` }]
  })
}

/** Rasterises every SVG the look draws with, once, at install. */
export const loadTextures = async (): Promise<LookTextures> => {
  const glyphs = Object.fromEntries(enemyKinds.map((kind): [EnemyKind, SvgEntry] => {
    return [kind, [enemyGlyphSvg(kind, SHAPES[kind]), { ...GLYPH, label: kind }]]
  })) as Record<EnemyKind, SvgEntry>
  const cracks = Promise.all(SLABS.map((slab, index) => svgTexture(slabCrackSvg(index), { width: Math.round(slab.halfWidth * 2 * CRACK_PIXELS), label: `slab-crack${index}` })))
  const dash = Promise.all(DASH_KEYS.slice(1).map((notch, index) =>
    svgTexture(playerGlyphSvg(arrowheadOutline(PLAYER_SIZE, notch), SHAPES.player.extent), { ...GLYPH, label: `player-dash${index + 1}` })))
  const orbs = Promise.all([zoneOrbs("courtyard"), zoneOrbs("spiral"), zoneOrbs("void")])
  const named = await svgTextures({
    ...glyphs,
    floor: [floorSvg(), { width: FLOOR.width * FLOOR.pixelsPerUnit, mipmaps: true, label: "floor" }],
    spiralFloor: [spiralFloorSvg(), { width: SPIRAL_FLOOR.pixels, mipmaps: true, label: "spiral-floor" }],
    voidFloor: [voidFloorSvg(), { width: VOID_FLOOR.width * VOID_FLOOR.pixelsPerUnit, mipmaps: true, label: "void-floor" }],
    concrete: [concreteSvg(), { width: CONCRETE_SIZE, repeat: true, mipmaps: true, label: "concrete" }],
    shadow: [shadowSvg(), { width: 128, label: "shadow" }],
    glow: [glowSvg(), { width: 128, label: "glow" }],
    orb: [orbSvg(), { width: 128, label: "orb" }],
    streak: [streakSvg(), { width: 256, height: 64, label: "streak" }],
    fleck: [fleckSvg(), { width: 32, label: "fleck" }],
    player: [playerGlyphSvg(SHAPES.player.outline, SHAPES.player.extent), { ...GLYPH, label: "player" }]
  })
  const slabCracks = await cracks
  const [courtyard, spiral, voidOrbs] = await orbs
  const dashGlyphs = await dash
  return {
    ...named,
    slabCracks,
    zoneOrbs: { courtyard, spiral, void: voidOrbs },
    playerKeys: [named.player, ...dashGlyphs],
    destroy: () => {
      for (const texture of [...Object.values(named), ...slabCracks, ...dashGlyphs, ...[courtyard, spiral, voidOrbs].flatMap(({ orb, pale }) => [orb, pale])]) texture.destroy(true)
    }
  }
}
