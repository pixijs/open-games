import { gsap } from "gsap"
import { clamp } from "math"
import { Color, Container, FillGradient, Graphics, Rectangle, Text } from "pixi.js"
import type { FederatedPointerEvent } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { accentOf } from "../accent.ts"
import type { Accent } from "../accent.ts"
import { keyAction, opened, pointed, stepped } from "../cursor.ts"
import type { Cursor } from "../cursor.ts"
import { blurSprite } from "../kit/glow.ts"
import type { PanelBody } from "../kit/sheet.ts"
import { baselineOf, CAP_HEIGHT, face, inlineWidth, lineHeightOf, placeInLine, release, text, textIn, wrapped } from "../kit/type.ts"
import type { Viewport } from "../kit/viewport.ts"
import { drawn, ON_ONES } from "../motion.ts"
import type { Tinted } from "../screen.ts"
import { change, percent, ROWS, snap } from "../settings-rows.ts"
import type { Row } from "../settings-rows.ts"

const TRACK_HEIGHT = 12
const CHIP_PAD = { x: 9, y: 5 } as const
/** The marker reaches this far past the row on both sides, px. */
const BLEED = 12
/**
 * The compact look's sizes, px: rows and the gap between them, the least gap between a label and its control, the
 * track, the gap before the value and its box, a chip's height (its 1 px border, padding 5 over and 4 under its line),
 * the detail's line, its least height and the room above its rule and its text.
 */
const COMPACT = { row: 42, gap: 2, labelGap: 16, track: { width: 150, height: 10 }, valueGap: 4, value: 48, chip: 1 + 5 + 4 + 1, line: 18.75, detail: 40, ruleGap: 16, textGap: 12 } as const
/** The compact look's rule's y: under the last row, a row gap and `ruleGap` below it. */
const COMPACT_RULE_Y = (ROWS.length - 1) * (COMPACT.row + COMPACT.gap) + COMPACT.row + COMPACT.gap + COMPACT.ruleGap

interface Chip {
  readonly node: Container
  readonly box: Graphics
  readonly label: Text
  readonly value: string
  /** Whether it is the row's value, as last drawn. */
  on: boolean
}

interface RangeControl {
  readonly kind: "range"
  readonly node: Container
  readonly track: Graphics
  /** What scales with the value: the fill, and its glow in the compact look. */
  readonly bar: Container
  readonly fill: Graphics
  readonly ticks: Graphics
  readonly value: Text
}

interface ChoiceControl {
  readonly kind: "choice"
  readonly node: Container
  readonly chips: ReadonlyArray<Chip>
}

export interface SettingsOptions {
  /** Pause's side panel at fixed sizes, rather than the title's sheet. */
  readonly compact?: true
  /** The compact body's height changed as the detail took another line: its panel lays out again. */
  readonly resized?: () => void
}

export interface SettingsPanel extends PanelBody, Tinted {
  /** The compact body's least width: its widest row's label, a 16 px gap and its control. */
  natural(): number
}

/**
 * The SETTINGS panel, saved as they change: screen shake, impact flashes, film grain, the FPS readout and
 * fullscreen. Up and down pick a row, left and right change it, Enter steps a choice on; the pointer clicks a value
 * or the shake track. The line under the rows says what the picked one does. The title's sheet sets it in the type
 * scale's roles; `compact` is pause's side panel at fixed sizes, in the zone's accent (`tint`), its height reported
 * through the node's `boundsArea`.
 */
