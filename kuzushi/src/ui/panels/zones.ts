import { gsap } from "gsap"
import { clamp } from "math"
import { Color, Container, DashLineShader, FillGradient, Graphics, Rectangle, SmoothGraphics, Sprite, Text, Texture } from "pixi.js"
import type { FederatedPointerEvent } from "pixi.js"

import { hex, PALETTE, paletteOf } from "../../art/palette.ts"
import { svgTexture } from "../../art/svg.ts"
import { bossOf, stageOf, ZONE_LIST } from "../../sim/index.ts"
import type { Zone, ZoneHazard, ZoneId } from "../../sim/index.ts"
import { keyAction, opened, pointed, stepped } from "../cursor.ts"
import type { Cursor } from "../cursor.ts"
import { formatTime, twoDigits } from "../format.ts"
import { enemyShape, shapeMarkup } from "../icons.ts"
import type { Shape } from "../icons.ts"
import { createCorners } from "../kit/corners.ts"
import { iconContext } from "../kit/icon.ts"
import type { PanelBody } from "../kit/sheet.ts"
import { baselineOf, CAP_HEIGHT, face, release, resize, text } from "../kit/type.ts"
import { drawn, ON_ONES, ON_TWOS, rattle } from "../motion.ts"
import { planSvg } from "../plan.ts"
import { readRecords } from "../records.ts"

/** What each zone's hazard is called on its card. */
const HAZARD_NAMES = { none: "No hazard", beam: "Beam", collapse: "Collapse" } as const satisfies Record<ZoneHazard, string>

/** A card's inner padding, and its icons' size and spacing, px. */
const PAD = 12
const ICON = 12
const ICON_GAP = 5
/** The palette strip's colours and their shares of its width. */
const SWATCH = [["ink", 1], ["groundDark", 1], ["ground", 1], ["groundLight", 1], ["light", 1], ["danger", 1.6]] as const
/** Plans are redrawn once the width they are needed at strays this far from the width they were drawn at. */
const REDRAW = 0.15
/** How far an italic numeral's last stroke leans past its measured width, in em. */
const ITALIC = 0.08
/** The numeral under a card's records shows only with this much room; beside a row's text, only this large. */
const MIN_NUMERAL_ROOM = 76
const MIN_NARROW_NUMERAL = 48

/** A plan of the zone's arena on its ink, in its palette (lit when its card is highlighted), under a vignette: a 40x26 card. */
const planCard = (zone: Zone, active: boolean) => {
  const palette = paletteOf(zone.id)
  const style = [
    `.k-plan-wall{fill:${hex(palette.groundDark)}}`,
    `.k-plan-floor{fill:${hex(active ? palette.groundLight : palette.ground)}}`,
    `.k-plan-tiles{fill:none;stroke:rgba(0,0,0,0.32);stroke-width:0.06}`,
    `.k-plan-shadow{fill:rgba(0,0,0,0.5);stroke:rgba(0,0,0,0.5)}`,
    `.k-plan-props{fill:${hex(active ? palette.light : palette.groundLight)};stroke:${hex(palette.ink)};stroke-width:0.14}`,
    `.k-plan-spawns{fill:${hex(palette.danger)}}`,
    `.k-plan-start{fill:${hex(PALETTE.paper)};stroke:${hex(palette.ink)};stroke-width:0.14}`,
    `.k-plan-floor.is-falling{stroke:rgba(0,0,0,0.75);stroke-width:0.12;stroke-dasharray:0.5 0.35}`,
    `.k-plan-beacon{fill:none;stroke:${hex(palette.danger)};stroke-width:0.25}`
  ].join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 26"><style>${style}</style>` +
    `<defs><radialGradient id="k-plan-vignette" cx="0.5" cy="0.4" r="0.72"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient></defs>` +
    `<rect width="40" height="26" fill="${hex(palette.ink)}"/>${planSvg(stageOf(zone.id).layout, zone.id)}<rect width="40" height="26" fill="url(#k-plan-vignette)"/></svg>`
}

type CardState = "idle" | "active" | "chosen" | "locked"

