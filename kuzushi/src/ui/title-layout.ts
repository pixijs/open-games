import { clamp } from "math"
import { Rectangle } from "pixi.js"

import type { MenuLook } from "./kit/menu.ts"
import type { Viewport } from "./kit/viewport.ts"

/**
 * Where everything on the title sits, in CSS pixels. Wide, the wordmark, 崩し and the menu (centred down the screen)
 * hold a column in the left half over the scene, and a panel's sheet covers the right half. Narrow, they stack and a
 * sheet covers the whole screen.
 */
export interface TitleLayout {
  readonly narrow: boolean
  /** The text column's left and right edges. */
  readonly column: { readonly left: number; readonly right: number }
  /** The letters' left and top, and their width. */
  readonly wordmark: { readonly x: number; readonly y: number; readonly letterWidth: number }
  /** 崩し under the wordmark: its top-left and size, and where its rule ends. */
  readonly kicker: { readonly x: number; readonly y: number; readonly size: number; readonly ruleTo: number }
  /** The menu's top-left and how it is set. */
  readonly menu: { readonly x: number; readonly y: number; readonly look: MenuLook }
  /** The hints' left and middle line, and where their rule ends (at `x` when there is none). */
  readonly footer: { readonly x: number; readonly y: number; readonly ruleTo: number }
  /** The screen's corner ticks. */
  readonly frame: Rectangle
  /** A panel's sheet. */
  readonly sheet: Rectangle
  /** What a sheet's header and body fill. */
  readonly content: Rectangle
}

/** START, CONTROLS, SETTINGS, EXTRAS. */
const MENU_ITEMS = 4

const lookOf = (width: number, size: number): MenuLook => ({
  width,
  size,
  tracking: 0.06,
  row: Math.round(1.22 * size),
  gap: Math.round(0.14 * size),
  indent: Math.round(0.82 * size)
})

const menuHeight = (look: MenuLook) => MENU_ITEMS * look.row + (MENU_ITEMS - 1) * look.gap

/** `letterHeight` gives the wordmark's letters' height at a width (the wordmark's aspect), so this stays pure. */
export const titleLayout = (v: Viewport, letterHeight: (width: number) => number): TitleLayout => {
  const { width: W, height: H, margin: m, narrow } = v
  const left = m
  const right = narrow ? W - m : Math.round(0.43 * W)
  const columnWidth = right - left

  const letterWidth = narrow ? Math.min(W - 2 * m, 480) : columnWidth
  const letterTop = narrow ? m + 8 : m + 0.02 * H
  const lettersBottom = letterTop + letterHeight(letterWidth)

  const kickerSize = clamp(0.03 * H, 20, 30)
  const kickerY = lettersBottom + 0.035 * H
  const kickerBottom = kickerY + kickerSize

  const size = narrow ? Math.round(clamp(Math.min(0.085 * W, 0.06 * H), 28, 44)) : Math.round(clamp(Math.min(0.036 * W, 0.072 * H), 40, 64))
  const look = lookOf(columnWidth, size)
  const footerY = H - m - 12
  // Centred down the screen, but never up into 崩し nor down into the keys along the foot.
  const menuY = clamp((H - menuHeight(look)) / 2, kickerBottom + 0.04 * H, footerY - 40 - menuHeight(look))

  const sheetX = Math.round(0.5 * W)
  const contentX = sheetX + clamp(0.034 * W, 32, 64)
  return {
    narrow,
    column: { left, right },
    wordmark: { x: left, y: letterTop, letterWidth },
    kicker: { x: left, y: kickerY, size: kickerSize, ruleTo: right },
    menu: { x: left, y: menuY, look },
    footer: { x: left, y: footerY, ruleTo: narrow ? left : right },
    frame: new Rectangle(0.5 * m, 0.5 * m, W - m, H - m),
    sheet: narrow ? new Rectangle(0, 0, W, H) : new Rectangle(sheetX, 0, W - sheetX, H),
    content: narrow ? new Rectangle(m, m, W - 2 * m, H - 2 * m) : new Rectangle(contentX, m, W - m - contentX, H - 2 * m - 40)
  }
}
