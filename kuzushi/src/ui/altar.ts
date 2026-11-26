import { gsap } from "gsap"
import { Color, Container, FillGradient, Graphics, Rectangle } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { weaponOf } from "../sim/index.ts"
import type { AltarView, WeaponId } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { createCorners } from "./kit/corners.ts"
import { keycap } from "./kit/keycap.ts"
import { createPlate } from "./kit/plate.ts"
import { baselineOf, lineBaseline, onBaseline, ownedFaces, placeInLine, shadowOf, textIn } from "./kit/type.ts"
import type { Shadow } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { createWipe } from "./kit/wipe.ts"
import { drawn, ON_ONES, rattle, shown } from "./motion.ts"
import type { Staged, Tinted } from "./screen.ts"
import { STYLE_NAMES } from "./weapon-hud.ts"

/** Where on screen a point on the ground is, in CSS pixels; null when it is behind the camera. */
export type Project = (x: number, y: number, z: number) => { readonly x: number; readonly y: number } | null

/** How high above the altar's centre the prompt points, in world units: just over the kanji floating above it. */
const ANCHOR_HEIGHT = 2.4

/** The least room kept between the card and the screen's edge, in px. */
const EDGE = 16
/** The card's width and padding inside its 1 px border, the stem under it, px. */
const WIDTH = 300
const PAD = { top: 12, side: 16, bottom: 14 } as const
const STEM = 30
const INNER = WIDTH - 2 - 2 * PAD.side
/** The line's height: Barlow 12.5 px at line-height 1.45. */
const LINE = 12.5 * 1.45

const glowOf = (accent: Accent): Shadow => ({ color: accent.accent, alpha: 0.55, blur: 14 })

export interface AltarPrompt extends Staged, Tinted {
  /** Every frame: the altars in the room, the weapon in hand, and whether the prompt may show (no banner, map or transition up). */
  update(altars: ReadonlyArray<AltarView>, hand: WeaponId, visible: boolean): void
}

/**
 * The altar's prompt while the hero stands within reach: a framed card over the altar with E TAKE, the weapon's
 * kanji, name and style, what it does in a line, and the weapon in hand, which goes onto the altar. Taking it stamps
 * the card with the swap; walking away folds it. It waits while a banner plays (the caller's `visible`), so the two
 * cards never cross at the top of the frame.
 */
