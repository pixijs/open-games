import { clamp } from "math"
import { Container, Graphics, Rectangle, SmoothGraphics } from "pixi.js"
import type { Text } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { shapeMarkup } from "../icons.ts"
import { iconContext } from "../kit/icon.ts"
import { fixedKeyBaseline, keycap } from "../kit/keycap.ts"
import type { PanelBody } from "../kit/sheet.ts"
import { baselineOf, CAP_HEIGHT, face, inlineWidth, lineHeightOf, placeInLine, release, resize, text, textIn } from "../kit/type.ts"
import { BINDINGS, MOVES } from "../moves.ts"

/** Between rows, a name and its note, and keycaps, px. */
const GAP = 14
const NOTE_GAP = 4
const KEY_GAP = 4
/** The rule and its room above the bindings strip, px. */
const STRIP_GAP = 16
/** A row's height bounds, px: the rows spread over the sheet between them. */
const MIN_ROW = 56
const MIN_NARROW_ROW = 48
const MAX_ROW = 140

/** Keycaps side by side, as one node: the type scale's, or a fixed 12 px. */
const keys = (names: ReadonlyArray<string>, fixed = false) => {
  const node = new Container()
  for (const name of names) node.addChild(keycap(name, { fixed }))
  return node
}

/** Lays out keycaps again once the type scale has refit them; returns their run's width. */
const respace = (node: Container, gap = KEY_GAP) => {
  let x = 0
  for (const cap of node.children) {
    cap.x = x
    x += Math.round(cap.width) + gap
  }
  return Math.max(0, x - gap)
}

interface Row {
  readonly node: Container
  readonly icon: SmoothGraphics
  readonly name: Text
  readonly note: Text
  readonly keys: Container
}

/** The compact look's sizes, px: the icon, the gap after it, a row's name line, the gap to its note, the gaps between rows (narrow: 8), keycaps and the bindings strip. */
const COMPACT = { icon: 22, iconGap: 16, line: 20, name: 15, noteGap: 3, rowGap: 14, narrowGap: 8, keyGap: 6, stripGap: 16, stripPad: 12, wordGap: 4, entryGap: 24, lineGap: 8, keyHeight: 19 } as const

/**
 * The controls as pause's side panel shows them, at fixed sizes: each move's 22 px icon beside its name with its keys
 * at the right end and its note under it, then the bindings strip under a rule. A narrow screen drops the notes and
 * the strip.
 */
