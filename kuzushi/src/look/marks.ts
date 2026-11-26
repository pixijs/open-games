import { css } from "../art/palette.ts"

/**
 * Hand-drawn wear for the stage floors, as SVG in world units: hairline cracks, scuffs, ink stains with splatter,
 * dry-brush marks and paper flecks, scattered over an area from (0, 0) to (width, depth). Each draws from `next`, so a
 * floor built from the same seed comes out the same every time.
 */

export type Next = () => number

export interface Area {
  readonly width: number
  readonly depth: number
}

export const fixed = (value: number) => value.toFixed(3)
export const between = (next: Next, low: number, high: number) => low + (high - low) * next()
export const pick = <T>(next: Next, items: ReadonlyArray<T>): T => items[Math.floor(next() * items.length) % items.length] as T

/** The filters the marks use: `ragged` edges for stains, `bristles` for brush marks, `soft` shadow, `mottle` over the stone. */
export const markFilters = `<filter id="ragged" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="3.2" numOctaves="3" seed="5" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.45" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="bristles" x="-10%" y="-60%" width="120%" height="220%">
      <feTurbulence type="fractalNoise" baseFrequency="0.35 11" numOctaves="2" seed="8" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.6 0 0 0 -1.05" result="mask"/>
      <feComposite in="SourceGraphic" in2="mask" operator="in"/>
    </filter>
    <filter id="soft" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="0.32"/>
    </filter>
    <filter id="mottle" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.22" numOctaves="4" seed="21" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.05  0 0 0 0 0.05  0 0 0 0 0.06  0 0 0 1.6 -0.62"/>
    </filter>`

/** One hairline crack from (x, y), wandering along `angle`, sometimes branching once. */
const crack = (next: Next, x: number, y: number, length: number, angle: number, depth: number): string => {
  const points: Array<readonly [number, number]> = [[x, y]]
  let heading = angle
  let px = x
  let py = y
  const steps = 4 + Math.floor(next() * 5)
  const branches: Array<string> = []
  for (let index = 0; index < steps; index += 1) {
    heading += (next() - 0.5) * 1.1
    const reach = (length / steps) * between(next, 0.6, 1.4)
    px += Math.cos(heading) * reach
    py += Math.sin(heading) * reach
    points.push([px, py])
    if (depth < 1 && next() < 0.25) branches.push(crack(next, px, py, length * 0.45, heading + (next() < 0.5 ? 0.9 : -0.9), depth + 1))
  }
  const line = points.map(([cx, cy]) => `${fixed(cx)},${fixed(cy)}`).join(" ")
  const width = depth === 0 ? 0.03 : 0.018
  return `<polyline points="${line}" transform="translate(0.018 0.022)" stroke="${css("paper")}" stroke-opacity="0.13" stroke-width="${fixed(width * 0.7)}" fill="none" stroke-linejoin="round"/>
    <polyline points="${line}" stroke="#141417" stroke-opacity="0.85" stroke-width="${fixed(width)}" fill="none" stroke-linejoin="round" stroke-linecap="round"/>${branches.join("")}`
}

export const cracks = (next: Next, count: number, area: Area): string =>
  Array.from({ length: count }, () => crack(next, between(next, 0.5, area.width - 0.5), between(next, 0.5, area.depth - 0.5), between(next, 0.6, 2.8), next() * Math.PI * 2, 0)).join("")

export const scuffs = (next: Next, count: number, area: Area): string => {
  const parts: Array<string> = []
  for (let index = 0; index < count; index += 1) {
    const x = between(next, 0.5, area.width - 0.5)
    const y = between(next, 0.5, area.depth - 0.5)
    const angle = next() * 360
    const length = between(next, 0.25, 1.1)
    const light = next() < 0.55
    parts.push(`<path d="M0 0 q${fixed(length * 0.5)} ${fixed(between(next, -0.12, 0.12))} ${fixed(length)} 0" transform="translate(${fixed(x)} ${fixed(y)}) rotate(${fixed(angle)})" stroke="${light ? css("paper") : css("ink")}" stroke-opacity="${fixed(light ? between(next, 0.05, 0.12) : between(next, 0.1, 0.22))}" stroke-width="${fixed(between(next, 0.02, 0.09))}" stroke-linecap="round" fill="none"/>`)
  }
  return parts.join("")
}

