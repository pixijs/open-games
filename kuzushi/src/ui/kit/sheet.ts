import { gsap } from "gsap"
import { Container, Graphics, Rectangle, SmoothGraphics } from "pixi.js"
import type { TextStyle } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { accentOf } from "../accent.ts"
import type { Accent } from "../accent.ts"
import { drawn, ON_ONES, shown } from "../motion.ts"
import { createCorners } from "./corners.ts"
import { backAction, keycap } from "./keycap.ts"
import { baselineOf, CAP_HEIGHT, text } from "./type.ts"
import type { Viewport } from "./viewport.ts"

/** What a sheet shows under its header. */
export interface PanelBody {
  readonly node: Container
  /** Brings what may have changed since it was last shown up to date (records, extras, fullscreen). */
  refresh(): void
  /** Keys while the sheet has the keyboard; Esc stays with the screen, which closes the sheet. */
  key(event: KeyboardEvent): boolean
  /** Fits the body to its box under the header, from its top-left. */
  layout(width: number, height: number, viewport: Viewport): void
}

export interface SheetEntry {
  /** "01", shown before the title in the accent. */
  readonly number: string
  readonly title: string
  readonly kanji: string
  readonly body: PanelBody
}

export interface Sheet {
  readonly node: Container
  /** Slides the sheet in with `entry`'s header and body; a body already up is swapped out. */
  show(entry: SheetEntry): gsap.core.Timeline
  hide(): gsap.core.Timeline
  key(event: KeyboardEvent): boolean
  /** `sheet` is the plate's box on screen; `content` the box its header and body fill. */
  layout(sheet: Rectangle, content: Rectangle, viewport: Viewport): void
  tint(accent: Accent): void
}

interface Boxes {
  readonly sheet: Rectangle
  readonly content: Rectangle
  readonly viewport: Viewport | null
}

/** Header to rule, and rule to body, px. */
const RULE_GAP = 14
const BODY_GAP = 24
/** What a body leaves clear above the content box's foot, px: the sheet's corner ticks sit there. */
const FOOT = 20

/**
 * A framed submenu sheet: an ink plate with an accent edge and corner ticks, a header with the entry's number, title
 * and kanji and a back action, a rule, and the entry's body. One sheet serves every entry of a screen, its body
 * swapped on show. It slides in from the right (from below on a narrow screen) and back out.
 */
