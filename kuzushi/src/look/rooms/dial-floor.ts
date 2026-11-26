import { mulberry32 } from "math/random"

import { css } from "../../art/palette.ts"
import type { RoomTemplate, TemplateId } from "../../sim/index.ts"
import { between, brushMarks, cracks, fixed, flecks, markFilters, pick, scuffs, stains } from "../marks.ts"
import type { Area, Next } from "../marks.ts"
import { seedOf } from "./seed.ts"

/**
 * The Spiral's round floors as SVG in world units, the dial's centre at (radius, radius): flagstones laid in rings that
 * alternate pale and dark like a target, the rim ticked like a dial, faint hour lines, burn streaks where a beam has
 * swept, and each room's own inlay (a sundial's hours, a shrine's star, the colonnade's spiral, an orrery's orbits).
 * The classic Spiral (../spiral-floor.ts) is drawn from the same pieces.
 */

export const DIAL_PIXELS = 52

/** One ring of stones from the spire out: its inner and outer radius, and whether it is laid in pale stone. */
export type StoneRing = readonly [inner: number, outer: number, pale: boolean]

const PALE = ["#7a7a80", "#7e7e84", "#76767c", "#82828a", "#727278"] as const
const DARK = ["#525258", "#56565c", "#4e4e54", "#5a5a60", "#4c4c52"] as const
export const DIAL_SEAM = "#3a3a3f"
const LINE = "#18181b"

/** A point `radius` out from the dial's centre (`r`, `r` in the drawing) at `angle`, as "x y". */
const at = (r: number, radius: number, angle: number) => `${fixed(r + Math.cos(angle) * radius)} ${fixed(r + Math.sin(angle) * radius)}`

/** A line from `inner` to `outer` along `angle`, about the dial's centre. */
const spoke = (r: number, inner: number, outer: number, angle: number, extra = "") =>
  `<line x1="${fixed(r + Math.cos(angle) * inner)}" y1="${fixed(r + Math.sin(angle) * inner)}" x2="${fixed(r + Math.cos(angle) * outer)}" y2="${fixed(r + Math.sin(angle) * outer)}" ${extra}/>`

/** A circle of `size` at `radius` along `angle` from the dial's centre. */
const dot = (r: number, radius: number, angle: number, size: number, extra = "") =>
  `<circle cx="${fixed(r + Math.cos(angle) * radius)}" cy="${fixed(r + Math.sin(angle) * radius)}" r="${fixed(size)}" ${extra}/>`

/** A flagstone between two radii and two angles: an annular sector. */
const sector = (r: number, inner: number, outer: number, from: number, to: number): string =>
  `M${at(r, inner, from)} A${fixed(inner)} ${fixed(inner)} 0 0 1 ${at(r, inner, to)} L${at(r, outer, to)} A${fixed(outer)} ${fixed(outer)} 0 0 0 ${at(r, outer, from)} Z`

/** Rings of flagstones about 1.9 units long, each with a lit inner edge and a shadowed outer one, some stained. */
export const flagstones = (next: Next, r: number, rings: ReadonlyArray<StoneRing>): string => {
  const parts: Array<string> = []
  for (const [inner, outer, pale] of rings) {
    const middle = (inner + outer) / 2
    const count = Math.max(8, Math.round((Math.PI * 2 * middle) / 1.9))
    const start = next() * Math.PI * 2
    const gapIn = 0.024 / inner
    const gapOut = 0.024 / outer
    for (let index = 0; index < count; index += 1) {
      const from = start + (index / count) * Math.PI * 2
      const to = start + ((index + 1) / count) * Math.PI * 2
      const fill = pick(next, pale ? PALE : DARK)
      const a = inner + 0.025
      const b = outer - 0.025
      parts.push(`<path d="${sector(r, a, b, from + gapIn, to - gapIn)}" fill="${fill}"/>`)
      parts.push(`<path d="M${at(r, a + 0.03, from + gapIn * 2)} A${fixed(a + 0.03)} ${fixed(a + 0.03)} 0 0 1 ${at(r, a + 0.03, to - gapIn * 2)}" stroke="${css("paper")}" stroke-opacity="${fixed(between(next, 0.05, 0.11))}" stroke-width="0.024" fill="none"/>`)
      parts.push(`<path d="M${at(r, b - 0.025, from + gapOut * 2)} A${fixed(b - 0.025)} ${fixed(b - 0.025)} 0 0 1 ${at(r, b - 0.025, to - gapOut * 2)}" stroke="${css("ink")}" stroke-opacity="${fixed(between(next, 0.08, 0.16))}" stroke-width="0.026" fill="none"/>`)
      if (next() < 0.35) parts.push(`<path d="${sector(r, a, b, from + gapIn, to - gapIn)}" fill="${css(next() < 0.5 ? "ink" : "paper")}" fill-opacity="${fixed(between(next, 0.03, 0.07))}"/>`)
    }
  }
  return parts.join("")
}

