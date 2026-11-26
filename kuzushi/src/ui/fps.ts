import { Container, Text } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { settings } from "../art/settings.ts"
import { digits, placeDigits } from "./kit/digits.ts"
import { face, lineHeightOf, placeInLine, release } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import type { Staged } from "./screen.ts"

/** How often the readout changes, in seconds: fast enough to see a drop, slow enough to read. */
const REFRESH = 0.25
const SIZE = 12
const TRACKING = 0.2

export interface Fps extends Staged {
  /** Every frame; `title` moves it in from the corner, clear of the title's frame. */
  update(title: boolean): void
}

/** Frames per second in the bottom-right corner while the Show FPS setting is on, averaged over each refresh. */
export const createFps = (): Fps => {
  const node = new Container({ label: "fps" })
  const value = digits({ family: "condensed", weight: "500", size: SIZE, tracking: TRACKING }, PALETTE.paper)
  const unitStyle = face({ family: "condensed", weight: "500", size: SIZE, tracking: TRACKING })
  const unit = new Text({ text: " FPS", style: unitStyle, roundPixels: true })
  unit.tint = PALETTE.concrete300
  node.addChild(value, unit)
  let frames = 0
  let since = performance.now()
  let viewport: Viewport | null = null
  let atTitle = false

  /** From the right: " FPS" with its last glyph's tracking inside the corner's edge, the figures before it. */
  const place = () => {
    if (viewport === null) return
    const { width: W, height: H, margin: m } = viewport
    const right = atTitle ? W - (0.5 * m + 28) : W - 12
    const bottom = atTitle ? H - (0.5 * m + 4) : H - 8
    const top = bottom - lineHeightOf(unitStyle)
    placeInLine(unit, right - unitStyle.letterSpacing - unit.width, top)
    placeDigits(value, unit.x - value.width, top)
  }

  const off = settings.subscribe((values) => {
    node.visible = values.fps
    frames = 0
    since = performance.now()
  })

  return {
    node,
    update: (title) => {
      if (title !== atTitle) {
        atTitle = title
        place()
      }
      if (!settings.get().fps) return
      frames += 1
      const now = performance.now()
      const seconds = (now - since) / 1000
      if (seconds < REFRESH) return
      const text = `${Math.round(frames / seconds)}`
      if (text.length !== value.text.length) {
        value.text = text
        place()
      } else value.text = text
      frames = 0
      since = now
    },
    layout: (next) => {
      viewport = next
      place()
    },
    dispose: () => {
      off()
      node.destroy({ children: true })
      release(unitStyle)
    }
  }
}
