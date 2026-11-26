import { css } from "../../art/palette.ts"
import { enemyKinds } from "../../sim/index.ts"
import { arc, between, blade, blob, blurFilter, dryFilter, INK, line, PAPER, pointsPath, RED, RED_DEEP, rngOf, roughFilter, star, svgDocument, taper } from "./pen.ts"
import type { Rng } from "./pen.ts"
import { flashCell, fragmentCell, ghostCell, halfCell } from "./shapes.ts"
import type { ShapeKind } from "./shapes.ts"
import { WEAPON_CELLS } from "./weapons.ts"

/**
 * Every small effect drawing on one sheet, so all the particle layers draw from one texture source.
 * Each cell is drawn in its own -1..1 space, pointing +x where it has a direction.
 */

export const ATLAS_SIZE = 2048

interface CellSpec {
  readonly name: string
  readonly size: 512 | 256 | 128
  readonly draw: (id: string) => string
}

const ray = (rng: Rng, angle: number, from: number, to: number, width: number, color: string, wobble = 0.02): string =>
  `<path d="${blade([Math.cos(angle) * from, Math.sin(angle) * from], [Math.cos(angle) * to, Math.sin(angle) * to], width, 0.3, rng, wobble)}" fill="${color}"/>`

/** An impact starburst, rays longer toward +x (the blow's direction). Drawing 0 is the full flash, 2 the last wisps. */
const burst = (drawing: 0 | 1 | 2) => (id: string): string => {
  const rng = rngOf(101 + drawing * 17)
  const rays = 17
  const parts: Array<string> = [roughFilter(`${id}-r`, 3 + drawing, 2.2, 0.05)]
  const reach = (angle: number) => 0.55 + 0.43 * Math.max(0, Math.cos(angle)) ** 1.2 + 0.06 * rng()
  if (drawing === 0) {
    parts.push(`<radialGradient id="${id}-g"><stop offset="0" stop-color="${RED}" stop-opacity="0.8"/><stop offset="0.6" stop-color="${RED}" stop-opacity="0.35"/><stop offset="1" stop-color="${RED}" stop-opacity="0"/></radialGradient>`,
      `<circle r="0.75" fill="url(#${id}-g)"/>`)
  }
  const body: Array<string> = []
  for (let index = 0; index < rays; index++) {
    const angle = (index / rays) * Math.PI * 2 + between(rng, -0.1, 0.1)
    const length = reach(angle) * (drawing === 0 ? 1 : drawing === 1 ? 1.08 : 1.12)
    const start = drawing === 0 ? 0.08 : drawing === 1 ? length * 0.4 : length * 0.7
    const width = between(rng, 0.08, 0.15) * (drawing === 2 ? 0.45 : drawing === 1 ? 0.75 : 1)
    if (drawing === 2 && index % 2 === 1) continue
    body.push(ray(rng, angle, start, length, width, RED))
    if (index % 2 === 0 || drawing === 0) body.push(ray(rng, angle, start + 0.02, length * 0.9, width * 0.5, PAPER))
  }
  if (drawing === 0) {
    body.push(`<path d="${star(11, 0.24, (angle) => 0.42 + 0.2 * Math.max(0, Math.cos(angle)), rng, 0.45)}" fill="${PAPER}" stroke="${RED}" stroke-width="0.035"/>`,
      `<circle r="0.15" fill="${PAPER}"/>`)
  } else if (drawing === 1) {
    body.push(`<circle r="0.34" fill="none" stroke="${PAPER}" stroke-width="0.07" stroke-dasharray="0.25 0.1"/>`)
  } else {
    body.push(`<circle r="0.6" fill="none" stroke="${RED}" stroke-width="0.022" stroke-dasharray="0.3 0.2"/>`)
  }
  parts.push(`<g filter="url(#${id}-r)">${body.join("")}</g>`)
  return parts.join("")
}