/** Rings from `inner` out to `radius`, alternating dark and pale, `width` each, the last stretched to the rim. */
const ringsFor = (inner: number, radius: number, width: number, paleFirst = false): ReadonlyArray<StoneRing> => {
  const count = Math.max(1, Math.round((radius - inner) / width))
  const step = (radius - inner) / count
  return Array.from({ length: count }, (_, index) => [inner + index * step, index === count - 1 ? radius : inner + (index + 1) * step, (index % 2 === 1) !== paleFirst] as const)
}

/** The rim marked like a dial: a tick every 6°, a long one every 30° with a diamond, two thin rings; hour lines in from `hoursFrom`. */
export const dialRim = (radius: number, hoursFrom: number): string => {
  const r = radius
  const ticks: Array<string> = []
  for (let index = 0; index < 60; index += 1) {
    const angle = (index / 60) * Math.PI * 2
    const long = index % 5 === 0
    const inner = long ? radius - 1.25 : radius - 0.75
    const outer = long ? radius - 0.18 : radius - 0.4
    ticks.push(`<line x1="${fixed(r + Math.cos(angle) * inner)}" y1="${fixed(r + Math.sin(angle) * inner)}" x2="${fixed(r + Math.cos(angle) * outer)}" y2="${fixed(r + Math.sin(angle) * outer)}" stroke-width="${long ? 0.07 : 0.035}"/>`)
    if (long) {
      const x = r + Math.cos(angle) * (radius - 1.55)
      const y = r + Math.sin(angle) * (radius - 1.55)
      ticks.push(`<path d="M${fixed(x + Math.cos(angle) * 0.18)} ${fixed(y + Math.sin(angle) * 0.18)} L${fixed(x - Math.sin(angle) * 0.1)} ${fixed(y + Math.cos(angle) * 0.1)} L${fixed(x - Math.cos(angle) * 0.18)} ${fixed(y - Math.sin(angle) * 0.18)} L${fixed(x + Math.sin(angle) * 0.1)} ${fixed(y - Math.cos(angle) * 0.1)} Z" fill="#1c1c20" fill-opacity="0.8" stroke="none"/>`)
    }
  }
  const hours = Array.from({ length: 12 }, (_, index) => {
    const angle = (index / 12) * Math.PI * 2
    return `<line x1="${fixed(r + Math.cos(angle) * hoursFrom)}" y1="${fixed(r + Math.sin(angle) * hoursFrom)}" x2="${fixed(r + Math.cos(angle) * (radius - 1.6))}" y2="${fixed(r + Math.sin(angle) * (radius - 1.6))}"/>`
  }).join("")
  return `<g stroke="${LINE}" stroke-opacity="0.7" fill="none">
    <circle cx="${r}" cy="${r}" r="${fixed(radius - 0.1)}" stroke-width="0.05"/>
    <circle cx="${r}" cy="${r}" r="${fixed(radius - 1.38)}" stroke-width="0.03"/>
    ${ticks.join("")}
  </g>
  <g stroke="${LINE}" stroke-opacity="0.22" stroke-width="0.03" stroke-dasharray="0.5 0.35">${hours}</g>`
}

/** Dark streaks fanning out from a spire of `spire` radius, where its beam has burned the stone. */
export const burns = (next: Next, r: number, spire: number, count = 26): string =>
  Array.from({ length: count }, () => {
    const angle = next() * Math.PI * 2
    const from = between(next, spire + 0.1, spire + 0.6)
    const to = between(next, spire + 1.6, spire + 5.5)
    const width = between(next, 0.12, 0.3)
    return `<g filter="url(#bristles)"><line x1="${fixed(r + Math.cos(angle) * from)}" y1="${fixed(r + Math.sin(angle) * from)}" x2="${fixed(r + Math.cos(angle) * to)}" y2="${fixed(r + Math.sin(angle) * to)}" stroke="${css("ink")}" stroke-opacity="${fixed(between(next, 0.12, 0.26))}" stroke-width="${fixed(width)}" stroke-linecap="round"/></g>`
  }).join("")

