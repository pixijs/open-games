import { gsap } from "gsap"
import { Container, Graphics, Rectangle, SmoothGraphics } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { accentOf } from "../accent.ts"
import type { Accent } from "../accent.ts"
import { drawn, ON_ONES } from "../motion.ts"
import { createCorners } from "./corners.ts"
import type { Corners } from "./corners.ts"
import { blurSprite } from "./glow.ts"
import { backAction, fixedKeyBaseline, keycap } from "./keycap.ts"
import { createPlate } from "./plate.ts"
import type { PanelBody } from "./sheet.ts"
import { baselineOf, face, inlineWidth, lineHeightOf, placeInLine, release, textIn } from "./type.ts"
import type { Viewport } from "./viewport.ts"
import { createWipe } from "./wipe.ts"

export interface PanelOptions {
  readonly title: string
  /** Shows Esc and BACK at the head's end, which call this when clicked. */
  readonly back?: () => void
  /** Keycaps and what they do at the head's end, instead of BACK: the map's "Tab Hold M Toggle". */
  readonly keys?: ReadonlyArray<readonly [key: string, word: string]>
  /** The plate's ink, .78 by default; the map over play is .7. */
  readonly fill?: number
  /**
   * A plain panel (the map over play) rather than a submenu's: its head only as tall as its keycaps (19 px, not 22)
   * and 20 px under the body, not 24.
   */
  readonly plain?: true
}

export interface Panel {
  /** Placed by its owner. */
  readonly node: Container
  /** The corner ticks, for an owner playing its own entrance. */
  readonly ticks: Corners
  /** What it shows under its head; a body already up is swapped out. */
  setBody(body: PanelBody | null): void
  /** Sets it `width` wide and returns its height: the head, the body's own height (laid out with no height of its own) and the padding. */
  layout(width: number, viewport: Viewport): number
  /** Refreshes the body, then wipes in from the left as it slides 36 px right, ticks, head and body following. */
  open(): gsap.core.Timeline
  /** Slides 18 px left and fades as it wipes off toward the right, then hides. */
  close(): gsap.core.Timeline
  tint(accent: Accent): void
}

/** The plate's border, the padding inside it, and the gap under the head, px. */
const BORDER = 1
const PAD = { top: 20, side: 24 } as const
const BODY_GAP = 16
const HEAD_GAP = 12
/** The mark: a 6 px square turned 45°, so its points sit this far from its middle. */
const MARK = 3 * Math.SQRT2

/**
 * A submenu panel: an ink plate with corner ticks, a head of an accent diamond, the title, a rule to the end and a
 * back action or key hints, and its body. Pause's side panels and the map over play use it. It wipes in from the
 * menu that opened it and folds away the same way. The body sits inside the plate's border and padding; it reports
 * its height through its node's bounds (a `boundsArea` keeps them exact).
 */