/** The parry's X: two crossing blades and a glint. Drawing 1 is the thinner afterflash. */
const xflash = (drawing: 0 | 1) => (id: string): string => {
  const rng = rngOf(211 + drawing)
  const width = drawing === 0 ? 0.24 : 0.1
  const reach = drawing === 0 ? 0.92 : 0.98
  const blades = [Math.PI / 4, -Math.PI / 4].map((angle) => {
    const dx = Math.cos(angle) * reach
    const dy = Math.sin(angle) * reach
    const under = `<path d="${blade([-dx, -dy], [dx, dy], width * 1.55, 0.5, rng, 0.02)}" fill="${RED}"/>`
    const over = `<path d="${blade([-dx, -dy], [dx, dy], width, 0.5, rng, 0.015)}" fill="${PAPER}"/>`
    return under + over
  }).join("")
  const ticks = Array.from({ length: 8 }, (_, index) => {
    const angle = (index / 8) * Math.PI * 2 + Math.PI / 8
    return ray(rng, angle, drawing === 0 ? 0.52 : 0.66, drawing === 0 ? 0.74 : 0.9, 0.035, PAPER)
  }).join("")
  const glint = `<path d="${star(4, drawing === 0 ? 0.07 : 0.04, () => (drawing === 0 ? 0.42 : 0.26), rng, 0.05)}" fill="${PAPER}"/>`
  const gap = drawing === 1 ? `<circle r="0.16" fill="${PAPER}" opacity="0"/>` : ""
  return `${roughFilter(`${id}-r`, 9 + drawing, 2.5, 0.035)}<g filter="url(#${id}-r)">${blades}${ticks}${glint}${gap}</g>`
}

/** A brush-drawn shock ring: broken arcs, white inside, red outside. */
const shock = (drawing: 0 | 1) => (id: string): string => {
  const rng = rngOf(307 + drawing * 5)
  const segments: Array<string> = []
  let angle = rng() * Math.PI
  const radius = drawing === 0 ? 0.74 : 0.86
  while (angle < Math.PI * 2 + 0.4) {
    const span = between(rng, 0.5, 1.3)
    const width = between(rng, 0.07, 0.13) * (drawing === 0 ? 1 : 0.55)
    const spine = arc(0, 0, (t) => radius + 0.02 * Math.sin(t * 7), angle, angle + span, 18)
    segments.push(`<path d="${taper(arc(0, 0, () => radius + 0.07, angle, angle + span, 18), (t) => width * 0.8 * Math.sin(t * Math.PI))}" fill="${RED}" opacity="0.8"/>`)
    segments.push(`<path d="${taper(spine, (t) => width * Math.sin(t * Math.PI) ** 0.6)}" fill="${PAPER}"/>`)
    angle += span + between(rng, 0.08, drawing === 0 ? 0.25 : 0.5)
  }
  return `${roughFilter(`${id}-r`, 21 + drawing, 2.4, 0.04)}<g filter="url(#${id}-r)">${segments.join("")}</g>`
}

/** A sunburst all round: the special's and the big kills' radial flash. */
const radial = (id: string): string => {
  const rng = rngOf(401)
  const rays = Array.from({ length: 26 }, (_, index) => {
    const angle = (index / 26) * Math.PI * 2 + between(rng, -0.08, 0.08)
    const length = between(rng, 0.6, 0.99)
    return ray(rng, angle, 0.12, length, between(rng, 0.06, 0.13), index % 2 === 0 ? RED : PAPER)
  }).join("")
  return `${roughFilter(`${id}-r`, 33, 2.2, 0.04)}<g filter="url(#${id}-r)">${rays}<path d="${star(12, 0.18, () => 0.36, rng, 0.35)}" fill="${PAPER}"/></g>`
}

