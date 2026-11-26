import { gsap } from "gsap"
import { clamp } from "math"
import { mulberry32 } from "math/random"
import { BlurFilter, Container, Graphics, GraphicsContext, Rectangle, SmoothGraphics } from "pixi.js"

import { PALETTE, paletteOf } from "../art/palette.ts"
import type { ZonePalette } from "../art/palette.ts"
import { bossOf, TRANSITION, zoneOf } from "../sim/index.ts"
import type { TransitionView, ZoneId } from "../sim/index.ts"
import { brushStroke } from "./brush.ts"
import type { Point } from "./brush.ts"
import { twoDigits } from "./format.ts"
import { brushRaster, inkContext, spineReveal } from "./kit/ink.ts"
import { radialScrim } from "./kit/scrim.ts"
import type { Scrim } from "./kit/scrim.ts"
import { inlineWidth, lineBaseline, lineHeightOf, ownedFaces, placeInLine, resize, shadowOf, textIn, tracked } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { createWipe } from "./kit/wipe.ts"
import { drawn, ON_ONES, ON_TWOS, rattle } from "./motion.ts"
import type { Staged } from "./screen.ts"

/** The zone change's beats in seconds from its start (docs/DESIGN.md, Into the next zone). */
const BEAT = (() => {
  const { exit, cover, card, reveal } = TRANSITION.zone
  return { cover: exit / 60, card: (exit + cover) / 60, reveal: (exit + cover + card) / 60, end: (exit + cover + card + reveal) / 60 }
})()

/** The sheet's dry-brush edge, in its units, stretched across the screen and 22% of its height. */
const EDGE = { width: 1000, height: 140 } as const
/** The sheet starts and ends this many screen heights off the screen. */
const OFF = 1.18

interface Edge {
  /** The ink: the block solid below y 76 and the wide strokes laid across it. */
  readonly shapes: ReadonlyArray<string>
  /** Drops of ink flung ahead of it. */
  readonly drops: ReadonlyArray<{ readonly x: number; readonly y: number; readonly rx: number; readonly ry: number }>
  /** The thin accent stroke riding just ahead. */
  readonly line: ReadonlyArray<string>
}

/**
 * A dry-brush edge for the ink sheet, 1000 × 140 with the ink solid below `y` 76: wide strokes laid across it at
 * different heights, so their tapered ends and bristles cut peaks and gaps into the edge, drops of ink flung ahead of
 * it, and a thin accent stroke riding just ahead, as the banners' band has.
 */
const brushEdge = (seed: number): Edge => {
  const random = mulberry32.create(seed)
  const next = () => mulberry32.sample(random)
  const strokes = Array.from({ length: 8 }, (_, i) => {
    const from = -120 + i * 150 + next() * 60
    const y = 52 + next() * 22
    const span = 280 + next() * 160
    const points: ReadonlyArray<Point> = [[from, y + 6], [from + span * 0.4, y - 4 + next() * 8], [from + span, y - 2 + next() * 10]]
    return brushStroke(points, { width: 30 + next() * 18, seed: seed + i, start: 0.5 + next() * 0.4, attack: 0.08, release: 0.32, dry: 0.45, bristles: 12, rough: 0.14, wobble: 0.35 }).shapes
  }).flat()
  const drops = Array.from({ length: 12 }, () => {
    const r = 1.2 + next() * 3
    const x = Math.round(next() * 1000)
    const y = Math.round(22 + next() * 34)
    return { x, y, rx: Math.round(r * 7.5) / 10, ry: Math.round(r * 10) / 10 }
  })
  const line = brushStroke([[-10, 44 + next() * 6], [480, 40 + next() * 6], [1010, 44 + next() * 6]], { width: 3.4, seed: seed + 40, start: 0.3, attack: 0.3, release: 0.35, dry: 0.3, bristles: 4 }).shapes
  return { shapes: ["M-20 76L1020 76L1020 156L-20 156Z", ...strokes], drops, line }
}

const TOP = brushEdge(71)
const BOTTOM = brushEdge(73)
const bar = brushStroke([[4, 22], [220, 17], [470, 20], [596, 18]], { width: 22, seed: 77, start: 0.95, attack: 0.02, release: 0.24, dry: 0.42, bristles: 12, rough: 0.05, streaks: 3 })
const BAR = { width: 600, height: 40 } as const
const BAR_HEIGHT = 30

/** `from` blended toward `to` by `t`, channel by channel, as GSAP tweens a colour. */
const blend = (from: number, to: number, t: number): number => {
  const channel = (shift: number) => {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    return Math.round(a + (b - a) * t) << shift
  }
  return channel(16) | channel(8) | channel(0)
}

