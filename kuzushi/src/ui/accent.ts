import { paletteOf } from "../art/palette.ts"
import type { ZoneId } from "../sim/index.ts"

/**
 * The UI's accent per zone: the zone's danger colour for marks, rules, glows and brackets, its deep tone, and the
 * fill that paper text sits on (menu bars, the rank seal). The Spiral's amber is too light for paper text, so its
 * fill is a darker amber; the red and the violet carry paper as they are.
 */
const FILL: Readonly<Record<ZoneId, number>> = {
  courtyard: paletteOf("courtyard").danger,
  spiral: 0xb86a00,
  void: paletteOf("void").danger
}

/** A zone's accent for Pixi screens: `accent` for marks, rules, glows and brackets, `deep` its dark tone, `fill` what paper text sits on. */
export interface Accent {
  readonly accent: number
  readonly deep: number
  readonly fill: number
}

export const accentOf = (zone: ZoneId): Accent => {
  const palette = paletteOf(zone)
  return { accent: palette.danger, deep: palette.dangerDeep, fill: FILL[zone] }
}

/** `accent` drained to grey, as the scene drains under pause: each colour's luminance. */
export const greyOf = (accent: Accent): Accent => {
  const grey = (value: number) => {
    const luma = Math.round(0.2126 * ((value >> 16) & 0xff) + 0.7152 * ((value >> 8) & 0xff) + 0.0722 * (value & 0xff))
    return (luma << 16) | (luma << 8) | luma
  }
  return { accent: grey(accent.accent), deep: grey(accent.deep), fill: grey(accent.fill) }
}