/** An ink splatter thrown toward +x: a blob, droplets and streaks. `red` adds deep red flecks. */
const splat = (seed: number, red: boolean) => (id: string): string => {
  const rng = rngOf(seed)
  const parts: Array<string> = [`<path d="${blob(-0.2, 0, between(rng, 0.36, 0.44), rng, 0.35)}" fill="${INK}"/>`]
  for (let index = 0; index < 4; index++) {
    parts.push(`<path d="${blob(between(rng, -0.1, 0.35), between(rng, -0.3, 0.3), between(rng, 0.1, 0.2), rng, 0.4, 12)}" fill="${INK}"/>`)
  }
  for (let index = 0; index < 5; index++) {
    const angle = between(rng, -0.9, 0.9)
    parts.push(`<path d="${blade([Math.cos(angle) * 0.15 - 0.1, Math.sin(angle) * 0.15], [Math.cos(angle) * between(rng, 0.7, 0.97), Math.sin(angle) * between(rng, 0.6, 0.95)], between(rng, 0.08, 0.15), 0.15, rng, 0.03)}" fill="${INK}"/>`)
  }
  for (let index = 0; index < 18; index++) {
    const angle = between(rng, -1.2, 1.2) + (rng() < 0.2 ? Math.PI : 0)
    const distance = between(rng, 0.45, 0.97)
    const size = between(rng, 0.02, 0.07) * (1.2 - distance * 0.5)
    const color = red && rng() < 0.4 ? RED_DEEP : INK
    parts.push(`<circle cx="${Math.cos(angle) * distance}" cy="${Math.sin(angle) * distance}" r="${size}" fill="${color}"/>`)
  }
  if (red) parts.push(`<path d="${blob(0.05, 0.02, 0.12, rng, 0.4, 12)}" fill="${RED_DEEP}" opacity="0.85"/>`)
  return `${roughFilter(`${id}-r`, seed, 3.2, 0.06)}<g filter="url(#${id}-r)" opacity="0.92">${parts.join("")}</g>`
}

/** Floor cracks from a heavy blow: jagged lines branching from the centre. */
const cracks = (seed: number) => (id: string): string => {
  const rng = rngOf(seed)
  const lines: Array<string> = []
  const count = 7
  for (let index = 0; index < count; index++) {
    let angle = (index / count) * Math.PI * 2 + between(rng, -0.3, 0.3)
    let point: readonly [number, number] = [Math.cos(angle) * 0.08, Math.sin(angle) * 0.08]
    const spine: Array<readonly [number, number]> = [point]
    const length = between(rng, 0.55, 0.95)
    for (let step = 1; step <= 7; step++) {
      angle += between(rng, -0.45, 0.45)
      const r = (step / 7) * length
      point = [Math.cos(angle) * r, Math.sin(angle) * r]
      spine.push(point)
      if (step === 3 && rng() < 0.7) {
        const branch = angle + between(rng, 0.4, 0.9) * (rng() < 0.5 ? -1 : 1)
        lines.push(`<path d="${taper(line(point, [point[0] + Math.cos(branch) * 0.3, point[1] + Math.sin(branch) * 0.3], 6, rng, 0.05), (t) => 0.028 * (1 - t))}" fill="${INK}"/>`)
      }
    }
    lines.push(`<path d="${taper(spine, (t) => 0.05 * (1 - t) + 0.006)}" fill="${INK}"/>`)
  }
  return `${roughFilter(`${id}-r`, seed, 4, 0.025)}<g filter="url(#${id}-r)" opacity="0.9"><path d="${blob(0, 0, 0.12, rng, 0.4)}" fill="${INK}"/>${lines.join("")}</g>`
}

const lockon = (): string => {
  const corners = [0, 1, 2, 3].map((index) => {
    const angle = (index * Math.PI) / 2
    const cx = Math.cos(angle) * 0.72
    const cy = Math.sin(angle) * 0.72
    const a = angle + Math.PI * 0.75
    const b = angle - Math.PI * 0.75
    return `<path d="M${cx + Math.cos(a) * 0.3} ${cy + Math.sin(a) * 0.3}L${cx} ${cy}L${cx + Math.cos(b) * 0.3} ${cy + Math.sin(b) * 0.3}" fill="none" stroke="${RED}" stroke-width="0.07" stroke-linejoin="miter"/>
<path d="M${Math.cos(angle) * 0.8} ${Math.sin(angle) * 0.8}L${Math.cos(angle) * 0.98} ${Math.sin(angle) * 0.98}" stroke="${RED}" stroke-width="0.05"/>`
  }).join("")
  return corners
}