/** A groove of pale stone inlaid along `points` (drawing coordinates), notched every 1.15 units. */
export const groove = (points: ReadonlyArray<readonly [number, number]>): string => {
  const line = points.map(([x, y]) => `${fixed(x)},${fixed(y)}`).join(" ")
  const notches: Array<string> = []
  let walked = 0
  for (let index = 1; index < points.length; index += 1) {
    const [x, y] = points[index] ?? [0, 0]
    const [px, py] = points[index - 1] ?? [0, 0]
    walked += Math.hypot(x - px, y - py)
    if (walked < 1.15) continue
    walked = 0
    const length = Math.hypot(x - px, y - py) || 1
    const nx = -(y - py) / length
    const ny = (x - px) / length
    notches.push(`<line x1="${fixed(x - nx * 0.42)}" y1="${fixed(y - ny * 0.42)}" x2="${fixed(x + nx * 0.42)}" y2="${fixed(y + ny * 0.42)}"/>`)
  }
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="${line}" stroke="${LINE}" stroke-opacity="0.85" stroke-width="0.78"/>
    <polyline points="${line}" stroke="#a2a2a8" stroke-width="0.6"/>
    <polyline points="${line}" stroke="${css("paper")}" stroke-opacity="0.35" stroke-width="0.12" transform="translate(-0.08 -0.1)"/>
    <polyline points="${line}" stroke="${LINE}" stroke-opacity="0.5" stroke-width="0.05"/>
    <g stroke="${LINE}" stroke-width="0.07" stroke-opacity="0.75">${notches.join("")}</g>
  </g>`
}

/** Points along a circle of `radius` from `from` to `to` radians, for a groove. */
const arc = (r: number, radius: number, from: number, to: number): ReadonlyArray<readonly [number, number]> => {
  const steps = Math.max(8, Math.ceil(Math.abs(to - from) * radius / 0.3))
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = from + ((to - from) * index) / steps
    return [r + Math.cos(angle) * radius, r + Math.sin(angle) * radius] as const
  })
}

/** A spiral groove winding in from `outer` at `from` to `inner` after `turn` radians clockwise on screen. */
const spiral = (r: number, outer: number, inner: number, from: number, turn: number): ReadonlyArray<readonly [number, number]> => {
  const steps = Math.ceil(turn / 0.03)
  return Array.from({ length: steps + 1 }, (_, index) => {
    const share = index / steps
    const radius = outer + (inner - outer) * share
    const angle = from + turn * share
    return [r + Math.cos(angle) * radius, r + Math.sin(angle) * radius] as const
  })
}

const cutLines = (body: string, width: number, opacity = 0.5) =>
  `<g fill="none" stroke="${LINE}" stroke-opacity="${opacity}" stroke-width="${fixed(width)}">${body}</g><g fill="none" stroke="${css("paper")}" stroke-opacity="0.1" stroke-width="${fixed(width * 0.6)}" transform="translate(0.03 0.035)">${body}</g>`

type Inlay = (r: number, template: RoomTemplate, next: Next) => string

/** A sundial: hour lines fanning north of the stump, every third long, the stump's long shadow cut into the stone. */
const gnomon: Inlay = (r, template) => {
  const radius = template.halfWidth
  const hours = Array.from({ length: 13 }, (_, index) => {
    const angle = Math.PI + (index / 12) * Math.PI
    const long = index % 3 === 0
    return spoke(r, 1.6, long ? radius - 1.7 : radius - 3.2, angle, `stroke-width="${long ? 0.07 : 0.035}"`)
  }).join("")
  const shadow = `<path d="M${at(r, 1.2, -1.95)} L${at(r, radius - 2.2, -1.62)} L${at(r, 1.2, -1.29)} Z" fill="${LINE}" fill-opacity="0.22" stroke="none" filter="url(#ragged)"/>`
  return `${shadow}${cutLines(`${hours}<circle cx="${r}" cy="${r}" r="${fixed(radius - 3.4)}" stroke-dasharray="0.4 0.3"/>`, 0.05, 0.55)}`
}

/** A shrine's eight-pointed star of inlaid lines round its middle. */
const shrineStar: Inlay = (r) => {
  const points = Array.from({ length: 16 }, (_, index) => at(r, index % 2 === 0 ? 4.4 : 1.9, (index / 16) * Math.PI * 2 - Math.PI / 2))
  return cutLines(`<path d="M${points.join(" L")} Z"/><circle cx="${r}" cy="${r}" r="4.9"/><circle cx="${r}" cy="${r}" r="1.3"/>`, 0.05, 0.55)
}

/** A ring room's single groove round the middle of the floor. */
const ringGroove: Inlay = (r, template) => groove(arc(r, template.halfWidth * 0.52, 0, Math.PI * 2 + 0.01))

/** The colonnade's spiral groove, through every pillar's foot from the rim in. */
const colonnade: Inlay = (r, template) => groove(spiral(r, template.halfWidth - 0.6, 3.2, (22.5 * Math.PI) / 180 - 0.5, Math.PI * 2 * 0.9))

/** The well's ring groove round its spire, and the beam's burns. */
const well: Inlay = (r, template, next) => `${burns(next, r, 1.4, 20)}${groove(arc(r, 3.4, 0, Math.PI * 2 + 0.01))}${groove(spiral(r, template.halfWidth - 0.7, 4.6, -Math.PI / 2, Math.PI * 1.4))}`

/** The dial: today's Spiral, its groove through every pillar's foot and its beam's burns. */
const dial: Inlay = (r, template, next) => {
  const spiralRadius = (degrees: number) => 12.4 - ((degrees - 150) * 1.267) / 52
  const from = 150 - ((template.halfWidth - 0.4 - 12.4) * 52) / 1.267
  const to = 150 + ((12.4 - 2.25) * 52) / 1.267
  const points: Array<readonly [number, number]> = []
  for (let degrees = from; degrees <= to; degrees += 1.5) {
    const angle = (degrees * Math.PI) / 180
    points.push([r + Math.cos(angle) * spiralRadius(degrees), r + Math.sin(angle) * spiralRadius(degrees)])
  }
  return `${burns(next, r, 2)}${groove(points)}`
}

/** The orrery's floor: orbits cut at every distance its moons and pillars keep, bodies resting on them, the zodiac's ticks. */
const orrery: Inlay = (r, template) => {
  const orbits = [3, 5.6, 9.5, 12.6]
  const rings = orbits.map((radius, index) => `<circle cx="${r}" cy="${r}" r="${radius}" ${index % 2 === 1 ? `stroke-dasharray="0.7 0.25"` : ""}/>`).join("")
  const bodies = orbits.map((radius, index) => {
    const angle = 0.7 + index * 2.1
    const size = 0.55 - index * 0.08
    return `${dot(r, radius, angle, size, `fill="${LINE}" fill-opacity="0.45"`)}${dot(r, radius, angle, size + 0.18)}`
  }).join("")
  const zodiac = Array.from({ length: 12 }, (_, index) => {
    const angle = (index / 12) * Math.PI * 2 + Math.PI / 12
    return spoke(r, 10.6, 11.6, angle)
  }).join("")
  return cutLines(`${rings}${bodies}${zodiac}<circle cx="${r}" cy="${r}" r="${fixed(template.halfWidth - 3.6)}" stroke-width="0.025"/>`, 0.05, 0.55)
}

const INLAYS: Partial<Readonly<Record<TemplateId, Inlay>>> = {
  "spiral.gnomon": gnomon,
  "spiral.shrine": shrineStar,
  "spiral.ring": ringGroove,
  "spiral.colonnade": colonnade,
  "spiral.well": well,
  "spiral.dial": dial,
  "spiral.orrery": orrery
}

/** The innermost ring of stones: round a spire or stump at the centre, else round a small round stone. */
const coreOf = (template: RoomTemplate): number => {
  const centre = template.pillars.find((pillar) => Math.hypot(pillar.x, pillar.z) < 0.5)
  return centre === undefined ? 1.4 : centre.radius + (centre.radius > 1.3 ? 0.6 : 0.1)
}

const contactShadows = (r: number, template: RoomTemplate): string => {
  const pillars = template.pillars.map((pillar) =>
    `<circle cx="${fixed(pillar.x + r)}" cy="${fixed(pillar.z + r)}" r="${fixed(pillar.radius + (pillar.radius > 1.3 ? 0.45 : 0.24))}"/>`).join("")
  return `<g fill="${css("ink")}" opacity="0.6" filter="url(#soft)">${pillars}<circle cx="${r}" cy="${r}" r="${fixed(template.halfWidth + 0.55)}" fill="none" stroke="${css("ink")}" stroke-width="1.5"/></g>`
}

export const dialFloorSvg = (id: TemplateId, template: RoomTemplate): string => {
  const random = mulberry32.create(seedOf(id))
  const next: Next = () => mulberry32.sample(random)
  const radius = template.halfWidth
  const size = radius * 2
  const area: Area = { width: size, depth: size }
  const inlay = INLAYS[id] ?? ringGroove
  const big = size * size
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fixed(size)} ${fixed(size)}">
  <defs>
    <filter id="wobble" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="1.7" numOctaves="2" seed="${seedOf(id) % 89}" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.08" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    ${markFilters}
  </defs>
  <rect width="${fixed(size)}" height="${fixed(size)}" fill="${DIAL_SEAM}"/>
  <g filter="url(#wobble)">${flagstones(next, radius, ringsFor(coreOf(template), radius, radius > 12 ? 1.8 : 1.6, id === "spiral.gnomon"))}</g>
  <rect width="${fixed(size)}" height="${fixed(size)}" filter="url(#mottle)"/>
  ${dialRim(radius, coreOf(template) + 1)}
  ${inlay(radius, template, next)}
  ${scuffs(next, Math.round(big / 8), area)}
  ${brushMarks(next, Math.round(big / 90), area)}
  ${cracks(next, Math.round(big / 22), area)}
  ${stains(next, Math.round(big / 100), area)}
  ${contactShadows(radius, template)}
  ${flecks(next, Math.round(big * 1.2), area)}
</svg>`
}
