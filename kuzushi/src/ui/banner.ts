import { gsap } from "gsap"
import { clamp } from "math"
import { Container, GraphicsContext, GraphicsPath, SmoothGraphics } from "pixi.js"
import type { TextStyle } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { ROOM, slabGroupsOf, zoneOf } from "../sim/index.ts"
import type { ArenaLayout, DropKind, MomentOf, WaveMix, ZoneId } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { brushStroke } from "./brush.ts"
import { formatTime, twoDigits } from "./format.ts"
import { enemyShape, shapeMarkup } from "./icons.ts"
import type { Shape } from "./icons.ts"
import { digits, placeDigits } from "./kit/digits.ts"
import { blurSprite } from "./kit/glow.ts"
import { iconContext } from "./kit/icon.ts"
import { brushRaster, inkLayer, spineReveal } from "./kit/ink.ts"
import { inlineWidth, lineBaseline, lineHeightOf, ownedFaces, placeInLine, resize, shadowOf, textIn, tracked } from "./kit/type.ts"
import type { Face } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { drawn, ON_ONES } from "./motion.ts"
import { piece } from "./screen.ts"
import type { Staged, Tinted } from "./screen.ts"

const band = brushStroke([[6, 46], [260, 41], [520, 45], [760, 42], [994, 46]], { width: 80, seed: 23, start: 0.7, attack: 0.04, release: 0.14, dry: 0.26, bristles: 14, rough: 0.05, wobble: 0.1 })
const redline = brushStroke([[40, 95], [500, 92], [960, 94]], { width: 3.2, seed: 29, start: 0.2, attack: 0.3, release: 0.4, dry: 0.3, bristles: 4 })

/** The band's drawing, in its units, stretched over the banner's box. */
const BAND = { width: 1000, height: 100 } as const
/** A crown over an elite's icon in the mix, in its 24 x 10 units drawn 14 px wide. */
const CROWN = "M2 9 5 2 9 6 12 0 15 6 19 2 22 9Z"
/** The FOCUS drop's spark, in a 24-unit box. */
const SPARK = "M12 1.5 14.3 9.7 22.5 12 14.3 14.3 12 22.5 9.7 14.3 1.5 12 9.7 9.7Z"
/** The mix's icons, px. */
const ICON = 14
/** The time and room count figures, in tabular figures. */
const FIGURE: Face = { family: "condensed", weight: "400", size: 18, tracking: 0.06 }

type Variant = "wave" | "final" | "cleared" | "clear" | "zone"

/** One entry under the banner's title: an enemy kind and its count, a warning, a drop, a figure and what it counts. */
type Mix =
  | { readonly kind: "enemy"; readonly shape: Shape; readonly count: number; readonly elite: boolean }
  | { readonly kind: "warn"; readonly count?: number; readonly words: string }
  | { readonly kind: "heal" }
  | { readonly kind: "focus" }
  | { readonly kind: "figure"; readonly figure: string; readonly words: string }

const mixOf = (counts: ReadonlyArray<WaveMix>): ReadonlyArray<Mix> =>
  counts.map((each) => ({ kind: "enemy", shape: enemyShape[each.kind], count: each.count, elite: each.elite }))

/** What a room's clear left on the floor for the player to pick up. */
export interface ClearReward {
  readonly drops: ReadonlyArray<DropKind>
}

/** The CLEAR banner's line for each drop: the diamond and +1, FOCUS and what it fills. */
const DROP_WORDS: Readonly<Record<DropKind, Mix>> = { diamond: { kind: "heal" }, focus: { kind: "focus" } }

/** A zone's clear: its time from its start room, the best kept on this device, and whether a gate opened. */
export interface ZoneClear {
  readonly zone: ZoneId
  readonly time: number
  readonly best: number
  readonly gate: boolean
}

export interface Banner extends Staged, Tinted {
  /** Plays over the wave's intro, before its enemies arrive; `delay` lets a screen cut finish first. */
  wave(wave: number, total: number, counts: ReadonlyArray<WaveMix>, zone: ZoneId, delay?: number): void
  /** A wave before the room's last is cleared: says so, and in The Void how many slabs it brings down. */
  cleared(moment: MomentOf<"waveCleared">, layout: ArenaLayout): void
  /** The room's seals break: its fight is won. */
  clear(reward: ClearReward): void
  /** A zone's boss is down: the zone's clear time against its best, and whether its gate opened. */
  zone(clear: ZoneClear): void
  /** The run opens on its first zone: its number, name, kanji and room count. */
  intro(id: ZoneId, delay?: number): void
  hide(): void
  /** Whether a banner is on screen or waiting on its delay to come. */
  showing(): boolean
}

