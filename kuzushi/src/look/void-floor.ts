import { mulberry32 } from "math/random"

import { css } from "../art/palette.ts"
import { stageOf } from "../sim/index.ts"
import type { Slab } from "../sim/index.ts"
import { between, fixed, flecks, markFilters, scuffs, stains } from "./marks.ts"
import type { Next } from "./marks.ts"

/**
 * The Void's slab tops as one SVG over the floor's bounding box, in world units (x + halfWidth, z + halfDepth): pale
 * stone with a faint engraved grid, a worn lip and an inset rule round every slab, a seal engraved on the core that
 * never falls, and on every slab that will fall the hairline cracks it will break along. `slabCrackSvg` draws those
 * same cracks alone, white on clear, for the red seams that glow while the slab cracks.
 */

const LAYOUT = stageOf("void").layout
export const SLABS: ReadonlyArray<Slab> = LAYOUT.floor.kind === "slabs" ? LAYOUT.floor.slabs : []
export const VOID_FLOOR = { x: -LAYOUT.halfWidth, z: -LAYOUT.halfDepth, width: LAYOUT.halfWidth * 2, depth: LAYOUT.halfDepth * 2, pixelsPerUnit: 64 } as const
/** Texels per world unit of a slab's crack drawing. */
export const CRACK_PIXELS = 48

/** Slab tops, a little lighter where a slab never falls: under the Void's grade they read as its ground light and ground. */
export const TOPS = ["#6e6e74", "#68686e", "#6c6c72", "#646469", "#6a6a70"] as const
export const CORE = "#727278"

export type Polyline = ReadonlyArray<readonly [number, number]>

/** One crack wandering from (x, y) along `angle` inside the slab's own frame (0 to width, 0 to depth). */
const wander = (next: Next, x: number, y: number, angle: number, length: number, width: number, depth: number): Polyline => {
  const points: Array<readonly [number, number]> = [[x, y]]
  let heading = angle
  let px = x
  let py = y
  const steps = 5 + Math.floor(next() * 5)
  for (let index = 0; index < steps; index += 1) {
    heading += (next() - 0.5) * 0.9
    const reach = (length / steps) * between(next, 0.6, 1.3)
    px = Math.max(0.05, Math.min(width - 0.05, px + Math.cos(heading) * reach))
    py = Math.max(0.05, Math.min(depth - 0.05, py + Math.sin(heading) * reach))
    points.push([px, py])
  }
  return points
}

/** The cracks a falling slab breaks along, in its own frame from `seed`: runs in from its edges, and branches off them. */
export const cracksOf = (slab: Slab, seed: number): ReadonlyArray<Polyline> => {
  if (slab.fallsAfter === null) return []
  const random = mulberry32.create(seed)
  const next: Next = () => mulberry32.sample(random)
  const width = slab.halfWidth * 2
  const depth = slab.halfDepth * 2
  const lines: Array<Polyline> = []
  const count = 3 + Math.floor((width * depth) / 9)
  for (let crack = 0; crack < count; crack += 1) {
    const side = Math.floor(next() * 4)
    const along = between(next, 0.15, 0.85)
    const [x, y, angle] = side === 0 ? [along * width, 0, Math.PI / 2] : side === 1 ? [along * width, depth, -Math.PI / 2] : side === 2 ? [0, along * depth, 0] : [width, along * depth, Math.PI]
    const line = wander(next, x, y, angle + between(next, -0.5, 0.5), between(next, 0.45, 0.9) * Math.max(width, depth), width, depth)
    lines.push(line)
    const fork = line[Math.floor(line.length / 2)]
    if (fork !== undefined && next() < 0.7) lines.push(wander(next, fork[0], fork[1], angle + (next() < 0.5 ? 1.1 : -1.1), between(next, 0.8, 2), width, depth))
  }
  return lines
}

const SLAB_CRACKS: ReadonlyArray<ReadonlyArray<Polyline>> = SLABS.map((slab, index) => cracksOf(slab, 0xc4ac + index * 97))

const points = (line: Polyline, dx: number, dy: number) => line.map(([x, y]) => `${fixed(x + dx)},${fixed(y + dy)}`).join(" ")

/** The engraved seal on a slab that never falls: two rings and four ticks at its centre. */
const sealAt = (cx: number, cy: number) => `<g fill="none" stroke="#2a2a2e" stroke-opacity="0.5">
        <circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="1.6" stroke-width="0.05"/>
        <circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="2.15" stroke-width="0.025" stroke-dasharray="0.4 0.2"/>
        <path d="M${fixed(cx - 2.6)} ${fixed(cy)} H${fixed(cx - 1.75)} M${fixed(cx + 1.75)} ${fixed(cy)} H${fixed(cx + 2.6)} M${fixed(cx)} ${fixed(cy - 2.6)} V${fixed(cy - 1.75)} M${fixed(cx)} ${fixed(cy + 1.75)} V${fixed(cy + 2.6)}" stroke-width="0.05"/>
      </g>`

/**
 * One slab's top in a drawing whose origin is the world point `origin`: its stone in `fill`, a lift of light across
 * it, a faint 1-unit grid, `mark` engraved over it, the hairline `cracks` it will break along, an inset rule and a
 * worn paper lip.
 */
