import { gsap } from "gsap"
import { clamp } from "math"
import { mulberry32 } from "math/random"
import { Container, Rectangle, SmoothGraphics } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { bossOf, zoneOf } from "../sim/index.ts"
import type { BossView } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { brushStroke } from "./brush.ts"
import { brushRaster, inkLayer, spineReveal } from "./kit/ink.ts"
import { inlineWidth, lineHeightOf, ownedFaces, placeInLine, resize, shadowOf, textIn, tracked } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { createWipe } from "./kit/wipe.ts"
import { drawn, ON_ONES, ON_TWOS, rattle } from "./motion.ts"
import type { Staged, Tinted } from "./screen.ts"

const band = brushStroke([[10, 250], [300, 205], [620, 160], [890, 128]], { width: 230, seed: 41, start: 0.5, attack: 0.08, release: 0.2, dry: 0.36, bristles: 16, rough: 0.05, wobble: 0.08, streaks: 5 })
const edge = brushStroke([[30, 330], [420, 262], [860, 210]], { width: 7, seed: 43, start: 0.2, attack: 0.3, release: 0.4, dry: 0.3, bristles: 5 })
const underline = brushStroke([[2, 10], [160, 7], [330, 9]], { width: 9, seed: 47, start: 0.9, attack: 0.03, release: 0.32, dry: 0.4, bristles: 8 })

/** The card's drawing and the underline's, in their units, each stretched over its box. */
const CARD = { width: 900, height: 420 } as const
const UNDER = { width: 340, height: 20 } as const
/** The underline's height, px. */
const UNDER_HEIGHT = 14

/** Speed lines streaking behind the card, the same every time. */
const LINES = (() => {
  const random = mulberry32.create(0x6b63)
  const next = () => mulberry32.sample(random)
  return Array.from({ length: 16 }, () => ({ y: 40 + next() * 340, x: next() * 700, length: 120 + next() * 320, width: 0.8 + next() * 2.2 }))
})()

/** The intro's length in seconds, matching the boss's name card (its `progress` runs 0 to 1 over it). */
const LENGTH = 2

export interface BossCard extends Staged, Tinted {
  /** Every frame with the room's boss: plays the card through its intro. */
  update(view: BossView | null): void
}

/**
 * A boss's name card, left of the camera's boss shot while its intro holds the game: an ink band slashes in, the
 * kanji stamps down large, the name tracks in under an accent stroke with the zone and the boss's phases, speed lines
 * stream behind, and the band slashes away as the intro ends. It is scrubbed by the boss view's `progress`, so it
 * holds with the game and steps frame by frame with it.
 */