export const createPanel = (options: PanelOptions): Panel => {
  const node = new Container({ label: `panel ${options.title}` })
  node.visible = false
  const head = options.plain === true ? 19 : 22
  const foot = options.plain === true ? 20 : 24
  const wrap = new Container()
  const plate = createPlate(options.fill)
  const ticks = createCorners({ arm: 12, weight: 1, color: PALETTE.paper, alpha: 0.85 })

  const headSlot = new Container()
  const headBody = new Container()
  const markGlow = blurSprite(`<rect x="-3" y="-3" width="6" height="6" transform="rotate(45)"/>`, { x: -12, y: -12, width: 24, height: 24 }, 4, { width: 48, height: 48 }, "panel-mark")
  markGlow.alpha = 0.6
  const mark = new SmoothGraphics().poly([0, -MARK, MARK, 0, 0, MARK, -MARK, 0]).fill(0xffffff)
  const titleStyle = face({ family: "condensed", weight: "500", size: 12, tracking: 0.42 })
  const smallStyle = face({ family: "condensed", weight: "500", size: 11, tracking: 0.3 })
  const title = textIn(options.title.toUpperCase(), titleStyle, PALETTE.paper)
  const rule = new Graphics().rect(0, 0, 1, 1).fill({ color: PALETTE.paper, alpha: 0.18 })

  const end = new Container({ label: "panel-end" })
  // Keys and words read as one line, `Tab Hold M Toggle`: each word keeps the spaces round it.
  const pairs = (options.keys ?? []).map(([key, word], index, all) => ({
    cap: keycap(key, { fixed: true }),
    word: textIn(` ${word.toUpperCase()}${index < all.length - 1 ? " " : ""}`, smallStyle, PALETTE.concrete300)
  }))
  for (const { cap, word } of pairs) end.addChild(cap, word)
  const backCap = options.back === undefined ? null : keycap("Esc", { fixed: true })
  const backLabel = options.back === undefined ? null : textIn("BACK", smallStyle, PALETTE.concrete300)
  if (backCap !== null && backLabel !== null) {
    end.addChild(backCap, backLabel)
    backAction(end, backLabel, () => options.back?.())
  }
  headBody.addChild(markGlow, mark, title, rule, end)
  headSlot.addChild(headBody)

  const bodySlot = new Container()
  const bodyMotion = new Container()
  bodySlot.addChild(bodyMotion)
  const opening = createWipe("left")
  const closing = createWipe("right")
  wrap.addChild(plate.node, ticks.node, headSlot, bodySlot)
  node.addChild(wrap)

  let body: PanelBody | null = null
  let motion: gsap.core.Timeline | null = null

  const maskWith = (mask: Graphics) => {
    for (const each of [opening.mask, closing.mask]) if (each !== mask && each.parent === wrap) wrap.removeChild(each)
    wrap.addChild(mask)
    wrap.mask = mask
  }

  /** Lays the head's end out from its left and returns its width. */
  const arrangeEnd = () => {
    let x = 0
    const capTop = Math.round((head - 19) / 2)
    for (const { cap, word } of pairs) {
      x += 10
      cap.position.set(x, capTop)
      x += Math.round(cap.width) + 6
      word.position.set(x, Math.round(capTop + fixedKeyBaseline() - baselineOf(word.style)))
      x += inlineWidth(word)
    }
    if (backCap !== null && backLabel !== null) {
      backCap.position.set(x, Math.round((head - backCap.height) / 2))
      x += Math.round(backCap.width) + 8
      placeInLine(backLabel, x, (head - lineHeightOf(smallStyle)) / 2)
      x += inlineWidth(backLabel)
      end.hitArea = new Rectangle(-8, -11, x + 16, head + 22)
    }
    return x
  }

  const tint = (accent: Accent) => {
    mark.tint = accent.accent
    markGlow.tint = accent.accent
  }
  tint(accentOf("courtyard"))

  node.once("destroyed", () => {
    motion?.kill()
    for (const each of [opening.mask, closing.mask]) if (!each.destroyed) each.destroy()
    release(titleStyle)
    release(smallStyle)
  })

  return {
    node,
    ticks,
    setBody: (next) => {
      if (body !== null && body !== next) bodyMotion.removeChild(body.node)
      body = next
      if (next !== null) bodyMotion.addChild(next.node)
    },
    layout: (width, viewport) => {
      const inner = Math.max(0, width - 2 * (BORDER + PAD.side))
      headSlot.position.set(BORDER + PAD.side, BORDER + PAD.top)
      mark.position.set(3, head / 2)
      markGlow.position.set(3 - 12, head / 2 - 12)
      placeInLine(title, 6 + HEAD_GAP, (head - lineHeightOf(titleStyle)) / 2)
      const endWidth = arrangeEnd()
      end.x = Math.round(inner - endWidth)
      const ruleFrom = Math.round(title.x + inlineWidth(title) + HEAD_GAP)
      rule.position.set(ruleFrom, Math.floor((head - 1) / 2))
      rule.scale.x = Math.max(0, end.x - HEAD_GAP - ruleFrom)
      const top = BORDER + PAD.top + head + BODY_GAP
      bodySlot.position.set(BORDER + PAD.side, top)
      body?.layout(inner, 0, viewport)
      const height = Math.round(top + (body === null ? 0 : body.node.height) + foot + BORDER)
      plate.draw(width, height)
      ticks.place(0, 0, width, height)
      const box = new Rectangle(0, 0, width, height)
      opening.fit(box)
      closing.fit(box)
      return height
    },
    open: () => {
      body?.refresh()
      motion?.kill()
      maskWith(opening.mask)
      node.visible = true
      wrap.alpha = 1
      motion = gsap.timeline()
        .fromTo(wrap, { x: -36 }, { x: 0, duration: 0.3, ease: drawn(0.3, "expo.out", ON_ONES) }, 0)
        .fromTo(opening, { amount: 0 }, { amount: 1, duration: 0.3, ease: drawn(0.3, "expo.out", ON_ONES) }, 0)
        .add(ticks.pop(2.4, 0.24, drawn(0.24, "power3.out", ON_ONES), 0.03), 0.08)
        .fromTo(headBody, { x: -12, alpha: 0 }, { x: 0, alpha: 1, duration: 0.3, ease: "power3.out" }, 0.1)
        .fromTo(bodyMotion, { y: 10, alpha: 0 }, { y: 0, alpha: 1, duration: 0.32, ease: "power3.out" }, 0.14)
      return motion
    },
    close: () => {
      motion?.kill()
      maskWith(closing.mask)
      closing.amount = 1
      motion = gsap.timeline()
        .to(wrap, { x: -18, alpha: 0, duration: 0.2, ease: drawn(0.2, "power2.in", ON_ONES) }, 0)
        .to(closing, { amount: 0, duration: 0.2, ease: drawn(0.2, "power2.in", ON_ONES) }, 0)
        .set(node, { visible: false })
      return motion
    },
    tint
  }
}
