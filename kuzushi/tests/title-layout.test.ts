import { Rectangle } from "pixi.js"
import { describe, expect, test } from "vitest"

import { viewportOf } from "../src/ui/kit/viewport.ts"
import { titleLayout } from "../src/ui/title-layout.ts"

/** The wordmark's letters, width over height. */
const ASPECT = 4.07
const SIZES = [[1280, 720], [1680, 800], [1920, 1080], [700, 900], [390, 844]] as const
const WIDE_SIZES: Readonly<Record<string, number>> = { "1280x720": 46, "1680x800": 58, "1920x1080": 64 }

const layoutAt = (width: number, height: number) => titleLayout(viewportOf(width, height, 1), (letters) => letters / ASPECT)

const inside = (box: Rectangle, width: number, height: number) => {
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(width + 1e-6)
  expect(box.bottom).toBeLessThanOrEqual(height + 1e-6)
}

describe.each(SIZES)("the title at %ix%i", (width, height) => {
  const layout = layoutAt(width, height)
  const { look } = layout.menu
  const menuBottom = layout.menu.y + 4 * look.row + 3 * look.gap
  const lettersBottom = layout.wordmark.y + layout.wordmark.letterWidth / ASPECT

  test("every box lies on screen", () => {
    inside(layout.frame, width, height)
    inside(layout.sheet, width, height)
    inside(layout.content, width, height)
    inside(new Rectangle(layout.wordmark.x, layout.wordmark.y, layout.wordmark.letterWidth, lettersBottom - layout.wordmark.y), width, height)
    inside(new Rectangle(layout.kicker.x, layout.kicker.y, layout.kicker.ruleTo - layout.kicker.x, layout.kicker.size), width, height)
    inside(new Rectangle(layout.menu.x, layout.menu.y, look.width, menuBottom - layout.menu.y), width, height)
    inside(new Rectangle(layout.footer.x, layout.footer.y, layout.footer.ruleTo - layout.footer.x, 0), width, height)
  })

  test("the menu sits under 崩し and above the footer", () => {
    expect(layout.menu.y).toBeGreaterThanOrEqual(layout.kicker.y + layout.kicker.size + 16)
    expect(menuBottom).toBeLessThanOrEqual(layout.footer.y - 12)
  })

  if (!layout.narrow) {
    test("the menu sits near the middle of the screen", () => {
      const middle = layout.menu.y + (menuBottom - layout.menu.y) / 2
      expect(Math.abs(middle - height / 2)).toBeLessThanOrEqual(0.1 * height)
    })

    test("the column keeps to the left half and the sheet takes the right half", () => {
      expect(layout.menu.x + look.width).toBeLessThanOrEqual(width / 2)
      expect(layout.column.right).toBeLessThanOrEqual(width / 2)
      const half = Math.round(width / 2)
      expect(layout.sheet).toEqual(new Rectangle(half, 0, width - half, height))
    })

    test("the menu is set large", () => {
      expect(look.size).toBe(WIDE_SIZES[`${width}x${height}`])
    })
  } else {
    test("a sheet covers the whole screen", () => {
      expect(layout.sheet).toEqual(new Rectangle(0, 0, width, height))
    })
  }
})