export const createSettings = (options: SettingsOptions = {}): SettingsPanel => {
  const compact = options.compact === true
  let accent = accentOf("courtyard")
  const node = new Container({ label: "settings" })
  const marker = new Container()
  const markerFill = new Graphics()
  const markerBar = new Graphics()
  marker.addChild(markerFill, markerBar)
  node.addChild(marker)
  /** The marker's fade: the accent at .3 to nothing, through the deep tone at .12 in the compact look. */
  const markerGradientOf = (next: Accent) => new FillGradient({
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    colorStops: compact
      ? [{ offset: 0, color: new Color(next.accent).setAlpha(0.3) }, { offset: 0.5, color: new Color(next.deep).setAlpha(0.12) }, { offset: 1, color: new Color(next.deep).setAlpha(0) }]
      : [{ offset: 0, color: new Color(next.accent).setAlpha(0.3) }, { offset: 1, color: new Color(next.deep).setAlpha(0) }]
  })
  let markerGradient = markerGradientOf(accent)

  /** The compact look's own faces; the title's sheet uses the shared roles. */
  const own = compact
    ? {
        name: face({ family: "condensed", weight: "500", size: 14, tracking: 0.32 }),
        label: face({ family: "condensed", weight: "500", size: 12, tracking: 0.22 }),
        digits: face({ family: "condensed", weight: "500", size: 13, tracking: 0.06 }),
        body: face({ family: "text", weight: "400", size: 12.5, tracking: 0.02 })
      }
    : null
  const make = (content: string, role: "name" | "label" | "digits", tint: number = PALETTE.paper) =>
    own === null ? text(content, role, tint) : textIn(content, own[role], tint)

  let cursor: Cursor = opened
  let trackWidth: number = COMPACT.track.width
  let rowHeight: number = compact ? COMPACT.row : 52
  let markerWidth = 0

  /** The pointer or a key moved the highlight; the detail may have taken another line, and the panel lays out again. */
  const moved = (next: Cursor) => {
    const before = detail.height
    select(next, false)
    if (!compact || detail.height === before) return
    fitBounds()
    options.resized?.()
  }

  /** A row's control was used by the pointer: it takes the highlight and shows its new value. */
  const used = (index: number) => {
    moved({ active: index, armed: true })
    paint(true)
  }

  const rangeControl = (row: Extract<Row, { kind: "range" }>, index: number): RangeControl => {
    const controlNode = new Container()
    const track = new Graphics()
    const bar = new Container()
    const fill = new Graphics()
    if (compact) {
      const { width, height } = COMPACT.track
      const glow = blurSprite(`<rect width="${width}" height="${height}"/>`, { x: -12, y: -12, width: width + 24, height: height + 24 }, 4, { width: 2 * (width + 24), height: 2 * (height + 24) }, "settings-fill")
      glow.alpha = 0.5
      bar.addChild(glow)
    }
    bar.addChild(fill)
    const ticks = new Graphics()
    const value = make("", "digits")
    controlNode.addChild(track, bar, ticks, value)
    track.eventMode = "static"
    track.cursor = "pointer"
    track.on("pointertap", (event: FederatedPointerEvent) => {
      if (event.button !== 0) return
      row.write(snap(event.getLocalPosition(track).x / trackWidth))
      used(index)
    })
    return { kind: "range", node: controlNode, track, bar, fill, ticks, value }
  }

  const choiceControl = (row: Extract<Row, { kind: "choice" }>, index: number): ChoiceControl => {
    const controlNode = new Container()
    const chips = row.choices.map((choice): Chip => {
      const chip = new Container({ label: `choice ${choice.label}` })
      const box = new Graphics()
      const label = make(choice.label.toUpperCase(), "label", PALETTE.concrete400)
      chip.addChild(box, label)
      chip.eventMode = "static"
      chip.cursor = "pointer"
      chip.on("pointertap", (event: FederatedPointerEvent) => {
        if (event.button !== 0) return
        row.write(choice.value)
        used(index)
      })
      controlNode.addChild(chip)
      return { node: chip, box, label, value: choice.value, on: false }
    })
    return { kind: "choice", node: controlNode, chips }
  }

  const rows = ROWS.map((row, index) => {
    const slot = new Container({ label: `setting ${row.label}` })
    slot.eventMode = "static"
    const label = make(row.label.toUpperCase(), "name")
    const control = row.kind === "range" ? rangeControl(row, index) : choiceControl(row, index)
    slot.addChild(label, control.node)
    slot.on("pointermove", (event: FederatedPointerEvent) => {
      const next = pointed(cursor, index, event.movementX, event.movementY)
      if (next.active !== cursor.active || next.armed !== cursor.armed) moved(next)
    })
    node.addChild(slot)
    return { slot, label, control }
  })
  const rule = new Graphics()
  const detail = own === null ? wrapped("", "body", 300, PALETTE.concrete300) : new Text({ text: "", style: own.body, roundPixels: true })
  if (own !== null) {
    own.body.wordWrap = true
    own.body.lineHeight = COMPACT.line
    detail.tint = PALETTE.concrete300
  }
  node.addChild(rule, detail)

  const chipWidth = (chip: Chip) => Math.round(compact ? 2 * (1 + CHIP_PAD.x) + inlineWidth(chip.label) : chip.label.width + CHIP_PAD.x * 2)

  /** Draws a chip's box for whether it is on: a border box round its label in the compact look. */
  const chipBox = (chip: Chip, on: boolean) => {
    chip.on = on
    const width = chipWidth(chip)
    const height = Math.round(compact ? COMPACT.chip + lineHeightOf(chip.label.style) : chip.label.height + CHIP_PAD.y * 2 - 2)
    chip.box.clear().rect(0, 0, width, height)
    if (on) chip.box.fill({ color: accent.accent, alpha: 0.22 }).stroke({ width: 1, color: accent.accent, alpha: 0.85, alignment: 1 })
    else chip.box.fill({ color: PALETTE.ink, alpha: 0 })
    chip.node.hitArea = new Rectangle(0, 0, width, height)
    if (compact) placeInLine(chip.label, 1 + CHIP_PAD.x, 1 + CHIP_PAD.y)
    else chip.label.position.set(CHIP_PAD.x, CHIP_PAD.y - 1)
    chip.label.tint = on ? PALETTE.paper : PALETTE.concrete400
    chip.node.pivot.set(width / 2, height / 2)
  }

  /** The compact value's figures, right-aligned in their box after the track. */
  const placeValue = (value: Text) => {
    if (compact) placeInLine(value, trackWidth + COMPACT.valueGap + COMPACT.value - inlineWidth(value), (COMPACT.track.height - lineHeightOf(value.style)) / 2)
  }

  const paint = (pop: boolean) => {
    ROWS.forEach((row, index) => {
      const control = rows[index]?.control
      if (control === undefined) return
      if (row.kind === "range" && control.kind === "range") {
        const value = row.read()
        gsap.to(control.bar.scale, { x: value, duration: pop ? 0.2 : 0, ease: drawn(0.2, "power3.out", ON_ONES), overwrite: true })
        control.value.text = percent(value)
        placeValue(control.value)
        return
      }
      if (row.kind !== "choice" || control.kind !== "choice") return
      const current = row.read()
      for (const chip of control.chips) {
        const on = chip.value === current
        const was = chip.on
        chipBox(chip, on)
        if (pop && on && !was) gsap.fromTo(chip.node.scale, { x: 1.25, y: 1.25 }, { x: 1, y: 1, duration: 0.25, ease: drawn(0.25, "back.out(3)", ON_ONES) })
      }
    })
  }

  const rowTop = (index: number) => (compact ? index * (COMPACT.row + COMPACT.gap) : index * rowHeight)

  const select = (next: Cursor, instant: boolean) => {
    cursor = next
    rows.forEach((row, index) => {
      row.label.alpha = index === cursor.active ? 1 : 0.66
    })
    const row = rows[cursor.active]
    if (row === undefined) return
    gsap.to(marker, { y: row.slot.y, duration: instant ? 0 : 0.18, ease: drawn(0.18, "expo.out", ON_ONES), overwrite: true })
    detail.text = ROWS[cursor.active]?.detail ?? ""
  }

  const step = (index: number, by: -1 | 1) => {
    change(index, by)
    paint(true)
  }

  const drawMarker = () => {
    markerFill.clear().rect(-BLEED, 0, markerWidth + BLEED * 2, rowHeight).fill(markerGradient)
    markerBar.clear().rect(-BLEED, 0, 2, rowHeight).fill(accent.accent)
  }

  const repaint = () => paint(true)
  document.addEventListener("fullscreenchange", repaint)
  node.once("destroyed", () => {
    document.removeEventListener("fullscreenchange", repaint)
    gsap.killTweensOf([marker, ...rows.flatMap(({ control }) => (control.kind === "range" ? [control.bar.scale] : control.chips.map((chip) => chip.node.scale)))])
    markerGradient.destroy()
    if (own !== null) for (const style of Object.values(own)) release(style)
  })

  /** Draws a range's track `width` by `height` with its tenths ticked, and its fill in `colour`. */
  const drawTrack = (control: RangeControl, width: number, height: number, colour: number) => {
    control.track.clear().rect(0, 0, width, height).fill({ color: PALETTE.paper, alpha: 0.12 })
    control.ticks.clear()
    for (let tick = 1; tick < 10; tick++) control.ticks.rect(Math.round((tick / 10) * width), 0, 1, height).fill({ color: PALETTE.ink, alpha: 0.7 })
    control.track.hitArea = new Rectangle(0, -8, width, height + 16)
    control.fill.clear().rect(0, 0, width, height).fill(colour)
  }

  /** Sets a choice's chips in a row, 4 px apart, and returns where the next would start. */
  const placeChips = (control: ChoiceControl) => {
    let x = 0
    for (const chip of control.chips) {
      chipBox(chip, chip.on)
      chip.node.position.set(Math.round(x + chip.node.pivot.x), Math.round(chip.node.pivot.y))
      x += Math.round(chip.node.pivot.x * 2) + 4
    }
    return x
  }

  /** The title's sheet: rows spread to the type scale, a track that grows with the screen, labels over controls when narrow. */
  const layoutTitle = (width: number, viewport: Viewport) => {
    const stacked = viewport.narrow && width < 420
    trackWidth = viewport.narrow ? 120 : clamp(0.12 * viewport.width, 150, 240)
    rowHeight = stacked ? 76 : Math.max(52, 0.075 * viewport.height)
    rows.forEach((row, index) => {
      const { slot, label, control } = row
      slot.y = Math.round(index * rowHeight)
      slot.hitArea = new Rectangle(-BLEED, 0, width + BLEED * 2, rowHeight)
      if (control.kind === "range") {
        drawTrack(control, trackWidth, TRACK_HEIGHT, accent.accent)
        control.value.position.set(trackWidth + 12, Math.round(TRACK_HEIGHT / 2 - (baselineOf(control.value.style) - (CAP_HEIGHT * Number(control.value.style.fontSize)) / 2)))
      } else {
        placeChips(control)
      }
      const controlWidth = control.kind === "range" ? trackWidth + 12 + 48 : control.node.width
      const controlHeight = control.kind === "range" ? TRACK_HEIGHT : control.node.height
      if (stacked) {
        label.position.set(0, 10)
        control.node.position.set(0, Math.round(label.y + label.height + 10))
      } else {
        label.position.set(0, Math.round((rowHeight - label.height) / 2))
        control.node.position.set(Math.round(width - controlWidth), Math.round((rowHeight - controlHeight) / 2))
      }
    })
    markerWidth = width
    drawMarker()
    const ruleY = Math.round(ROWS.length * rowHeight + 16)
    rule.clear().rect(0, ruleY, width, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
    detail.style.wordWrapWidth = Math.max(1, width)
    detail.position.set(0, ruleY + 12)
  }

  /** Pause's panel: 42 px rows, 2 apart, each label left and its control right, and the detail under a rule. */
  const layoutCompact = (width: number) => {
    const { track: size } = COMPACT
    rows.forEach((row, index) => {
      const { slot, label, control } = row
      slot.y = rowTop(index)
      slot.hitArea = new Rectangle(-BLEED, 0, width + BLEED * 2, COMPACT.row)
      placeInLine(label, 0, (COMPACT.row - lineHeightOf(label.style)) / 2)
      if (control.kind === "range") {
        drawTrack(control, size.width, size.height, 0xffffff)
        placeValue(control.value)
        control.node.position.set(Math.round(width - size.width - COMPACT.valueGap - COMPACT.value), Math.round((COMPACT.row - size.height) / 2))
        return
      }
      const x = placeChips(control)
      const chipHeight = Math.round(COMPACT.chip + lineHeightOf(control.chips[0]?.label.style ?? label.style))
      control.node.position.set(Math.round(width - (x - 4)), Math.round((COMPACT.row - chipHeight) / 2))
    })
    markerWidth = width
    drawMarker()
    rule.clear().rect(0, COMPACT_RULE_Y, width, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
    detail.style.wordWrapWidth = Math.max(1, width)
    placeInLine(detail, 0, COMPACT_RULE_Y + 1 + COMPACT.textGap)
  }

  /** The compact body's height: the detail's box grows past its least height as its text wraps. */
  const fitBounds = () => {
    if (!compact) return
    const lines = Math.max(1, Math.round(detail.height / COMPACT.line))
    node.boundsArea = new Rectangle(0, 0, markerWidth, COMPACT_RULE_Y + Math.max(COMPACT.detail, 1 + COMPACT.textGap + lines * COMPACT.line))
  }

  const tint = (next: Accent) => {
    accent = next
    const old = markerGradient
    markerGradient = markerGradientOf(next)
    old.destroy()
    drawMarker()
    for (const { control } of rows) {
      if (control.kind === "range") control.bar.tint = next.accent
      else for (const chip of control.chips) chipBox(chip, chip.on)
    }
  }
  if (compact) tint(accent)

  return {
    node,
    refresh: () => {
      paint(false)
      select(opened, true)
      fitBounds()
    },
    key: (event) => {
      if (event.code === "ArrowLeft" || event.code === "KeyA") step(cursor.active, -1)
      else if (event.code === "ArrowRight" || event.code === "KeyD") step(cursor.active, 1)
      else {
        const action = keyAction(event.code)
        if (action === null) return false
        if (action === "choose") step(cursor.active, 1)
        else moved(stepped(cursor, action.move, ROWS.length))
      }
      return true
    },
    layout: (width, _height, viewport) => {
      if (compact) layoutCompact(width)
      else layoutTitle(width, viewport)
      paint(false)
      select(cursor, true)
      fitBounds()
    },
    tint,
    natural: () => Math.ceil(Math.max(...rows.map(({ label, control }) => {
      const controlWidth = control.kind === "range"
        ? COMPACT.track.width + COMPACT.valueGap + COMPACT.value
        : control.chips.reduce((sum, chip) => sum + chipWidth(chip), 0) + 4 * (control.chips.length - 1)
      return inlineWidth(label) + COMPACT.labelGap + controlWidth
    })))
  }
}