export const createAltarPrompt = (project: Project): AltarPrompt => {
  const node = new Container({ label: "altar" })
  node.visible = false
  node.alpha = 0
  const faces = ownedFaces()

  const stemFill = new FillGradient({
    end: { x: 0, y: 1 },
    colorStops: [
      { offset: 0, color: new Color(PALETTE.paper).setAlpha(0.18) },
      { offset: 1, color: new Color(PALETTE.paper) }
    ]
  })
  const stem = new Graphics().rect(0, -STEM, 1, STEM).fill(stemFill)

  const card = new Container({ label: "altar-card" })
  const body = new Container()
  const wipe = createWipe("bottom")
  // The card's backdrop-filter was blur(4px), not the panels' 6.
  const plate = createPlate(0.78, 4)
  const ticks = createCorners({ arm: 12, weight: 1, color: PALETTE.paper, alpha: 0.85 })
  const content = new Container()
  content.position.set(1 + PAD.side, 1 + PAD.top)

  const key = keycap("E", { paint: "inverted", fixed: true })
  const verb = textIn("TAKE", faces.style({ family: "condensed", weight: "500", size: 13, tracking: 0.4 }), PALETTE.paper)
  const rule = new Graphics().rect(0, 0, 1, 1).fill({ color: PALETTE.paper, alpha: 0.18 })
  const styleName = textIn("", faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.36 }))
  const kanjiStyle = faces.style({ family: "jp", size: 34, shadow: glowOf(accentOf("courtyard")) }, PALETTE.paper)
  const kanji = textIn("", kanjiStyle)
  const kanjiBody = new Container()
  kanjiBody.addChild(kanji)
  const name = textIn("", faces.style({ family: "condensed", weight: "600", size: 22, tracking: 0.36 }), PALETTE.paper)
  const lineStyle = faces.style({ family: "text", weight: "400", size: 12.5, tracking: 0.02 }, { color: PALETTE.paper, alpha: 0.82 })
  lineStyle.wordWrap = true
  lineStyle.wordWrapWidth = INNER
  lineStyle.lineHeight = LINE
  const line = textIn("", lineStyle)
  const handRule = new Graphics().rect(0, 0, INNER, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
  const handWordStyle = faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.34 })
  const handWord = textIn("IN HAND", handWordStyle, PALETTE.concrete300)
  const handName = textIn("", handWordStyle, PALETTE.paper)
  const handKanji = textIn("", faces.style({ family: "jp", size: 14 }), PALETTE.paper)
  content.addChild(key, verb, rule, styleName, kanjiBody, name, line, handRule, handWord, handName, handKanji)
  body.addChild(plate.node, ticks.node, content, wipe.mask)
  body.mask = wipe.mask
  card.addChild(body)
  node.addChild(stem, card)

  let screenWidth = 0
  let height = 0
  let shownKey: string | null = null

  /** Sets the card's rows from the top of its content and sizes its plate round them. */
  const arrange = () => {
    key.position.set(0, 0)
    const head = Math.max(19, key.height)
    placeInLine(verb, key.width + 8, 0, head)
    placeInLine(styleName, INNER - styleName.style.letterSpacing - styleName.width, 0, head)
    const ruleFrom = verb.x + verb.width + verb.style.letterSpacing + 8
    rule.position.set(Math.round(ruleFrom), Math.round(head / 2))
    rule.scale.x = Math.max(0, Math.round(styleName.x - 8 - ruleFrom))

    const weaponTop = head + 10
    const kanjiBox = 34
    kanji.position.set(0, Math.round(weaponTop + lineBaseline(kanjiStyle, kanjiBox) - baselineOf(kanjiStyle)))
    kanjiBody.pivot.set(Math.round(kanji.width / 2), Math.round(weaponTop + kanjiBox / 2))
    kanjiBody.position.copyFrom(kanjiBody.pivot)
    placeInLine(name, kanji.width + 12, weaponTop, kanjiBox)

    const lineTop = weaponTop + kanjiBox + 8
    const lines = Math.max(1, Math.round(line.height / LINE))
    placeInLine(line, 0, lineTop)
    const handTop = lineTop + lines * LINE + 10
    handRule.y = Math.round(handTop)
    handWord.x = 0
    handName.x = Math.round(handWord.width + handWord.style.letterSpacing + 8)
    handKanji.x = Math.round(handName.x + handName.width + handName.style.letterSpacing + 8)
    const handHeight = onBaseline(handTop + 1 + 8, [handWord, handName, handKanji])

    height = Math.round(1 + PAD.top + handTop + 9 + handHeight + PAD.bottom + 1)
    plate.draw(WIDTH, height)
    ticks.place(0, 0, WIDTH, height)
    wipe.fit(new Rectangle(0, 0, WIDTH, height))
    card.position.set(-WIDTH / 2, -STEM - height)
  }

  const fill = (weapon: WeaponId, hand: WeaponId) => {
    const info = weaponOf(weapon)
    const held = weaponOf(hand)
    kanji.text = info.kanji
    name.text = info.name.toUpperCase()
    styleName.text = STYLE_NAMES[info.style].toUpperCase()
    line.text = info.line
    handName.text = held.name.toUpperCase()
    handKanji.text = held.kanji
    arrange()
  }

  /** The kanji stamps in from `from` times its size, turning a little as it lands on opening. */
  const stamp = (from: number, duration: number, turn: boolean) => {
    const ease = drawn(duration, "power4.in", ON_ONES)
    return gsap.timeline()
      .fromTo(kanjiBody.scale, { x: from, y: from }, { x: 1, y: 1, duration, ease }, 0)
      .fromTo(kanjiBody, { alpha: 0, angle: turn ? -12 : 0 }, { alpha: 1, angle: 0, duration, ease }, 0)
  }

  const open = () => {
    gsap.killTweensOf([node, body, wipe, stem.scale, kanjiBody, kanjiBody.scale])
    node.visible = true
    node.alpha = 1
    gsap.timeline()
      .fromTo(stem.scale, { y: 0 }, { y: 1, duration: 0.16, ease: drawn(0.16, "power3.out", ON_ONES) }, 0)
      .fromTo(wipe, { amount: 0 }, { amount: 1, duration: 0.24, ease: drawn(0.24, "expo.out", ON_ONES) }, 0.06)
      .fromTo(body, { y: 10 }, { y: 0, duration: 0.24, ease: drawn(0.24, "expo.out", ON_ONES) }, 0.06)
      .add(stamp(2, 0.18, true), 0.16)
  }

  return {
    node,
    update: (altars, hand, visible) => {
      const near = visible ? altars.find((altar) => altar.near && altar.weapon !== null) : undefined
      if (near === undefined || near.weapon === null) {
        if (shownKey !== null) shown(node, false, 0.15)
        shownKey = null
        return
      }
      const keyOf = `${near.index}:${near.weapon}`
      if (shownKey === null) {
        fill(near.weapon, hand)
        open()
      } else if (keyOf !== shownKey) {
        fill(near.weapon, hand)
        stamp(2.2, 0.2, false)
        rattle(body, 6, 0.3)
      }
      shownKey = keyOf
      const at = project(near.x, ANCHOR_HEIGHT, near.z)
      if (at === null) return
      const half = WIDTH / 2 + EDGE
      const x = Math.min(Math.max(at.x, half), screenWidth - half)
      const y = Math.max(at.y, height + STEM + EDGE)
      node.position.set(Math.round(x), Math.round(y))
    },
    layout: (viewport: Viewport) => {
      screenWidth = viewport.width
      arrange()
    },
    tint: (next) => {
      styleName.tint = next.accent
      kanjiStyle.dropShadow = shadowOf(glowOf(next))
    },
    dispose: () => {
      gsap.killTweensOf([node, body, wipe, stem.scale, kanjiBody, kanjiBody.scale])
      node.destroy({ children: true })
      stemFill.destroy()
      faces.release()
    }
  }
}