export const createSheet = (back: () => void): Sheet => {
  const node = new Container({ label: "sheet" })
  node.visible = false
  node.alpha = 0
  const slide = new Container()
  const plate = new Graphics()
  const edge = new Graphics()
  const ticks = createCorners({ arm: 14, weight: 1, color: PALETTE.paper, alpha: 0.85 })

  const headerSlot = new Container()
  const header = new Container()
  const diamond = new SmoothGraphics().poly([4, 0, 8, 4, 4, 8, 0, 4]).fill(0xffffff)
  const number = text("", "small")
  const title = text("", "title")
  const kanji = text("", "kanji", PALETTE.concrete300)
  const backButton = new Container({ label: "sheet-back" })
  const backKey = keycap("Esc")
  const backLabel = text("BACK", "label", PALETTE.concrete300)
  backButton.addChild(backKey, backLabel)
  backAction(backButton, backLabel, back)
  header.addChild(diamond, number, title, kanji, backButton)
  headerSlot.addChild(header)

  const ruleSlot = new Container()
  const rule = new Container()
  const line = new Graphics()
  const dash = new Graphics().rect(0, -1, 28, 2).fill(0xffffff)
  rule.addChild(line, dash)
  ruleSlot.addChild(rule)

  const bodySlot = new Container()
  const body = new Container()
  bodySlot.addChild(body)
  slide.addChild(plate, edge, ticks.node, headerSlot, ruleSlot, bodySlot)
  node.addChild(slide)

  /** What the sheet shows; null while it is hidden or hiding. */
  let entry: SheetEntry | null = null
  /** The body on the sheet, kept while it hides. */
  let mounted: SheetEntry | null = null
  let motion: gsap.core.Timeline | null = null
  let box: Boxes = { sheet: new Rectangle(), content: new Rectangle(), viewport: null }

  /** Where the sheet waits off screen: its width to the right, or a screen's height down when narrow. */
  const away = () => (box.viewport?.narrow === true ? { x: 0, y: box.viewport.height } : { x: box.sheet.width, y: 0 })

  const arrange = () => {
    const { sheet, content, viewport } = box
    plate.clear().rect(sheet.x, sheet.y, sheet.width, sheet.height).fill({ color: PALETTE.ink, alpha: 0.9 })
      .rect(sheet.x + 8, sheet.y, 1, sheet.height).fill({ color: PALETTE.paper, alpha: 0.12 })
    edge.clear().rect(sheet.x, sheet.y, 2, sheet.height).fill({ color: 0xffffff, alpha: 0.9 })
    ticks.place(content.x, content.y, content.width, content.height)

    headerSlot.position.set(Math.round(content.x), Math.round(content.y))
    const baseline = baselineOf(title.style)
    const capMiddle = baseline - (CAP_HEIGHT * Number(title.style.fontSize)) / 2
    const onBaseline = (style: TextStyle) => Math.round(baseline - baselineOf(style))
    diamond.position.set(0, Math.round(capMiddle - 4))
    number.position.set(18, onBaseline(number.style))
    title.position.set(Math.round(number.x + number.width + 12), 0)
    kanji.position.set(Math.round(title.x + title.width + 12), onBaseline(kanji.style))
    const labelCapMiddle = baselineOf(backLabel.style) - (CAP_HEIGHT * Number(backLabel.style.fontSize)) / 2
    backLabel.position.set(Math.round(backKey.width + 8), 0)
    backKey.y = Math.round(labelCapMiddle - backKey.height / 2)
    const backWidth = Math.round(backLabel.x + backLabel.width)
    backButton.position.set(Math.round(content.width - backWidth), onBaseline(backLabel.style))
    backButton.hitArea = new Rectangle(-8, Math.round(labelCapMiddle - 22), backWidth + 16, 44)

    const ruleY = Math.round(content.y + title.height + RULE_GAP)
    ruleSlot.position.set(Math.round(content.x), ruleY)
    line.clear().rect(0, 0, content.width, 1).fill({ color: PALETTE.paper, alpha: 0.18 })
    bodySlot.position.set(Math.round(content.x), ruleY + BODY_GAP)
    if (mounted !== null && viewport !== null) mounted.body.layout(content.width, Math.max(0, content.y + content.height - ruleY - BODY_GAP - FOOT), viewport)
  }

  const mount = (next: SheetEntry | null) => {
    if (mounted !== null && mounted !== next) body.removeChild(mounted.body.node)
    mounted = next
    if (next !== null) body.addChild(next.body.node)
  }

  const tint = (accent: Accent) => {
    edge.tint = accent.accent
    diamond.tint = accent.accent
    number.tint = accent.accent
    dash.tint = accent.accent
  }
  tint(accentOf("courtyard"))

  return {
    node,
    show: (next) => {
      motion?.kill()
      entry = next
      next.body.refresh()
      number.text = next.number
      title.text = next.title.toUpperCase()
      kanji.text = next.kanji
      mount(next)
      arrange()
      motion = gsap.timeline()
        .add(shown(node, true), 0)
        .fromTo(slide, away(), { x: 0, y: 0, duration: 0.3, ease: drawn(0.3, "expo.out", ON_ONES) }, 0)
        .add(ticks.pop(2.4, 0.24, drawn(0.24, "power3.out", ON_ONES), 0.03), 0.08)
        .fromTo(header, { x: -16, alpha: 0 }, { x: 0, alpha: 1, duration: 0.3, ease: "power3.out" }, 0.1)
        .fromTo(rule.scale, { x: 0 }, { x: 1, duration: 0.24, ease: drawn(0.24, "power3.out", ON_ONES) }, 0.1)
        .fromTo(body, { y: 12, alpha: 0 }, { y: 0, alpha: 1, duration: 0.32, ease: "power3.out" }, 0.14)
      return motion
    },
    hide: () => {
      motion?.kill()
      entry = null
      motion = gsap.timeline()
        .to([header, body], { alpha: 0, duration: 0.12 })
        .to(slide, { ...away(), duration: 0.22, ease: drawn(0.22, "power2.in", ON_ONES) })
        .add(shown(node, false))
        .add(() => mount(null))
      return motion
    },
    key: (event) => entry?.body.key(event) ?? false,
    layout: (sheet, content, viewport) => {
      box = { sheet, content, viewport }
      arrange()
    },
    tint
  }
}
