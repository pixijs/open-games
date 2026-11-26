import { gsap } from "gsap"
import { mulberry32 } from "math/random"
import { Container, Graphics, SmoothGraphics, Sprite, Texture } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import { svgTexture } from "../art/svg.ts"
import { accentOf } from "./accent.ts"
import { brushStroke, lean, svgPaths } from "./brush.ts"
import type { BrushStroke, Point } from "./brush.ts"
import { KUZUSHI, LETTER_GAP, SLANT } from "./letters.ts"
import type { LetterStroke } from "./letters.ts"
import { drawn, ON_ONES, ON_TWOS, rattle } from "./motion.ts"

const BASELINE = 100

/** Every stroke of every letter, moved to its place in the word and slanted. */
const placed = (() => {
  const all: Array<{ readonly points: ReadonlyArray<Point>; readonly brush: LetterStroke["brush"] }> = []
  let x = 0
  for (const letter of KUZUSHI) {
    for (const { points, brush } of letter.strokes) all.push({ points: lean(points.map(([px, py]): Point => [px + x, py]), SLANT, BASELINE), brush })
    x += letter.advance + LETTER_GAP
  }
  return all
})()

const strokes = placed.map(({ points, brush }, i) => ({ stroke: brushStroke(points, { streaks: 3, ...brush, seed: 11 + i }), width: brush.width }))

/** The letters' own box, so the page can line their edges up with the text around them. */
const LETTER_BOX = (() => {
  const xs = placed.flatMap(({ points, brush }) => points.flatMap(([x]) => [x - brush.width * 0.4, x + brush.width * 0.4]))
  const ys = placed.flatMap(({ points, brush }) => points.flatMap(([, y]) => [y - brush.width * 0.2, y + brush.width * 0.2]))
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
})()
const right = LETTER_BOX.right
const LETTER_WIDTH = LETTER_BOX.right - LETTER_BOX.left

/** The letters' width over their height. */
export const LETTER_ASPECT = LETTER_WIDTH / (LETTER_BOX.bottom - LETTER_BOX.top)

const VIEW = { x: -30, y: -40, width: right + 74, height: 196 } as const
const SLASH_FROM: Point = [-8, 101]
const SLASH_TO: Point = [right + 36, -14]
const SLASH_ANGLE = Math.atan2(SLASH_TO[1] - SLASH_FROM[1], SLASH_TO[0] - SLASH_FROM[0])
const SLASH_DIR: Point = [Math.cos(SLASH_ANGLE), Math.sin(SLASH_ANGLE)]

/** A point `along` the cut from its start, pushed `across` it (positive is below the cut). */
const onCut = (along: number, across: number): Point =>
  [SLASH_FROM[0] + SLASH_DIR[0] * along - SLASH_DIR[1] * across, SLASH_FROM[1] + SLASH_DIR[1] * along + SLASH_DIR[0] * across]

/** How far a half moves along the cut, and a little away from it: `sign` 1 is the top half. */
const apart = (sign: 1 | -1, reach: number) => {
  const [x, y] = onCut(reach, -reach * 0.2)
  return { x: sign * (x - SLASH_FROM[0]), y: sign * (y - SLASH_FROM[1]) }
}

const CUT_LENGTH = Math.hypot(SLASH_TO[0] - SLASH_FROM[0], SLASH_TO[1] - SLASH_FROM[1])

/** The strip between `near` and `far` units across the cut, reaching `reach` past both of its ends. */
const strip = (near: number, far: number, reach = 0): string =>
  [onCut(-reach, near), onCut(CUT_LENGTH + reach, near), onCut(CUT_LENGTH + reach, far), onCut(-reach, far)]
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")

const slash = brushStroke([SLASH_FROM, onCut(CUT_LENGTH * 0.45, 3), SLASH_TO], { width: 7.5, seed: 4, start: 0.12, attack: 0.4, release: 0.42, dry: 0.22, bristles: 5, rough: 0.12, wobble: 0.2 })
const core = brushStroke([onCut(CUT_LENGTH * 0.14, 1), onCut(CUT_LENGTH * 0.45, 3), onCut(CUT_LENGTH * 0.84, 1)], { width: 2.4, seed: 5, start: 0.1, attack: 0.45, release: 0.45, dry: 0 })