const summon = (id: string): string => {
  const rng = rngOf(503)
  const ticks = [0, 1, 2].map((index) => {
    const angle = (index / 3) * Math.PI * 2 - Math.PI / 2
    return `<path d="${pointsPath([[Math.cos(angle) * 0.62, Math.sin(angle) * 0.62], [Math.cos(angle + 0.12) * 0.86, Math.sin(angle + 0.12) * 0.86], [Math.cos(angle - 0.12) * 0.86, Math.sin(angle - 0.12) * 0.86]])}" fill="${RED}"/>`
  }).join("")
  return `${roughFilter(`${id}-r`, 41, 3, 0.03)}<g filter="url(#${id}-r)">
<circle r="0.9" fill="none" stroke="${RED}" stroke-width="0.05" stroke-dasharray="0.5 0.08 0.12 0.08"/>
<circle r="0.5" fill="none" stroke="${RED}" stroke-width="0.025" stroke-dasharray="0.08 0.06" opacity="${0.6 + rng() * 0.2}"/>${ticks}</g>`
}

const halo = (id: string): string => `<radialGradient id="${id}-g"><stop offset="0" stop-color="${PAPER}" stop-opacity="1"/><stop offset="0.25" stop-color="${PAPER}" stop-opacity="0.55"/><stop offset="1" stop-color="${PAPER}" stop-opacity="0"/></radialGradient><circle r="1" fill="url(#${id}-g)"/>`

const haloRing = (id: string): string => `<radialGradient id="${id}-g"><stop offset="0.55" stop-color="${PAPER}" stop-opacity="0"/><stop offset="0.8" stop-color="${PAPER}" stop-opacity="0.9"/><stop offset="1" stop-color="${PAPER}" stop-opacity="0"/></radialGradient><circle r="1" fill="url(#${id}-g)"/>`

const flare = (id: string): string => `<radialGradient id="${id}-g"><stop offset="0" stop-color="${PAPER}" stop-opacity="1"/><stop offset="1" stop-color="${PAPER}" stop-opacity="0"/></radialGradient><ellipse rx="1" ry="0.14" fill="url(#${id}-g)"/><ellipse rx="0.25" ry="0.25" fill="url(#${id}-g)"/>`

const glint = (): string => {
  const rng = rngOf(601)
  return `<path d="${blade([-1, 0], [1, 0], 0.16, 0.5, rng)}" fill="${PAPER}"/><path d="${blade([0, -0.62], [0, 0.62], 0.14, 0.5, rng)}" fill="${PAPER}"/><circle r="0.1" fill="${PAPER}"/>`
}

const cutline = (): string => {
  const rng = rngOf(611)
  return `<path d="${blade([-1, 0], [1, 0], 0.11, 0.55, rng)}" fill="${RED}"/><path d="${blade([-0.97, 0], [0.97, 0], 0.05, 0.55, rng)}" fill="${PAPER}"/>`
}

/** A white shard speed line, heavier at the +x end. */
const speedline = (id: string): string => {
  const rng = rngOf(617)
  return `${roughFilter(`${id}-r`, 61, 3, 0.02)}<g filter="url(#${id}-r)"><path d="${taper(line([-1, 0], [0.98, 0], 16, rng, 0.03), (t) => 0.13 * t ** 1.4 * (t > 0.92 ? (1 - t) / 0.08 : 1))}" fill="${PAPER}"/></g>`
}

const chevron = (color: string) => (): string => `<path d="M-0.5 -0.62L0.38 0L-0.5 0.62" fill="none" stroke="${color}" stroke-width="0.2" stroke-linejoin="miter"/><path d="M-0.95 -0.62L-0.07 0L-0.95 0.62" fill="none" stroke="${color}" stroke-width="0.12" opacity="0.6"/>`

