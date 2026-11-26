import { clamp } from "math"
import { Container } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { listExtras } from "../extras.ts"
import { createMenu, DETAIL_GAP } from "../kit/menu.ts"
import type { Menu } from "../kit/menu.ts"
import type { PanelBody } from "../kit/sheet.ts"
import { text } from "../kit/type.ts"
import type { Viewport } from "../kit/viewport.ts"

/** A label's line over its size: Barlow Condensed's ascent and descent. */
const LEAD = 1.2
/** Room above and below a row's text inside its bar, px: a detail stays on the brush and clear of the brackets. */
const PAD = 4
/** The labels' smallest size, px. */
const MIN_SIZE = 18
/** Under this width a detail would wrap into the next row, so rows show their labels alone; likewise when too short. */
const MIN_DETAIL_WIDTH = 440

/** The EXTRAS panel: a menu of every registered extra (the lab's scenes), or a line saying there are none. */
export const createExtras = (): PanelBody => {
  const node = new Container({ label: "extras" })
  const empty = text("NO EXTRAS INSTALLED", "small", PALETTE.concrete300)
  node.addChild(empty)
  /** Measures a detail's line at the type scale; never drawn. */
  const line = text("Ag", "body")
  let menu: Menu | null = null
  let details = true
  let box: { readonly width: number; readonly height: number; readonly viewport: Viewport } | null = null

  const build = () => {
    menu?.node.destroy({ children: true, context: true })
    menu = null
    const extras = listExtras()
    empty.visible = extras.length === 0
    if (extras.length === 0) return
    menu = createMenu(extras.map((extra) => (details ? { label: extra.label, detail: extra.detail, action: extra.open } : { label: extra.label, action: extra.open })))
    node.addChild(menu.node)
    menu.reset()
  }

  /** How the rows fit every extra in the box's height, label and detail inside each row's bar, and whether the details fit. */
  const sizes = (width: number, height: number, viewport: Viewport) => {
    const count = Math.max(1, listExtras().length)
    const most = Math.floor(height / count)
    const detail = DETAIL_GAP + line.height
    const rowOf = (size: number, details: boolean) => Math.round(LEAD * size) + 2 * PAD + (details ? detail : 0)
    const details = width >= MIN_DETAIL_WIDTH && rowOf(MIN_SIZE, true) <= most
    const room = (most - 2 * PAD - (details ? detail : 0)) / LEAD
    const size = Math.round(Math.max(MIN_SIZE, Math.min(clamp(0.018 * viewport.width, 20, 30), room)))
    const row = Math.min(rowOf(size, details), most)
    return { size, row, gap: count * (row + 4) <= height ? 4 : 0, details }
  }

  /** Sizes the menu to its box, rebuilding it with or without details when that changes. */
  const fit = () => {
    if (box === null) return
    const { size, row, gap, details: fits } = sizes(box.width, box.height, box.viewport)
    if (fits !== details) {
      details = fits
      build()
    }
    menu?.layout({ width: box.width, size, tracking: 0.16, row, gap, indent: Math.round(0.6 * size) })
  }

  node.once("destroyed", () => line.destroy())

  return {
    node,
    refresh: () => {
      if (box !== null) details = sizes(box.width, box.height, box.viewport).details
      build()
      fit()
    },
    key: (event) => menu?.key(event) ?? false,
    layout: (width, height, viewport) => {
      box = { width, height, viewport }
      fit()
    }
  }
}
