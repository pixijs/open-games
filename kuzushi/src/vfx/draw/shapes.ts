import { arrowheadPoints, DASH_NOTCH } from "../../art/arrowhead.ts"
import { hex, paletteOfKind } from "../../art/palette.ts"
import type { EnemyKind } from "../../sim/index.ts"
import { INK, PAPER, pointsPath, RED } from "./pen.ts"
import type { Point } from "./pen.ts"

/** The silhouettes of the actors in the effect art, pointing +x, about 0.85 across in the cell's -1..1 space. */

export type ShapeKind = EnemyKind | "player"

const polygon = (count: number, radius: number, turn = 0): Array<Point> =>
  Array.from({ length: count }, (_, index) => {
    const angle = turn + (index / count) * Math.PI * 2
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const
  })

const arc = (radius: number, from: number, to: number, count: number): Array<Point> =>
  Array.from({ length: count }, (_, index) => {
    const angle = from + ((to - from) * index) / (count - 1)
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const
  })

const cog = (outer: number, inner: number): Array<Point> =>
  Array.from({ length: 8 }, (_, tooth) => {
    const at = (tooth / 8) * Math.PI * 2
    const step = Math.PI / 8
    return [[at - step * 0.55, inner], [at - step * 0.35, outer], [at + step * 0.35, outer], [at + step * 0.55, inner]] as const
  }).flat().map(([angle, reach]): Point => [Math.cos(angle) * reach, Math.sin(angle) * reach])

const plus = (arm: number, half: number): Array<Point> =>
  [[arm, half], [half, half], [half, arm], [-half, arm], [-half, half], [-arm, half], [-arm, -half], [-half, -half], [-half, -arm], [half, -arm], [half, -half], [arm, -half]]

const outlineOf = (kind: ShapeKind): string => {
  switch (kind) {
    case "chaser": return `M0.8 0A0.8 0.8 0 1 1 -0.8 0A0.8 0.8 0 1 1 0.8 0Z`
    case "shooter": return pointsPath(polygon(3, 0.84))
    case "bruiser":
    case "gatekeeper": return pointsPath([[0.68, 0.68], [-0.68, 0.68], [-0.68, -0.68], [0.68, -0.68]])
    case "trickster": return pointsPath(polygon(4, 0.86))
    case "orbiter": return `M0.8 0A0.8 0.8 0 1 1 -0.8 0A0.8 0.8 0 1 1 0.8 0ZM0.42 0A0.42 0.42 0 1 0 -0.42 0A0.42 0.42 0 1 0 0.42 0Z`
    case "warden":
    case "orrery": return `M0.82 0A0.82 0.82 0 1 1 -0.82 0A0.82 0.82 0 1 1 0.82 0Z`
    case "lancer": return pointsPath([[0.92, 0], [0.29, 0.17], [-0.17, 0.15], [-0.58, 0], [-0.17, -0.15], [0.29, -0.17]])
    case "splitter":
    case "splitling":
    case "sunder": return pointsPath(polygon(6, 0.84))
    case "sweeper": return pointsPath([[0.9, 0], [0.25, 0.09], ...arc(0.3, 0.4, Math.PI * 2 - 0.4, 14), [0.25, -0.09]])
    case "pulsar": return pointsPath(cog(0.84, 0.64))
    case "leaper": return pointsPath(plus(0.86, 0.27))
    case "cutter": return pointsPath([[0.9, -0.18], [0.55, 0.18], [-0.9, 0.18], [-0.55, -0.18]])
    case "player": return pointsPath(arrowheadPoints(0.9, -0.58, 0.6))
  }
}

/** The four pieces each shape breaks into: wedges from the centre, between these angles. */
const FRAGMENT_CUTS = [0.35, 1.9, 3.3, 4.9] as const
/** Pieces are drawn shrunk by this much so they fit their own cell, and centred there. */
export const FRAGMENT_SCALE = 0.72
const FRAGMENT_REACH = 0.4

/** Where piece `index`'s wedge starts, and the angle it spans. */
const wedgeSpan = (index: number) => {
  const from = FRAGMENT_CUTS[index] ?? 0
  const to = FRAGMENT_CUTS[(index + 1) % FRAGMENT_CUTS.length] ?? 0
  return { from, span: (to - from + Math.PI * 2) % (Math.PI * 2) }
}

