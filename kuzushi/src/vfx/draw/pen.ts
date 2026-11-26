import { mulberry32 } from "math/random"

import { css } from "../../art/palette.ts"

/** Hand-drawn SVG building blocks for the effect art: seeded randomness, tapered strokes, ink filters. */

export type Rng = () => number
export type Point = readonly [number, number]

export const rngOf = (seed: number): Rng => {
  const state = mulberry32.create(seed)
  return () => mulberry32.sample(state)
}

export const between = (rng: Rng, min: number, max: number): number => min + (max - min) * rng()

export const INK = css("ink")
export const PAPER = css("paper")
export const RED = css("red")
export const RED_DEEP = css("redDeep")

const n = (value: number): string => (Math.round(value * 10000) / 10000).toString()

export const pointsPath = (points: ReadonlyArray<Point>, close = true): string =>
  points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${n(x)} ${n(y)}`).join("") + (close ? "Z" : "")

/** A closed outline around a centreline, `width(t)` wide at each point (t runs 0 to 1 along it): a brush stroke. */
export const taper = (spine: ReadonlyArray<Point>, width: (t: number) => number): string => {
  const left: Array<Point> = []
  const right: Array<Point> = []
  const last = spine.length - 1
  spine.forEach(([x, y], index) => {
    const [ax, ay] = spine[Math.max(0, index - 1)] ?? [x, y]
    const [bx, by] = spine[Math.min(last, index + 1)] ?? [x, y]
    const length = Math.hypot(bx - ax, by - ay) || 1
    const half = width(index / Math.max(1, last)) / 2
    const nx = (-(by - ay) / length) * half
    const ny = ((bx - ax) / length) * half
    left.push([x + nx, y + ny])
    right.push([x - nx, y - ny])
  })
  return pointsPath([...left, ...right.reverse()])
}

/** Points along a straight line, nudged sideways by `wobble` so it reads as drawn. */
export const line = (from: Point, to: Point, count: number, rng?: Rng, wobble = 0): Array<Point> => {
  const [x0, y0] = from
  const [x1, y1] = to
  const length = Math.hypot(x1 - x0, y1 - y0) || 1
  const nx = -(y1 - y0) / length
  const ny = (x1 - x0) / length
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1)
    const off = rng === undefined ? 0 : (rng() - 0.5) * wobble * Math.sin(t * Math.PI)
    return [x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off] as const
  })
}

/** Points along an arc around (cx, cy), radius `radius(t)`, from angle a0 to a1 (radians). */
export const arc = (cx: number, cy: number, radius: (t: number) => number, a0: number, a1: number, count: number): Array<Point> =>
  Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1)
    const angle = a0 + (a1 - a0) * t
    const r = radius(t)
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] as const
  })

/** A lens: pointed at both ends, fullest at `peak` along it. */
export const lens = (peak = 0.5, power = 0.8) => (t: number): number => {
  const shaped = t < peak ? t / peak : (1 - t) / (1 - peak)
  return Math.max(0, Math.sin((shaped * Math.PI) / 2)) ** power
}

/** A blade or ray from `from` to `to`, `width` wide at its fullest. */
export const blade = (from: Point, to: Point, width: number, peak = 0.35, rng?: Rng, wobble = 0): string =>
  taper(line(from, to, 14, rng, wobble), (t) => width * lens(peak)(t))

/** A ragged blob: a circle whose radius wanders. */
export const blob = (cx: number, cy: number, radius: number, rng: Rng, jag = 0.25, count = 22): string =>
  pointsPath(Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2
    const r = radius * (1 - jag / 2 + rng() * jag)
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] as const
  }))

/** A star outline with `spikes` points between radii `inner` and `outer`, each point jittered. */
export const star = (spikes: number, inner: number, outer: (angle: number) => number, rng: Rng, jitter = 0.2, turn = 0): string =>
  pointsPath(Array.from({ length: spikes * 2 }, (_, index) => {
    const angle = turn + (index / (spikes * 2)) * Math.PI * 2 + (rng() - 0.5) * (jitter * Math.PI) / spikes
    const r = index % 2 === 0 ? outer(angle) * (1 - jitter / 2 + rng() * jitter) : inner * (0.8 + rng() * 0.4)
    return [Math.cos(angle) * r, Math.sin(angle) * r] as const
  }))

/** Displaces edges with fractal noise so fills and strokes read as inked by hand. Units are the drawing's. */
export const roughFilter = (id: string, seed: number, frequency: number, scale: number, region = 1.3): string =>
  `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-region}" y="${-region}" width="${region * 2}" height="${region * 2}">
<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="2" seed="${seed}"/>
<feDisplacementMap in="SourceGraphic" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter>`

/** Cuts streaky gaps into what it filters, like a dry brush dragged along x. */
export const dryFilter = (id: string, seed: number, fx: number, fy: number, cut: number, region = 1.3): string =>
  `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-region}" y="${-region}" width="${region * 2}" height="${region * 2}">
<feTurbulence type="fractalNoise" baseFrequency="${fx} ${fy}" numOctaves="3" seed="${seed}" result="grain"/>
<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${4.5} 0 0 0 ${-cut}" result="mask"/>
<feComposite in="SourceGraphic" in2="mask" operator="in"/></filter>`

export const blurFilter = (id: string, deviation: number, region = 1.4): string =>
  `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-region}" y="${-region}" width="${region * 2}" height="${region * 2}"><feGaussianBlur stdDeviation="${deviation}"/></filter>`

export const svgDocument = (width: number, height: number, viewBox: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${body}</svg>`
