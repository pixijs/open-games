import { gsap } from "gsap"
import { CanvasTextMetrics, fontStringFromTextStyle, Text, TextStyle } from "pixi.js"
import type { FillInput, TextDropShadow } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { drawn, ON_TWOS } from "../motion.ts"

/** The UI's three faces, loaded by index.html; installUi waits for them before any text is drawn. */
export const FAMILY = {
  condensed: '"Barlow Condensed", "Arial Narrow", sans-serif',
  text: '"Barlow", "Helvetica Neue", Arial, sans-serif',
  jp: '"Yuji Boku", "Hiragino Mincho ProN", "Yu Mincho", serif'
} as const

export type Role = "title" | "name" | "label" | "small" | "key" | "digits" | "body" | "kanji"

export interface Face {
  readonly family: keyof typeof FAMILY
  readonly weight?: "300" | "400" | "500" | "600" | "700"
  readonly italic?: boolean
  /** CSS pixels, as given (10.5 and 12.5 too); `resize` rounds. */
  readonly size: number
  /** Letter spacing in em. */
  readonly tracking?: number
  /** An outline face: a stroke this wide and no fill. */
  readonly stroke?: number
  /**
   * A shadow straight down, or a glow at distance 0, px, such as the HUD's `0 1px 2px` ink .9 (`INK_SHADOW`). A glow
   * coloured unlike the text needs the text coloured through the style's fill, not `Text.tint`.
   */
  readonly shadow?: Shadow
}

export interface Shadow {
  readonly color: number
  readonly alpha: number
  readonly blur: number
  readonly distance?: number
}

/** A `0 1px 2px` ink text shadow at .9, under the HUD's and the boss bar's words. */
export const INK_SHADOW: Shadow = { color: PALETTE.ink, alpha: 0.9, blur: 2, distance: 1 }

/** A face's shadow as a TextStyle's drop shadow. */
export const shadowOf = (shadow: Shadow): TextDropShadow => ({
  color: shadow.color,
  alpha: shadow.alpha,
  blur: shadow.blur,
  distance: shadow.distance ?? 0,
  angle: Math.PI / 2
})

/** Barlow Condensed's cap height, in em: where a cap's top sits above its baseline. */
export const CAP_HEIGHT = 0.7

/** Every style made here, re-rasterised by `refreshFonts`. */
const styles = new Set<TextStyle>()
/** `wrapped` clones and the role each follows through `scaleType`. */
const clones = new Map<TextStyle, Role>()
let scale = 1
/** Each font's ascent and descent as CSS lays out a line with it, by font string. */
const lineBoxes = new Map<string, { readonly ascent: number; readonly descent: number }>()
let measurer: CanvasRenderingContext2D | null = null

/**
 * How far an italic glyph leans past its advance, in em. Canvas text rasterises only the measured box, so an italic
 * face's texture is padded by this much or its last letter's top-right is sliced off; its measured width is unchanged.
 */
const ITALIC_LEAN = 0.15

/**
 * A style's texture padding: an italic face's lean, and as far as its drop shadow reaches, or the canvas cuts the
 * shadow off at the texture's edge. Set it again after changing the shadow.
 */
export const paddingOf = (style: TextStyle): number => {
  const lean = style.fontStyle === "italic" ? Math.ceil(ITALIC_LEAN * Number(style.fontSize)) : 0
  const shadow: TextDropShadow | null = style.dropShadow
  return lean + (shadow === null ? 0 : Math.ceil(shadow.blur + shadow.distance))
}

/** Sets a style's size, rounded, and its letter spacing; leaves it alone (and its texts unrasterised) when neither changes. */
export const resize = (style: TextStyle, size: number, tracking: number): void => {
  const px = Math.round(size)
  const spacing = px * tracking
  if (style.fontSize === px && style.letterSpacing === spacing) return
  style.fontSize = px
  style.letterSpacing = spacing
  style.padding = paddingOf(style)
}

/** A registered white style for display type an owner sizes itself with `resize`; colour comes from `Text.tint`. */
export const face = (spec: Face): TextStyle => {
  const style = new TextStyle({
    fontFamily: FAMILY[spec.family],
    fontWeight: spec.weight ?? "400",
    fontStyle: spec.italic === true ? "italic" : "normal",
    fontSize: spec.size,
    letterSpacing: spec.size * (spec.tracking ?? 0),
    fill: spec.stroke === undefined ? 0xffffff : { color: 0xffffff, alpha: 0 },
    ...(spec.stroke === undefined ? {} : { stroke: { color: 0xffffff, width: spec.stroke, join: "round" as const } }),
    ...(spec.shadow === undefined ? {} : { dropShadow: shadowOf(spec.shadow) })
  })
  style.padding = paddingOf(style)
  styles.add(style)
  return style
}

