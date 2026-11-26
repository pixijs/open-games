import { gsap } from "gsap"
import { clamp } from "math"
import { mulberry32 } from "math/random"
import { Container, Graphics, GraphicsContext, Rectangle, SmoothGraphics, Sprite, TextStyle, Texture } from "pixi.js"
import type { Text } from "pixi.js"

import { hex, PALETTE } from "../art/palette.ts"
import { svgTexture } from "../art/svg.ts"
import type { IntentApi } from "../host/types.ts"
import { ROOM_KINDS, weaponOf, ZONE_LIST, zoneOf } from "../sim/index.ts"
import type { GameView, MomentOf } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { brushStroke } from "./brush.ts"
import { formatTime, twoDigits } from "./format.ts"
import { shapeMarkup } from "./icons.ts"
import { createCorners } from "./kit/corners.ts"
import { digits, placeDigits } from "./kit/digits.ts"
import type { Drain } from "./kit/drain.ts"
import { blurSprite } from "./kit/glow.ts"
import { iconContext } from "./kit/icon.ts"
import { brushRaster } from "./kit/ink.ts"
import { createMenu } from "./kit/menu.ts"
import { createPlate } from "./kit/plate.ts"
import { radialScrim } from "./kit/scrim.ts"
import { blockPointer, createSink } from "./kit/sink.ts"
import { FAMILY, inlineWidth, lineBaseline, lineHeightOf, ownedFaces, placeInLine, resize, shadowOf, textIn, tracked } from "./kit/type.ts"
import type { Face } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { createWipe } from "./kit/wipe.ts"
import { drawn, ON_ONES, rattle } from "./motion.ts"
import { recordRun } from "./records.ts"
import { piece } from "./screen.ts"
import type { StageScreen, Tinted } from "./screen.ts"

type Outcome = MomentOf<"runCleared"> | MomentOf<"gameOver">

const underline = brushStroke([[4, 14], [180, 10], [396, 12]], { width: 12, seed: 61, start: 0.9, attack: 0.03, release: 0.3, dry: 0.4, bristles: 9 })
const cut = brushStroke([[4, 44], [200, 26], [396, 6]], { width: 6, seed: 63, start: 0.1, attack: 0.4, release: 0.4, dry: 0.25, bristles: 5, rough: 0.12 })
const UNDERLINE = { width: 400, height: 24 } as const
const CUT = { width: 400, height: 50 } as const

/** The rank's seal: a rough square in a 100-unit box, its ink eaten by noise like a hanko's. */
const SEAL = (() => {
  const random = mulberry32.create(5)
  const wobble = () => (mulberry32.sample(random) - 0.5) * 5
  const corners = [[6, 6], [94, 6], [94, 94], [6, 94]]
  const edge: Array<string> = []
  for (let side = 0; side < 4; side++) {
    const [ax, ay] = corners[side] as [number, number]
    const [bx, by] = corners[(side + 1) % 4] as [number, number]
    for (let i = 0; i < 6; i++) edge.push(`${(ax + ((bx - ax) * i) / 6 + wobble()).toFixed(1)},${(ay + ((by - ay) * i) / 6 + wobble()).toFixed(1)}`)
  }
  const rough = `<filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="2"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -6 4.6"/><feComposite in="SourceGraphic" operator="in"/></filter>`
  return (paint: string) => `${rough}<polygon points="${edge.join(" ")}" filter="url(#rough)" ${paint}/>`
})()
/** The seal's size, px, and its glow's box in its units. */
const SEAL_SIZE = 104
const SEAL_GLOW = { x: -42, y: -42, width: 184, height: 184 } as const
/** A hollow seal's paint: ink at .6 inside a 4-unit stroke. */
const HOLLOW = (stroke: string) => `fill="${hex(PALETTE.ink)}" fill-opacity="0.6" stroke="${stroke}" stroke-width="4"`