export interface ZoneCard extends Staged {
  /** Every frame: plays through a zone change, from the zone the hero leaves (`zone` until the swap). */
  update(transition: TransitionView | null, zone: ZoneId): void
}

/**
 * The zone change's card. Over the cover beat an ink sheet rises up the screen in the old zone's ink, its dry-brush
 * edge leading; under it the ink turns to the new zone's, and the card plays on it: the kanji stamps down large, ZONE
 * and its number, the name, its accent bar drawn in the new danger colour, the zone's room count and boss. Through the
 * reveal the sheet rises off the top, taking the card with it. It is scrubbed by the transition's progress, so it
 * holds and steps with the game.
 */
export const createZoneCard = (): ZoneCard => {
  const node = new Container({ label: "zone-card" })
  node.visible = false
  node.alpha = 0
  let viewport: Viewport | null = null

  const faces = ownedFaces()
  const holder = (...children: ReadonlyArray<Container>) => {
    const made = new Container()
    if (children.length > 0) made.addChild(...children)
    return made
  }

  const sheet = new Container({ label: "zone-sheet" })
  const paper = new Graphics().rect(0, 0, 1, 1).fill(0xffffff)

  /** One of the sheet's edges: its ink and drops in the sheet's colour, then the line's glow and the line. */
  const edgeOf = (drawing: Edge) => {
    const edge = new Container()
    const inkUnits = new Container()
    const inkContextOf = inkContext(drawing.shapes)
    const ink = new SmoothGraphics(inkContextOf)
    const dropsContext = new GraphicsContext()
    for (const drop of drawing.drops) dropsContext.ellipse(drop.x, drop.y, drop.rx, drop.ry).fill(0xffffff)
    const drops = new SmoothGraphics(dropsContext)
    inkUnits.addChild(ink, drops)
    const glow = brushRaster(drawing.line, EDGE, 4)
    const line = brushRaster(drawing.line, EDGE)
    edge.addChild(inkUnits, glow.sprite, line.sprite)
    return {
      edge,
      ink,
      drops,
      lines: [glow.sprite, line.sprite],
      contexts: [inkContextOf, dropsContext],
      fit: (size: { readonly width: number; readonly height: number }, resolution: number) => {
        inkUnits.scale.set(size.width / EDGE.width, size.height / EDGE.height)
        glow.fit(size, 1)
        line.fit(size, resolution)
      }
    }
  }
  const top = edgeOf(TOP)
  const bottom = edgeOf(BOTTOM)

  /** The new zone's glow under the card, its two ellipses made again for each zone change. */
  const glow = new Container()
  let scrims: ReadonlyArray<{ readonly scrim: Scrim; readonly radii: readonly [number, number] }> = []

  const jpStyle = faces.style({ family: "jp", size: 272, shadow: { color: PALETTE.paper, alpha: 0.45, blur: 40 } }, PALETTE.paper)
  const jp = textIn("", jpStyle)
  const jpBody = holder(jp)
  const jpSlot = holder(jpBody)

  const kickerStyle = faces.style({ family: "condensed", weight: "500", size: 14, tracking: 0.6 })
  const zoneWord = textIn("ZONE", kickerStyle, PALETTE.concrete300)
  const numStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 40, tracking: 0.04, shadow: { color: PALETTE.paper, alpha: 0.6, blur: 18 } })
  const num = textIn("", numStyle)
  const numBody = holder(num)
  const numSlot = holder(numBody)
  const kickerBody = holder(zoneWord, numSlot)
  const kickerSlot = holder(kickerBody)

  const nameStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 112, tracking: 0.04 })
  const name = textIn("", nameStyle, PALETTE.paper)
  const nameWipe = createWipe("left")
  const nameBody = holder(name, nameWipe.mask)
  nameBody.mask = nameWipe.mask
  const nameSlot = holder(nameBody)

  const barReveal = spineReveal(bar.points, 80)
  const barLine = brushRaster(bar.shapes, BAR)
  const barUnits = holder(barReveal.mask)
  const barLineSlot = holder(barLine.sprite, barUnits)
  barLineSlot.mask = barReveal.mask
  // A 10 px glow round the bar as drawn so far: a copy under its own reveal, blurred whole.
  const glowReveal = spineReveal(bar.points, 80)
  const glowLine = brushRaster(bar.shapes, BAR)
  const glowUnits = holder(glowReveal.mask)
  const glowMasked = holder(glowLine.sprite, glowUnits)
  glowMasked.mask = glowReveal.mask
  const barGlow = holder(glowMasked)
  const barBlur = new BlurFilter({ strength: 10 / 1.29, quality: 4, resolution: 1 })
  barBlur.padding = 30
  barGlow.filters = [barBlur]
  barGlow.alpha = 0.7
  const barSlot = holder(barGlow, barLineSlot)

  const infoStyle = faces.style({ family: "condensed", weight: "500", size: 13, tracking: 0.36 })
  const infoKanjiStyle = faces.style({ family: "jp", size: 16, tracking: 0.04 })
  const rooms = textIn("", infoStyle, PALETTE.paper)
  const roomsWord = textIn(" ROOMS", infoStyle, PALETTE.paper)
  const bossWord = textIn("BOSS ", infoStyle, PALETTE.paper)
  const bossName = textIn("", infoStyle, PALETTE.paper)
  const bossKanji = textIn("", infoKanjiStyle, PALETTE.paper)
  for (const dim of [roomsWord, bossWord]) dim.alpha = 0.68
  const dot = new Graphics().rect(-2.5, -2.5, 5, 5).fill(0xffffff)
  dot.angle = 45
  const infoBody = holder(rooms, roomsWord, dot, bossWord, bossName, bossKanji)
  const infoSlot = holder(infoBody)

  const body = holder(kickerSlot, nameSlot, barSlot, infoSlot)
  const bodySlot = holder(body)

  sheet.addChild(top.edge, paper, glow, jpSlot, bodySlot, bottom.edge)
  node.addChild(sheet)

  /** The sheet's rise in screen heights, its colour from the old zone's ink to the new's, and the line's switch to the new danger colour. */
  const motion = { rise: OFF, colour: 0, line: 0 }
  let palettes: { readonly before: ZonePalette; readonly after: ZonePalette } = { before: paletteOf("courtyard"), after: paletteOf("courtyard") }
  let painted = { sheet: -1, line: -1 }
  /** The letter spacing ZONE was last laid out at: the number follows it as it tracks in. */
  let kickerAt = -1

  const placeNumber = () => {
    kickerAt = kickerStyle.letterSpacing
    const left = 4 + inlineWidth(zoneWord) + 0.4 * 14
    const width = inlineWidth(num)
    const height = lineHeightOf(numStyle)
    numSlot.position.set(left + width / 2, height / 2)
    numBody.pivot.set(width / 2, height / 2)
  }

  /** The card's words: the kanji right of centre, the body's column left, both centred down the screen. */
  const arrange = () => {
    if (viewport === null) return
    const { width: W, height: H } = viewport
    const jpSize = Number(jpStyle.fontSize)
    const jpLine = 1.2 * jpSize
    const jpWidth = inlineWidth(jp)
    jpSlot.position.set(W - 0.09 * W - jpWidth / 2, H / 2)
    jpBody.pivot.set(jpWidth / 2, jpLine / 2)
    placeInLine(jp, 0, 0, jpLine)

    const kickerAbove = Math.max(lineBaseline(kickerStyle), lineBaseline(numStyle))
    const kickerHeight = kickerAbove + Math.max(lineHeightOf(kickerStyle) - lineBaseline(kickerStyle), lineHeightOf(numStyle) - lineBaseline(numStyle))
    placeInLine(zoneWord, 4, kickerAbove - lineBaseline(kickerStyle))
    placeInLine(num, 0, kickerAbove - lineBaseline(numStyle))
    placeNumber()

    const nameSize = Number(nameStyle.fontSize)
    placeInLine(name, 0, 0, nameSize)
    nameWipe.fit(new Rectangle(0, 0, inlineWidth(name), nameSize))

    const barWidth = Math.round(clamp(0.36 * W, 320, 600))
    for (const units of [barUnits, glowUnits]) units.scale.set(barWidth / BAR.width, BAR_HEIGHT / BAR.height)
    glowLine.fit({ width: barWidth, height: BAR_HEIGHT }, 1)
    barLine.fit({ width: barWidth, height: BAR_HEIGHT }, viewport.resolution)

    // The info row: each span a line box on its own baseline, the dot between, all centred on the row's middle.
    const smallAbove = lineBaseline(infoStyle)
    const smallBelow = lineHeightOf(infoStyle) - smallAbove
    const bossAbove = Math.max(smallAbove, lineBaseline(infoKanjiStyle))
    const bossBelow = Math.max(smallBelow, lineHeightOf(infoKanjiStyle) - lineBaseline(infoKanjiStyle))
    const infoHeight = Math.max(smallAbove + smallBelow, bossAbove + bossBelow, 5)
    const middle = infoHeight / 2
    const roomsBaseline = middle - (smallAbove + smallBelow) / 2 + smallAbove
    const bossBaseline = middle - (bossAbove + bossBelow) / 2 + bossAbove
    let x = 0
    for (const each of [rooms, roomsWord]) {
      placeInLine(each, x, roomsBaseline - lineBaseline(each.style))
      x += inlineWidth(each)
    }
    x += 16
    dot.position.set(x + 2.5, middle)
    x += 5 + 16
    for (const each of [bossWord, bossName, bossKanji]) {
      placeInLine(each, x, bossBaseline - lineBaseline(each.style))
      x += inlineWidth(each)
    }

    let y = 0
    kickerSlot.y = y
    y += kickerHeight + 2
    nameSlot.y = y
    y += nameSize + 12
    barSlot.y = y
    y += BAR_HEIGHT + 18
    infoSlot.y = y
    y += infoHeight
    bodySlot.position.set(0.1 * W, H / 2 - y / 2)
  }

  const fitGlow = () => {
    if (viewport === null) return
    const { width: W, height: H } = viewport
    for (const { scrim, radii } of scrims) scrim.fit(new Rectangle(0, 0, W, H), [radii[0] * W, radii[1] * H])
  }

  const layout = (next: Viewport) => {
    viewport = next
    const { width: W, height: H } = next
    paper.scale.set(W, H)
    const edgeHeight = Math.round(0.22 * H)
    top.fit({ width: W, height: edgeHeight }, next.resolution)
    bottom.fit({ width: W, height: edgeHeight }, next.resolution)
    top.edge.position.set(0, 1 - edgeHeight)
    bottom.edge.position.set(0, H - 1 + edgeHeight)
    bottom.edge.scale.y = -1
    resize(jpStyle, Math.min(0.34 * H, 0.24 * W), 0)
    resize(nameStyle, clamp(6.6 * (W / 100), 54, 112), 0.04)
    fitGlow()
    arrange()
    painted = { sheet: -1, line: -1 }
    paint()
  }

  /** Applies what the timeline moved that GSAP can't tween on a node: the sheet's rise in screen heights and its colours. */
  const paint = () => {
    sheet.y = motion.rise * (viewport?.height ?? 0)
    const sheetColour = blend(palettes.before.ink, palettes.after.ink, motion.colour)
    if (sheetColour !== painted.sheet) {
      painted.sheet = sheetColour
      for (const each of [paper, top.ink, top.drops, bottom.ink, bottom.drops]) each.tint = sheetColour
    }
    const lineColour = motion.line >= 1 ? palettes.after.danger : palettes.before.danger
    if (lineColour !== painted.line) {
      painted.line = lineColour
      for (const each of [...top.lines, ...bottom.lines]) each.tint = lineColour
    }
    if (kickerStyle.letterSpacing !== kickerAt) placeNumber()
  }

  let playing: string | null = null
  let card: gsap.core.Timeline | null = null

  const build = (from: ZoneId, to: ZoneId) => {
    const zone = zoneOf(to)
    const boss = bossOf(zone.boss)
    palettes = { before: paletteOf(from), after: paletteOf(to) }
    const accent = palettes.after.danger
    jpStyle.dropShadow = shadowOf({ color: accent, alpha: 0.45, blur: 40 })
    numStyle.fill = accent
    numStyle.dropShadow = shadowOf({ color: accent, alpha: 0.6, blur: 18 })
    for (const each of [glowLine, barLine]) each.sprite.tint = accent
    dot.tint = accent
    jp.text = zone.kanji
    num.text = twoDigits(zone.number)
    name.text = zone.name.toUpperCase()
    rooms.text = String(zone.rooms)
    bossName.text = `${boss.name.toUpperCase()} `
    bossKanji.text = boss.kanji

    for (const { scrim } of scrims) scrim.node.destroy()
    scrims = [
      { scrim: radialScrim([[0, accent, 0.12], [0.7, accent, 0]], [0.72, 0.5]), radii: [0.4, 0.5] },
      { scrim: radialScrim([[0, palettes.after.groundDark, 0.85], [0.7, palettes.after.groundDark, 0]], [0.72, 0.5]), radii: [0.5, 0.7] }
    ]
    glow.addChild(...scrims.map(({ scrim }) => scrim.node))
    fitGlow()
    arrange()
    painted = { sheet: -1, line: -1 }

    card?.kill()
    const rising = BEAT.card - BEAT.cover
    const leaving = BEAT.end - BEAT.reveal
    const stamp = drawn(0.2, "power4.in", ON_ONES)
    card = gsap.timeline({ paused: true })
      .set(node, { visible: true, alpha: 1 }, 0)
      .set(motion, { colour: 0, line: 0 }, 0)
      .fromTo(motion, { rise: OFF }, { rise: 0, duration: rising, ease: drawn(rising, "power2.in", ON_ONES) }, BEAT.cover)
      .fromTo([top.drops, bottom.drops], { y: 14 }, { y: -10, duration: rising, ease: drawn(rising, "none", ON_TWOS) }, BEAT.cover)
      .set([jpBody, kickerBody, nameBody, infoBody], { alpha: 0 }, 0)
      .set([barReveal, glowReveal], { head: 0, tail: 0 }, 0)
      .set(glow, { alpha: 0 }, 0)
      .to(motion, { colour: 1, duration: 0.2, ease: "none" }, BEAT.card)
      .set(motion, { line: 1 }, BEAT.card)
      .to(glow, { alpha: 1, duration: 0.5, ease: "power2.out" }, BEAT.card)
      .fromTo(jpBody, { alpha: 0, angle: -10 }, { alpha: 1, angle: -3, duration: 0.2, ease: stamp }, BEAT.card + 0.04)
      .fromTo(jpBody.scale, { x: 1.7, y: 1.7 }, { x: 1, y: 1, duration: 0.2, ease: stamp }, BEAT.card + 0.04)
      .add(rattle(jpBody, 10, 0.32), BEAT.card + 0.24)
      .fromTo(kickerBody, { alpha: 0 }, { alpha: 1, duration: 0.5, ease: "expo.out" }, BEAT.card + 0.12)
      .add(tracked(kickerStyle, 1.4, 0.6, { duration: 0.5, ease: "expo.out" }), BEAT.card + 0.12)
      .fromTo(numBody.scale, { x: 2, y: 2 }, { x: 1, y: 1, duration: 0.2, ease: stamp }, BEAT.card + 0.2)
      .fromTo(numBody, { alpha: 0 }, { alpha: 1, duration: 0.2, ease: stamp }, BEAT.card + 0.2)
      .fromTo(nameBody, { alpha: 0, x: -50 }, { alpha: 1, x: 0, duration: 0.34, ease: drawn(0.34, "expo.out") }, BEAT.card + 0.22)
      .fromTo(nameWipe, { amount: 0 }, { amount: 1, duration: 0.34, ease: drawn(0.34, "expo.out") }, BEAT.card + 0.22)
      .to([barReveal, glowReveal], { head: 1, duration: 0.36, ease: drawn(0.36, "power3.out", ON_ONES) }, BEAT.card + 0.36)
      .fromTo(infoBody, { alpha: 0, y: 10 }, { alpha: 1, y: 0, duration: 0.4, ease: "power3.out" }, BEAT.card + 0.55)
      .fromTo(body, { x: 0 }, { x: 16, duration: BEAT.reveal - BEAT.card, ease: "none" }, BEAT.card)
      .fromTo(jpBody, { x: 0 }, { x: -20, duration: BEAT.reveal - BEAT.card - 0.3, ease: "none" }, BEAT.card + 0.3)
      .to(motion, { rise: -OFF, duration: leaving, ease: drawn(leaving, "power2.in", ON_ONES) }, BEAT.reveal)
      .to([infoBody, nameBody, kickerBody], { alpha: 0, y: -24, duration: 0.2, ease: "power2.in", stagger: 0.03 }, BEAT.reveal)
      .to([top.drops, bottom.drops], { y: 14, duration: leaving, ease: drawn(leaving, "none", ON_TWOS) }, BEAT.reveal)
      .set(node, { visible: false, alpha: 0 }, BEAT.end)
  }

  return {
    node,
    layout,
    update: (transition, zone) => {
      if (transition === null || transition.kind !== "zone") {
        if (playing !== null) {
          card?.progress(1)
          node.visible = false
          node.alpha = 0
        }
        playing = null
        return
      }
      const key = `${transition.from}>${transition.zone}`
      if (key !== playing) {
        playing = key
        build(transition.swapped ? transition.zone : zone, transition.zone)
      }
      card?.progress(clamp(transition.overall, 0, 1))
      paint()
    },
    dispose: () => {
      card?.kill()
      node.destroy({ children: true })
      barBlur.destroy()
      for (const each of [...top.contexts, ...bottom.contexts]) each.destroy()
      faces.release()
    }
  }
}
