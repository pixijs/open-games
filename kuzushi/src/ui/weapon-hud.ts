import { gsap } from "gsap"
import { Container, Graphics, SmoothGraphics, Text } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { weaponOf } from "../sim/index.ts"
import type { WeaponId, WeaponStyle, WeaponView } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { blurSprite } from "./kit/glow.ts"
import { baselineOf, face, lineBaseline, placeInLine, release, shadowOf, textIn } from "./kit/type.ts"
import type { Shadow } from "./kit/type.ts"
import { drawn, ON_ONES, rattle } from "./motion.ts"

/** What each style is called under the weapon's name. */
export const STYLE_NAMES = { melee: "Melee", heavy: "Heavy", ranged: "Ranged", magic: "Magic" } as const satisfies Record<WeaponStyle, string>

/** Pips drawn for the darts' clip. */
const CLIP = 6
/** A dart's pip: a slanted needle in an 8x16 box, drawn 8x15. */
const PIP = [5.5, 1, 7, 1, 2.5, 15, 1, 15]
const PIP_SCALE = 15 / 16
/** The mark's box, the framed square turned inside it, and the gap to the text. */
const MARK = 54
const FRAME = 38
const TEXT_GAP = 14
/** The text column's rows, px: name, style, the darts' pips and charge, and the gaps between them. */
const NAME = 15
const STYLE = 10.5
const GAP = 5
const AMMO_TOP = NAME + GAP + STYLE + GAP + 3
const CHARGE_TOP = AMMO_TOP + 15 + GAP + 2
const CHARGE_WIDTH = 66
/** Space under the row, px. */
const FOOT = 3

const kanjiShadow = (accent: Accent): Shadow => ({ color: accent.accent, alpha: 0.55, blur: 10 })

export interface WeaponHud {
  readonly node: Container
  /** Every frame; returns true when the weapon changed, so its box may have (its name, the darts' pips) and its owner should place it again. */
  update(view: WeaponView): boolean
  /** Sets the narrow layout (no text) and returns the box's size. */
  layout(narrow: boolean): { readonly width: number; readonly height: number }
  reset(): void
  tint(accent: Accent): void
  dispose(): void
}

/**
 * The weapon in hand, beside the vitals: its kanji in a framed square turned 45°, its name and its style, and for the
 * darts a pip per shot loaded and the charge filling while attack is held. Taking a weapon stamps the new kanji in; a
 * dash's reload sweeps the pips full. Its text wears `shadow`, as the rest of the vitals.
 */