/** The red splatter flung off the end of the cut, mostly past its tip. */
const DROPS: ReadonlyArray<{ readonly x: number; readonly y: number; readonly r: number }> = (() => {
  const random = mulberry32.create(77)
  const next = () => mulberry32.sample(random)
  const drops: Array<{ x: number; y: number; r: number }> = []
  const spray = (from: number, count: number, reach: number, size: number) => {
    for (let i = 0; i < count; i++) {
      const [x, y] = onCut(from + next() * reach, (next() - 0.5) * Math.abs(reach) * 0.42)
      drops.push({ x, y, r: size * (0.25 + next() ** 2) })
    }
  }
  spray(CUT_LENGTH - 24, 16, 46, 2.6)
  spray(CUT_LENGTH * 0.5, 6, 30, 1.4)
  spray(8, 5, -22, 1.6)
  return drops
})()

const FILTERS = {
  ink: `<filter id="kz-ink" x="-6%" y="-20%" width="112%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="3" result="warp"/>
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="3.2" xChannelSelector="R" yChannelSelector="G" result="rough"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="1" seed="8" result="grain"/>
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -16 12.2" result="speckle"/>
      <feComposite in="rough" in2="speckle" operator="in" result="inked"/>
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0d0d0f" flood-opacity="0.85"/>
    </filter>`,
  swell: `<filter id="kz-swell" x="-8%" y="-30%" width="116%" height="160%">
      <feMorphology operator="dilate" radius="4.5" result="fat"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="5" result="warp"/>
      <feDisplacementMap in="fat" in2="warp" scale="5" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`,
  glow: `<filter id="kz-glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="4"/></filter>`
} as const

const CLIPS = `<clipPath id="kz-above"><polygon points="${strip(-2000, 0, 2000)}"/></clipPath><clipPath id="kz-below"><polygon points="${strip(0, 2000, 2000)}"/></clipPath>`

/** Each stroke whole, with its dry streaks cut out: the write's reveal is drawn in Pixi. */
const streaked = (id: string, stroke: BrushStroke) =>
  `<mask id="${id}" maskUnits="userSpaceOnUse" x="${VIEW.x}" y="${VIEW.y}" width="${VIEW.width}" height="${VIEW.height}">` +
  `<rect x="${VIEW.x}" y="${VIEW.y}" width="${VIEW.width}" height="${VIEW.height}" fill="#fff"/>` +
  stroke.streaks.map((d, i) => `<path d="${d}" fill="none" stroke="#000" stroke-width="${(0.7 + (i % 3) * 0.35).toFixed(2)}" stroke-linecap="round"/>`).join("") +
  `</mask>`

const LETTERS = strokes.map(({ stroke }, i) => streaked(`kz-m${i}`, stroke)).join("") +
  `<g id="kz-letters" fill="#fff">${strokes.map(({ stroke }, i) => `<g mask="url(#kz-m${i})">${svgPaths(stroke.shapes)}</g>`).join("")}</g>`

const svg = (defs: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.width.toFixed(1)} ${VIEW.height}"><defs>${defs}</defs>${body}</svg>`

const half = (clip: "above" | "below", filter: "ink" | "swell") =>
  svg(FILTERS[filter] + CLIPS + LETTERS, `<g clip-path="url(#kz-${clip})"><g filter="url(#kz-${filter})"><use href="#kz-letters"/></g></g>`)

/** The six drawings rasterised, each white so the sprites take their colours by tint, and the share of the ink width each is drawn at. */
const RASTERS = {
  topInk: [half("above", "ink"), 1],
  bottomInk: [half("below", "ink"), 1],
  topSwell: [half("above", "swell"), 0.5],
  bottomSwell: [half("below", "swell"), 0.5],
  slash: [svg(FILTERS.glow, `<g filter="url(#kz-glow)" fill="#fff" opacity="0.85">${svgPaths(slash.shapes)}</g><g fill="#fff">${svgPaths(slash.shapes)}</g>`), 1],
  core: [svg("", `<g fill="#fff">${svgPaths(core.shapes)}</g>`), 1]
} as const satisfies Record<string, readonly [string, number]>

type RasterName = keyof typeof RASTERS
const NAMES = Object.keys(RASTERS) as ReadonlyArray<RasterName>

/** Rasters are redrawn once the width they are needed at strays this far from the width they were drawn at. */
const REDRAW = 0.15