export const slabTop = (next: Next, slab: Slab, origin: { readonly x: number; readonly z: number }, fill: string, cracks: ReadonlyArray<Polyline>, mark: (cx: number, cy: number) => string): string => {
  const x0 = slab.x - slab.halfWidth - origin.x
  const y0 = slab.z - slab.halfDepth - origin.z
  const width = slab.halfWidth * 2
  const depth = slab.halfDepth * 2
  const grid: Array<string> = []
  for (let gx = 1; gx < width; gx += 1) grid.push(`<line x1="${fixed(x0 + gx)}" y1="${fixed(y0 + 0.2)}" x2="${fixed(x0 + gx)}" y2="${fixed(y0 + depth - 0.2)}"/>`)
  for (let gy = 1; gy < depth; gy += 1) grid.push(`<line x1="${fixed(x0 + 0.2)}" y1="${fixed(y0 + gy)}" x2="${fixed(x0 + width - 0.2)}" y2="${fixed(y0 + gy)}"/>`)
  const lines = cracks.map((line) => `<polyline points="${points(line, x0 + 0.02, y0 + 0.025)}" stroke="${css("paper")}" stroke-opacity="0.18" stroke-width="0.02"/><polyline points="${points(line, x0, y0)}" stroke="#1a1a1d" stroke-opacity="0.38" stroke-width="0.026"/>`).join("")
  return `<rect x="${fixed(x0)}" y="${fixed(y0)}" width="${fixed(width)}" height="${fixed(depth)}" fill="${fill}"/>
    <rect x="${fixed(x0)}" y="${fixed(y0)}" width="${fixed(width)}" height="${fixed(depth)}" fill="url(#lift)" opacity="${fixed(between(next, 0.5, 1))}"/>
    <g stroke="#2a2a2e" stroke-opacity="0.16" stroke-width="0.025">${grid.join("")}</g>
    <g stroke="${css("paper")}" stroke-opacity="0.12" stroke-width="0.02" transform="translate(0.03 0.035)">${grid.join("")}</g>
    ${mark(x0 + width / 2, y0 + depth / 2)}
    <g fill="none" stroke-linejoin="round" stroke-linecap="round">${lines}</g>
    <rect x="${fixed(x0 + 0.24)}" y="${fixed(y0 + 0.24)}" width="${fixed(width - 0.48)}" height="${fixed(depth - 0.48)}" fill="none" stroke="#1d1d21" stroke-opacity="0.42" stroke-width="0.04"/>
    <rect x="${fixed(x0 + 0.05)}" y="${fixed(y0 + 0.05)}" width="${fixed(width - 0.1)}" height="${fixed(depth - 0.1)}" fill="none" stroke="${css("paper")}" stroke-opacity="0.5" stroke-width="0.07"/>`
}

/** The gradient `slabTop` lifts each slab with, and the filters, for a drawing's defs. */
export const SLAB_DEFS = `${markFilters}
    <linearGradient id="lift" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${css("paper")}" stop-opacity="0.1"/><stop offset="0.6" stop-color="${css("paper")}" stop-opacity="0"/><stop offset="1" stop-color="${css("ink")}" stop-opacity="0.12"/>
    </linearGradient>`

export const voidFloorSvg = (): string => {
  const random = mulberry32.create(0x7015)
  const next: Next = () => mulberry32.sample(random)
  const { width, depth } = VOID_FLOOR
  const area = { width, depth }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${depth}">
  <defs>${SLAB_DEFS}</defs>
  <rect width="${width}" height="${depth}" fill="#2a2a2e"/>
  ${SLABS.map((slab, index) => slabTop(next, slab, VOID_FLOOR, slab.fallsAfter === null ? CORE : (TOPS[index % TOPS.length] ?? TOPS[0]), SLAB_CRACKS[index] ?? [], slab.fallsAfter === null ? sealAt : () => "")).join("")}
  <rect width="${width}" height="${depth}" filter="url(#mottle)" opacity="0.7"/>
  ${scuffs(next, 70, area)}
  ${stains(next, 5, area)}
  ${flecks(next, 700, area)}
</svg>`
}

/** Slab `index`'s cracks, white on clear in its own frame, a soft halo under a hot core: tinted red and added as light. */
export const slabCrackSvg = (index: number): string => crackGlowSvg(SLABS[index], SLAB_CRACKS[index] ?? [])

/** A slab's `lines`, white on clear in its own frame, a soft halo under a hot core: tinted to the accent and added as light. */
export const crackGlowSvg = (slab: Slab | undefined, lines: ReadonlyArray<Polyline>): string => {
  const width = (slab?.halfWidth ?? 1) * 2
  const depth = (slab?.halfDepth ?? 1) * 2
  const halo = lines.map((line) => `<polyline points="${points(line, 0, 0)}"/>`).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${depth}">
  <defs><filter id="bloom" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.09"/></filter></defs>
  <g fill="none" stroke-linejoin="round" stroke-linecap="round">
    <g stroke="#ffffff" stroke-opacity="0.5" stroke-width="0.26" filter="url(#bloom)">${halo}</g>
    <g stroke="#ffffff" stroke-opacity="0.9" stroke-width="0.09">${halo}</g>
    <g stroke="#ffffff" stroke-width="0.035">${halo}</g>
  </g>
</svg>`
}