/** The card's border and its padding inside it, px; narrow, the padding is 20 all round. */
const BORDER = 1
const PAD = { top: 28, side: 32, bottom: 28 } as const
const NARROW_PAD = 20
const KICKER = { height: 22, gap: 12 } as const
/** The stats' grid: two columns, rows 35 px tall with 10 between, at most 440 px wide; the rank's column beside it. */
const STATS = { width: 440, row: 35, across: 24, down: 10, value: 26 } as const
const RANK_WIDTH = 168
const GAP = { title: 20, underline: 8, sub: 16, grid: 24, rank: 6, menu: 28 } as const
const UNDERLINE_HEIGHT = 16
const DIAMOND = { size: 16, gap: 6 } as const
const MENU = { size: 17, tracking: 0.42, row: 42, gap: 16, indent: 20, barX: 0, shift: 12, idle: 0.72, trail: 52 } as const
const MENU_BLEED = 12
/** The stats' figures: 26 px, in tabular figures. */
const FIGURE: Face = { family: "condensed", weight: "500", size: STATS.value, tracking: 0.08 }

interface Stat {
  readonly slot: Container
  readonly body: Container
  readonly label: Text
  /** Right-aligned in the row by `arrangeStat`. */
  readonly value: Container
  readonly rule: Graphics
  /** Lays the value out from its top-left; returns its width, its last letter's spacing included, and how far below its top its baseline sits. */
  arrange(): { readonly width: number; readonly baseline: number }
}

export interface ResultsOptions {
  readonly intents: Pick<IntentApi, "restart" | "quit">
  /** Where the results' keyboard sink lives: the overlay's root. */
  readonly overlay: HTMLElement
  /** The scene's grade, shared with the title and pause: the results drain the scene to grey. */
  readonly drain: Drain
}

export interface Results extends StageScreen, Tinted {
  /** The run's end as it happened, and how many zones it cleared, for the card that follows. */
  record(outcome: Outcome, zones: number): void
  /** The seal in both its forms in every zone's accent, rasterised at once, for loading to hand to the GPU. */
  readonly seals: Promise<ReadonlyArray<Texture>>
}

/**
 * Run clear and game over: the world drains behind a card with the zone reached (and the run's span when it crossed
 * zones), the run's time, kills, rooms and zones cleared, the diamonds left and the weapon in hand, and a seal stamped
 * like a hanko: a full run's rank (kept as the best full run on this device, and the card says when it beats it), the
 * zone a practice run started from, or the zone the player fell in. Retry or title. It holds the keyboard while it is
 * up, and a press anywhere on it never reaches the game.
 */