export const stains = (next: Next, count: number, area: Area): string => {
  const parts: Array<string> = []
  for (let index = 0; index < count; index += 1) {
    const x = between(next, 2, area.width - 2)
    const y = between(next, 2, area.depth - 2)
    const radius = between(next, 0.25, 0.85)
    const opacity = between(next, 0.22, 0.48)
    const blobs = Array.from({ length: 3 }, () =>
      `<ellipse cx="${fixed(x + between(next, -radius, radius) * 0.6)}" cy="${fixed(y + between(next, -radius, radius) * 0.6)}" rx="${fixed(radius * between(next, 0.5, 1))}" ry="${fixed(radius * between(next, 0.4, 0.9))}"/>`).join("")
    const angle = next() * Math.PI * 2
    const flicks = Array.from({ length: 9 }, () => {
      const reach = radius * between(next, 1.1, 3.2)
      const spread = angle + between(next, -0.5, 0.5)
      return `<circle cx="${fixed(x + Math.cos(spread) * reach)}" cy="${fixed(y + Math.sin(spread) * reach)}" r="${fixed(between(next, 0.015, 0.07))}"/>`
    }).join("")
    parts.push(`<g fill="${css("ink")}" opacity="${fixed(opacity)}" filter="url(#ragged)">${blobs}</g><g fill="${css("ink")}" opacity="${fixed(opacity * 1.2)}">${flicks}</g>`)
  }
  return parts.join("")
}

export const brushMarks = (next: Next, count: number, area: Area): string => {
  const parts: Array<string> = []
  for (let index = 0; index < count; index += 1) {
    const x = between(next, 2, area.width - 2)
    const y = between(next, 2, area.depth - 2)
    const length = between(next, 1.8, 4.2)
    const bend = between(next, -0.5, 0.5)
    const width = between(next, 0.18, 0.42)
    const light = next() < 0.4
    parts.push(`<g transform="translate(${fixed(x)} ${fixed(y)}) rotate(${fixed(between(next, -40, 40) + (next() < 0.5 ? 0 : 180))})" filter="url(#bristles)">
      <path d="M0 0 Q${fixed(length * 0.5)} ${fixed(bend)} ${fixed(length)} ${fixed(bend * 0.4)}" stroke="${light ? css("paper") : css("ink")}" stroke-opacity="${fixed(light ? 0.16 : 0.3)}" stroke-width="${fixed(width)}" stroke-linecap="round" fill="none"/>
    </g>`)
  }
  return parts.join("")
}

const SHADES = ["#5e5e64", "#636369", "#68686e", "#6c6c72", "#707076", "#74747a", "#66666c", "#5a5a60"] as const
const DARK_SHADES = ["#4a4a50", "#505056", "#545459"] as const

/** The grout between tiles: a hairline only a little darker than the stone, so thin telegraphs read over it. */
export const SEAM = { gap: 0.011, color: "#45454a" } as const