const smallStar = (): string => {
  const rng = rngOf(631)
  return `<path d="${star(6, 0.22, () => 0.92, rng, 0.3)}" fill="${PAPER}" stroke="${RED}" stroke-width="0.07"/>`
}

const dryRing = (id: string): string => `${dryFilter(`${id}-d`, 71, 0.6, 6, 1.6)}<circle r="0.82" fill="none" stroke="${PAPER}" stroke-width="0.16" filter="url(#${id}-d)"/>`

// The 128 px bits.
const spark = (fill: string, edge: string) => (): string => `<path d="${blade([-1, 0], [1, 0], 0.26, 0.72)}" fill="${fill}" stroke="${edge}" stroke-width="0.05"/>`
const droplet = (): string => `<circle r="0.5" fill="${RED}"/><circle cx="-0.15" cy="-0.15" r="0.16" fill="${PAPER}" opacity="0.8"/>`
const shard = (): string => `<path d="${pointsPath([[0.98, 0], [-0.85, 0.16], [-0.6, -0.1]])}" fill="${PAPER}" stroke="${RED}" stroke-width="0.05" stroke-linejoin="round"/>`
const ember = (): string => `<path d="${pointsPath([[0.48, 0], [0, 0.48], [-0.48, 0], [0, -0.48]])}" fill="${RED}"/>`
const dotSquare = (): string => `<rect x="-0.42" y="-0.42" width="0.84" height="0.84" fill="${PAPER}"/>`
const dotTriangle = (): string => `<path d="${pointsPath([[0.62, 0], [-0.45, 0.5], [-0.45, -0.5]])}" fill="${PAPER}"/>`
const inkDrop = (id: string): string => `${roughFilter(`${id}-r`, 81, 3, 0.12)}<path d="${blob(0, 0, 0.55, rngOf(83), 0.35)}" fill="${INK}" filter="url(#${id}-r)"/>`
const pebble = (): string => `<path d="${blob(0, 0, 0.6, rngOf(89), 0.6, 7)}" fill="${css("concrete400")}" stroke="${INK}" stroke-width="0.1"/>`
const cross = (): string => `<path d="M-0.6 -0.6L0.6 0.6M-0.6 0.6L0.6 -0.6" stroke="${PAPER}" stroke-width="0.2" stroke-linecap="round"/>`
const ringSmall = (): string => `<circle r="0.72" fill="none" stroke="${PAPER}" stroke-width="0.14"/>`
const speck = (): string => `<path d="${blade([-0.9, 0.2], [0.9, -0.2], 0.3, 0.4)}" fill="${RED}"/>`

const shapeCells = (kind: ShapeKind): Array<CellSpec> => [
  { name: `${kind}-flash`, size: 128, draw: (id) => `${blurFilter(`${id}-b`, 0.06)}${flashCell(kind, `${id}-b`)}` },
  { name: `${kind}-half0`, size: 128, draw: (id) => halfCell(kind, 1, id) },
  { name: `${kind}-half1`, size: 128, draw: (id) => halfCell(kind, -1, id) },
  ...[0, 1, 2, 3].map((index): CellSpec => ({ name: `${kind}-frag${index}`, size: 128, draw: (id) => fragmentCell(kind, index, id) }))
]

