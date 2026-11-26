import { BitmapFontManager, BitmapText, CanvasTextMetrics, TextStyle } from "pixi.js"

import { FAMILY, lineBaseline, shadowOf } from "./type.ts"
import type { Face } from "./type.ts"

const CHARS = "0123456789:./ "
const DIGITS = "0123456789"

interface Font {
  readonly face: Face
  /** The resolution it was installed at; 0 before its first install. */
  resolution: number
  /** Whether its web font had loaded when it was installed: it is installed again once it has. */
  loaded: boolean
}

/** Every face asked for, by font name. */
const fonts = new Map<string, Font>()
const texts = new Set<BitmapText>()
const facesOf = new WeakMap<BitmapText, Face>()
let resolution = 1

const nameOf = (face: Face) => [
  "digits", face.family, face.weight ?? "400", face.italic === true ? "italic" : "normal", face.size,
  ...(face.shadow === undefined ? [] : [face.shadow.color, face.shadow.alpha, face.shadow.blur, face.shadow.distance ?? 0])
].join("-")

const cssFont = (face: Face) => `${face.italic === true ? "italic " : ""}${face.weight ?? "400"} ${face.size}px ${FAMILY[face.family]}`

/** A figure's advance in `face` in tabular figures, as the page lays it out; canvas text can't ask for them. */
const tabularOf = (face: Face) => {
  const probe = document.createElement("span")
  probe.style.cssText = `position: absolute; visibility: hidden; white-space: pre; font: ${cssFont(face)}; font-variant-numeric: tabular-nums`
  probe.textContent = "0"
  document.body.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width
}

/** Installs `font` at the current resolution with every digit advancing as the font's tabular figures (or the widest), centred in it. */
const install = (name: string, font: Font) => {
  if (font.resolution > 0) BitmapFontManager.uninstall(name)
  const { face } = font
  const installed = BitmapFontManager.install({
    name,
    style: new TextStyle({
      fontFamily: FAMILY[face.family],
      fontWeight: face.weight ?? "400",
      fontStyle: face.italic === true ? "italic" : "normal",
      fontSize: face.size,
      fill: 0xffffff,
      ...(face.shadow === undefined ? {} : { dropShadow: shadowOf(face.shadow) })
    }),
    chars: CHARS,
    resolution,
    skipKerning: true,
    padding: 4 + Math.ceil(2 * (face.shadow?.blur ?? 0))
  })
  const tabular = (tabularOf(face) * installed.baseMeasurementFontSize) / face.size
  const across = tabular > 0 ? tabular : Math.max(...Array.from(DIGITS, (char) => installed.chars[char]?.xAdvance ?? 0))
  for (const char of DIGITS) {
    const data = installed.chars[char]
    if (data === undefined) continue
    data.xOffset += (across - data.xAdvance) / 2
    data.xAdvance = across
  }
  font.resolution = resolution
  font.loaded = document.fonts.check(cssFont(face))
}

/**
 * Figures that change often (the run timer, results counters, FPS): a BitmapText in `face`'s BitmapFont, so no canvas
 * text re-rasterises as they change, with every digit advancing as a tabular figure and centred in it
 * (Barlow Condensed's digits are proportional, 1 is 7.5px against 0's 13.3px at 30px; its tabular figures are 12.5px). `face.size` is the
 * largest it is drawn at; set `style.fontSize` (and `letterSpacing`) to draw it smaller. Colour it with `tint`.
 */
export const digits = (face: Face, tint = 0xffffff): BitmapText => {
  const name = nameOf(face)
  let font = fonts.get(name)
  if (font === undefined) {
    font = { face, resolution: 0, loaded: false }
    fonts.set(name, font)
    install(name, font)
  }
  const text = new BitmapText({
    text: "",
    style: { fontFamily: name, fontSize: face.size, letterSpacing: (face.tracking ?? 0) * face.size },
    roundPixels: true
  })
  text.tint = tint
  texts.add(text)
  facesOf.set(text, face)
  text.once("destroyed", () => texts.delete(text))
  return text
}

/**
 * Installs every digits font again at `resolution` when it changed, and any whose web font has loaded since, then
 * relayouts their texts. Call it on every layout; it does nothing when neither changed.
 */
export const refreshDigits = (next: number): void => {
  resolution = next
  let changed = false
  for (const [name, font] of fonts) {
    if (font.resolution === next && (font.loaded || !document.fonts.check(cssFont(font.face)))) continue
    install(name, font)
    changed = true
  }
  if (!changed) return
  BitmapFontManager.measureCache.clear()
  for (const text of texts) text.style.update()
}

/**
 * Puts a digits text's left at `x` with its baseline where CSS sets figures in a line box `lineHeight` px
 * tall at `top` (line-height normal without one), at the size it is drawn. A glyph sits its font's ascent below its
 * top, and its shadow's distance more: the font measures each glyph with its shadow.
 */
export const placeDigits = (text: BitmapText, x: number, top: number, lineHeight?: number): void => {
  const face = facesOf.get(text)
  if (face === undefined) return
  const size = Number(text.style.fontSize)
  const scale = size / face.size
  const ascent = CanvasTextMetrics.measureFont(cssFont(face)).ascent + (face.shadow?.distance ?? 0)
  const line = lineBaseline(new TextStyle({ fontFamily: FAMILY[face.family], fontWeight: face.weight ?? "400", fontStyle: face.italic === true ? "italic" : "normal", fontSize: size }), lineHeight)
  text.position.set(Math.round(x), Math.round(top + line - ascent * scale))
}