export const createResults = (options: ResultsOptions): Results => {
  const { intents, overlay, drain } = options
  const node = new Container({ label: "results" })
  node.visible = false
  let accent = accentOf("courtyard")

  const veil = new Container({ label: "results-veil" })
  /** The backdrop's ink over the drained scene: .57 behind a clear, .66 behind a game over. */
  const flat = new Graphics()
  const clearScrim = radialScrim([[0, PALETTE.ink, 0.2], [1, PALETTE.ink, 0.72]], [0.5, 0.5])
  /** White, tinted the accent's deep tone. */
  const overScrim = radialScrim([[0, 0xffffff, 0], [0.3, 0xffffff, 0], [1, 0xffffff, 0.32]], [0.5, 0.5])
  veil.addChild(flat, clearScrim.node, overScrim.node)
  node.addChild(veil)
  const card = piece(node, "results-card")

  const faces = ownedFaces()

  const plate = createPlate()
  const ticks = createCorners({ arm: 12, weight: 1, color: PALETTE.paper, alpha: 0.85 })
  card.body.addChild(plate.node, ticks.node)

  const kicker = piece(card.body, "results-kicker")
  const indexStyle = faces.style({ family: "condensed", weight: "600", size: 12, tracking: 0.12 })
  const arenaStyle = faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.42 })
  const kanjiStyle = faces.style({ family: "jp", size: 22 })
  const zoneNumber = textIn("", indexStyle, PALETTE.paper)
  const zoneName = textIn("", arenaStyle, PALETTE.concrete300)
  const kickerRule = new Graphics().rect(0, 0, 1, 1).fill({ color: PALETTE.paper, alpha: 0.18 })
  const jp = textIn("", kanjiStyle, PALETTE.paper)
  kicker.body.addChild(zoneNumber, zoneName, kickerRule, jp)

  const titleSlot = new Container({ label: "results-title" })
  card.body.addChild(titleSlot)
  const wordStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 76, tracking: 0.06 })
  const word = piece(titleSlot, "results-word")
  const wordText = textIn("", wordStyle, PALETTE.paper)
  word.body.addChild(wordText)
  const underWrap = new Container({ label: "results-underline" })
  const underWipe = createWipe("left")
  const underLine = brushRaster(underline.shapes, UNDERLINE)
  underLine.sprite.tint = PALETTE.paper
  underWrap.addChild(underLine.sprite, underWipe.mask)
  underWrap.mask = underWipe.mask
  const cutWrap = new Container({ label: "results-cut" })
  const cutWipe = createWipe("left")
  const cutGlow = brushRaster(cut.shapes, CUT, 6)
  cutGlow.sprite.alpha = 0.8
  const cutLine = brushRaster(cut.shapes, CUT)
  cutWrap.addChild(cutGlow.sprite, cutLine.sprite, cutWipe.mask)
  cutWrap.mask = cutWipe.mask
  titleSlot.addChild(underWrap, cutWrap)

  const subStyle = faces.style({ family: "condensed", weight: "400", size: 13, tracking: 0.42 })
  const sub = textIn("", subStyle, PALETTE.concrete300)
  card.body.addChild(sub)

  const statsSlot = new Container({ label: "results-stats" })
  card.body.addChild(statsSlot)
  const labelStyle = faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.42 })
  /** The figures' line box, for their baseline: 26 px at line-height 1. */
  const figureLine = new TextStyle({ fontFamily: FAMILY.condensed, fontWeight: "500", fontSize: STATS.value })
  /** "/ 3" after the zones cleared, its figure tabular too. */
  const outOf: Face = { family: "condensed", weight: "500", size: 14, tracking: 0.1 }
  const outOfLine = new TextStyle({ fontFamily: FAMILY.condensed, fontWeight: "500", fontSize: outOf.size })
  const weaponStyle = faces.style({ family: "condensed", weight: "500", size: 16, tracking: 0.3 })

  const stat = (name: string, value: Container, arrange: Stat["arrange"]): Stat => {
    const { slot, body } = piece(statsSlot, `results-stat ${name}`)
    const label = textIn("", labelStyle, PALETTE.concrete300)
    label.text = name.toUpperCase()
    const rule = new Graphics().rect(0, 0, 1, 1).fill({ color: PALETTE.paper, alpha: 0.12 })
    body.addChild(label, value, rule)
    return { slot, body, label, value, rule, arrange }
  }
  /** A stat of figures that count up, right-aligned, so a longer count moves left. */
  const counted = (name: string) => {
    const figures = digits(FIGURE, PALETTE.paper)
    const value = new Container()
    value.addChild(figures)
    return {
      figures,
      stat: stat(name, value, () => {
        placeDigits(figures, 0, 0, STATS.value)
        return { width: figures.width, baseline: lineBaseline(figureLine, STATS.value) }
      })
    }
  }
  const time = counted("Time")
  const kills = counted("Kills")
  const rooms = counted("Rooms")
  const zonesCount = digits(FIGURE, PALETTE.paper)
  const zonesOf = digits(outOf, PALETTE.concrete300)
  const zonesValue = new Container()
  zonesValue.addChild(zonesCount, zonesOf)
  const zones = stat("Zones", zonesValue, () => {
    const baseline = lineBaseline(figureLine, STATS.value)
    placeDigits(zonesCount, 0, 0, STATS.value)
    placeDigits(zonesOf, zonesCount.width + 6, baseline - lineBaseline(outOfLine))
    return { width: zonesCount.width + 6 + zonesOf.width, baseline }
  })
  const diamonds = new Container()
  /** A diamond left: paper with no edge. */
  const solidDiamond = new GraphicsContext().poly([12, 2.5, 21.5, 12, 12, 21.5, 2.5, 12]).fill(0xffffff)
  const lives = stat("Diamonds", diamonds, () => ({
    width: Math.max(0, diamonds.children.length * (DIAMOND.size + DIAMOND.gap) - DIAMOND.gap),
    // The icons' row is 26 px tall; its baseline is its first icon's bottom.
    baseline: (STATS.value + DIAMOND.size) / 2
  }))
  const weaponJp = textIn("", kanjiStyle, PALETTE.paper)
  const weaponName = textIn("", weaponStyle, PALETTE.paper)
  const weaponValue = new Container()
  weaponValue.addChild(weaponJp, weaponName)
  const weapon = stat("Weapon", weaponValue, () => {
    const across = inlineWidth(weaponJp) + 8
    placeInLine(weaponJp, 0, 0, 22)
    placeInLine(weaponName, across, 3, 16)
    return { width: across + inlineWidth(weaponName), baseline: lineBaseline(kanjiStyle, 22) }
  })
  const stats: ReadonlyArray<Stat> = [time.stat, kills.stat, rooms.stat, zones, lives, weapon]

  const rank = new Container({ label: "results-rank" })
  card.body.addChild(rank)
  const seal = piece(rank, "results-seal")
  seal.body.pivot.set(SEAL_SIZE / 2, SEAL_SIZE / 2)
  const sealUnits = new Container()
  sealUnits.scale.set(SEAL_SIZE / 100)
  const glowFull = blurSprite(SEAL(""), SEAL_GLOW, 14 * (100 / SEAL_SIZE), { width: 192, height: 192 }, "results-seal")
  glowFull.alpha = 0.45
  const glowHollow = blurSprite(SEAL(HOLLOW("#fff")), SEAL_GLOW, 10 * (100 / SEAL_SIZE), { width: 192, height: 192 }, "results-seal-hollow")
  glowHollow.alpha = 0.35
  const sealInk = new Sprite(Texture.EMPTY)
  sealUnits.addChild(glowFull, glowHollow, sealInk)
  const letterStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 74 })
  const hollowStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 66 })
  const hollowGlowStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 66, shadow: { color: accent.accent, alpha: 0.4, blur: 14 } }, PALETTE.paper)
  const letterDeep = textIn("", letterStyle, PALETTE.paper)
  const letter = textIn("", letterStyle, PALETTE.paper)
  seal.body.addChild(sealUnits, letterDeep, letter)
  const rankLabelStyle = faces.style({ family: "condensed", weight: "500", size: 10.5, tracking: 0.42 })
  const rankWordStyle = faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.24 })
  const rankLabel = piece(rank, "results-rank-label")
  const rankLabelText = textIn("", rankLabelStyle, PALETTE.concrete300)
  rankLabel.body.addChild(rankLabelText)
  const rankWord = piece(rank, "results-rank-word")
  const rankWordText = textIn("", rankWordStyle, PALETTE.paper)
  rankWord.body.addChild(rankWordText)

  const menuSlot = new Container({ label: "results-menu" })
  card.body.addChild(menuSlot)
  const menu = createMenu([
    { label: "Retry", action: intents.restart },
    { label: "Title", action: intents.quit }
  ], { row: true, weight: "500" })
  menuSlot.addChild(menu.node)

  const sink = createSink(overlay, "Results", (event) => menu.key(event))
  blockPointer(node)

  let viewport: Viewport | null = null
  let outcome: Outcome | null = null
  let zonesCleared = 0
  let cleared = true
  let hollow = true
  let motion: gsap.core.Timeline | null = null
  let leaving: gsap.core.Timeline | null = null

  /** The seal rasterised by the browser with its noise, once per variant and accent. */
  const seals = new Map<string, Promise<Texture>>()
  const sealOf = (asHollow: boolean, colours: Accent): { readonly key: string; readonly loading: Promise<Texture> } => {
    const key = `${asHollow ? "hollow" : "full"} ${colours.accent} ${colours.fill}`
    let loading = seals.get(key)
    if (loading === undefined) {
      const paint = asHollow ? HOLLOW(hex(colours.accent)) : `fill="${hex(colours.fill)}"`
      loading = svgTexture(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${SEAL(paint)}</svg>`, { width: 2 * SEAL_SIZE, height: 2 * SEAL_SIZE, label: "seal" })
      seals.set(key, loading)
    }
    return { key, loading }
  }
  let sealKey = ""
  const paintSeal = () => {
    const { key, loading } = sealOf(hollow, accent)
    sealKey = key
    void loading.then((texture) => {
      if (sealInk.destroyed || sealKey !== key) return
      sealInk.texture = texture
      sealInk.setSize(100, 100)
    })
    glowFull.visible = !hollow
    glowHollow.visible = hollow
    letter.style = hollow ? hollowGlowStyle : letterStyle
    letter.tint = hollow ? 0xffffff : PALETTE.paper
    letterDeep.style = hollow ? hollowStyle : letterStyle
  }

  /** The stats' columns' width, px, set by `place`. */
  let column = 0
  const arrangeStat = (each: Stat) => {
    const { width: valueWidth, baseline } = each.arrange()
    const above = Math.max(lineBaseline(labelStyle), baseline)
    placeInLine(each.label, 0, above - lineBaseline(labelStyle))
    each.value.position.set(Math.round(column - valueWidth), Math.round(above - baseline))
    each.rule.position.set(0, STATS.row - 1)
    each.rule.scale.x = column
  }

  /** Lays the card out for the viewport and what it shows; the card's motion is left to its bodies. */
  const place = () => {
    if (viewport === null) return
    const { width: W, height: H, margin: m, narrow } = viewport
    const width = Math.round(Math.min(700, W - 2 * m))
    const pad = narrow ? { top: NARROW_PAD, side: NARROW_PAD, bottom: NARROW_PAD } : PAD
    const left = BORDER + pad.side
    const inner = width - 2 * left
    let y = BORDER + pad.top

    kicker.slot.position.set(0, y)
    placeInLine(zoneNumber, left, (KICKER.height - lineHeightOf(indexStyle)) / 2)
    placeInLine(zoneName, zoneNumber.x + inlineWidth(zoneNumber) + KICKER.gap, (KICKER.height - lineHeightOf(arenaStyle)) / 2)
    placeInLine(jp, left + inner - inlineWidth(jp), 0, KICKER.height)
    const ruleFrom = Math.round(zoneName.x + inlineWidth(zoneName) + KICKER.gap)
    kickerRule.position.set(ruleFrom, Math.floor((KICKER.height - 1) / 2))
    kickerRule.scale.x = Math.max(0, jp.x - KICKER.gap - ruleFrom)
    y += KICKER.height + GAP.title

    const size = clamp(0.054 * W, 44, 76)
    resize(wordStyle, size, 0.06)
    const line = 0.95 * Number(wordStyle.fontSize)
    titleSlot.position.set(left, Math.round(y))
    word.slot.position.set(0, Math.round(0.6 * line))
    word.body.pivot.set(0, Math.round(0.6 * line))
    placeInLine(wordText, 0, 0, line)
    underWrap.position.set(0, Math.round(line + GAP.underline))
    underLine.fit({ width: inner, height: UNDERLINE_HEIGHT }, viewport.resolution)
    underWipe.fit(new Rectangle(0, 0, inner, UNDERLINE_HEIGHT))
    const cutBox = { width: 1.08 * inner, height: 0.7 * line }
    cutWrap.position.set(Math.round(-0.04 * inner), Math.round(0.04 * line))
    cutLine.fit(cutBox, viewport.resolution)
    cutGlow.fit(cutBox, 1)
    cutWipe.fit(new Rectangle(0, 0, cutBox.width, cutBox.height))
    y += cleared ? line + GAP.underline + UNDERLINE_HEIGHT : line

    if (sub.visible) {
      y += GAP.sub
      placeInLine(sub, left, y)
      y += lineHeightOf(subStyle)
    }
    y += GAP.grid

    const statsWidth = Math.min(STATS.width, narrow ? inner : inner - STATS.across - RANK_WIDTH)
    column = (statsWidth - STATS.across) / 2
    stats.forEach((each, index) => {
      each.slot.position.set(Math.round((index % 2) * (column + STATS.across)), Math.floor(index / 2) * (STATS.row + STATS.down))
      arrangeStat(each)
    })
    const statsHeight = 3 * STATS.row + 2 * STATS.down

    seal.slot.position.set(RANK_WIDTH / 2, SEAL_SIZE / 2)
    const letterSize = Number(letter.style.fontSize)
    placeInLine(letter, (SEAL_SIZE - inlineWidth(letter)) / 2, (SEAL_SIZE - letterSize) / 2, letterSize)
    letterDeep.position.set(letter.x, letter.y + 2)
    const centred = (text: Text) => (RANK_WIDTH - inlineWidth(text) + text.style.letterSpacing) / 2
    let rankY = SEAL_SIZE + GAP.rank
    placeInLine(rankLabelText, 0, 0)
    rankLabel.slot.position.set(Math.round(centred(rankLabelText)), rankY)
    rankY += lineHeightOf(rankLabelStyle) + GAP.rank
    placeInLine(rankWordText, 0, 0)
    rankWord.slot.position.set(Math.round(centred(rankWordText)), Math.round(rankY))
    const rankHeight = rankY + (rankWordText.text === "" ? 0 : lineHeightOf(rankWordStyle))

    let gridHeight: number
    if (narrow) {
      statsSlot.position.set(left, Math.round(y))
      rank.position.set(Math.round(left + (inner - RANK_WIDTH) / 2), Math.round(y + statsHeight + GAP.grid))
      gridHeight = statsHeight + GAP.grid + rankHeight
    } else {
      gridHeight = Math.max(statsHeight, rankHeight)
      statsSlot.position.set(left, Math.round(y + gridHeight - statsHeight))
      rank.position.set(left + inner - RANK_WIDTH, Math.round(y + gridHeight - rankHeight))
    }
    y += gridHeight + GAP.menu

    menu.layout({ width: inner + 2 * MENU_BLEED, ...MENU })
    menuSlot.position.set(left - MENU_BLEED, Math.round(y))
    const height = Math.round(y + MENU.row + pad.bottom + BORDER)
    plate.draw(width, height)
    ticks.place(0, 0, width, height)
    card.slot.position.set(Math.round((W - width) / 2), Math.round((H - height) / 2))
  }

  const tint = (next: Accent) => {
    accent = next
    zoneNumber.tint = next.accent
    weaponJp.tint = next.accent
    cutLine.sprite.tint = next.accent
    cutGlow.sprite.tint = next.accent
    glowFull.tint = next.accent
    glowHollow.tint = next.accent
    letterDeep.tint = next.deep
    hollowGlowStyle.dropShadow = shadowOf({ color: next.accent, alpha: 0.4, blur: 14 })
    overScrim.node.tint = next.deep
    menu.tint(next)
    paintSeal()
  }
  tint(accent)
  const allSeals = Promise.all(ZONE_LIST.flatMap((zone) => [true, false].map((asHollow) => sealOf(asHollow, accentOf(zone.id)).loading)))

  const enter = (view: GameView) => {
    motion?.kill()
    leaving?.kill()
    cleared = view.flow === "RunClear"
    const seconds = outcome?.time ?? view.timer
    const killCount = outcome?.kills ?? view.kills
    const roomCount = outcome?.rooms ?? view.run.rooms
    const zone = zoneOf(view.zone)
    const from = zoneOf(view.run.from)
    zoneNumber.text = `ZONE ${zone.number}`
    zoneName.text = zone.name.toUpperCase()
    wordText.text = cleared ? "RUN CLEAR" : "GAME OVER"
    jp.text = cleared ? "完" : "敗"
    sub.text = view.run.sandbox ? "SANDBOX" : from.number === zone.number ? "" : `ZONE ${from.number} TO ZONE ${zone.number}`
    sub.visible = sub.text !== ""
    zonesCount.text = String(zonesCleared)
    zonesOf.text = `/ ${ZONE_LIST.length - from.number + 1}`
    for (const old of diamonds.removeChildren()) old.destroy()
    for (let i = 0; i < view.maxLives; i++) {
      const left = i < view.lives
      const icon = new SmoothGraphics(left ? solidDiamond : iconContext(shapeMarkup("diamond"), "outline", 1.5))
      icon.scale.set(DIAMOND.size / 24)
      icon.position.set(i * (DIAMOND.size + DIAMOND.gap), (STATS.value - DIAMOND.size) / 2)
      icon.tint = PALETTE.paper
      icon.alpha = left ? 1 : 0.45
      diamonds.addChild(icon)
    }
    const hand = weaponOf(view.weapon.id)
    weaponJp.text = hand.kanji
    weaponName.text = hand.name.toUpperCase()

    const fell = outcome?.type === "gameOver" && outcome.room !== null ? view.map?.rooms[outcome.room] : undefined
    const full = cleared && view.run.rank !== null
    hollow = !full
    if (full && view.run.rank !== null) {
      const kept = recordRun(seconds, view.run.rank)
      letter.text = view.run.rank
      rankLabelText.text = "RANK"
      rankWordText.text = kept.time === seconds && kept.rank === view.run.rank ? "NEW BEST" : `BEST ${formatTime(kept.time)}`
    } else if (cleared) {
      letter.text = String(from.number)
      rankLabelText.text = "FROM ZONE"
      rankWordText.text = "PRACTICE"
    } else {
      letter.text = String(zone.number)
      rankLabelText.text = "FELL IN"
      rankWordText.text = fell === undefined ? "" : `${ROOM_KINDS[fell.kind].name} room`.toUpperCase()
    }
    letterDeep.text = letter.text
    paintSeal()
    flat.alpha = cleared ? 0.57 : 0.66
    clearScrim.node.visible = cleared
    overScrim.node.visible = !cleared
    underWrap.visible = cleared
    cutWrap.visible = !cleared

    const counter = { time: 0, kills: 0, rooms: 0 }
    const show = () => {
      time.figures.text = formatTime(counter.time)
      kills.figures.text = twoDigits(counter.kills)
      rooms.figures.text = twoDigits(counter.rooms)
      for (const each of [time, kills, rooms]) each.stat.value.x = Math.round(column - each.figures.width)
    }
    show()
    place()
    node.visible = true
    node.alpha = 1
    card.body.position.set(0, 0)
    menu.reset()
    sink.focus()
    drain.to({ desaturate: 1 }, 0.6)

    const stamp = drawn(0.22, "power4.in", ON_ONES)
    const sealAt = cleared ? 1.9 : 1.6
    motion = gsap.timeline()
      .fromTo(veil, { alpha: 0 }, { alpha: 1, duration: 0.6, ease: "power2.out" })
      .fromTo(card.body, { alpha: 0, y: 24 }, { alpha: 1, y: 0, duration: 0.45, ease: "power3.out" }, 0.1)
      .add(ticks.pop(2.4, 0.35, drawn(0.35, "power3.out"), 0.04), 0.2)
      .fromTo(kicker.body, { alpha: 0, x: -12 }, { alpha: 1, x: 0, duration: 0.4, ease: "power3.out" }, 0.25)
      .fromTo(word.body, { alpha: 0, x: -24 }, { alpha: 1, x: 0, duration: 0.3, ease: drawn(0.3, "expo.out", ON_ONES) }, 0.32)
      .fromTo(word.body.scale, { x: 1.7, y: 1.7 }, { x: 1, y: 1, duration: 0.3, ease: drawn(0.3, "expo.out", ON_ONES) }, 0.32)
      .add(rattle(card.body, 6, 0.3), 0.5)
      .fromTo(cleared ? underWipe : cutWipe, { amount: 0 }, { amount: 1, duration: 0.2, ease: drawn(0.2, "power3.in", ON_ONES) }, 0.55)
      .fromTo(sub, { alpha: 0 }, { alpha: 1, duration: 0.6, ease: "expo.out" }, 0.7)
      .add(tracked(subStyle, 0.9, 0.42, { duration: 0.6, ease: "expo.out" }), 0.7)
      .fromTo(stats.map((each) => each.body), { alpha: 0, x: -16 }, { alpha: 1, x: 0, duration: 0.35, ease: "power3.out", stagger: 0.1 }, 0.85)
      .to(counter, { time: seconds, kills: killCount, rooms: roomCount, duration: 0.9, ease: drawn(0.9, "power2.out"), onUpdate: show }, 0.9)
      .fromTo(seal.body, { alpha: 0, angle: -28 }, { alpha: 1, angle: full ? -7 : 4, duration: 0.22, ease: stamp }, sealAt)
      .fromTo(seal.body.scale, { x: 2.6, y: 2.6 }, { x: 1, y: 1, duration: 0.22, ease: stamp }, sealAt)
      .add(rattle(card.body, cleared ? 8 : 5, 0.35), ">")
      .fromTo([rankLabel.body, rankWord.body], { alpha: 0, y: 6 }, { alpha: 1, y: 0, duration: 0.4, stagger: 0.08, ease: "power3.out" }, ">-0.2")
      .fromTo(menu.items, { alpha: 0, y: 10 }, { alpha: 1, y: 0, duration: 0.35, ease: "back.out(2)", stagger: 0.07 }, cleared ? 2.3 : 2)
  }

  return {
    node,
    seals: allSeals,
    record: (moment, zonesThrough) => {
      outcome = moment
      zonesCleared = zonesThrough
    },
    enter,
    exit: () => {
      outcome = null
      sink.release()
      motion?.kill()
      leaving?.kill()
      leaving = gsap.timeline()
        .to(card.body, { alpha: 0, y: -16, duration: 0.2, ease: "power2.in" }, 0.05)
        .to(veil, { alpha: 0, duration: 0.35, ease: "power2.in" }, 0.1)
        .add(() => void drain.to({ desaturate: 0 }, 0.35, "power2.in"), 0.1)
        .set(node, { visible: false })
    },
    layout: (next) => {
      viewport = next
      const { width: W, height: H } = next
      flat.clear().rect(0, 0, W, H).fill(PALETTE.ink)
      for (const scrim of [clearScrim, overScrim]) scrim.fit(new Rectangle(0, 0, W, H), [(W / 2) * Math.SQRT2, (H / 2) * Math.SQRT2])
      node.hitArea = new Rectangle(0, 0, W, H)
      place()
    },
    tint,
    dispose: () => {
      motion?.kill()
      leaving?.kill()
      sink.dispose()
      node.destroy({ children: true })
      solidDiamond.destroy()
      for (const loading of seals.values()) void loading.then((texture) => texture.destroy(true))
      faces.release()
    }
  }
}