export const createWeaponHud = (shadow: Shadow): WeaponHud => {
  const node = new Container({ label: "weapon" })
  /** The mark's place in the row; the mark itself rattles. */
  const markSlot = new Container({ label: "weapon-mark" })
  const mark = new Container()
  markSlot.addChild(mark)
  const frame = new Container()
  frame.position.set(MARK / 2, MARK / 2)
  frame.angle = 45
  const square = new Graphics().rect(-FRAME / 2, -FRAME / 2, FRAME, FRAME).fill({ color: PALETTE.ink, alpha: 0.6 }).stroke({ width: 1, color: PALETTE.paper, alignment: 1 })
  // A 14 px glow outside the square and a 10 px one inset inside its border: blur deviations 7 and 5.
  const outer = new Container()
  const outerHole = new Graphics().rect(-FRAME / 2, -FRAME / 2, FRAME, FRAME).fill(0xffffff)
  outer.setMask({ mask: outerHole, inverse: true })
  const outerReach = FRAME / 2 + 21
  const outerGlow = blurSprite(`<rect x="${-FRAME / 2}" y="${-FRAME / 2}" width="${FRAME}" height="${FRAME}"/>`, { x: -outerReach, y: -outerReach, width: 2 * outerReach, height: 2 * outerReach }, 7, { width: 4 * outerReach, height: 4 * outerReach }, "weapon-mark")
  outerGlow.alpha = 0.28
  outer.addChild(outerGlow)
  const inner = new Container()
  const innerClip = new Graphics().rect(1 - FRAME / 2, 1 - FRAME / 2, FRAME - 2, FRAME - 2).fill(0xffffff)
  inner.mask = innerClip
  const innerReach = FRAME / 2 - 1 + 15
  const ring = `M${-innerReach} ${-innerReach}H${innerReach}V${innerReach}H${-innerReach}ZM${1 - FRAME / 2} ${1 - FRAME / 2}H${FRAME / 2 - 1}V${FRAME / 2 - 1}H${1 - FRAME / 2}Z`
  const innerGlow = blurSprite(`<path fill-rule="evenodd" d="${ring}"/>`, { x: -innerReach, y: -innerReach, width: 2 * innerReach, height: 2 * innerReach }, 5, { width: 4 * innerReach, height: 4 * innerReach }, "weapon-mark-inset")
  innerGlow.alpha = 0.22
  inner.addChild(innerGlow)
  frame.addChild(outerHole, outer, square, inner, innerClip)
  const kanjiStyle = face({ family: "jp", size: 24, shadow: kanjiShadow(accentOf("courtyard")) })
  kanjiStyle.fill = PALETTE.paper
  const kanji = new Text({ text: "", style: kanjiStyle, roundPixels: true })
  kanji.position.set(MARK / 2, MARK / 2)
  mark.addChild(frame, kanji)

  const column = new Container({ label: "weapon-text" })
  const nameStyle = face({ family: "condensed", weight: "500", size: NAME, tracking: 0.36, shadow })
  const styleStyle = face({ family: "condensed", weight: "500", size: STYLE, tracking: 0.42, shadow })
  const name = textIn("", nameStyle, PALETTE.paper)
  const style = textIn("", styleStyle, PALETTE.concrete300)
  const nameSlot = new Container()
  const styleSlot = new Container()
  nameSlot.addChild(name)
  styleSlot.addChild(style)

  const ammo = new Container({ label: "weapon-ammo" })
  const pips = Array.from({ length: CLIP }, (_, index) => {
    const slot = new Container()
    slot.position.set(index * 11 + 4, AMMO_TOP + 7.5)
    const body = new Container()
    body.pivot.set(4, 7.5)
    const units = new Container()
    units.scale.set(PIP_SCALE)
    units.x = 0.25
    const empty = new SmoothGraphics().poly(PIP).stroke({ width: 1, color: 0xffffff })
    const fill = new SmoothGraphics().poly(PIP).fill(PALETTE.paper)
    fill.visible = false
    units.addChild(empty, fill)
    body.addChild(units)
    slot.addChild(body)
    ammo.addChild(slot)
    return { body, empty, fill }
  })
  const charge = new Container({ label: "weapon-charge" })
  charge.position.set(0, CHARGE_TOP)
  charge.alpha = 0
  const chargeTrack = new Graphics().rect(0, 0, CHARGE_WIDTH, 2).fill({ color: PALETTE.paper, alpha: 0.18 })
  const chargeFill = new Graphics().rect(0, 0, CHARGE_WIDTH, 2).fill(0xffffff)
  chargeFill.scale.x = 0
  charge.addChild(chargeTrack, chargeFill)
  column.addChild(nameSlot, styleSlot, ammo, charge)
  node.addChild(markSlot, column)

  let accent = accentOf("courtyard")
  let weapon: WeaponId | null = null
  let loaded = -1
  let charging = false
  let chargeFull = false
  let emptyClip = false
  let narrow = false

  const darts = () => weapon === "darts"
  /** The row's height: the mark's, or the text column's if taller; narrow, the hidden column takes no room. */
  const height = () => (narrow ? MARK : Math.max(MARK, darts() ? CHARGE_TOP + 2 : NAME + GAP + STYLE)) + FOOT

  const paintPips = () => {
    for (const pip of pips) {
      pip.empty.tint = emptyClip ? accent.accent : PALETTE.paper
      pip.empty.alpha = emptyClip ? 1 : 0.36
    }
  }

  const arrange = () => {
    kanji.pivot.set(Math.round(kanji.getLocalBounds().width / 2), Math.round(baselineOf(kanjiStyle) - lineBaseline(kanjiStyle, 24) + 12))
    const box = height() - FOOT
    const middle = box / 2
    markSlot.y = Math.round(middle - MARK / 2)
    const columnHeight = darts() ? CHARGE_TOP + 2 : NAME + GAP + STYLE
    column.position.set(MARK + TEXT_GAP, Math.round(middle - columnHeight / 2))
    column.visible = !narrow
    placeInLine(name, 0, 0, NAME)
    placeInLine(style, 0, NAME + GAP, STYLE)
    ammo.visible = darts()
    charge.visible = darts()
  }

  const show = (id: WeaponId, stamp: boolean) => {
    const info = weaponOf(id)
    kanji.text = info.kanji
    name.text = info.name.toUpperCase()
    style.text = STYLE_NAMES[info.style].toUpperCase()
    if (!stamp) return
    gsap.killTweensOf([kanji, kanji.scale, frame, frame.scale, nameSlot, styleSlot])
    gsap.timeline()
      .fromTo(frame, { alpha: 0 }, { alpha: 1, duration: 0.24, ease: drawn(0.24, "power4.in", ON_ONES) }, 0)
      .fromTo(frame.scale, { x: 1.7, y: 1.7 }, { x: 1, y: 1, duration: 0.24, ease: drawn(0.24, "power4.in", ON_ONES) }, 0)
      .fromTo(kanji, { alpha: 0, angle: -12 }, { alpha: 1, angle: 0, duration: 0.22, ease: drawn(0.22, "power4.in", ON_ONES) }, 0.04)
      .fromTo(kanji.scale, { x: 2.2, y: 2.2 }, { x: 1, y: 1, duration: 0.22, ease: drawn(0.22, "power4.in", ON_ONES) }, 0.04)
      .add(rattle(mark, 5, 0.3), 0.26)
      .fromTo([nameSlot, styleSlot], { alpha: 0, x: -14 }, { alpha: 1, x: 0, duration: 0.3, ease: drawn(0.3, "expo.out"), stagger: 0.05 }, 0.2)
  }

  const fill = (count: number, sweep: boolean) => {
    pips.forEach((pip, index) => {
      const full = index < count
      const was = pip.fill.visible
      pip.fill.visible = full
      if (full && !was) {
        const delay = sweep ? index * 0.035 : 0
        gsap.fromTo(pip.body.scale, { y: 1.8 }, { y: 1, duration: 0.22, ease: drawn(0.22, "back.out(3)", ON_ONES), delay })
        gsap.fromTo(pip.body, { y: -3 }, { y: 0, duration: 0.22, ease: drawn(0.22, "back.out(3)", ON_ONES), delay })
      }
      if (!full && was) gsap.fromTo(pip.body, { x: 3 }, { x: 0, duration: 0.18, ease: drawn(0.18, "power2.out", ON_ONES) })
    })
  }

  return {
    node,
    update: (view) => {
      const changed = view.id !== weapon
      if (changed) {
        show(view.id, weapon !== null)
        weapon = view.id
        loaded = -1
        arrange()
      }
      const count = view.ammo?.loaded ?? 0
      if (view.ammo !== null && count !== loaded) {
        fill(count, loaded >= 0 && count - loaded > 1)
        loaded = count
      }
      const empty = view.ammo !== null && count === 0
      if (empty !== emptyClip) {
        emptyClip = empty
        paintPips()
      }
      const held = view.charge !== null
      if (held !== charging) {
        charging = held
        gsap.to(charge, { alpha: held ? 1 : 0, duration: 0.12, overwrite: true })
      }
      chargeFill.scale.x = view.charge ?? 0
      const full = (view.charge ?? 0) >= 1
      if (full !== chargeFull) {
        chargeFull = full
        chargeFill.tint = full ? accent.accent : PALETTE.paper
      }
      return changed
    },
    layout: (next) => {
      narrow = next
      arrange()
      const text = Math.max(name.width + nameStyle.letterSpacing, style.width + styleStyle.letterSpacing)
      return { width: narrow ? MARK : Math.round(MARK + TEXT_GAP + text), height: height() }
    },
    reset: () => {
      weapon = null
      loaded = -1
    },
    tint: (next) => {
      accent = next
      outer.tint = next.accent
      inner.tint = next.accent
      kanjiStyle.dropShadow = shadowOf(kanjiShadow(next))
      if (chargeFull) chargeFill.tint = next.accent
      paintPips()
    },
    dispose: () => {
      gsap.killTweensOf([mark, kanji, kanji.scale, frame, frame.scale, nameSlot, styleSlot, charge, ...pips.flatMap((pip) => [pip.body, pip.body.scale])])
      node.destroy({ children: true })
      for (const each of [kanjiStyle, nameStyle, styleStyle]) release(each)
    }
  }
}
