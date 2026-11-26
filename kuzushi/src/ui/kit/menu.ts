import { gsap } from "gsap"
import { clamp } from "math"
import { AlphaFilter, Color, Container, FillGradient, Graphics, GraphicsPath, Rectangle, SmoothGraphics } from "pixi.js"
import type { FederatedPointerEvent, Text, TextStyle } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { play } from "../../art/sounds.ts"
import { accentOf } from "../accent.ts"
import type { Accent } from "../accent.ts"
import { svgPaths } from "../brush.ts"
import { keyAction, opened, pointed, stepped } from "../cursor.ts"
import type { Cursor } from "../cursor.ts"
import { FILL, SLASH, SLASH_CORE } from "../menu.ts"
import type { MenuItem } from "../menu.ts"
import { drawn, ON_ONES, rattle, shown } from "../motion.ts"
import { createCorners } from "./corners.ts"
import type { Corners } from "./corners.ts"
import { blurSprite } from "./glow.ts"
import { inkContext } from "./ink.ts"
import { createLayer, eraseRamp } from "./layer.ts"
import { baselineOf, CAP_HEIGHT, face, inlineWidth, release, resize, textIn, wrapped } from "./type.ts"

/** How a menu is set, in px; its owner sizes it from the viewport. */
export interface MenuLook {
  /** The rows' width; the bar runs to it. */
  readonly width: number
  /** The labels' size. */
  readonly size: number
  /** The labels' letter spacing, in em. */
  readonly tracking: number
  /** Each row's height. */
  readonly row: number
  /** Space between rows. */
  readonly gap: number
  /** Where labels start; numbers sit before it. */
  readonly indent: number
  /** Where the bar starts in a row's box; `indent - 0.3 * size` by default. */
  readonly barX?: number
  /** How far the highlighted label steps right; `0.22 * size` by default. */
  readonly shift?: number
  /** The idle labels' alpha; .66 solid, .62 outlined by default. */
  readonly idle?: number
  /** Side by side only: the room after a label inside its bar. */
  readonly trail?: number
}

export interface Menu {
  readonly node: Container
  /** Each item's body, which `intro` slides in, for an owner playing its own entrance (the results'). */
  readonly items: ReadonlyArray<Container>
  /** The highlighted item. */
  readonly active: number
  /** Puts the highlight on `index` (the first by default) at once. */
  reset(index?: number): void
  /** Arrows and WASD move, Enter, Space and J choose. Returns whether the key was used. */
  key(event: KeyboardEvent): boolean
  /** Dims the menu while a panel it opened has the keyboard; its choice stays marked. */
  rest(on: boolean): void
  /** The rows slide in one after another and the bar wipes in under the highlighted one. */
  intro(): gsap.core.Timeline
  layout(look: MenuLook): void
  /** Item `index`'s box, in the menu's space. */
  rect(index: number): Rectangle
  tint(accent: Accent): void
}

export interface MenuOptions {
  /** Numbers the rows 01, 02, ... in the accent, before the labels. */
  readonly numbered?: boolean
  /** Idle labels are outlines and the highlighted one is solid; otherwise every label is solid. */
  readonly outline?: boolean
  /** The highlight moved to another item, by key or pointer. */
  readonly onMove?: (index: number) => void
  /**
   * Items side by side (the results' menu), each `indent`, its label and `trail` wide with `gap` between; Left and
   * Right move. Otherwise they stack `width` wide.
   */
  readonly row?: true
  /** The labels' weight: 600 by default; pause and the results set theirs at 500. */
  readonly weight?: "500" | "600"
}

/** The outline labels' stroke, px. */
const OUTLINE = 1.5
/** Between a label and its detail line, px; an owner sizing rows for details leaves room for it. */
export const DETAIL_GAP = 4
const DEFAULT_LOOK: MenuLook = { width: 300, size: 20, tracking: 0.4, row: 48, gap: 4, indent: 22 }

/** The bar's extent in its 300x40 units: its gradient runs across the path's own box. */
const SPAN = new GraphicsPath(FILL.ink).bounds

/** The bar's colours from the accent's fill to its deep tone, opaque, across the brush in its units so every bristle shares one gradient. */
const colourOf = (accent: Accent) => new FillGradient({
  start: { x: SPAN.minX, y: 0 },
  end: { x: SPAN.maxX, y: 0 },
  textureSpace: "global",
  colorStops: [
    { offset: 0, color: new Color(accent.fill) },
    { offset: 0.38, color: new Color(accent.fill) },
    { offset: 0.72, color: new Color(accent.deep) },
    { offset: 1, color: new Color(accent.deep) }
  ]
})