/** Unregisters and destroys a style from `face`, once nothing draws with it. */
export const release = (style: TextStyle): void => {
  styles.delete(style)
  clones.delete(style)
  style.destroy()
}

/** The faces one screen owns: each made with `style`, all released together once nothing draws with them. */
export interface OwnedFaces {
  /** A `face` of `spec`, filled `fill` when given: a glow coloured unlike its text needs the text coloured here. */
  style(spec: Face, fill?: FillInput): TextStyle
  release(): void
}

export const ownedFaces = (): OwnedFaces => {
  const made: Array<TextStyle> = []
  return {
    style: (spec, fill) => {
      const style = face(spec)
      if (fill !== undefined) style.fill = fill
      made.push(style)
      return style
    },
    release: () => {
      for (const each of made) release(each)
    }
  }
}

/**
 * A text in `style`, tinted `tint`. Destroy it with `destroy()`, never `destroy(true)`, which would take a shared
 * style with it.
 */
export const textIn = (content: string, style: TextStyle, tint: number = 0xffffff): Text => {
  const node = new Text({ text: content, style, roundPixels: true })
  node.tint = tint
  return node
}

interface RoleFace extends Face {
  /** The smallest it shrinks to, in px, so hints stay legible at 1280x720. */
  readonly floor: number
}

const role = (spec: RoleFace) => ({ spec, style: face(spec) })

/** The type roles at scale 1; Barlow Condensed unless noted. */
const ROLES: Readonly<Record<Role, { readonly spec: RoleFace; readonly style: TextStyle }>> = {
  /** Sheet titles. */
  title: role({ family: "condensed", weight: "700", italic: true, size: 40, floor: 28, tracking: 0.08 }),
  /** Control names, settings labels. */
  name: role({ family: "condensed", weight: "600", size: 20, floor: 16, tracking: 0.3 }),
  /** Zone and boss names, choice chips, BACK. */
  label: role({ family: "condensed", weight: "500", size: 14, floor: 13, tracking: 0.28 }),
  /** Hints, ZONE n, BEST/RUN/BOSS keys, hazards, LOCKED, a sheet's number. */
  small: role({ family: "condensed", weight: "600", size: 12, floor: 11, tracking: 0.26 }),
  /** Keycap letters. */
  key: role({ family: "condensed", weight: "600", size: 12, floor: 11, tracking: 0.12 }),
  /** Times, percent, rank. */
  digits: role({ family: "condensed", weight: "500", size: 14, floor: 13, tracking: 0.06 }),
  /** Notes and details, in Barlow. */
  body: role({ family: "text", weight: "400", size: 14, floor: 13, tracking: 0.02 }),
  /** Zone, boss and sheet kanji, in Yuji Boku. */
  kanji: role({ family: "jp", size: 18, floor: 16 })
}

const fit = (style: TextStyle, spec: RoleFace) => resize(style, Math.max(spec.floor, spec.size * scale), spec.tracking ?? 0)

/**
 * A text in `role`'s shared style, tinted `tint` (paper by default). Content is drawn as given: the condensed roles
 * are caps, so pass them upper case. Destroy it with `destroy()`, never `destroy(true)`, which would take the shared
 * style with it.
 */
export const text = (content: string, role: Role, tint: number = PALETTE.paper): Text => textIn(content, ROLES[role].style, tint)

/** A text in its own copy of `role`'s style that wraps at `width`; set `style.wordWrapWidth` to reflow it. */
export const wrapped = (content: string, role: Role, width: number, tint: number = PALETTE.paper): Text => {
  const style = ROLES[role].style.clone()
  style.wordWrap = true
  style.wordWrapWidth = width
  styles.add(style)
  clones.set(style, role)
  const node = textIn(content, style, tint)
  node.once("destroyed", () => release(style))
  return node
}

/** Sizes every role for the viewport's type scale. */
export const scaleType = (next: number): void => {
  scale = next
  for (const { spec, style } of Object.values(ROLES)) fit(style, spec)
  for (const [style, follows] of clones) fit(style, ROLES[follows].spec)
}

/** Re-measures and re-rasterises every text, once web fonts that arrived late have loaded. */
export const refreshFonts = (): void => {
  CanvasTextMetrics.clearMetrics()
  lineBoxes.clear()
  for (const style of styles) style.update()
}