const CELLS: ReadonlyArray<CellSpec> = [
  { name: "burst0", size: 512, draw: burst(0) },
  { name: "burst1", size: 512, draw: burst(1) },
  { name: "burst2", size: 512, draw: burst(2) },
  { name: "radial", size: 512, draw: radial },
  { name: "xflash0", size: 512, draw: xflash(0) },
  { name: "xflash1", size: 512, draw: xflash(1) },
  { name: "shock0", size: 512, draw: shock(0) },
  { name: "shock1", size: 512, draw: shock(1) },
  { name: "splat0", size: 256, draw: splat(701, false) },
  { name: "splat1", size: 256, draw: splat(709, false) },
  { name: "splat2", size: 256, draw: splat(719, true) },
  { name: "splat3", size: 256, draw: splat(727, true) },
  { name: "crack0", size: 256, draw: cracks(733) },
  { name: "crack1", size: 256, draw: cracks(739) },
  { name: "lockon", size: 256, draw: lockon },
  { name: "summon", size: 256, draw: summon },
  { name: "halo", size: 256, draw: halo },
  { name: "haloRing", size: 256, draw: haloRing },
  { name: "flare", size: 256, draw: flare },
  { name: "glint", size: 256, draw: glint },
  { name: "cutline", size: 256, draw: cutline },
  { name: "speedline", size: 256, draw: speedline },
  { name: "chevron", size: 256, draw: chevron(RED) },
  { name: "chevronWhite", size: 256, draw: chevron(PAPER) },
  { name: "dryRing", size: 256, draw: dryRing },
  ...enemyKinds.flatMap(shapeCells),
  { name: "ghost", size: 128, draw: () => ghostCell(false) },
  { name: "ghostSolid", size: 128, draw: () => ghostCell(true) },
  ...[0, 1, 2, 3].map((index): CellSpec => ({ name: `player-frag${index}`, size: 128, draw: (id) => fragmentCell("player", index, id) })),
  { name: "spark", size: 128, draw: spark(PAPER, RED) },
  { name: "sparkRed", size: 128, draw: spark(RED, RED_DEEP) },
  { name: "sparkWhite", size: 128, draw: spark(PAPER, PAPER) },
  { name: "droplet", size: 128, draw: droplet },
  { name: "shard", size: 128, draw: shard },
  { name: "ember", size: 128, draw: ember },
  { name: "dotSquare", size: 128, draw: dotSquare },
  { name: "dotTriangle", size: 128, draw: dotTriangle },
  { name: "inkDrop", size: 128, draw: inkDrop },
  { name: "pebble", size: 128, draw: pebble },
  { name: "cross", size: 128, draw: cross },
  { name: "ringSmall", size: 128, draw: ringSmall },
  { name: "speck", size: 128, draw: speck },
  { name: "star", size: 128, draw: smallStar },
  ...WEAPON_CELLS
]

interface CellRect {
  readonly name: string
  readonly x: number
  readonly y: number
  readonly size: number
}

/** Shelf-packs the cells: the 512s, then the 256s, then the 128s, each in rows across the sheet. */
const layout = (): ReadonlyArray<CellRect> => {
  const rects: Array<CellRect> = []
  let top = 0
  for (const size of [512, 256, 128] as const) {
    const ofSize = CELLS.filter((cell) => cell.size === size)
    const perRow = ATLAS_SIZE / size
    ofSize.forEach((cell, index) => {
      rects.push({ name: cell.name, x: (index % perRow) * size, y: top + Math.floor(index / perRow) * size, size })
    })
    top += Math.ceil(ofSize.length / perRow) * size
  }
  return rects
}

export const ATLAS_CELLS = layout()

/** The sheet is ATLAS_SIZE wide and as tall as its cells need. */
const ATLAS_HEIGHT = Math.max(...ATLAS_CELLS.map((cell) => cell.y + cell.size))

/** The whole sheet as one SVG. Content is clipped to its cell and drawn at 96% so neighbours never bleed. */
export const atlasSvg = (): string => {
  const rects = new Map(ATLAS_CELLS.map((rect) => [rect.name, rect]))
  const groups = CELLS.map((cell, index) => {
    const rect = rects.get(cell.name)
    if (rect === undefined) return ""
    const scale = (rect.size / 2) * 0.96
    return `<g transform="translate(${rect.x + rect.size / 2} ${rect.y + rect.size / 2}) scale(${scale})"><g clip-path="url(#cell)">${cell.draw(`c${index}`)}</g></g>`
  }).join("")
  return svgDocument(ATLAS_SIZE, ATLAS_HEIGHT, `0 0 ${ATLAS_SIZE} ${ATLAS_HEIGHT}`, `<defs><clipPath id="cell"><rect x="-1.04" y="-1.04" width="2.08" height="2.08"/></clipPath></defs>${groups}`)
}