/** How much of the bar fades out along it, for opacities 1, .92, .55 and 0 at the gradient's stops, erased from the whole at once. */
const FADE = [[0, 0], [0.38, 0.08], [0.72, 0.45], [1, 1]] as const

const armOf = (size: number) => Math.round(Math.max(12, Math.min(18, 0.26 * size)))

interface Row {
  /** Placed by layout; takes the pointer. */
  readonly slot: Container
  /** Slides in with the intro. */
  readonly body: Container
  readonly number: Text | null
  readonly labelSlot: Container
  /** The highlighted label's step right, with its detail. */
  readonly shift: Container
  /** Rattles when chosen. */
  readonly label: Container
  readonly outline: Text | null
  readonly solid: Text
  readonly detail: Text | null
}

/**
 * The Pixi twin of ui/menu.ts, with its contract and its moves: a list of options in wide-tracked caps, the highlighted
 * one on a brush bar in the accent that fades out to the right, inside corner brackets. Moving smears the bar across
 * to the next item and snaps the brackets onto it; choosing slashes across the item. It opens on the first item, and
 * the pointer selects only once it has moved (see `Cursor`). Its owner sizes it with `layout`.
 *
 * The bar is drawn at the highlighted item's size into a Layer, its colours opaque and its fade erased from the whole,
 * so the dry bristles fade with the body instead of each restarting the gradient over it; resting and smearing fade
 * the whole bar at once.
 */