interface Card {
  readonly zone: Zone
  readonly accent: number
  /** The highlighted card's fill, built once. */
  readonly glow: FillGradient
  /** Placed by layout; takes the pointer. */
  readonly slot: Container
  /** Lifts, rattles and slides in. */
  readonly body: Container
  readonly back: SmoothGraphics
  readonly hatch: SmoothGraphics
  readonly dashes: SmoothGraphics
  readonly open: Container
  readonly number: Text
  readonly kanji: Text
  readonly plan: Sprite
  readonly swatch: Graphics
  readonly name: Text
  readonly foes: ReadonlyArray<SmoothGraphics>
  readonly hazard: Text
  readonly rules: Graphics
  readonly bossKey: Text
  readonly bossKanji: Text
  readonly bossIcon: SmoothGraphics
  readonly bossName: Text
  readonly bestKey: Text
  readonly best: Text
  readonly run: { readonly key: Text; readonly time: Text; readonly rank: Text } | null
  readonly numeral: Text
  readonly numeralOutline: Text
  readonly locked: Container
  readonly lockNumber: Text
  readonly lockWord: Text
  state: CardState
  width: number
  height: number
  planWidth: number
}

/** Puts `texts` on one baseline under `top`; returns the bottom of the tallest. */
const onBaseline = (top: number, texts: ReadonlyArray<Text>) => {
  const ascent = Math.max(...texts.map((each) => baselineOf(each.style)))
  let bottom = top
  for (const each of texts) {
    each.y = Math.round(top + ascent - baselineOf(each.style))
    bottom = Math.max(bottom, each.y + each.height)
  }
  return bottom
}

/** Where a text's capitals sit halfway up, from its top. */
const capMiddle = (each: Text) => baselineOf(each.style) - (CAP_HEIGHT * Number(each.style.fontSize)) / 2

/**
 * START's zones: a card per zone with its number and kanji, a plan of its place and a strip of its palette in its own
 * colours, its name, its four enemies, its hazard, its boss, and the best clear kept on this device (zone 1's card
 * also the best full run and its rank). Zone 1 is always open; a later zone opens once a run has reached it, and
 * until then shows LOCKED and its number only. Left and right (or up and down) pick an open card; Enter or a click
 * starts the run there. Corner brackets in the zone's accent snap from card to card. Narrow, the cards are rows.
 */