export const createBossCard = (): BossCard => {
  const node = new Container({ label: "boss-card" })
  node.visible = false
  node.alpha = 0
  let accent = accentOf("courtyard")
  let size: { width: number; height: number } = CARD

  const faces = ownedFaces()

  // The speed lines behind, then the band and its accent edge, drawn on along the band's spine.
  const linesUnits = new Container({ label: "boss-card-lines" })
  const lines = LINES.map((line) => {
    const rect = new SmoothGraphics().rect(Math.round(line.x), line.y, Math.round(line.length), line.width).fill(PALETTE.paper)
    rect.alpha = 0
    return rect
  })
  linesUnits.addChild(...lines)
  const reveal = spineReveal(band.points, 480)
  const wrapper = new Container()
  const ink = inkLayer(band.shapes, CARD)
  ink.node.tint = PALETTE.ink
  ink.node.alpha = 0.9
  const edgeGlow = brushRaster(edge.shapes, CARD, 6)
  edgeGlow.sprite.alpha = 0.8
  const edgeLine = brushRaster(edge.shapes, CARD)
  const units = new Container()
  units.addChild(reveal.mask)
  wrapper.addChild(ink.node, edgeGlow.sprite, edgeLine.sprite, units)
  wrapper.mask = reveal.mask

  // The words: kicker, kanji, name, the accent underline and the phases, down the card's left.
  const bodySlot = new Container({ label: "boss-card-words" })
  const body = new Container()
  bodySlot.addChild(body)
  const slot = (child: Container) => {
    const holder = new Container()
    const moving = new Container()
    moving.addChild(child)
    holder.addChild(moving)
    body.addChild(holder)
    return { slot: holder, body: moving }
  }
  const kickerStyle = faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.6 })
  const kicker = textIn("", kickerStyle, accent.accent)
  const jpStyle = faces.style({ family: "jp", size: 190, shadow: { color: accent.accent, alpha: 0.55, blur: 30 } }, PALETTE.paper)
  const jpInkStyle = faces.style({ family: "jp", size: 190 })
  const jp = textIn("", jpStyle)
  const jpInk = textIn("", jpInkStyle, PALETTE.ink)
  jpInk.alpha = 0.8
  const jpGroup = new Container()
  jpGroup.addChild(jpInk, jp)
  const nameStyle = faces.style({ family: "condensed", weight: "600", size: 38, tracking: 0.42 })
  const name = textIn("", nameStyle, PALETTE.paper)
  const underGroup = new Container()
  const underWipe = createWipe("left")
  const underGlow = brushRaster(underline.shapes, UNDER, 6)
  underGlow.sprite.alpha = 0.7
  const underLine = brushRaster(underline.shapes, UNDER)
  underGroup.addChild(underGlow.sprite, underLine.sprite, underWipe.mask)
  underGroup.mask = underWipe.mask
  const phases = textIn("", faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.42 }), PALETTE.concrete300)
  const kickerPart = slot(kicker)
  const jpPart = slot(jpGroup)
  const namePart = slot(name)
  const underPart = slot(underGroup)
  const phasesPart = slot(phases)

  node.addChild(linesUnits, wrapper, bodySlot)

  let viewport: Viewport | null = null
  let shownFor = -1
  let card: gsap.core.Timeline | null = null

  /** The words stacked down the card, each at its row's left. */
  const arrange = () => {
    if (viewport === null) return
    let y = 0
    kickerPart.slot.y = y
    placeInLine(kicker, 4, 0)
    y += lineHeightOf(kickerStyle) + 6
    const jpSize = Number(jpStyle.fontSize)
    const jpWidth = inlineWidth(jp)
    placeInLine(jp, 0, 0, jpSize)
    jpInk.position.set(jp.x, jp.y + 4)
    jpPart.slot.position.set(0.3 * jpWidth, y + 0.6 * jpSize)
    jpPart.body.pivot.set(0.3 * jpWidth, 0.6 * jpSize)
    y += jpSize + 6
    namePart.slot.y = y
    placeInLine(name, 0, 0)
    y += lineHeightOf(nameStyle) + 8
    underPart.slot.y = y
    y += UNDER_HEIGHT + 10
    phasesPart.slot.y = y
    placeInLine(phases, 0, 0)
  }

  const layout = (next: Viewport) => {
    viewport = next
    const { width: W, height: H, margin } = next
    const vw = W / 100
    size = { width: Math.round(Math.min(0.64 * W, 980)), height: Math.round(Math.min(0.52 * H, 460)) }
    node.position.set(0, Math.round((H - size.height) / 2))
    for (const each of [linesUnits, units]) each.scale.set(size.width / CARD.width, size.height / CARD.height)
    ink.fit(size.width, size.height)
    edgeGlow.fit(size, 1)
    edgeLine.fit(size, next.resolution)
    bodySlot.position.set(Math.round(1.5 * margin), Math.round(0.18 * size.height))
    const jpSize = clamp(13 * vw, 96, 190)
    resize(jpStyle, jpSize, 0)
    resize(jpInkStyle, jpSize, 0)
    resize(nameStyle, clamp(2.4 * vw, 24, 38), Number(nameStyle.letterSpacing) / Math.max(1, Number(nameStyle.fontSize)))
    const under = { width: Math.round(clamp(24 * vw, 240, 380)), height: UNDER_HEIGHT }
    underGlow.fit(under, 1)
    underLine.fit(under, next.resolution)
    underWipe.fit(new Rectangle(0, 0, under.width, under.height))
    arrange()
  }

  const tint = (next: Accent) => {
    accent = next
    kicker.tint = next.accent
    jpStyle.dropShadow = shadowOf({ color: next.accent, alpha: 0.55, blur: 30 })
    for (const brush of [edgeGlow, edgeLine, underGlow, underLine]) brush.sprite.tint = next.accent
  }

  const build = (view: BossView) => {
    const boss = bossOf(view.boss)
    kicker.text = `ZONE ${zoneOf(boss.zone).number} · BOSS`
    jp.text = boss.kanji
    jpInk.text = boss.kanji
    name.text = boss.name.toUpperCase()
    phases.text = `${boss.phases.length} PHASES`
    arrange()
    card?.kill()
    const stamp = drawn(0.18, "power4.in", ON_ONES)
    card = gsap.timeline({ paused: true })
      .set(node, { visible: true, alpha: 1 }, 0)
      .set(reveal, { tail: 0 }, 0)
      .fromTo(reveal, { head: 0 }, { head: 1, duration: 0.2, ease: drawn(0.2, "power3.out", ON_ONES) }, 0)
      .fromTo(lines, { x: (index: number) => -260 - (index % 4) * 60, alpha: 0 }, { x: (index: number) => 260 + (index % 3) * 70, alpha: 0.85, duration: 1.7, ease: drawn(1.7, "none", ON_TWOS), stagger: 0.012 }, 0.05)
      .fromTo(jpPart.body, { alpha: 0, angle: -14 }, { alpha: 1, angle: -4, duration: 0.18, ease: stamp }, 0.12)
      .fromTo(jpPart.body.scale, { x: 2.6, y: 2.6 }, { x: 1, y: 1, duration: 0.18, ease: stamp }, 0.12)
      .add(rattle(jpPart.body, 9, 0.3), 0.3)
      .fromTo(kickerPart.body, { alpha: 0 }, { alpha: 1, duration: 0.5, ease: "expo.out" }, 0.2)
      .add(tracked(kickerStyle, 1.2, 0.6, { duration: 0.5, ease: "expo.out" }), 0.2)
      .fromTo(namePart.body, { alpha: 0, x: -60 }, { alpha: 1, x: 0, duration: 0.45, ease: drawn(0.45, "expo.out") }, 0.3)
      .add(tracked(nameStyle, 0.9, 0.42, { duration: 0.45, ease: "expo.out" }), 0.3)
      .fromTo(underWipe, { amount: 0 }, { amount: 1, duration: 0.2, ease: drawn(0.2, "power3.in", ON_ONES) }, 0.45)
      .fromTo(phasesPart.body, { alpha: 0, y: 8 }, { alpha: 1, y: 0, duration: 0.3, ease: "power3.out" }, 0.6)
      .fromTo(body, { x: 0 }, { x: 18, duration: 1.0, ease: "none" }, 0.6)
      .to([phasesPart, underPart, namePart, kickerPart, jpPart].map((each) => each.body), { alpha: 0, x: -50, duration: 0.16, ease: "power2.in", stagger: 0.02 }, 1.66)
      .to(reveal, { tail: 1, duration: 0.2, ease: drawn(0.2, "power3.in", ON_ONES) }, 1.76)
      .to(lines, { alpha: 0, duration: 0.15 }, 1.8)
      .set(node, { visible: false, alpha: 0 }, LENGTH)
  }

  return {
    node,
    layout,
    tint,
    update: (view) => {
      const intro = view !== null && view.state === "intro"
      if (!intro) {
        if (shownFor >= 0) {
          card?.progress(1)
          node.visible = false
          node.alpha = 0
        }
        shownFor = -1
        return
      }
      if (view.id !== shownFor) {
        shownFor = view.id
        build(view)
      }
      card?.progress(clamp(view.progress, 0, 1))
    },
    dispose: () => {
      card?.kill()
      node.destroy({ children: true })
      faces.release()
    }
  }
}
