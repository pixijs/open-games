import { PALETTE, paletteOf, rgbOf } from "../art/palette.ts"
import type { ZoneId } from "../sim/index.ts"

/**
 * How the grade paints a zone (docs/DESIGN.md, Palettes). The world is drawn in the Courtyard's greys; the grade maps
 * each grey to the zone's tone at the same place on the scale, so a surface that reads as the Courtyard's floor reads
 * as the zone's floor: ink, ground dark, ground, ground light, the light, paper. The Courtyard's own map is the plain
 * ink-to-paper ramp the title and the classic stages use. Outside the Courtyard the grade also repaints the Courtyard's
 * red, wherever an effect still uses it, as the zone's accent.
 */

/** Where each tone sits between ink (0) and paper (1): the Courtyard's ground values' places on its own ramp. */
export const TONE_STOPS = [0, 0.178, 0.298, 0.467, 0.8, 1] as const

type Rgb = readonly [number, number, number]

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

const INK = rgbOf(PALETTE.ink)
const PAPER = rgbOf(PALETTE.paper)
const RED = rgbOf(PALETTE.red)

/** The six tones of a zone's ramp, at `TONE_STOPS`, as sRGB 0 to 1. */
export const tonesOf = (zone: ZoneId): ReadonlyArray<Rgb> => {
  if (zone === "courtyard") return TONE_STOPS.map((stop) => mix(INK, PAPER, stop))
  const colors = paletteOf(zone)
  return [colors.ink, colors.groundDark, colors.ground, colors.groundLight, colors.light, colors.paper].map(rgbOf)
}

const LUMA: Rgb = [0.2126, 0.7152, 0.0722]
const dot = (a: Rgb, b: Rgb) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Rgb, b: Rgb): Rgb => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k]
const length = (a: Rgb) => Math.sqrt(dot(a, a))
const cross = (a: Rgb, b: Rgb): Rgb => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const chroma = (color: Rgb): Rgb => sub(color, [dot(color, LUMA), dot(color, LUMA), dot(color, LUMA)])

/**
 * Turning the Courtyard's red into `accent`: in the plane of colour round the grey axis, red's direction (`u`) and the
 * one across it (`v`), the turn and stretch that take red's colour to the accent's, and the lift in lightness a full
 * red takes. A pixel k parts red becomes k parts accent; its white or grey part stays.
 */
export interface Repaint {
  readonly u: Rgb
  readonly v: Rgb
  readonly cos: number
  readonly sin: number
  readonly stretch: number
  readonly lift: number
  /** How much colour a full red has, to measure how red a pixel is. */
  readonly reach: number
}

export const repaintOf = (accent: number): Repaint => {
  const red = chroma(RED)
  const target = chroma(rgbOf(accent))
  const u = scale(red, 1 / length(red))
  const normal = scale(LUMA, 1 / length(LUMA))
  const v = cross(normal, u)
  const turn = Math.atan2(dot(target, v), dot(target, u))
  return { u, v, cos: Math.cos(turn), sin: Math.sin(turn), stretch: length(target) / length(red), lift: dot(rgbOf(accent), LUMA) - dot(RED, LUMA), reach: length(red) }
}

/** The hue of an sRGB colour, in turns from red. */
export const hueOf = (color: number): number => {
  const [r, g, b] = rgbOf(color)
  const hi = Math.max(r, g, b)
  const span = hi - Math.min(r, g, b)
  if (span === 0) return 0
  const sixths = hi === r ? (g - b) / span : hi === g ? (b - r) / span + 2 : (r - g) / span + 4
  return (((sixths / 6) % 1) + 1) % 1
}

export const RED_HUE = hueOf(PALETTE.red)