/** A piece of a mix entry, centred on the entry's middle line, `width` across. */
interface Piece {
  readonly node: Container
  readonly width: number
  readonly height: number
  place(x: number): void
}

/**
 * The banner: an ink brush band wipes across the screen with its words. A wave's number and its enemy mix as the wave
 * starts (the first says the doors are sealed, an elite's wears a crown); a wave's clear and, in The Void, how many
 * slabs it brings down; CLEAR as a room's seals break, with the diamond and FOCUS it left; a zone's clear with its time and
 * best; and the run's first zone, as the run opens on it.
 */
export const createBanner = (): Banner => {
  const node = new Container({ label: "banner" })
  node.visible = false
  let accent = accentOf("courtyard")
  let viewport: Viewport | null = null
  let variant: Variant = "wave"

  const faces = ownedFaces()
  const kickerStyle = faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.6 })
  const jpStyle = faces.style({ family: "jp", size: 48, shadow: { color: accent.accent, alpha: 0.6, blur: 16 } }, PALETTE.paper)
  const wordStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 60, tracking: 0.16 })
  const numStyle = faces.style({ family: "condensed", weight: "700", italic: true, size: 68 })
  const ofStyle = faces.style({ family: "condensed", weight: "500", size: 16, tracking: 0.2 })
  const countStyle = faces.style({ family: "condensed", weight: "500", size: 14, tracking: 0.1 })
  const smallStyle = faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.34 })
  const healStyle = faces.style({ family: "condensed", weight: "600", size: 16, tracking: 0.1 })
  const focusStyle = faces.style({ family: "condensed", weight: "600", size: 16, tracking: 0.06 })
  const figureStyle = faces.style(FIGURE)

  // The band: the ink brush (filled once, so its bristles never double) and the accent line, drawn on along the spine.
  const art = new Container({ label: "banner-band" })
  const reveal = spineReveal(band.points, 160)
  const wrapper = new Container()
  const ink = inkLayer(band.shapes, BAND)
  ink.node.tint = PALETTE.ink
  ink.node.alpha = 0.86
  const red = brushRaster(redline.shapes, BAND)
  const units = new Container()
  units.addChild(reveal.mask)
  wrapper.addChild(ink.node, red.sprite, units)
  wrapper.mask = reveal.mask
  art.addChild(wrapper)

  const content = new Container({ label: "banner-words" })
  node.addChild(art, content)
  const kicker = textIn("", kickerStyle)
  kicker.anchor.x = 0.5
  const jp = textIn("", jpStyle)
  const word = textIn("", wordStyle, PALETTE.paper)
  const num = textIn("", numStyle, PALETTE.paper)
  const of = textIn("", ofStyle, PALETTE.concrete300)
  const kickerPart = piece(content, "kicker", kicker)
  const jpPart = piece(content, "kanji", jp)
  const wordPart = piece(content, "word", word)
  const numPart = piece(content, "num", num)
  const ofPart = piece(content, "of", of)
  const mixRow = new Container()
  const mixPart = piece(content, "mix", mixRow)
  const bodies = [kickerPart, jpPart, wordPart, numPart, ofPart, mixPart].map((each) => each.body)

  // The mix's pieces, made again for each banner.
  const crownContext = new GraphicsContext().path(new GraphicsPath(CROWN)).fill(0xffffff)
  const sparkContext = new GraphicsContext().path(new GraphicsPath(SPARK)).fill(0xffffff).stroke({ width: 1.5, color: PALETTE.ink })
  /** What the mix draws in the accent, recoloured with it. */
  let accented: Array<Container> = []
  let items: Array<{ readonly node: Container; readonly width: number; readonly height: number }> = []

  const words = (content: string, textStyle: TextStyle, tint: number): Piece => {
    const text = textIn("", textStyle, tint)
    text.text = content
    const height = lineHeightOf(textStyle)
    return { node: text, width: inlineWidth(text), height, place: (x) => placeInLine(text, x, -height / 2) }
  }
  const figure = (content: string): Piece => {
    const text = digits(FIGURE, PALETTE.paper)
    text.text = content
    const height = lineHeightOf(figureStyle)
    return { node: text, width: text.width, height, place: (x) => placeDigits(text, x, -height / 2) }
  }
  const icon = (context: GraphicsContext, tint: number): Piece => {
    const shape = new SmoothGraphics(context)
    shape.scale.set(ICON / 24)
    shape.tint = tint
    return { node: shape, width: ICON, height: ICON, place: (x) => shape.position.set(x, -ICON / 2) }
  }
  /** The spark with its blurred accent glow. */
  const spark = (): Piece => {
    const holder = new Container()
    const glow = blurSprite(`<path d="${SPARK}"/>`, { x: -8, y: -8, width: 40, height: 40 }, 4, { width: 40, height: 40 }, "banner-spark")
    glow.tint = accent.accent
    glow.alpha = 0.8
    accented.push(glow)
    const shape = new SmoothGraphics(sparkContext)
    shape.tint = PALETTE.paper
    holder.addChild(glow, shape)
    holder.scale.set(ICON / 24)
    return { node: holder, width: ICON, height: ICON, place: (x) => holder.position.set(x, -ICON / 2) }
  }
  const tintedAccent = (piece: Piece): Piece => {
    accented.push(piece.node)
    return piece
  }
  /** Lays pieces out in a row `gap` apart, each centred on the row's middle line at y 0. */
  const entry = (gap: number, pieces: ReadonlyArray<Piece>) => {
    const holder = new Container()
    let x = 0
    for (const piece of pieces) {
      piece.place(x)
      holder.addChild(piece.node)
      x += piece.width + gap
    }
    return { node: holder, width: x - gap, height: Math.max(...pieces.map((piece) => piece.height)) }
  }
  const make = (each: Mix) => {
    switch (each.kind) {
      case "enemy": {
        const made = entry(8, [tintedAccent(icon(iconContext(shapeMarkup(each.shape), "solid"), accent.accent)), words(String(each.count), countStyle, PALETTE.paper)])
        if (each.elite) {
          const crown = new SmoothGraphics(crownContext)
          const scale = ICON / 24
          crown.scale.set(scale)
          crown.tint = PALETTE.paper
          crown.position.set(0, -made.height / 2 - 9 + (6 - 10 * scale) / 2)
          made.node.addChild(crown)
        }
        return made
      }
      case "warn":
        return entry(6, [
          ...(each.count === undefined ? [] : [tintedAccent(words(String(each.count), countStyle, accent.accent))]),
          tintedAccent(words(each.words.toUpperCase(), smallStyle, accent.accent))
        ])
      case "heal":
        return entry(8, [icon(iconContext(shapeMarkup("diamond"), "solid"), PALETTE.paper), words("+1", healStyle, PALETTE.paper)])
      case "focus":
        return entry(6, [spark(), words(`+${ROOM.cacheFocus}`, focusStyle, PALETTE.paper), words("FOCUS", smallStyle, PALETTE.paper)])
      case "figure":
        return entry(10, [figure(each.figure), words(each.words.toUpperCase(), smallStyle, PALETTE.concrete300)])
    }
  }
  const setMix = (mix: ReadonlyArray<Mix>) => {
    for (const old of mixRow.removeChildren()) {
      gsap.killTweensOf(old)
      old.destroy({ children: true })
    }
    accented = []
    items = mix.map(make)
    for (const item of items) mixRow.addChild(item.node)
  }

  /** The kicker's colour: the accent for a final wave, a clear and a zone, paper at .72 otherwise. */
  const paintKicker = () => {
    const bright = variant === "final" || variant === "clear" || variant === "zone"
    kicker.tint = bright ? accent.accent : PALETTE.paper
    kicker.alpha = bright ? 1 : 0.72
  }

  const sizeWord = () => {
    if (viewport === null) return
    const vw = viewport.width / 100
    resize(wordStyle, variant === "zone" ? clamp(3.6 * vw, 30, 52) : clamp(4.4 * vw, 36, 60), 0.16)
  }

  /** The column of words, centred in the box: the kicker, the title row on one baseline with its "of", then the mix. */
  const arrange = () => {
    if (viewport === null) return
    const { width: W, height: H } = viewport
    const boxTop = 0.22 * H
    const boxHeight = clamp(0.22 * H, 150, 184)
    const centre = W / 2
    // Cleared, CLEAR and a zone's words end the row: their last letter's spacing is taken back, so the row centres on the glyphs.
    const trimmed = variant === "cleared" || variant === "clear" || variant === "zone"
    const row = ([[jpPart, jp], [wordPart, word], [numPart, num]] as const)
      .filter(([each]) => each.slot.visible)
      .map(([each, text]) => {
        const size = Number(text.style.fontSize)
        const width = inlineWidth(text) - (each === wordPart && trimmed ? text.style.letterSpacing : 0)
        return { each, text, size, width, above: lineBaseline(text.style, size) }
      })
    const rowAbove = Math.max(...row.map((box) => box.above))
    const titleHeight = rowAbove + Math.max(...row.map((box) => box.size - box.above))
    const rowWidth = row.reduce((sum, box) => sum + box.width, 0) + 14 * (row.length - 1)
    const kickerHeight = lineHeightOf(kickerStyle)
    const mixHeight = Math.max(0, ...items.map((item) => item.height))
    const total = kickerHeight + 6 + titleHeight + 6 + 2 + mixHeight
    const top = boxTop + 0.07 * boxHeight + (0.78 * boxHeight - total) / 2

    kickerPart.slot.position.set(centre, top)
    placeInLine(kicker, 0, 0)
    const rowTop = top + kickerHeight + 6
    let x = centre - rowWidth / 2
    for (const box of row) {
      const boxTopY = rowTop + rowAbove - box.above
      box.each.slot.position.set(x + box.width / 2, boxTopY + box.size / 2)
      box.each.body.pivot.set(box.width / 2, box.size / 2)
      placeInLine(box.text, 0, 0, box.size)
      x += box.width + 14
    }
    // "/ 03" hangs past the row, its 16 px line's foot half an em over the row's foot.
    ofPart.slot.position.set(centre + rowWidth / 2 + 14, rowTop + titleHeight - 8 - 16)
    placeInLine(of, 0, 0, 16)

    mixPart.slot.position.set(centre, rowTop + titleHeight + 6 + 2 + mixHeight / 2)
    const mixWidth = items.reduce((sum, item) => sum + item.width, 0) + 24 * Math.max(0, items.length - 1)
    let at = -mixWidth / 2
    for (const item of items) {
      item.node.x = at
      at += item.width + 24
    }
  }

  const layout = (next: Viewport) => {
    viewport = next
    const { width: W, height: H, narrow } = next
    const vw = W / 100
    const boxHeight = clamp(0.22 * H, 150, 184)
    const bandWidth = narrow ? W : 0.8 * W
    art.position.set(narrow ? 0 : Math.round(0.1 * W), Math.round(0.22 * H))
    units.scale.set(bandWidth / BAND.width, boxHeight / BAND.height)
    ink.fit(bandWidth, boxHeight)
    red.fit({ width: bandWidth, height: boxHeight }, next.resolution)
    resize(jpStyle, clamp(3.4 * vw, 30, 48), 0)
    resize(numStyle, clamp(5 * vw, 40, 68), 0)
    sizeWord()
    arrange()
  }

  let playing: gsap.core.Timeline | null = null

  const play = (hold: number, withMix: boolean, delay = 0) => {
    playing?.kill()
    const entries = items.map((item) => item.node)
    gsap.killTweensOf([reveal, ...bodies, jpPart.body.scale, numPart.body.scale, ...entries])
    reveal.head = 0
    reveal.tail = 0
    for (const body of bodies) {
      body.alpha = 0
      body.position.set(0, 0)
      body.scale.set(1)
    }
    const stamp = drawn(0.22, "power4.in", ON_ONES)
    const pop = drawn(0.25, "back.out(2.4)", ON_ONES)
    const timeline = gsap.timeline({
      delay,
      onComplete: () => {
        node.visible = false
      }
    })
      .set(node, { visible: true })
      .to(reveal, { head: 1, duration: 0.26, ease: drawn(0.26, "power3.out", ON_ONES) })
      .fromTo(jpPart.body, { alpha: 0, angle: -10 }, { alpha: 1, angle: 0, duration: 0.22, ease: stamp }, 0.06)
      .fromTo(jpPart.body.scale, { x: 1.8, y: 1.8 }, { x: 1, y: 1, duration: 0.22, ease: stamp }, 0.06)
      .fromTo(wordPart.body, { alpha: 0, x: -40 }, { alpha: 1, x: 0, duration: 0.3, ease: drawn(0.3, "expo.out") }, 0.08)
      .fromTo(numPart.body, { alpha: 0, angle: -8 }, { alpha: 1, angle: 0, duration: 0.25, ease: pop }, 0.16)
      .fromTo(numPart.body.scale, { x: 1.8, y: 1.8 }, { x: 1, y: 1, duration: 0.25, ease: pop }, 0.16)
      .fromTo(ofPart.body, { alpha: 0, x: 12 }, { alpha: 1, x: 0, duration: 0.3, ease: "power3.out" }, 0.26)
      .fromTo(kickerPart.body, { alpha: 0 }, { alpha: 1, duration: 0.5, ease: "expo.out" }, 0.12)
      .add(tracked(kickerStyle, 1.2, 0.6, { duration: 0.5, ease: "expo.out" }), 0.12)
    if (withMix) {
      timeline
        .fromTo(mixPart.body, { alpha: 0 }, { alpha: 1, duration: 0.01 }, 0.3)
        .fromTo(entries, { alpha: 0, y: 8 }, { alpha: 1, y: 0, duration: 0.25, ease: "back.out(2)", stagger: 0.05 }, 0.3)
    }
    timeline
      .to([mixPart, kickerPart, ofPart, numPart, wordPart, jpPart].map((each) => each.body), { alpha: 0, x: 48, duration: 0.18, ease: "power2.in", stagger: 0.02 }, 0.3 + hold)
      .to(reveal, { tail: 1, duration: 0.26, ease: drawn(0.26, "power3.in", ON_ONES) }, 0.38 + hold)
    playing = timeline
  }

  /** Sets the banner's variant, its words (kicker, kanji, title word, number and its "of") and its mix. */
  const show = (next: Variant, text: { readonly kicker: string; readonly jp?: string; readonly word: string; readonly num?: string; readonly of?: string }, mix: ReadonlyArray<Mix>) => {
    variant = next
    kicker.text = text.kicker.replace(/\s+/g, " ").toUpperCase()
    jp.text = text.jp ?? ""
    word.text = text.word.toUpperCase()
    num.text = text.num ?? ""
    of.text = text.of ?? ""
    jpPart.slot.visible = jp.text !== ""
    numPart.slot.visible = num.text !== ""
    paintKicker()
    sizeWord()
    resize(kickerStyle, 11, 0.6)
    setMix(mix)
    arrange()
  }

  const hide = () => {
    playing?.kill()
    playing = null
    node.visible = false
  }

  return {
    node,
    layout,
    tint: (next: Accent) => {
      accent = next
      red.sprite.tint = next.accent
      jpStyle.dropShadow = shadowOf({ color: next.accent, alpha: 0.6, blur: 16 })
      paintKicker()
      for (const each of accented) each.tint = next.accent
    },
    wave: (wave, total, counts, zone, delay = 0) => {
      const elite = counts.some((each) => each.elite)
      const kick = elite ? "Elite wave" : wave === 1 ? "Doors sealed" : wave === total ? "Final wave" : `Zone ${zoneOf(zone).number}`
      show(wave === total && total > 1 ? "final" : "wave", { kicker: kick, word: "Wave", num: twoDigits(wave), of: `/ ${twoDigits(total)}` }, mixOf(counts))
      play(delay > 0 ? 0.7 : 0.9, true, delay)
    },
    cleared: (moment, layout) => {
      if (moment.wave === moment.total) return
      const falling = slabGroupsOf(layout).find((group) => group.after === moment.wave)?.slabs.length ?? 0
      show("cleared", { kicker: `Wave ${twoDigits(moment.wave)}`, word: "Cleared" }, falling === 0 ? [] : [{ kind: "warn", count: falling, words: falling === 1 ? "slab falls" : "slabs fall" }])
      play(0.45, falling > 0)
    },
    clear: (reward) => {
      show("clear", { kicker: "Doors open", word: "Clear" }, reward.drops.map((drop) => DROP_WORDS[drop]))
      play(0.75, reward.drops.length > 0)
    },
    zone: (clear) => {
      const zone = zoneOf(clear.zone)
      const best = clear.best === clear.time ? "New best" : `Best ${formatTime(clear.best)}`
      show("zone", { kicker: `Zone ${twoDigits(zone.number)}  ·  ${zone.name}`, jp: zone.kanji, word: "Clear" }, [
        { kind: "figure", figure: formatTime(clear.time), words: best },
        ...(clear.gate ? [{ kind: "warn", words: "Gate open" } as const] : [])
      ])
      play(1.6, true)
    },
    intro: (id, delay = 0) => {
      const zone = zoneOf(id)
      show("zone", { kicker: `Zone ${twoDigits(zone.number)}`, jp: zone.kanji, word: zone.name }, [{ kind: "figure", figure: String(zone.rooms), words: "rooms" }])
      play(1.1, true, delay)
    },
    hide,
    showing: () => playing !== null && playing.progress() < 1,
    dispose: () => {
      hide()
      gsap.killTweensOf([reveal, ...bodies, jpPart.body.scale, numPart.body.scale])
      node.destroy({ children: true })
      crownContext.destroy()
      sparkContext.destroy()
      faces.release()
    }
  }
}