const createCompactControls = (): PanelBody => {
  const node = new Container({ label: "controls" })
  const nameStyle = face({ family: "condensed", weight: "500", size: 15, tracking: 0.36 })
  const noteStyle = face({ family: "text", weight: "400", size: 12.5, tracking: 0.02 })
  noteStyle.wordWrap = true
  const wordStyle = face({ family: "condensed", weight: "500", size: 10.5, tracking: 0.22 })
  const rows: ReadonlyArray<Row> = MOVES.map((move) => {
    const row = new Container({ label: `control ${move.name}` })
    const icon = new SmoothGraphics(iconContext(shapeMarkup(move.shape), "outline"))
    icon.tint = PALETTE.paper
    icon.scale.set(COMPACT.icon / 24)
    const name = textIn(move.name.toUpperCase(), nameStyle, PALETTE.paper)
    const note = textIn(move.note, noteStyle, PALETTE.concrete300)
    const caps = keys(move.keys, true)
    row.addChild(icon, name, note, caps)
    node.addChild(row)
    return { node: row, icon, name, note, keys: caps }
  })
  const rule = new Graphics()
  const strip = new Container({ label: "bindings" })
  const bindings = BINDINGS.map(([name, names]) => {
    const entry = new Container()
    const word = textIn(`${name.toUpperCase()} `, wordStyle, PALETTE.concrete300)
    const caps = keys(names, true)
    entry.addChild(word, caps)
    strip.addChild(entry)
    return { entry, word, caps }
  })
  node.addChild(rule, strip)
  node.once("destroyed", () => {
    for (const style of [nameStyle, noteStyle, wordStyle]) release(style)
  })

  /** Sets the bindings in lines across `width`, wrapping; returns the strip's height. */
  const arrangeStrip = (width: number) => {
    let x = 0
    let y = 0
    for (const { entry, word, caps } of bindings) {
      word.y = Math.round(fixedKeyBaseline() - baselineOf(wordStyle))
      caps.x = Math.round(inlineWidth(word) + COMPACT.wordGap)
      const entryWidth = caps.x + respace(caps, COMPACT.wordGap)
      if (x > 0 && x + entryWidth > width) {
        x = 0
        y += COMPACT.keyHeight + COMPACT.lineGap
      }
      entry.position.set(Math.round(x), y)
      x += entryWidth + COMPACT.entryGap
    }
    return y + COMPACT.keyHeight
  }

  return {
    node,
    refresh: () => {},
    key: () => false,
    layout: (width, _height, viewport) => {
      const { narrow } = viewport
      const textX = COMPACT.icon + COMPACT.iconGap
      const noteLine = lineHeightOf(noteStyle)
      noteStyle.lineHeight = noteLine
      noteStyle.wordWrapWidth = Math.max(1, width - textX)
      let y = 0
      for (const row of rows) {
        row.note.visible = !narrow
        const noteHeight = narrow ? 0 : Math.max(1, Math.round(row.note.height / noteLine)) * noteLine
        const height = Math.round(COMPACT.line + COMPACT.noteGap + noteHeight)
        row.node.y = Math.round(y)
        row.icon.position.set(0, Math.round((height - COMPACT.icon) / 2))
        placeInLine(row.name, textX, (COMPACT.line - COMPACT.name) / 2, COMPACT.name)
        row.keys.position.set(Math.round(width - respace(row.keys, COMPACT.keyGap)), 1)
        placeInLine(row.note, textX, COMPACT.line + COMPACT.noteGap)
        y += height + (narrow ? COMPACT.narrowGap : COMPACT.rowGap)
      }
      let bottom = Math.round(y - (narrow ? COMPACT.narrowGap : COMPACT.rowGap))
      rule.visible = !narrow
      strip.visible = !narrow
      if (!narrow) {
        const ruleY = bottom + COMPACT.stripGap
        rule.clear().rect(0, ruleY, width, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
        strip.y = ruleY + 1 + COMPACT.stripPad
        bottom = strip.y + arrangeStrip(width)
      }
      node.boundsArea = new Rectangle(0, 0, width, bottom)
    }
  }
}

/**
 * The CONTROLS panel: the four moves with the boards' diamond, circle, triangle and square, spread down the sheet, then
 * how to move, aim, take a weapon, see the map and pause. Names and notes are set larger than the kit's roles, with
 * the type scale, so the sheet reads at the menu's size; `compact` is pause's side panel at fixed sizes.
 */
export const createControls = (options: { readonly compact?: true } = {}): PanelBody => {
  if (options.compact === true) return createCompactControls()
  const node = new Container({ label: "controls" })
  const nameStyle = face({ family: "condensed", weight: "600", size: 26, tracking: 0.3 })
  const noteStyle = face({ family: "text", weight: "400", size: 16, tracking: 0.02 })
  noteStyle.wordWrap = true
  const rows: ReadonlyArray<Row> = MOVES.map((move) => {
    const row = new Container({ label: `control ${move.name}` })
    const icon = new SmoothGraphics(iconContext(shapeMarkup(move.shape), "outline"))
    icon.tint = PALETTE.paper
    const name = textIn(move.name.toUpperCase(), nameStyle, PALETTE.paper)
    const note = textIn(move.note, noteStyle, PALETTE.concrete300)
    const caps = keys(move.keys)
    row.addChild(icon, name, note, caps)
    node.addChild(row)
    return { node: row, icon, name, note, keys: caps }
  })
  const rule = new Graphics()
  const strip = new Container({ label: "bindings" })
  const bindings = BINDINGS.map(([name, names]) => {
    const entry = new Container()
    const word = text(name.toUpperCase(), "small", PALETTE.concrete300)
    const caps = keys(names)
    entry.addChild(word, caps)
    strip.addChild(entry)
    return { entry, word, caps }
  })
  node.addChild(rule, strip)
  node.once("destroyed", () => {
    release(nameStyle)
    release(noteStyle)
  })

  /** Sets the bindings in lines across `width`; returns the strip's height. */
  const arrangeStrip = (width: number) => {
    let x = 0
    let y = 0
    let bottom = 0
    for (const { entry, word, caps } of bindings) {
      respace(caps)
      const first = caps.children[0]
      caps.x = Math.round(word.width + 8)
      const capMiddle = baselineOf(word.style) - (CAP_HEIGHT * Number(word.style.fontSize)) / 2
      word.y = Math.round((first?.height ?? 0) / 2 - capMiddle)
      const entryWidth = Math.round(caps.x + caps.width)
      if (x > 0 && x + entryWidth > width) {
        x = 0
        y += Math.round(entry.height + 10)
      }
      entry.position.set(x, y)
      x += entryWidth + 24
      bottom = Math.max(bottom, y + Math.round(entry.height))
    }
    return bottom
  }

  return {
    node,
    refresh: () => {},
    key: () => false,
    layout: (width, height, viewport) => {
      const { narrow, scale } = viewport
      resize(nameStyle, Math.max(20, 26 * scale), 0.3)
      resize(noteStyle, Math.max(14, 16 * scale), 0.02)
      const icon = Math.round(Math.max(26, 32 * scale))
      const textX = icon + Math.round(0.75 * icon)
      for (const row of rows) respace(row.keys)
      const widestKeys = Math.max(...rows.map((row) => Math.round(row.keys.width)))
      noteStyle.wordWrapWidth = Math.max(1, width - textX - widestKeys - 24)

      /** The strip and its rule after the last row's gap. */
      const stripBlock = GAP + STRIP_GAP + arrangeStrip(width)
      const least = narrow ? MIN_NARROW_ROW : MIN_ROW
      const withStrip = height - stripBlock >= 4 * least + 3 * GAP
      const room = height - (withStrip ? stripBlock : 0)
      const rowHeight = Math.round(clamp((room - 3 * GAP) / 4, least, MAX_ROW))
      rows.forEach((row, index) => {
        row.node.y = Math.round(index * (rowHeight + GAP))
        row.icon.scale.set(icon / 24)
        row.icon.position.set(0, Math.round((rowHeight - icon) / 2))
        const noted = row.name.height + NOTE_GAP + row.note.height <= rowHeight - 8
        row.note.visible = noted
        const block = row.name.height + (noted ? NOTE_GAP + row.note.height : 0)
        const top = Math.round((rowHeight - block) / 2)
        row.name.position.set(textX, top)
        row.note.position.set(textX, Math.round(top + row.name.height + NOTE_GAP))
        row.keys.position.set(Math.round(width - row.keys.width), Math.round((rowHeight - row.keys.height) / 2))
      })
      const ruleY = Math.round(rows.length * (rowHeight + GAP))
      rule.clear().rect(0, ruleY, width, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
      rule.visible = withStrip
      strip.visible = withStrip
      strip.y = ruleY + STRIP_GAP
    }
  }
}