/** Worn stone tiles `size` across over the area, each a shade of grey with a lit and a shadowed edge and one of six `tileShade` gradients. */
export const tiles = (next: Next, area: Area, size: number, shades: ReadonlyArray<string> = SHADES, dark: ReadonlyArray<string> = DARK_SHADES): string => {
  const parts: Array<string> = []
  const gap = SEAM.gap
  for (let x = 0; x < area.width; x += size) {
    for (let y = 0; y < area.depth; y += size) {
      const fill = next() < 0.12 ? pick(next, dark) : pick(next, shades)
      const w = size - gap * 2
      parts.push(`<rect x="${fixed(x + gap)}" y="${fixed(y + gap)}" width="${fixed(w)}" height="${fixed(w)}" fill="${fill}"/>`)
      parts.push(`<rect x="${fixed(x + gap)}" y="${fixed(y + gap)}" width="${fixed(w)}" height="${fixed(w)}" fill="url(#tileShade${Math.floor(next() * 6)})"/>`)
      parts.push(`<path d="M${fixed(x + gap + 0.02)} ${fixed(y + size - gap - 0.02)} V${fixed(y + gap + 0.02)} H${fixed(x + size - gap - 0.02)}" stroke="${css("paper")}" stroke-opacity="${fixed(between(next, 0.05, 0.1))}" stroke-width="0.022" fill="none"/>`)
      parts.push(`<path d="M${fixed(x + gap + 0.02)} ${fixed(y + size - gap - 0.015)} H${fixed(x + size - gap - 0.015)} V${fixed(y + gap + 0.02)}" stroke="${css("ink")}" stroke-opacity="${fixed(between(next, 0.07, 0.13))}" stroke-width="0.022" fill="none"/>`)
    }
  }
  return parts.join("")
}

/** Six light-to-dark gradients across a tile at random angles, `tileShade0` to `tileShade5`, for `tiles`. */
export const tileShades = (next: Next): string =>
  Array.from({ length: 6 }, (_, index) => {
    const angle = next() * Math.PI * 2
    const x = Math.cos(angle) * 0.5
    const y = Math.sin(angle) * 0.5
    return `<linearGradient id="tileShade${index}" x1="${fixed(0.5 - x)}" y1="${fixed(0.5 - y)}" x2="${fixed(0.5 + x)}" y2="${fixed(0.5 + y)}">
      <stop offset="0" stop-color="${css("paper")}" stop-opacity="${fixed(between(next, 0.04, 0.09))}"/>
      <stop offset="0.55" stop-color="${css("paper")}" stop-opacity="0"/>
      <stop offset="1" stop-color="${css("ink")}" stop-opacity="${fixed(between(next, 0.08, 0.16))}"/>
    </linearGradient>`
  }).join("")

/** A coordinate across a `span` of `size` tiles that lands on a seam, or with `partway`, in the middle half of a tile. */
const seamPoint = (next: Next, span: number, size: number, partway: boolean): number => {
  const count = span / size
  return partway ? (Math.floor(between(next, 1, count - 1)) + between(next, 0.25, 0.75)) * size : Math.round(between(next, 1, count - 1)) * size
}

/** Chipped tile edges, each partway along a seam, never where seams cross. */
export const chips = (next: Next, count: number, area: Area, size: number): string => {
  const parts: Array<string> = []
  for (let index = 0; index < count; index += 1) {
    const onRow = next() < 0.5
    const cx = seamPoint(next, area.width, size, onRow)
    const cy = seamPoint(next, area.depth, size, !onRow)
    const radius = between(next, 0.07, 0.2)
    const corners = 5 + Math.floor(next() * 3)
    const start = next() * Math.PI * 2
    const points = Array.from({ length: corners }, (_, corner) => {
      const angle = start + (corner / corners) * Math.PI * 2
      const reach = radius * between(next, 0.45, 1.1)
      return `${fixed(cx + Math.cos(angle) * reach)},${fixed(cy + Math.sin(angle) * reach)}`
    }).join(" ")
    parts.push(`<polygon points="${points}" fill="${css("concrete800")}" stroke="#2a2a2e" stroke-width="0.01"/>`)
  }
  return parts.join("")
}

export const flecks = (next: Next, count: number, area: Area): string => {
  const parts: Array<string> = []
  for (let index = 0; index < count; index += 1) {
    const light = next() < 0.6
    parts.push(`<circle cx="${fixed(next() * area.width)}" cy="${fixed(next() * area.depth)}" r="${fixed(between(next, 0.006, light ? 0.026 : 0.02))}" fill="${light ? css("paper") : css("ink")}" fill-opacity="${fixed(light ? between(next, 0.12, 0.38) : between(next, 0.2, 0.5))}"/>`)
  }
  return parts.join("")
}