export const createZones = (options: { readonly launch: (zone: Zone) => void; readonly onMove?: (index: number) => void }): PanelBody => {
  const node = new Container({ label: "zones" })
  const numeralStyle = face({ family: "condensed", weight: "700", italic: true, size: 64 })
  const numeralOutlineStyle = face({ family: "condensed", weight: "700", italic: true, size: 64, stroke: 1.5 })
  const lockStyle = face({ family: "condensed", weight: "700", italic: true, size: 64, stroke: 1.5 })
  const icon = (shape: Shape, tint: number) => {
    const each = new SmoothGraphics(iconContext(shapeMarkup(shape), "solid"))
    each.scale.set(ICON / 24)
    each.tint = tint
    return each
  }

  const cards: ReadonlyArray<Card> = ZONE_LIST.map((zone, index) => {
    const palette = paletteOf(zone.id)
    const accent = palette.danger
    const boss = bossOf(zone.boss)
    const slot = new Container({ label: `zone ${zone.id}` })
    const body = new Container()
    const back = new SmoothGraphics()
    const hatch = new SmoothGraphics()
    const dashes = new SmoothGraphics()
    dashes.context.customShader = new DashLineShader({ dash: 4, gap: 3 })
    const open = new Container()
    const numeralOutline = new Text({ text: twoDigits(zone.number), style: numeralOutlineStyle, roundPixels: true })
    const numeral = new Text({ text: twoDigits(zone.number), style: numeralStyle, roundPixels: true })
    const number = text(`ZONE ${zone.number}`, "small", accent)
    const kanji = text(zone.kanji, "kanji", PALETTE.concrete300)
    const plan = new Sprite(Texture.EMPTY)
    const swatch = new Graphics()
    const name = text(zone.name.toUpperCase(), "label")
    const foes = zone.roster.map((kind) => icon(enemyShape[kind], accent))
    const hazard = text(HAZARD_NAMES[zone.hazard].toUpperCase(), "small", zone.hazard === "none" ? PALETTE.concrete300 : accent)
    const rules = new Graphics()
    const bossKey = text("BOSS", "small", PALETTE.concrete300)
    const bossKanji = text(boss.kanji, "kanji", PALETTE.concrete300)
    const bossIcon = icon(enemyShape[zone.boss], accent)
    const bossName = text(boss.name.toUpperCase(), "label")
    const bestKey = text("BEST", "small", PALETTE.concrete300)
    const best = text("--:--.--", "digits")
    const run = zone.number === 1 ? { key: text("RUN", "small", PALETTE.concrete300), time: text("--:--.--", "digits"), rank: text("-", "digits", accent) } : null
    open.addChild(numeralOutline, numeral, number, kanji, plan, swatch, name, ...foes, hazard, rules, bossKey, bossKanji, bossIcon, bossName, bestKey, best, ...(run === null ? [] : [run.key, run.time, run.rank]))
    const locked = new Container()
    const lockNumber = new Text({ text: twoDigits(zone.number), style: lockStyle, roundPixels: true })
    lockNumber.alpha = 0.16
    const lockWord = text("LOCKED", "small", PALETTE.concrete300)
    locked.addChild(lockNumber, lockWord)
    body.addChild(back, hatch, dashes, open, locked)
    slot.addChild(body)
    slot.cursor = "pointer"
    slot.on("pointermove", (event: FederatedPointerEvent) => {
      const at = slots.indexOf(index)
      if (at >= 0) select(pointed(cursor, at, event.movementX, event.movementY), false)
    })
    slot.on("pointertap", (event: FederatedPointerEvent) => {
      const at = slots.indexOf(index)
      if (event.button === 0 && at >= 0) launch(at)
    })
    node.addChild(slot)
    const glow = new FillGradient({
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [{ offset: 0, color: new Color(accent).setAlpha(0.2) }, { offset: 0.55, color: new Color(PALETTE.ink).setAlpha(0.5) }, { offset: 1, color: new Color(PALETTE.ink).setAlpha(0.5) }]
    })
    return {
      zone, accent, glow, slot, body, back, hatch, dashes, open, number, kanji, plan, swatch, name, foes, hazard, rules,
      bossKey, bossKanji, bossIcon, bossName, bestKey, best, run, numeral, numeralOutline, locked, lockNumber, lockWord,
      state: "idle", width: 0, height: 0, planWidth: 0
    }
  })
  const brackets = createCorners({ arm: 12, weight: 2, color: PALETTE.red, alpha: 1, glow: true })
  node.addChild(brackets.node)

  /** The cards that can be chosen, by index; the cursor moves through these. */
  let slots: ReadonlyArray<number> = [0]
  let cursor: Cursor = opened
  let launched = false
  const plans = new Map<ZoneId, { rest: Texture; active: Texture; width: number; drawing: number }>()

  const cardAt = (slot: number) => cards[slots[slot] ?? 0]

  const paint = (card: Card) => {
    const { width, height, state } = card
    const lit = state === "active" || state === "chosen"
    card.back.clear().rect(0, 0, width, height)
    if (state === "locked") card.back.fill({ color: PALETTE.ink, alpha: 0.5 })
    else {
      if (state === "idle") card.back.fill({ color: PALETTE.ink, alpha: 0.45 })
      else if (state === "active") card.back.fill(card.glow)
      else card.back.fill({ color: card.accent, alpha: 0.45 })
      card.back.rect(0.5, 0.5, width - 1, height - 1).stroke(state === "idle" ? { width: 1, color: PALETTE.paper, alpha: 0.14 } : { width: 1, color: card.accent, alpha: 0.7 })
    }
    card.open.visible = state !== "locked"
    card.locked.visible = state === "locked"
    card.hatch.visible = state === "locked"
    card.dashes.visible = state === "locked"
    card.slot.eventMode = state === "locked" ? "none" : "static"
    card.kanji.tint = lit ? PALETTE.paper : PALETTE.concrete300
    card.bossKanji.tint = lit ? PALETTE.paper : PALETTE.concrete300
    card.numeralOutline.tint = card.accent
    card.numeralOutline.alpha = lit ? 0 : 0.4
    card.numeral.tint = state === "chosen" ? PALETTE.paper : card.accent
    card.numeral.alpha = lit ? 0.9 : 0
    const plan = plans.get(card.zone.id)
    card.plan.texture = plan === undefined ? Texture.EMPTY : lit ? plan.active : plan.rest
    card.plan.setSize(card.planWidth, Math.round(card.planWidth * 0.65))
  }

  /** Rasterises a zone's plans for `width` px, unless the ones it has were drawn near that. */
  const drawPlans = (zone: Zone, width: number) => {
    const plan = plans.get(zone.id) ?? { rest: Texture.EMPTY, active: Texture.EMPTY, width: 0, drawing: 0 }
    plans.set(zone.id, plan)
    if (plan.width > 0 && Math.abs(width - plan.width) <= REDRAW * plan.width) return
    plan.width = width
    const drawing = ++plan.drawing
    void Promise.all([svgTexture(planCard(zone, false), { width, label: `plan-${zone.id}` }), svgTexture(planCard(zone, true), { width, label: `plan-${zone.id}-lit` })]).then(([rest, active]) => {
      if (drawing !== plan.drawing) {
        rest.destroy(true)
        active.destroy(true)
        return
      }
      const old = [plan.rest, plan.active]
      plan.rest = rest
      plan.active = active
      for (const card of cards) if (card.zone === zone) paint(card)
      for (const texture of old) if (texture !== Texture.EMPTY) texture.destroy(true)
    })
  }

  const placeBrackets = () => {
    const card = cardAt(cursor.active)
    if (card !== undefined) brackets.place(card.slot.x, card.slot.y, card.width, card.height, 7, 6)
  }

  const select = (next: Cursor, instant: boolean) => {
    if (!instant && next.active === cursor.active && next.armed === cursor.armed) return
    const from = cursor.active
    cursor = next
    const chosen = cardAt(cursor.active)
    for (const card of cards) {
      if (card.state === "locked") continue
      card.state = card === chosen ? "active" : "idle"
      paint(card)
    }
    if (chosen === undefined) return
    brackets.tint(chosen.accent)
    placeBrackets()
    if (instant || from === cursor.active) return
    brackets.snap(14, 10, 0.18, 0.015)
    gsap.fromTo(chosen.body, { y: 4 }, { y: 0, duration: 0.26, ease: drawn(0.26, "back.out(3)", ON_ONES) })
    options.onMove?.(ZONE_LIST.indexOf(chosen.zone))
  }

  const launch = (slot: number) => {
    const card = cardAt(slot)
    if (launched || card === undefined) return
    launched = true
    select({ active: slot, armed: true }, false)
    card.state = "chosen"
    paint(card)
    gsap.timeline({ onComplete: () => {
      card.state = "active"
      paint(card)
    } })
      .add(rattle(card.body, 6, 0.24))
      .add(brackets.kick(8, 8), 0)
    options.launch(card.zone)
  }

  /** A card's contents laid out in a column: wide screens. */
  const column = (card: Card, width: number, height: number) => {
    const inner = width - PAD * 2
    card.number.x = PAD
    card.kanji.x = width - PAD - card.kanji.width
    let y = onBaseline(PAD, [card.number, card.kanji]) + 8
    card.planWidth = inner
    card.plan.visible = true
    card.plan.position.set(PAD, y)
    y += Math.round(inner * 0.65) + 4
    card.swatch.visible = true
    card.swatch.clear()
    const total = SWATCH.reduce((sum, [, share]) => sum + share, 0)
    let x = PAD
    const palette = paletteOf(card.zone.id)
    for (const [colour, share] of SWATCH) {
      const each = (inner * share) / total
      card.swatch.rect(x, y, each, 4).fill(palette[colour])
      x += each
    }
    y += 4 + 10
    card.name.position.set(PAD, y)
    y = Math.round(y + card.name.height + 6)
    card.hazard.position.set(width - PAD - card.hazard.width, y)
    const iconY = Math.round(y + capMiddle(card.hazard) - ICON / 2)
    card.foes.forEach((foe, at) => foe.position.set(PAD + at * (ICON + ICON_GAP), iconY))
    y = Math.round(Math.max(y + card.hazard.height, iconY + ICON) + 9)
    card.rules.clear().rect(PAD, y, inner, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
    y += 10
    card.bossKey.x = PAD
    card.bossKanji.x = width - PAD - card.bossKanji.width
    card.bossKey.visible = true
    card.bossKanji.visible = true
    y = onBaseline(y, [card.bossKey, card.bossKanji]) + 6
    card.bossName.position.set(PAD + ICON + 8, Math.round(y))
    card.bossIcon.position.set(PAD, Math.round(y + capMiddle(card.bossName) - ICON / 2))
    card.bossName.visible = true
    card.bossIcon.visible = true
    y = Math.round(y + card.bossName.height + 9)
    card.rules.rect(PAD, y, inner, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
    y += 10
    card.bestKey.x = PAD
    card.best.x = Math.round(PAD + card.bestKey.width + 8)
    y = onBaseline(y, [card.bestKey, card.best])
    if (card.run !== null) {
      card.run.key.x = PAD
      card.run.time.x = Math.round(PAD + card.run.key.width + 8)
      card.run.rank.x = width - PAD - card.run.rank.width
      for (const each of [card.run.key, card.run.time, card.run.rank]) each.visible = true
      y = onBaseline(y + 6, [card.run.key, card.run.time, card.run.rank])
    }
    return height - PAD - y
  }

  /** A card's contents beside its plan in a row: narrow screens, where the cards stack. Returns the room right of the text. */
  const row = (card: Card, width: number, height: number, tall: boolean) => {
    const withPlan = height >= 110 && width >= 460
    const planHeight = height - PAD * 2
    card.planWidth = Math.round(planHeight / 0.65)
    card.plan.visible = withPlan
    card.plan.position.set(PAD, PAD)
    const left = withPlan ? PAD + card.planWidth + 16 : PAD
    card.number.x = left
    card.kanji.x = Math.round(left + card.number.width + 10)
    let y = onBaseline(PAD, [card.number, card.kanji]) + 6
    card.swatch.visible = false
    card.rules.clear()
    card.name.position.set(left, y)
    y = Math.round(y + card.name.height + 6)
    card.foes.forEach((foe, at) => foe.position.set(left + at * (ICON + ICON_GAP), Math.round(y + capMiddle(card.hazard) - ICON / 2)))
    card.hazard.position.set(left + 4 * (ICON + ICON_GAP) + 8, y)
    y = Math.round(y + card.hazard.height + 6)
    card.bossKey.visible = false
    card.bossKanji.visible = false
    card.bossName.visible = tall
    card.bossIcon.visible = tall
    if (tall) {
      card.bossName.position.set(left + ICON + 8, y)
      card.bossIcon.position.set(left, Math.round(y + capMiddle(card.bossName) - ICON / 2))
      y = Math.round(y + card.bossName.height + 6)
    }
    card.bestKey.x = left
    card.best.x = Math.round(left + card.bestKey.width + 8)
    onBaseline(y, [card.bestKey, card.best])
    if (card.run !== null) for (const each of [card.run.key, card.run.time, card.run.rank]) each.visible = false
    const shown = [card.kanji, card.name, card.hazard, card.best, ...(tall ? [card.bossName] : [])]
    return width - PAD - Math.max(...shown.map((each) => each.x + each.width)) - 16
  }

  /** The faint hatch of a locked card: 135° lines every 9 px, clipped to it. */
  const drawLocked = (card: Card, width: number, height: number, narrow: boolean) => {
    const step = 9 * Math.SQRT2
    card.hatch.clear()
    for (let along = step; along < width + height; along += step) {
      const from = Math.max(0, along - height)
      const to = Math.min(width, along)
      card.hatch.moveTo(from, along - from).lineTo(to, along - to)
    }
    card.hatch.stroke({ width: 1, color: PALETTE.paper, alpha: 0.035 })
    card.dashes.clear().rect(0.5, 0.5, width - 1, height - 1).stroke({ width: 1, color: PALETTE.paper, alpha: 0.16 })
    card.lockNumber.visible = !narrow
    if (narrow) {
      card.lockWord.text = `${twoDigits(card.zone.number)}   LOCKED`
      card.lockWord.position.set(PAD, Math.round((height - card.lockWord.height) / 2))
      return
    }
    card.lockWord.text = "LOCKED"
    resize(lockStyle, Math.min(0.55 * width, 150), 0)
    const numberHeight = baselineOf(lockStyle)
    const top = Math.round((height - (numberHeight + 12 + card.lockWord.height)) / 2)
    card.lockNumber.position.set(Math.round((width - card.lockNumber.width) / 2), top)
    card.lockWord.position.set(Math.round((width - card.lockWord.width) / 2), Math.round(top + numberHeight + 12))
  }

  const fill = () => {
    const records = readRecords()
    for (const card of cards) {
      const best = records.zones[card.zone.id]
      card.best.text = best === undefined ? "--:--.--" : formatTime(best)
      if (card.run !== null) {
        card.run.time.text = records.run === null ? "--:--.--" : formatTime(records.run.time)
        card.run.rank.text = records.run?.rank ?? "-"
      }
      card.state = records.reached.includes(card.zone.id) ? "idle" : "locked"
    }
    slots = cards.flatMap((card, index) => (card.state === "locked" ? [] : [index]))
  }

  node.once("destroyed", () => {
    for (const card of cards) card.glow.destroy()
    for (const plan of plans.values()) for (const texture of [plan.rest, plan.active]) if (texture !== Texture.EMPTY) texture.destroy(true)
    for (const style of [numeralStyle, numeralOutlineStyle, lockStyle]) release(style)
  })

  return {
    node,
    refresh: () => {
      launched = false
      fill()
      select(opened, true)
      gsap.timeline()
        .fromTo(cards.map((card) => card.body), { y: 24 }, { y: 0, duration: 0.3, ease: drawn(0.3, "expo.out", ON_TWOS), stagger: 0.05 }, 0)
        .add(brackets.snap(14, 10, 0.18, 0.015), 0.3)
    },
    key: (event) => {
      const action = keyAction(event.code)
      if (action === null || launched) return action !== null
      if (action === "choose") launch(cursor.active)
      else select(stepped(cursor, action.move, slots.length), false)
      return true
    },
    layout: (width, height, viewport) => {
      const gap = viewport.width >= 1600 ? 20 : 16
      const narrow = viewport.narrow
      const cardWidth = narrow ? width : (width - 2 * gap) / 3
      const cardHeight = narrow ? (height - 2 * gap) / 3 : Math.min(height, 2.5 * cardWidth)
      let room = Number.POSITIVE_INFINITY
      cards.forEach((card, index) => {
        card.width = Math.round(cardWidth)
        card.height = Math.round(cardHeight)
        card.slot.position.set(Math.round(narrow ? 0 : index * (cardWidth + gap)), Math.round(narrow ? index * (cardHeight + gap) : 0))
        card.slot.hitArea = new Rectangle(0, 0, card.width, card.height)
        drawLocked(card, card.width, card.height, narrow)
        room = Math.min(room, narrow ? row(card, card.width, card.height, height >= 520) : column(card, card.width, card.height))
        drawPlans(card.zone, card.planWidth * viewport.resolution)
        paint(card)
      })
      const size = narrow ? Math.min(0.9 * cardHeight, room / (1 + ITALIC)) : clamp(Math.min(0.9 * cardWidth, room - 12), 64, 240)
      resize(numeralStyle, size, 0)
      resize(numeralOutlineStyle, size, 0)
      const shown = narrow ? size >= MIN_NARROW_NUMERAL : room >= MIN_NUMERAL_ROOM
      for (const card of cards) {
        card.numeral.visible = shown
        card.numeralOutline.visible = shown
        const x = Math.round(card.width - PAD - card.numeral.width - ITALIC * size)
        const y = Math.round(card.height - PAD - baselineOf(numeralStyle))
        card.numeral.position.set(x, y)
        card.numeralOutline.position.set(x - 0.75, y - 0.75)
      }
      placeBrackets()
    }
  }
}