/**
 * Tweens a style's letter spacing from `fromEm` to `toEm`, held on twos so a .5 s tracking-in rasterises its texts
 * about six times rather than every frame. The spacing follows the style's size as it tweens. `vars` takes the
 * tween's duration, ease (a name), delay and the rest; the spacing is set as GSAP renders, so it holds and steps
 * inside a paused timeline scrubbed by `progress`. Every text on the style tracks with it: give the tracked text a
 * `face` of its own, never a shared role.
 */
export const tracked = (style: TextStyle, fromEm: number, toEm: number, vars: gsap.TweenVars & { readonly duration: number; readonly ease?: string }): gsap.core.Tween => {
  const proxy = {
    get em() {
      return style.letterSpacing / Math.max(1, Number(style.fontSize))
    },
    set em(value: number) {
      const spacing = value * Number(style.fontSize)
      if (style.letterSpacing !== spacing) style.letterSpacing = spacing
    }
  }
  return gsap.fromTo(proxy, { em: fromEm }, { ...vars, em: toEm, ease: drawn(vars.duration, vars.ease ?? "none", ON_TWOS) })
}

/** How far below a text's top its baseline sits, for a face without a stroke. */
export const baselineOf = (style: TextStyle): number => CanvasTextMetrics.measureFont(fontStringFromTextStyle(style)).ascent

/** `style`'s font's ascent and descent as CSS lays out a line with it. */
const lineBox = (style: TextStyle) => {
  const font = fontStringFromTextStyle(style)
  const known = lineBoxes.get(font)
  if (known !== undefined) return known
  measurer ??= document.createElement("canvas").getContext("2d")
  if (measurer === null) return { ascent: baselineOf(style), descent: 0 }
  measurer.font = font
  const metrics = measurer.measureText("M")
  const box = { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent }
  lineBoxes.set(font, box)
  return box
}

/**
 * How far below the top of a CSS line box its text's baseline sits: a box `lineHeight` px tall (CSS line-height 1 is
 * the font size) with the font's own ascent and descent centred in it, the leading above floored to a whole pixel as
 * Chrome lays it out, or with line-height normal just the ascent. A Text at
 * `top + lineBaseline(style, height) - baselineOf(style)` sits where CSS would set it.
 */
export const lineBaseline = (style: TextStyle, lineHeight?: number): number => {
  const { ascent, descent } = lineBox(style)
  return lineHeight === undefined ? ascent : Math.floor((lineHeight - ascent - descent) / 2) + ascent
}

/** The height of a CSS line of `style` with line-height normal. */
export const lineHeightOf = (style: TextStyle): number => {
  const { ascent, descent } = lineBox(style)
  return ascent + descent
}

/**
 * Puts `text`'s left at `x` and its baseline where CSS sets it in a line box at `top` (see `lineBaseline`). A style
 * with a `lineHeight` of its own sets its lines in boxes that tall (the line box, unless `lineHeight` is given), and
 * Pixi centres each line's glyphs in them: its first baseline lands where CSS would set it.
 */
export const placeInLine = (text: Text, x: number, top: number, lineHeight?: number): void => {
  const own = text.style.lineHeight
  const shift = own > 0 ? Math.max(0, own - CanvasTextMetrics.measureFont(fontStringFromTextStyle(text.style)).fontSize) / 2 : 0
  text.position.set(Math.round(x), Math.round(top + lineBaseline(text.style, lineHeight ?? (own > 0 ? own : undefined)) - baselineOf(text.style) - shift))
}

/** Puts texts in a row on one baseline under `top`, as a baseline-aligned CSS row sets them (line-height normal); returns the row's height. */
export const onBaseline = (top: number, texts: ReadonlyArray<Text>): number => {
  const above = Math.max(...texts.map((each) => lineBaseline(each.style)))
  const below = Math.max(...texts.map((each) => lineHeightOf(each.style) - lineBaseline(each.style)))
  for (const each of texts) each.y = Math.round(top + above - baselineOf(each.style))
  return above + below
}

/**
 * How wide `text`'s CSS inline box is: its glyphs' advances and every letter's spacing, the last one's too. A Text's
 * own width leaves the last spacing out, adds its shadow's distance, and takes an italic glyph's ink where it reaches
 * past the advance.
 */
export const inlineWidth = (text: Text): number => {
  measurer ??= document.createElement("canvas").getContext("2d")
  if (measurer === null) return text.width
  measurer.font = fontStringFromTextStyle(text.style)
  return measurer.measureText(text.text).width + Array.from(text.text).length * text.style.letterSpacing
}