/** Where piece `index` sits in the shape's -1..1 space before it flies. */
export const fragmentOffset = (index: number): Point => {
  const { from, span } = wedgeSpan(index)
  const mid = from + span / 2
  return [Math.cos(mid) * FRAGMENT_REACH, Math.sin(mid) * FRAGMENT_REACH]
}

const wedge = (index: number): string => {
  const { from, span } = wedgeSpan(index)
  const points: Array<Point> = [[0, 0]]
  for (let step = 0; step <= 8; step++) {
    const angle = from + (span * step) / 8
    points.push([Math.cos(angle) * 1.6, Math.sin(angle) * 1.6])
  }
  return pointsPath(points)
}

/** A shape's fill: the hero's paper, or the danger accent of the zone the kind belongs to. */
const fillOf = (kind: ShapeKind): string => (kind === "player" ? PAPER : hex(paletteOfKind(kind).danger))

/** A white-hot silhouette: the frame a struck shape flashes for. */
export const flashCell = (kind: ShapeKind, id: string): string => `
<path d="${outlineOf(kind)}" fill="${kind === "player" ? RED : fillOf(kind)}" stroke="${kind === "player" ? RED : fillOf(kind)}" stroke-width="0.24" stroke-linejoin="round" opacity="0.9" filter="url(#${id})"/>
<path d="${outlineOf(kind)}" fill="${PAPER}" stroke="${PAPER}" stroke-width="0.06" stroke-linejoin="round"/>`

/** One half of a shape cut along x, with the white cut edge. `side` 1 keeps +y, -1 keeps -y. */
export const halfCell = (kind: ShapeKind, side: 1 | -1, id: string): string => {
  const outline = outlineOf(kind)
  const keep = side === 1 ? `M-1.2 0.03H1.2V1.2H-1.2Z` : `M-1.2 -0.03H1.2V-1.2H-1.2Z`
  return `
<clipPath id="${id}-keep"><path d="${keep}"/></clipPath>
<clipPath id="${id}-shape"><path d="${outline}"/></clipPath>
<g clip-path="url(#${id}-keep)">
<path d="${outline}" fill="${fillOf(kind)}" stroke="${INK}" stroke-width="0.12" stroke-linejoin="round"/>
<g clip-path="url(#${id}-shape)"><rect x="-1.2" y="${side === 1 ? 0.03 : -0.13}" width="2.4" height="0.1" fill="${PAPER}"/></g>
</g>`
}

/** Piece `index` of a shape, shrunk and centred in its own cell. */
export const fragmentCell = (kind: ShapeKind, index: number, id: string): string => {
  const [ox, oy] = fragmentOffset(index)
  return `
<clipPath id="${id}-wedge"><path d="${wedge(index)}"/></clipPath>
<g transform="scale(${FRAGMENT_SCALE}) translate(${-ox} ${-oy})">
<g clip-path="url(#${id}-wedge)">
<path d="${outlineOf(kind)}" fill="${fillOf(kind)}" stroke="${INK}" stroke-width="0.12" stroke-linejoin="round"/>
</g>
<path d="${wedge(index)}" fill="none" stroke="${PAPER}" stroke-width="0.05" clip-path="url(#${id}-inside)"/>
</g>
<clipPath id="${id}-inside"><path d="${outlineOf(kind)}"/></clipPath>`
}

/**
 * The player's afterimage. Left along a dash it's the dart the body folds into there, as narrow as the dash's
 * stretch draws the body and nudged forward so its long back fits the cell; solid (the player's hit flash) it's the
 * arrowhead at rest.
 */
export const ghostCell = (solid: boolean): string => solid
  ? `<path d="${outlineOf("player")}" fill="${PAPER}" fill-opacity="0.85" stroke="${INK}" stroke-width="0.07" stroke-linejoin="round"/>`
  : `<path d="${pointsPath(arrowheadPoints(0.96, -0.52, 0.34, DASH_NOTCH))}" fill="${PAPER}" fill-opacity="0.16" stroke="${PAPER}" stroke-width="0.07" stroke-linejoin="round"/>`