export interface Wordmark {
  readonly node: Container
  /** Resolves once the drawings are first rasterised. */
  readonly ready: Promise<void>
  /** Hides every stroke, the slash and the splatter, ready to draw in. */
  reset(): void
  /** Draws the letters stroke by stroke. */
  write(): gsap.core.Timeline
  /** The red slash strikes through: an impact frame, the word splits along the cut and settles. */
  strike(): gsap.core.Timeline
  /** The two halves fly apart along the cut. */
  cleave(): gsap.core.Timeline
  /** Puts the letters' left edge at `x` and their top at `y`, `letterWidth` wide, rasterised for `resolution`. */
  layout(x: number, y: number, letterWidth: number, resolution: number): void
}

/**
 * The KUZUSHI wordmark: brush letters struck through by a red slash. The letters, their impact swell, the slash and
 * its core are SVG drawings rasterised at the size they show (the ink's grain and roughness are SVG filters); the
 * write reveals them through a mask of the strokes' spines, and the halves above and below the cut move apart.
 */
export const createWordmark = (): Wordmark => {
  const accent = accentOf("courtyard").accent
  const node = new Container({ label: "wordmark" })
  const body = new Container()
  node.addChild(body)

  const sprite = (tint: number) => {
    const each = new Sprite(Texture.EMPTY)
    each.tint = tint
    return each
  }
  const halfOf = () => {
    const container = new Container()
    const swell = sprite(PALETTE.paper)
    swell.alpha = 0
    const ink = sprite(PALETTE.paper)
    container.addChild(swell, ink)
    return { container, swell, ink }
  }
  const top = halfOf()
  const bottom = halfOf()
  const halves = [top.container, bottom.container]
  const letters = new Container({ label: "wordmark-letters" })
  const reveal = new Graphics()
  letters.addChild(top.container, bottom.container)

  const cut = new Container({ label: "wordmark-slash" })
  const slashSprite = sprite(accent)
  const coreSprite = sprite(PALETTE.paper)
  const slashMask = new Graphics().rect(0, -20, 1, 40).fill(0xffffff)
  slashMask.position.set(SLASH_FROM[0], SLASH_FROM[1])
  slashMask.rotation = SLASH_ANGLE
  cut.addChild(slashSprite, coreSprite)

  const drops = new Container({ label: "wordmark-drops" })
  const dropScales = DROPS.map(({ x, y, r }) => {
    const drop = new SmoothGraphics().circle(0, 0, r).fill(0xffffff)
    drop.tint = accent
    drop.position.set(x, y)
    drops.addChild(drop)
    return drop.scale
  })
  body.addChild(letters, cut, drops)

  const sprites: Readonly<Record<RasterName, Sprite>> = {
    topInk: top.ink,
    bottomInk: bottom.ink,
    topSwell: top.swell,
    bottomSwell: bottom.swell,
    slash: slashSprite,
    core: coreSprite
  }

  let target = 0
  let generation = 0
  /** The textures the sprites show, kept here to free them: a destroyed sprite forgets its texture. */
  const held = new Map<RasterName, Texture>()
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  /** Rasterises the six textures for `width` px. A failure is logged and still settles `ready`: installUi awaits it. */
  const raster = async (width: number) => {
    target = width
    const drawing = ++generation
    const textures = await Promise.all(NAMES.map((name) => svgTexture(RASTERS[name][0], { width: width * RASTERS[name][1], label: `wordmark-${name}` }))).catch((error: unknown) => {
      console.error("The wordmark failed to rasterise.", error)
      resolveReady()
      return null
    })
    if (textures === null) return
    if (drawing !== generation || node.destroyed) {
      for (const texture of textures) texture.destroy(true)
      return
    }
    NAMES.forEach((name, index) => {
      const texture = textures[index]
      if (texture === undefined) return
      const each = sprites[name]
      each.texture = texture
      each.position.set(VIEW.x, VIEW.y)
      each.setSize(VIEW.width, VIEW.height)
      held.get(name)?.destroy(true)
      held.set(name, texture)
    })
    resolveReady()
  }

  /** How much of each stroke the write has drawn, and how many spine segments its mask shows. */
  const progress = strokes.map(() => ({ value: 0 }))
  const shown = strokes.map(() => -1)
  const drawReveal = () => {
    const counts = progress.map(({ value }) => Math.ceil(value * 71))
    if (counts.every((count, i) => count === shown[i])) return
    counts.forEach((count, i) => {
      shown[i] = count
    })
    reveal.clear()
    strokes.forEach(({ stroke, width }, i) => {
      const count = counts[i] ?? 0
      const [first, ...rest] = stroke.points.slice(0, count + 1)
      if (count === 0 || first === undefined) return
      reveal.moveTo(first[0], first[1])
      for (const [x, y] of rest) reveal.lineTo(x, y)
      reveal.stroke({ width: width * 1.9, color: 0xffffff, cap: "round", join: "round" })
    })
  }

  const mask = (on: boolean) => {
    letters.mask = on ? reveal : null
    if (on) letters.addChild(reveal)
    else letters.removeChild(reveal)
  }
  const maskCut = (on: boolean) => {
    cut.mask = on ? slashMask : null
    if (on) cut.addChild(slashMask)
    else cut.removeChild(slashMask)
  }

  /** The impact frame: the letters and the slash go ink and the swell goes paper behind them. */
  const impact = (on: boolean) => {
    top.ink.tint = on ? PALETTE.ink : PALETTE.paper
    bottom.ink.tint = on ? PALETTE.ink : PALETTE.paper
    top.swell.alpha = on ? 1 : 0
    bottom.swell.alpha = on ? 1 : 0
    slashSprite.tint = on ? PALETTE.ink : accent
  }

  const reset = () => {
    gsap.killTweensOf([...progress, slashMask.scale, ...dropScales, ...halves, body, cut, drops])
    for (const each of progress) each.value = 0
    drawReveal()
    mask(true)
    maskCut(true)
    slashMask.scale.x = 0
    for (const scale of dropScales) scale.set(0)
    for (const each of halves) {
      each.position.set(0, 0)
      each.angle = 0
      each.alpha = 1
    }
    body.position.set(0, 0)
    cut.alpha = 1
    drops.alpha = 1
    impact(false)
  }

  const write = () => {
    const timeline = gsap.timeline({ onUpdate: drawReveal, onComplete: () => mask(false) })
    strokes.forEach(({ stroke }, i) => {
      const duration = 0.2 + stroke.shapes.length * 0.004
      const each = progress[i]
      if (each !== undefined) timeline.to(each, { value: 1, duration, ease: drawn(duration, "power2.inOut", ON_ONES) }, i * 0.075)
    })
    return timeline
  }

  const IMPACT = 2 / ON_ONES

  const strike = () => {
    const hit = 0.13
    return gsap.timeline()
      .fromTo(slashMask.scale, { x: 0 }, { x: CUT_LENGTH + 20, duration: hit, ease: drawn(hit, "power3.in", ON_ONES) }, 0)
      .add(() => maskCut(false), hit)
      .add(() => impact(true), hit)
      .set(top.container, apart(1, 7), hit)
      .set(bottom.container, apart(-1, 7), hit)
      .fromTo(dropScales, { x: 0, y: 0 }, { x: 1, y: 1, duration: 0.25, ease: drawn(0.25, "back.out(3)", ON_TWOS), stagger: { each: 0.012, from: "random" } }, hit)
      .add(rattle(body, 5, 0.3), hit)
      .add(() => impact(false), hit + IMPACT)
      .to(halves, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.45)" }, hit + 0.2)
  }

  const cleave = () =>
    gsap.timeline()
      .add(() => impact(true))
      .set(top.container, { ...apart(1, 14), angle: -1 })
      .set(bottom.container, { ...apart(-1, 14), angle: 1 })
      .add(() => impact(false), IMPACT)
      .to(top.container, { ...apart(1, 120), angle: -3, alpha: 0, duration: 0.5, ease: "expo.out" }, IMPACT)
      .to(bottom.container, { ...apart(-1, 120), angle: 3, alpha: 0, duration: 0.5, ease: "expo.out" }, IMPACT)
      .to([cut, drops], { alpha: 0, duration: 0.3, ease: "power2.out" }, IMPACT)

  node.once("destroyed", () => {
    generation += 1
    for (const texture of held.values()) texture.destroy(true)
  })

  reset()
  return {
    node,
    ready,
    reset,
    write,
    strike,
    cleave,
    layout: (x, y, letterWidth, resolution) => {
      const scale = letterWidth / LETTER_WIDTH
      body.scale.set(scale)
      node.position.set(Math.round(x - LETTER_BOX.left * scale), Math.round(y - LETTER_BOX.top * scale))
      const width = VIEW.width * scale * resolution
      if (target === 0 || Math.abs(width - target) > REDRAW * target) void raster(width)
    }
  }
}
