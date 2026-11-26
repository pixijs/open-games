import { homeOf } from "../sim/index.ts"
import type { EnemyKind, ZoneId } from "../sim/index.ts"

/**
 * The Courtyard's colours, which are also the title's and the menus' (docs/DESIGN.md, Look). Play in the other zones
 * takes its colours from `paletteOf(zone)`.
 */
export const PALETTE = {
  ink: 0x0d0d0f,
  concrete900: 0x2b2b2f,
  concrete800: 0x35353a,
  concrete700: 0x414146,
  concrete600: 0x505056,
  concrete500: 0x616167,
  concrete400: 0x76767c,
  concrete300: 0x8c8c92,
  paper: 0xf2efe8,
  red: 0xff2e3f,
  redDeep: 0xb3121f
} as const

export type PaletteName = keyof typeof PALETTE

/**
 * One zone's colours. A frame of play holds these and nothing else: ink, three ground values, the light, the hero's
 * paper white, and one accent for danger (enemies, their telegraphs and orbs, the edges of the hero's effects, the
 * HUD's accent).
 */
export interface ZonePalette {
  readonly ink: number
  /** The floor's three values: shadowed and worn ground, the main floor, lit edges and inlays. */
  readonly groundDark: number
  readonly ground: number
  readonly groundLight: number
  /** The key light's colour. */
  readonly light: number
  /** The danger accent at full glow: enemy glow and rims, telegraph lines, orbs, the HUD's accent. */
  readonly danger: number
  /** The danger accent's deep tone: enemy sides, cores of orbs on pale floors, dark accents. */
  readonly dangerDeep: number
  /** The hero, in every zone. */
  readonly paper: number
}

export const ZONE_PALETTES = {
  courtyard: {
    ink: PALETTE.ink,
    groundDark: PALETTE.concrete800,
    ground: PALETTE.concrete600,
    groundLight: PALETTE.concrete400,
    light: PALETTE.paper,
    danger: PALETTE.red,
    dangerDeep: PALETTE.redDeep,
    paper: PALETTE.paper
  },
  spiral: {
    ink: 0x091017,
    groundDark: 0x182630,
    ground: 0x2a404b,
    groundLight: 0x46626c,
    light: 0xb8cfe0,
    danger: 0xffad1f,
    dangerDeep: 0xa65f00,
    paper: PALETTE.paper
  },
  void: {
    ink: 0x08070c,
    groundDark: 0x44465a,
    ground: 0x686b84,
    groundLight: 0x8487a0,
    light: 0xd9d2ff,
    danger: 0xa646ff,
    dangerDeep: 0x5a17b8,
    paper: PALETTE.paper
  }
} as const satisfies Record<ZoneId, ZonePalette>

export const paletteOf = (zone: ZoneId): ZonePalette => ZONE_PALETTES[zone]

/** A colour as a CSS hex string, for SVG and DOM. */
export const hex = (value: number): string => `#${value.toString(16).padStart(6, "0")}`

/** A colour's sRGB channels, 0 to 1. */
export const rgbOf = (color: number): readonly [number, number, number] =>
  [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255]

/** A Courtyard palette colour as a CSS hex string. */
export const css = (name: PaletteName): string => hex(PALETTE[name])

/** The palette of the zone a kind belongs to: its body, glow and telegraphs take that zone's danger accent. */
export const paletteOfKind = (kind: EnemyKind): ZonePalette => paletteOf(homeOf(kind))
