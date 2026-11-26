import { gsap } from "gsap"
import { clamp } from "math"
import { Color, Container, FillGradient, Graphics, Point, Rectangle } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { bossOf } from "../sim/index.ts"
import type { BossId, BossView } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { brushRaster } from "./kit/ink.ts"
import { createLayer, eraseRamp } from "./kit/layer.ts"
import { INK_SHADOW, inlineWidth, lineBaseline, lineHeightOf, ownedFaces, placeInLine, shadowOf, textIn, tracked } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { drawn, ON_ONES, rattle, shown } from "./motion.ts"
import type { Staged, Tinted } from "./screen.ts"

const ROMAN = ["I", "II", "III", "IV"] as const
const roman = (phase: number) => ROMAN[phase - 1] ?? String(phase)

/** What the bar says of the boss's state, when it isn't simply fighting. */
const STATE_WORDS = { broken: "Broken", shifting: "Shift" } as const

/** How far round the bar's box, in px, the boss counts as under it. */
const OVER = 28

/** The health bar's and the balance meter's heights, the gaps under the head and between the rows, px. */
const BAR = 9
const BALANCE = 4
const HEAD_GAP = 8
const ROW_GAP = 6
/** The state tag's box round its 11 px line: border, then padding top, right, bottom, left. */
const TAG = { border: 1, top: 3, right: 5, bottom: 2, left: 8, line: 11 } as const

/** A unit square: a bar's glow is it stretched to the bar and blurred. */
const UNIT = ["M0 0H1V1H0Z"]

export interface BossBar extends Staged, Tinted {
  /**
   * Every frame, with the room's boss (null once it is gone), whether the HUD has stepped back, and where the boss
   * stands on screen (null when it can't be placed).
   */
  update(view: BossView | null, held: boolean, at: { readonly x: number; readonly y: number } | null): void
  /** Screen boxes, [left, right, top, bottom]: the bar's own box and its band with the scrim, for layout checks. */
  rects(): Record<string, readonly [number, number, number, number]>
}

/**
 * The boss's bar, top centre in a boss room: its kanji and name, its phase, a thin bar of its health with a tick at
 * each phase threshold and a chip that trails a blow, and under it the thinner balance meter. The bar fills in as the
 * name card ends; a shift flashes it and turns the phase; a break floods the meter and drains it through the break;
 * the killing blow cracks the bar and throws its halves apart. While the boss stands under it on screen, it fades back
 * so the boss reads through it.
 */