export const createMenu = (items: ReadonlyArray<MenuItem>, options: MenuOptions = {}): Menu => {
  const node = new Container({ label: "menu" })
  const outlined = options.outline === true
  const across = options.row === true
  const weight = options.weight ?? "600"
  const solidStyle = face({ family: "condensed", weight, size: DEFAULT_LOOK.size, tracking: DEFAULT_LOOK.tracking })
  const outlineStyle = outlined ? face({ family: "condensed", weight, size: DEFAULT_LOOK.size, tracking: DEFAULT_LOOK.tracking, stroke: OUTLINE }) : null
  const numberStyle = options.numbered === true ? face({ family: "condensed", weight: "600", size: 13, tracking: 0.08 }) : null

  let look = DEFAULT_LOOK
  let accent = accentOf("courtyard")
  let cursor: Cursor = opened
  let resting = false
  let moving: gsap.core.Timeline | null = null
  let chosen: gsap.core.Timeline | null = null
  /** Each item's box, set by layout. */
  let boxes: ReadonlyArray<Rectangle> = []

  /** The bar, drawn `restSize` px: placing it on a box of another size only scales it. */
  const bar = new Container({ label: "menu-bar" })
  const fillBody = new Container()
  const glowUnits = new Container()
  const glow = blurSprite(svgPaths(FILL.shapes), { x: -15, y: -13, width: 330, height: 66 }, 6, { width: 600, height: 120 }, "menu-bar")
  glow.alpha = 0.4
  glow.tint = accent.accent
  glowUnits.addChild(glow)
  const fill = createLayer("menu-fill")
  let colour = colourOf(accent)
  const brush = new SmoothGraphics(inkContext(FILL.shapes, colour))
  const fade = eraseRamp(new Rectangle(SPAN.minX, -10, SPAN.maxX - SPAN.minX, 60), FADE, "x")
  const fillUnits = new Container()
  fillUnits.addChild(brush, fade)
  fill.content.addChild(fillUnits)
  const flash = new Graphics()
  flash.alpha = 0
  fillBody.addChild(glowUnits, fill.node)
  bar.addChild(fillBody, flash)
  let restSize = { width: 0, height: 0 }

  /** Draws the bar `width` by `height` px at rest and caches it at that size. */
  const fitBar = (width: number, height: number, force = false) => {
    if (!force && width === restSize.width && height === restSize.height) return
    restSize = { width, height }
    const units = { x: width / 300, y: height / 40 }
    glowUnits.scale.set(units.x, units.y)
    fillUnits.scale.set(units.x, units.y)
    bar.pivot.set(width / 2, height / 2)
    fillBody.pivot.set(0, height / 2)
    fillBody.position.set(0, height / 2)
    flash.clear().rect(0, 0, width, height).fill(PALETTE.paper)
    fill.refresh()
  }

  const makeBrackets = (length: number) => createCorners({ arm: length, weight: 2, color: accent.accent, alpha: 1, glow: true })
  let arm = armOf(look.size)
  let brackets: Corners = makeBrackets(arm)

  const slash = new Container({ label: "menu-slash" })
  const slashRed = new SmoothGraphics(inkContext(SLASH.shapes))
  slashRed.tint = accent.accent
  const slashCore = new SmoothGraphics(inkContext(SLASH_CORE.shapes))
  slashCore.tint = PALETTE.paper
  const slashMask = new Graphics().rect(-10, -5, 320, 50).fill(0xffffff)
  slash.addChild(slashRed, slashCore)
  slash.visible = false
  /** Fades the slash as one: the container's alpha would fade the red and the core apart, the red showing through the core. */
  const slashFade = new AlphaFilter()
  slash.filters = [slashFade]

  const rows: ReadonlyArray<Row> = items.map((item, index) => {
    const slot = new Container({ label: `menu-row ${item.label}` })
    slot.eventMode = "static"
    slot.cursor = "pointer"
    const body = new Container()
    const number = numberStyle === null ? null : textIn(String(index + 1).padStart(2, "0"), numberStyle)
    const labelSlot = new Container()
    const shift = new Container()
    const label = new Container()
    const outline = outlineStyle === null ? null : textIn(item.label.toUpperCase(), outlineStyle)
    outline?.position.set(-OUTLINE / 2, -OUTLINE / 2)
    const solid = textIn(item.label.toUpperCase(), solidStyle)
    const detail = item.detail === undefined ? null : wrapped(item.detail, "body", look.width, PALETTE.concrete300)
    label.addChild(...(outline === null ? [] : [outline]), solid)
    shift.addChild(label, ...(detail === null ? [] : [detail]))
    labelSlot.addChild(shift)
    body.addChild(...(number === null ? [] : [number]), labelSlot)
    slot.addChild(body)
    slot.on("pointermove", (event: FederatedPointerEvent) => moveTo(pointed(cursor, index, event.movementX, event.movementY)))
    slot.on("pointertap", (event: FederatedPointerEvent) => {
      if (event.button === 0) choose(index)
    })
    return { slot, body, number, labelSlot, shift, label, outline, solid, detail }
  })
  node.addChild(bar, brackets.node, slash, ...rows.map((row) => row.slot))

  const offset = () => look.shift ?? Math.round(0.22 * look.size)

  /** Sets every item's box from the look: stacked `width` wide, or side by side as wide as their labels. */
  const arrange = () => {
    let x = 0
    boxes = rows.map((row, index) => {
      if (!across) return new Rectangle(0, index * (look.row + look.gap), look.width, look.row)
      const width = Math.round(look.indent + inlineWidth(row.solid) + (look.trail ?? 0))
      const box = new Rectangle(x, 0, width, look.row)
      x += width + look.gap
      return box
    })
  }
  arrange()

  const rectOf = (index: number) => boxes[index]?.clone() ?? new Rectangle()

  const barRect = (index: number) => {
    const box = rectOf(index)
    const x = look.barX ?? Math.round(look.indent - 0.3 * look.size)
    return new Rectangle(box.x + x, box.y, box.width - x, box.height)
  }

  const putBar = (rect: Rectangle, skew = 0, alpha = 1) => {
    bar.position.set(rect.x + rect.width / 2, rect.y + rect.height / 2)
    bar.scale.set(rect.width / Math.max(1, restSize.width), rect.height / Math.max(1, restSize.height))
    bar.skew.x = skew
    bar.alpha = alpha
  }

  /** The bar drawn and placed at rest on `rect`, and the brackets round it. */
  const settleBar = (rect: Rectangle) => {
    fitBar(rect.width, rect.height)
    putBar(rect)
    brackets.place(rect.x, rect.y, rect.width, rect.height, 7, 6)
  }

  const place = (index: number) => {
    settleBar(barRect(index))
    fillBody.scale.set(1)
  }

  /** Each row's label, number and detail for the highlight and whether the menu rests. */
  const paint = (instant: boolean) => {
    const idle = resting ? 0.26 : look.idle ?? (outlined ? 0.62 : 0.66)
    const duration = instant ? 0 : 0.12
    rows.forEach((row, index) => {
      const on = index === cursor.active
      if (row.outline !== null) gsap.to(row.outline, { alpha: on ? 0 : idle, duration, overwrite: true })
      gsap.to(row.solid, { alpha: on ? 1 : row.outline === null ? idle : 0, duration, overwrite: true })
      if (row.number !== null) row.number.tint = on ? accent.accent : PALETTE.concrete400
      if (row.detail !== null) row.detail.tint = on ? PALETTE.paper : PALETTE.concrete300
    })
  }

  const moveTo = (next: Cursor) => {
    const from = cursor.active
    cursor = next
    if (next.active === from) return
    paint(false)
    const a = barRect(from)
    const b = barRect(next.active)
    const toward = across ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y)
    play("ui-move")
    moving?.kill()
    moving = gsap.timeline()
      .add(() => {
        putBar(a.clone().enlarge(b), -0.244 * toward, 0.5)
        fillBody.scale.set(across ? 0.8 : 1, across ? 1 : 0.55)
        for (const body of brackets.bodies) body.alpha = 0
      })
      .add(() => settleBar(b), 1 / ON_ONES)
      .fromTo(fillBody.scale, { x: 0.55, y: 1.3 }, { x: 1, y: 1, duration: 0.25, ease: drawn(0.25, "back.out(2.4)", ON_ONES) }, 1 / ON_ONES)
      .add(brackets.snap(12, 8, 0.17, 0.012), 1.5 / ON_ONES)
    const left = rows[from]
    const arrived = rows[next.active]
    if (left !== undefined) gsap.to(left.shift, { x: 0, duration: 0.2, ease: "power2.out", overwrite: true })
    if (arrived !== undefined) {
      gsap.fromTo(arrived.shift, { x: -4 }, { x: offset(), duration: 0.3, ease: drawn(0.3, "back.out(3)", ON_ONES), overwrite: true })
      if (arrived.number !== null) gsap.fromTo(arrived.number.scale, { x: 1.4, y: 1.4 }, { x: 1, y: 1, duration: 0.18, ease: drawn(0.18, "power2.out", ON_ONES), overwrite: true })
    }
    options.onMove?.(next.active)
  }

  const unmask = () => {
    slash.mask = null
    slash.removeChild(slashMask)
  }

  const choose = (index: number) => {
    moveTo({ active: index, armed: true })
    const row = rows[index]
    if (row === undefined) return
    const rect = barRect(index)
    chosen?.progress(1)
    slash.position.set(rect.x, rect.y - rect.height * 0.25)
    slash.scale.set(rect.width / 300, (rect.height * 1.5) / 40)
    slash.addChild(slashMask)
    slash.mask = slashMask
    slashMask.scale.x = 0
    slashFade.alpha = 1
    const strike = (on: boolean) => {
      row.solid.tint = on ? PALETTE.ink : PALETTE.paper
    }
    chosen = gsap.timeline({ onComplete: unmask })
      .add(shown(slash, true), 0)
      .to(slashMask.scale, { x: 1, duration: 0.1, ease: drawn(0.1, "power3.in", ON_ONES) }, 0)
      .set(flash, { alpha: 1 }, 0.1)
      .add(() => strike(true), 0.1)
      .set(flash, { alpha: 0 }, 0.1 + 2 / ON_ONES)
      .add(() => strike(false), 0.1 + 2 / ON_ONES)
      .add(rattle(row.label, 5, 0.22), 0.1)
      .add(brackets.kick(7, 5), 0.1)
      .to(slash, { x: rect.x + rect.width * 0.12, duration: 0.26, ease: drawn(0.26, "power2.in") }, 0.18)
      .to(slashFade, { alpha: 0, duration: 0.26, ease: drawn(0.26, "power2.in") }, 0.18)
      .add(shown(slash, false))
    play("ui-select")
    items[index]?.action()
  }

  const tint = (next: Accent) => {
    accent = next
    glow.tint = next.accent
    const old = { context: brush.context, colour }
    colour = colourOf(next)
    brush.context = inkContext(FILL.shapes, colour)
    old.context.destroy()
    old.colour.destroy()
    fill.refresh()
    brackets.tint(next.accent)
    slashRed.tint = next.accent
    paint(true)
  }
  paint(true)

  node.once("destroyed", () => {
    moving?.kill()
    chosen?.kill()
    slashMask.destroy()
    slashFade.destroy()
    colour.destroy()
    for (const style of [solidStyle, outlineStyle, numberStyle]) if (style !== null) release(style)
  })

  return {
    node,
    items: rows.map((row) => row.body),
    get active() {
      return cursor.active
    },
    reset: (index = 0) => {
      moving?.kill()
      chosen?.progress(1)
      cursor = { active: clamp(index, 0, items.length - 1), armed: false }
      resting = false
      paint(true)
      rows.forEach((row, at) => {
        row.slot.eventMode = "static"
        row.shift.x = at === cursor.active ? offset() : 0
        row.label.position.set(0, 0)
        row.number?.scale.set(1)
      })
      place(cursor.active)
      fillBody.alpha = 1
      gsap.killTweensOf([fillBody, brackets.node])
      brackets.node.alpha = 1
      brackets.node.visible = true
      for (const body of brackets.bodies) {
        body.position.set(0, 0)
        body.alpha = 1
      }
    },
    key: (event) => {
      const action = keyAction(event.code)
      if (action === null) return false
      if (action === "choose") choose(cursor.active)
      else moveTo(stepped(cursor, action.move, items.length))
      return true
    },
    rest: (on) => {
      resting = on
      for (const row of rows) row.slot.eventMode = on ? "none" : "static"
      paint(false)
      gsap.to(fillBody, { alpha: on ? 0.55 : 1, duration: 0.15, overwrite: true })
      shown(brackets.node, !on, 0.15)
    },
    intro: () => {
      place(cursor.active)
      const numbers = rows.flatMap((row) => (row.number === null ? [] : [row.number.scale]))
      return gsap.timeline()
        .fromTo(rows.map((row) => row.body), { x: -40, alpha: 0 }, { x: 0, alpha: 1, duration: 0.34, ease: drawn(0.34, "expo.out"), stagger: 0.06 }, 0)
        .fromTo(numbers, { x: 1.5, y: 1.5 }, { x: 1, y: 1, duration: 0.24, ease: drawn(0.24, "power3.out", ON_ONES), stagger: 0.06 }, 0)
        .fromTo(fillBody.scale, { x: 0 }, { x: 1, duration: 0.24, ease: drawn(0.24, "power3.out", ON_ONES) }, 0.05)
        .add(brackets.snap(16, 10, 0.2, 0.03), 0.15)
    },
    layout: (next) => {
      look = next
      resize(solidStyle, look.size, look.tracking)
      if (outlineStyle !== null) resize(outlineStyle, look.size, look.tracking)
      if (numberStyle !== null) resize(numberStyle, Math.max(13, 0.28 * look.size), 0.08)
      arrange()
      const capTop = (style: TextStyle) => baselineOf(style) - CAP_HEIGHT * Number(style.fontSize)
      rows.forEach((row, index) => {
        const box = rectOf(index)
        row.slot.position.set(Math.round(box.x), Math.round(box.y))
        row.slot.hitArea = new Rectangle(0, 0, box.width, box.height)
        if (row.detail !== null) row.detail.style.wordWrapWidth = Math.max(1, box.width - look.indent - offset() - 8)
        const block = row.solid.height + (row.detail === null ? 0 : DETAIL_GAP + row.detail.height)
        const top = Math.round((look.row - block) / 2)
        row.labelSlot.position.set(Math.round(look.indent), top)
        row.detail?.position.set(0, Math.round(row.solid.height + DETAIL_GAP))
        row.shift.x = index === cursor.active ? offset() : 0
        if (row.number !== null && numberStyle !== null) {
          const px = Math.round(row.number.width / 2)
          const py = Math.round(row.number.height / 2)
          row.number.pivot.set(px, py)
          row.number.position.set(px, Math.round(top + capTop(solidStyle) - capTop(numberStyle)) + py)
        }
      })
      if (armOf(look.size) !== arm) {
        moving?.kill()
        chosen?.progress(1)
        arm = armOf(look.size)
        const next = makeBrackets(arm)
        next.node.alpha = brackets.node.alpha
        next.node.visible = brackets.node.visible
        node.addChildAt(next.node, node.getChildIndex(brackets.node))
        brackets.node.destroy({ children: true, context: true })
        brackets = next
      }
      const rest = barRect(cursor.active)
      fitBar(rest.width, rest.height, true)
      if (moving === null || !moving.isActive()) place(cursor.active)
    },
    rect: rectOf,
    tint
  }
}
