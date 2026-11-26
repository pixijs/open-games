import { Container, Graphics } from "pixi.js"
import type { Text, TextStyle } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"
import { baselineOf, CAP_HEIGHT, face, lineBaseline, text } from "./type.ts"

/** How a key is drawn beside the plain one (ink box, paper edge and letters, in the type scale's key role). */
export interface KeyLook {
  /**
   * "tinted" draws its edge and letters white for the node's `tint` to colour (the HUD's accent keys); "inverted" is a
   * paper box with ink letters (the altar's E).
   */
  readonly paint?: "plain" | "tinted" | "inverted"
  /** At a fixed 12 px rather than the type scale's: keys on the HUD and the altar's card. */
  readonly fixed?: boolean
}

interface Cap {
  readonly node: Container
  readonly letters: Text
  /** Draws the box round the letters at their current size. */
  fit(): void
}

/** A fixed key's letters at 12 px, made once a key asks for them. */
let fixedStyle: TextStyle | null = null
const fixedFace = () => {
  fixedStyle ??= face({ family: "condensed", weight: "600", size: 12, tracking: 0.12 })
  return fixedStyle
}

/** A fixed key's box round 12 px letters at line-height 1: 3 px padding over them, 2 under, 6 each side, a 1 px border. */
const FIXED = { top: 1 + 3, side: 1 + 6, height: 1 + 3 + 12 + 2 + 1, min: 18 } as const

/** Where a fixed key's letters' baseline sits below its top, for words set beside it on the same line. */
export const fixedKeyBaseline = (): number => FIXED.top + lineBaseline(fixedFace(), 12)

const cap = (label: string, look: KeyLook = {}): Cap => {
  const node = new Container({ label: `key ${label}` })
  const box = new Graphics()
  const paint = look.paint ?? "plain"
  const letters = text(label.toUpperCase(), "key", paint === "inverted" ? PALETTE.ink : paint === "tinted" ? 0xffffff : PALETTE.paper)
  const fixed = look.fixed === true
  if (fixed) letters.style = fixedFace()
  node.addChild(box, letters)
  return {
    node,
    letters,
    fit: () => {
      // A fixed key's box holds its letters' trailing tracking, centred, at line-height 1.
      const run = letters.width + (fixed ? letters.style.letterSpacing : 0)
      const width = fixed ? Math.max(FIXED.min, Math.round(run + 2 * FIXED.side)) : Math.max(18, Math.round(letters.width) + 12)
      const height = fixed ? FIXED.height : Math.round(letters.height) + 6
      box.clear().rect(0, 0, width, height)
      if (paint === "inverted") box.fill(PALETTE.paper)
      else box.fill({ color: PALETTE.ink, alpha: 0.4 }).stroke({ width: 1, color: paint === "tinted" ? 0xffffff : PALETTE.paper, alpha: paint === "tinted" ? 1 : 0.34, alignment: 1 })
      const size = Number(letters.style.fontSize)
      const top = fixed ? FIXED.top + lineBaseline(letters.style, 12) : (height + CAP_HEIGHT * size) / 2
      letters.position.set(Math.round((width - run) / 2), Math.round(top - baselineOf(letters.style)))
    }
  }
}

/** Runs `layout` now and again whenever one of `texts`' styles changes (the type scale, late fonts), until `node` is destroyed. */
const follow = (node: Container, texts: ReadonlyArray<Text>, layout: () => void) => {
  layout()
  const styles = new Set(texts.map((each) => each.style))
  for (const style of styles) style.on("update", layout)
  node.once("destroyed", () => {
    for (const style of styles) style.off("update", layout)
  })
}

/** A key's name in a box. It refits itself when its type changes. */
export const keycap = (label: string, look?: KeyLook): Container => {
  const key = cap(label, look)
  follow(key.node, [key.letters], key.fit)
  return key.node
}

/** Keycaps then what they do, in a row: `hint(["W", "S"], "Select")`. */
export const hint = (keys: ReadonlyArray<string>, words: string): Container => {
  const node = new Container({ label: `hint ${words}` })
  const caps = keys.map((key) => cap(key))
  const label = text(words.toUpperCase(), "small", PALETTE.concrete300)
  node.addChild(...caps.map((key) => key.node), label)
  follow(node, [...caps.map((key) => key.letters), label], () => {
    let x = 0
    for (const key of caps) {
      key.fit()
      key.node.x = x
      x += Math.round(key.node.width) + 2
    }
    const first = caps[0]?.letters
    label.position.set(caps.length === 0 ? 0 : x - 2 + 8, first === undefined ? 0 : Math.round(first.y + baselineOf(first.style) - baselineOf(label.style)))
  })
  return node
}

/** Makes `node` a back action: it takes the pointer, its `label` lights to paper under it, and a left click calls `onBack`. */
export const backAction = (node: Container, label: Text, onBack: () => void): void => {
  node.eventMode = "static"
  node.cursor = "pointer"
  node.on("pointerover", () => {
    label.tint = PALETTE.paper
  })
  node.on("pointerout", () => {
    label.tint = PALETTE.concrete300
  })
  node.on("pointertap", (event) => {
    if (event.button === 0) onBack()
  })
}