export const createBossBar = (): BossBar => {
  const node = new Container({ label: "boss-bar" })
  const root = new Container()
  root.visible = false
  root.alpha = 0
  node.addChild(root)
  let accent = accentOf("courtyard")
  let width = 360

  const faces = ownedFaces()
  /** Paper words at .6: their colour fades, their shadow keeps its ink. */
  const dim = { color: PALETTE.paper, alpha: 0.6 }

  // The scrim: ink down from the screen's top, faded out at its foot and at both ends.
  const scrim = createLayer("boss-scrim")
  const scrimFill = new Graphics()
  let scrimGradient: FillGradient | null = null
  const content = new Container({ label: "boss-content" })
  root.addChild(scrim.node, content)

  // The head: kanji, name, the state's tag and the phase at the right end, on one baseline.
  const head = new Container()
  const jpStyle = faces.style({ family: "jp", size: 24, shadow: { color: accent.accent, alpha: 0.6, blur: 12 } }, accent.accent)
  const jp = textIn("", jpStyle)
  const jpBody = new Container()
  jpBody.addChild(jp)
  const nameStyle = faces.style({ family: "condensed", weight: "500", size: 15, tracking: 0.42, shadow: INK_SHADOW })
  const name = textIn("", nameStyle, PALETTE.paper)
  const nameBody = new Container()
  nameBody.addChild(name)
  const stateStyle = faces.style({ family: "condensed", weight: "600", size: 11, tracking: 0.34, shadow: INK_SHADOW })
  const stateBox = new Graphics()
  const stateText = textIn("", stateStyle)
  const stateSlot = new Container()
  const stateBody = new Container()
  stateBody.addChild(stateBox, stateText)
  stateSlot.addChild(stateBody)
  stateSlot.visible = false
  const phaseWordStyle = faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.36, shadow: INK_SHADOW }, dim)
  const numeralStyle = faces.style({ family: "condensed", weight: "600", size: 15, tracking: 0.1, shadow: INK_SHADOW }, PALETTE.paper)
  const totalStyle = faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.1, shadow: INK_SHADOW }, dim)
  const phaseWord = textIn("PHASE ", phaseWordStyle)
  const numeral = textIn("", numeralStyle)
  const numeralSlot = new Container()
  const numeralBody = new Container()
  numeralBody.addChild(numeral)
  numeralSlot.addChild(numeralBody)
  const total = textIn("", totalStyle)
  const phase = new Container()
  phase.addChild(phaseWord, numeralSlot, total)
  head.addChild(jpBody, nameBody, stateSlot, phase)

  // The health bar: its outline and track, the chip, the fill with its glow and hit flash, the threshold ticks.
  const barSlot = new Container()
  const barBody = new Container()
  barSlot.addChild(barBody)
  const felled = new Container()
  felled.visible = false
  const felledLine = new Graphics()
  const felledGlow = brushRaster(UNIT, { width: 1, height: 1 }, 9)
  felledGlow.sprite.tint = PALETTE.paper
  felledGlow.sprite.alpha = 0.8
  felled.addChild(felledGlow.sprite, felledLine)
  const outline = new Graphics()
  const track = new Graphics()
  const chip = new Graphics()
  const fillGroup = new Container()
  const fillGlow = brushRaster(UNIT, { width: 1, height: 1 }, 5)
  fillGlow.sprite.alpha = 0.55
  const fill = new Graphics()
  let fillGradient: FillGradient | null = null
  const hitFill = new Graphics()
  hitFill.visible = false
  fillGroup.addChild(fillGlow.sprite, fill, hitFill)
  const ticks = new Graphics()
  barBody.addChild(felled, outline, track, chip, fillGroup, ticks)

  // The balance meter and its word.
  const balanceSlot = new Container()
  const balanceBody = new Container()
  balanceSlot.addChild(balanceBody)
  const balanceLine = new Graphics()
  const balanceGroup = new Container()
  const balanceGlow = brushRaster(UNIT, { width: 1, height: 1 }, 5)
  balanceGlow.sprite.alpha = 0.9
  balanceGlow.sprite.visible = false
  const balanceFill = new Graphics()
  balanceGroup.addChild(balanceGlow.sprite, balanceFill)
  balanceGroup.scale.x = 0
  balanceBody.addChild(balanceLine, balanceGroup)
  const foot = textIn("BALANCE", faces.style({ family: "condensed", weight: "500", size: 10, tracking: 0.42, shadow: INK_SHADOW }, dim))
  content.addChild(head, barSlot, balanceSlot, foot)

  let id = -1
  let boss: BossId | null = null
  let shownBar = false
  let health = 1
  let phaseAt = 0
  let state = ""
  let broken = false
  let over = false
  let thresholds: ReadonlyArray<number> = []
  /** The bar's box's height under the head's baseline row, px. */
  let height = 0
  /** The name's letter spacing the head was last laid out at: the state's tag follows the name as it tracks in. */
  let arrangedAt = -1
  const chipAt = { value: 1 }
  const setChip = () => {
    chip.scale.x = chipAt.value
  }

  const paintState = () => {
    const box = { width: TAG.border * 2 + TAG.left + inlineWidth(stateText) + TAG.right, height: TAG.border * 2 + TAG.top + TAG.line + TAG.bottom }
    stateBox.clear().rect(0, 0, box.width, box.height)
    if (broken) stateBox.fill(PALETTE.paper).stroke({ width: 1, color: PALETTE.paper, alignment: 1 })
    else stateBox.fill({ color: accent.accent, alpha: 0.14 }).stroke({ width: 1, color: accent.accent, alpha: 0.8, alignment: 1 })
    stateText.tint = broken ? PALETTE.ink : accent.accent
    stateBody.pivot.set(box.width / 2, box.height / 2)
    return box
  }

  const paintFill = () => {
    fillGradient?.destroy()
    fillGradient = new FillGradient({
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: new Color(accent.accent) },
        { offset: 1, color: new Color(accent.deep) }
      ]
    })
    fill.clear().rect(0, 0, width, BAR).fill(fillGradient)
    balanceFill.tint = broken ? accent.accent : PALETTE.paper
    for (const glow of [fillGlow, balanceGlow]) glow.sprite.tint = accent.accent
  }

  /** The head on one baseline (the kanji's and the tag's boxes one line tall, the others line-height normal), then the bars under it. */
  const arrangeHead = () => {
    arrangedAt = nameStyle.letterSpacing
    const jpAbove = lineBaseline(jpStyle, 24)
    const nameAbove = lineBaseline(nameStyle)
    const tag = stateSlot.visible ? paintState() : null
    const tagAbove = TAG.border + TAG.top + lineBaseline(stateStyle, TAG.line)
    const phaseAbove = Math.max(lineBaseline(phaseWordStyle), lineBaseline(numeralStyle))
    const above = Math.max(jpAbove, nameAbove, phaseAbove, tag === null ? 0 : tagAbove)
    const below = Math.max(
      24 - jpAbove,
      lineHeightOf(nameStyle) - nameAbove,
      lineHeightOf(phaseWordStyle) - lineBaseline(phaseWordStyle),
      lineHeightOf(numeralStyle) - lineBaseline(numeralStyle),
      tag === null ? 0 : tag.height - tagAbove
    )
    placeInLine(jp, 0, above - jpAbove, 24)
    const jpWidth = inlineWidth(jp)
    jpBody.pivot.set(jpWidth / 2, above - jpAbove + 12)
    jpBody.position.copyFrom(jpBody.pivot)
    nameBody.x = Math.round(jpWidth + 12)
    placeInLine(name, 0, above - nameAbove)
    if (tag !== null) {
      stateSlot.position.set(nameBody.x + inlineWidth(name) + 12 + tag.width / 2, above - tagAbove + tag.height / 2)
      placeInLine(stateText, TAG.border + TAG.left, TAG.border + TAG.top, TAG.line)
    }
    // The phase from its right end: "/ II", 4 px, the numeral, 6 px, "PHASE " with its spacing.
    const totalWidth = inlineWidth(total)
    const numeralWidth = inlineWidth(numeral)
    const totalLeft = width - totalWidth
    const numeralLeft = totalLeft - 4 - numeralWidth
    const wordLeft = numeralLeft - 6 - inlineWidth(phaseWord)
    placeInLine(total, totalLeft, above - lineBaseline(totalStyle))
    placeInLine(phaseWord, wordLeft, above - lineBaseline(phaseWordStyle))
    const numeralTop = above - lineBaseline(numeralStyle)
    numeralSlot.position.set(numeralLeft + numeralWidth / 2, numeralTop + lineHeightOf(numeralStyle) / 2)
    numeralBody.pivot.set(numeralWidth / 2, lineHeightOf(numeralStyle) / 2)
    placeInLine(numeral, 0, 0)

    const barTop = Math.round(above + below + HEAD_GAP)
    barSlot.position.set(width / 2, barTop + BAR / 2)
    barBody.pivot.set(width / 2, BAR / 2)
    const balanceWidth = Math.round(0.62 * width)
    const balanceTop = barTop + BAR + ROW_GAP
    balanceSlot.position.set(balanceWidth / 2, balanceTop + BALANCE / 2)
    balanceBody.pivot.set(balanceWidth / 2, BALANCE / 2)
    const footTop = balanceTop + BALANCE + ROW_GAP
    placeInLine(foot, 0, footTop)
    height = footTop + lineHeightOf(foot.style)
  }

  /** What depends on the bar's width: its rects, ticks and glows, and the scrim, drawn from the screen's top to 26 px under the box. */
  const arrangeBar = (margin: number) => {
    const balanceWidth = Math.round(0.62 * width)
    outline.clear().rect(-1, -1, width + 2, BAR + 2).stroke({ width: 1, color: PALETTE.paper, alpha: 0.28, alignment: 1 })
    track.clear().rect(0, 0, width, BAR).fill({ color: PALETTE.ink, alpha: 0.7 })
    chip.clear().rect(0, 0, width, BAR).fill({ color: PALETTE.paper, alpha: 0.85 })
    hitFill.clear().rect(0, 0, width, BAR).fill(PALETTE.paper)
    felledLine.clear().rect(-1, -1, width + 2, BAR + 2).stroke({ width: 1, color: PALETTE.paper, alignment: 1 })
    felledGlow.fit({ width, height: BAR }, 1)
    fillGlow.fit({ width, height: BAR }, 1)
    balanceGlow.fit({ width: balanceWidth, height: BALANCE }, 1)
    balanceLine.clear().rect(0, 0, balanceWidth, BALANCE).stroke({ width: 1, color: PALETTE.paper, alpha: 0.35, alignment: 1 })
    balanceFill.clear().rect(0, 0, balanceWidth, BALANCE).fill(0xffffff)
    paintFill()
    paintTicks()
    arrangeHead()

    const box = new Rectangle(-0.16 * width, -margin, 1.32 * width, margin + height + 26)
    scrimGradient?.destroy()
    scrimGradient = new FillGradient({
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: new Color(PALETTE.ink).setAlpha(0.72) },
        { offset: 0.72, color: new Color(PALETTE.ink).setAlpha(0.65) },
        { offset: 1, color: new Color(PALETTE.ink).setAlpha(0) }
      ]
    })
    scrimFill.clear().rect(box.x, box.y, box.width, box.height).fill(scrimGradient)
    for (const old of scrim.content.removeChildren()) if (old !== scrimFill) old.destroy()
    scrim.content.addChild(scrimFill, eraseRamp(box, [[0, 1], [0.18, 0], [0.82, 0], [1, 1]], "x"))
    scrim.refresh()
  }

  /** A 1 px paper tick at each phase threshold, 4 px over the bar's edges, with an ink edge round it. */
  const paintTicks = () => {
    ticks.clear()
    for (const at of thresholds) ticks.rect(at * width - 1.5, -5, 3, BAR + 10).fill({ color: PALETTE.ink, alpha: 0.7 })
    for (const at of thresholds) ticks.rect(at * width - 0.5, -4, 1, BAR + 8).fill(PALETTE.paper)
  }

  const setPhase = (view: BossView) => {
    numeral.text = roman(view.phase)
    total.text = `/ ${roman(view.phases)}`
  }

  const enter = (view: BossView) => {
    const info = bossOf(view.boss)
    jp.text = info.kanji
    name.text = info.name.toUpperCase()
    thresholds = view.thresholds
    paintTicks()
    health = 1
    chipAt.value = 1
    phaseAt = view.phase
    setPhase(view)
    gsap.killTweensOf([root, jpBody, jpBody.scale, nameBody, phase, fillGroup.scale, chip.scale, chipAt])
    // The timeline's from-states, set here too: a timeline made while GSAP's clock is held (freeze) renders none of them.
    root.visible = true
    root.alpha = 0
    root.y = -24
    jpBody.alpha = 0
    jpBody.scale.set(1.8)
    nameBody.alpha = 0
    phase.alpha = 0
    phase.x = 10
    fillGroup.scale.x = 0
    chip.scale.x = 0
    for (const body of [barBody, balanceBody]) {
      body.position.set(0, 0)
      body.angle = 0
      body.alpha = 1
    }
    const stamp = drawn(0.2, "power4.in", ON_ONES)
    gsap.timeline()
      .fromTo(root, { y: -24, alpha: 0 }, { y: 0, alpha: 1, duration: 0.4, ease: "expo.out" }, 0)
      .fromTo(jpBody.scale, { x: 1.8, y: 1.8 }, { x: 1, y: 1, duration: 0.2, ease: stamp }, 0.05)
      .fromTo(jpBody, { alpha: 0 }, { alpha: 1, duration: 0.2, ease: stamp }, 0.05)
      .fromTo(nameBody, { alpha: 0 }, { alpha: 1, duration: 0.5, ease: "expo.out" }, 0.1)
      .add(tracked(nameStyle, 1, 0.42, { duration: 0.5, ease: "expo.out" }), 0.1)
      .fromTo(phase, { alpha: 0, x: 10 }, { alpha: 1, x: 0, duration: 0.3, ease: "power3.out" }, 0.25)
      .fromTo(fillGroup.scale, { x: 0 }, { x: view.hp / view.maxHp, duration: 0.6, ease: drawn(0.6, "power2.out") }, 0.15)
      .fromTo(chip.scale, { x: 0 }, { x: 1, duration: 0.6, ease: drawn(0.6, "power2.out") }, 0.15)
    arrangeHead()
  }

  const hurt = (to: number, from: number) => {
    fillGroup.scale.x = to
    gsap.killTweensOf(chipAt)
    gsap.to(chipAt, { value: to, duration: 0.45, delay: 0.35, ease: drawn(0.45, "power2.in"), onUpdate: setChip })
    gsap.killTweensOf(hitFill)
    hitFill.visible = true
    gsap.set(hitFill, { visible: false, delay: 0.08 })
    if (from - to > 0.03) rattle(barBody, 3, 0.2)
  }

  const shift = (view: BossView) => {
    setPhase(view)
    arrangeHead()
    const ease = drawn(0.24, "power4.in", ON_ONES)
    gsap.fromTo(numeralBody.scale, { x: 2.2, y: 2.2 }, { x: 1, y: 1, duration: 0.24, ease })
    gsap.fromTo(numeralBody, { alpha: 0 }, { alpha: 1, duration: 0.24, ease })
    rattle(root, 6, 0.4)
  }

  /** The killing blow: the bar cracks where its health ran out and its halves fly apart. */
  const fell = () => {
    felled.visible = true
    fillGroup.scale.x = 0
    gsap.killTweensOf(chipAt)
    gsap.timeline()
      .add(rattle(root, 8, 0.3), 0)
      .to(barBody, { angle: -4, x: -40, alpha: 0, duration: 0.8, ease: drawn(0.8, "power2.in") }, 0.35)
      .to(balanceBody, { angle: 5, x: 40, alpha: 0, duration: 0.8, ease: drawn(0.8, "power2.in") }, 0.35)
      .add(shown(root, false, 0.5), 0.9)
  }

  const topLeft = new Point()
  const bottomRight = new Point()
  const corner = new Point()
  const boxOnScreen = () => {
    corner.set(0, 0)
    root.toGlobal(corner, topLeft)
    corner.set(width, height)
    root.toGlobal(corner, bottomRight)
    return { left: topLeft.x, right: bottomRight.x, top: topLeft.y, bottom: bottomRight.y }
  }

  const setBroken = (on: boolean) => {
    if (on === broken) return
    broken = on
    balanceGlow.sprite.visible = on
    balanceFill.tint = on ? accent.accent : PALETTE.paper
    if (stateSlot.visible) paintState()
  }

  return {
    node,
    update: (view, held, at) => {
      const box = at === null ? null : boxOnScreen()
      const isOver = box !== null && at !== null && at.x > box.left - OVER && at.x < box.right + OVER && at.y < box.bottom + OVER
      if (isOver !== over) {
        over = isOver
        gsap.to([scrim.node, content], { alpha: over ? 0.4 : 1, duration: 0.25, ease: "none", overwrite: "auto" })
      }
      const visible = view !== null && view.state !== "intro" && !held
      if (view !== null && (view.id !== id || view.boss !== boss)) {
        id = view.id
        boss = view.boss
        shownBar = false
        felled.visible = false
      }
      if (view === null) {
        if (shownBar && state !== "defeated") shown(root, false, 0.3)
        shownBar = false
        id = -1
        boss = null
        state = ""
        return
      }
      if (visible && !shownBar) {
        shownBar = true
        enter(view)
      } else if (!visible && shownBar && view.state === "intro") {
        shownBar = false
        gsap.killTweensOf(root)
        root.visible = false
        root.alpha = 0
      }
      node.alpha = held ? 0 : 1
      if (!shownBar) return

      const ratio = Math.max(0, view.hp / view.maxHp)
      if (ratio < health - 0.0001 && view.state !== "defeated") hurt(ratio, health)
      health = ratio
      if (view.phase !== phaseAt) {
        phaseAt = view.phase
        shift(view)
      }
      setBroken(view.state === "broken")
      if (view.state !== state) {
        if (view.state === "defeated") fell()
        state = view.state
        const word = view.state === "broken" || view.state === "shifting" ? STATE_WORDS[view.state] : view.open ? "Open" : ""
        stateText.text = word.toUpperCase()
        stateSlot.visible = word !== ""
        arrangeHead()
        if (word !== "") {
          const ease = drawn(0.2, "power4.in", ON_ONES)
          gsap.fromTo(stateBody.scale, { x: 1.8, y: 1.8 }, { x: 1, y: 1, duration: 0.2, ease })
          gsap.fromTo(stateBody, { alpha: 0 }, { alpha: 1, duration: 0.2, ease })
        }
      } else if (view.state === "fighting") {
        const word = view.open ? "OPEN" : ""
        if (stateText.text !== word) {
          stateText.text = word
          stateSlot.visible = word !== ""
          arrangeHead()
        }
      }
      if (nameStyle.letterSpacing !== arrangedAt) arrangeHead()
      const meter = view.state === "broken" ? 1 - view.progress : view.balance
      balanceGroup.scale.x = clamp(meter, 0, 1)
    },
    layout: (viewport: Viewport) => {
      width = Math.round(clamp(0.38 * viewport.width, 360, 640))
      node.position.set(Math.round((viewport.width - width) / 2), Math.round(viewport.margin))
      arrangeBar(Math.round(viewport.margin))
    },
    tint: (next: Accent) => {
      accent = next
      jpStyle.fill = next.accent
      jpStyle.dropShadow = shadowOf({ color: next.accent, alpha: 0.6, blur: 12 })
      paintFill()
      if (stateSlot.visible) paintState()
    },
    rects: () => {
      const box = boxOnScreen()
      const band = scrim.node.getBounds()
      return {
        "boss-bar": [Math.round(box.left), Math.round(box.right), Math.round(box.top), Math.round(box.bottom)],
        "boss-band": [Math.round(band.minX), Math.round(band.maxX), Math.round(band.minY), Math.round(band.maxY)]
      }
    },
    dispose: () => {
      gsap.killTweensOf([root, jpBody, jpBody.scale, nameBody, phase, fillGroup.scale, chip.scale, chipAt, hitFill, barBody, balanceBody, numeralBody, numeralBody.scale, stateBody, stateBody.scale, scrim.node, content])
      node.destroy({ children: true })
      fillGradient?.destroy()
      scrimGradient?.destroy()
      faces.release()
    }
  }
}
