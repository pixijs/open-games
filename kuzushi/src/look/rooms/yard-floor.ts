import { mulberry32 } from "math/random"

import { css } from "../../art/palette.ts"
import type { RoomTemplate, TemplateId } from "../../sim/index.ts"
import { between, brushMarks, chips, cracks, fixed, flecks, markFilters, scuffs, SEAM, stains, tileShades, tiles } from "../marks.ts"
import type { Area, Next } from "../marks.ts"
import { seedOf } from "./seed.ts"

/**
 * A Courtyard room's floor as one SVG in its template's units ((x + halfWidth, z + halfDepth), before mirroring): the
 * Courtyard's worn 2-unit tiles, wear paths along the door lanes, the template's own inlay (an arrow ring where the zone
 * begins, a shrine's rule, a cloister's walk, the gate's broken footing, the old court's ring, the great court's arena),
 * hairline cracks, chips, stains, contact shadow round every prop and along the walls, and paper flecks.
 */

export const YARD_PIXELS = 52

const LINE = "#18181b"

type Engrave = (area: Area, next: Next) => string

const ring = (cx: number, cy: number, r: number, width: number, extra = "") =>
  `<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="${fixed(r)}" stroke-width="${fixed(width)}" ${extra}/>`

/** Ticks round a circle: `count` of them from `inner` to `outer`, every `long`th reaching in further. */
const ticks = (cx: number, cy: number, count: number, inner: number, outer: number, long: number, reach: number) =>
  Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2
    const from = index % long === 0 ? inner - reach : inner
    return `<line x1="${fixed(cx + Math.cos(angle) * from)}" y1="${fixed(cy + Math.sin(angle) * from)}" x2="${fixed(cx + Math.cos(angle) * outer)}" y2="${fixed(cy + Math.sin(angle) * outer)}"/>`
  }).join("")

/** A paper rule a little below and right of an ink one, as if cut into the stone and caught by the light. */
const cut = (body: string, width: number, opacity = 0.42) =>
  `<g fill="none" stroke="${LINE}" stroke-opacity="${opacity}" stroke-width="${fixed(width)}">${body}</g><g fill="none" stroke="${css("paper")}" stroke-opacity="0.1" stroke-width="${fixed(width * 0.6)}" transform="translate(0.03 0.035)">${body}</g>`

/** The zone begins here: an arrowhead in a ring, the path to the north door paved pale. */
const forecourt: Engrave = (area) => {
  const cx = area.width / 2
  const cy = area.depth / 2
  const head = `<path d="M${fixed(cx)} ${fixed(cy - 1.5)} L${fixed(cx + 1.05)} ${fixed(cy + 1.1)} L${fixed(cx)} ${fixed(cy + 0.55)} L${fixed(cx - 1.05)} ${fixed(cy + 1.1)} Z" stroke-linejoin="round"/>`
  const path = `<rect x="${fixed(cx - 1.5)}" y="0" width="3" height="${fixed(area.depth)}" fill="${css("paper")}" fill-opacity="0.07" stroke="none"/>`
  return `${path}${cut(`${ring(cx, cy, 2.3, 0.05)}${ring(cx, cy, 2.75, 0.03, `stroke-dasharray="0.9 0.25"`)}${head}${ticks(cx, cy, 4, 2.9, 3.4, 1, 0)}`, 0.05)}`
}

/** A shrine's double rule round its middle, a diamond at each corner. */
const shrine: Engrave = (area) => {
  const cx = area.width / 2
  const cy = area.depth / 2
  const rect = (hw: number, hd: number) => `<rect x="${fixed(cx - hw)}" y="${fixed(cy - hd)}" width="${fixed(hw * 2)}" height="${fixed(hd * 2)}"/>`
  const diamonds = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx = 0, sy = 0]) => {
    const x = cx + sx * 4.6
    const y = cy + sy * 2.6
    return `<path d="M${fixed(x)} ${fixed(y - 0.35)} L${fixed(x + 0.35)} ${fixed(y)} L${fixed(x)} ${fixed(y + 0.35)} L${fixed(x - 0.35)} ${fixed(y)} Z"/>`
  }).join("")
  return cut(`${rect(4.6, 2.6)}${rect(4.25, 2.25)}${diamonds}`, 0.05)
}

/** Worn lanes crossing the yard between its doors, and a drain grate in the middle. */
const yardWear: Engrave = (area, next) => {
  const cx = area.width / 2
  const cy = area.depth / 2
  const lanes = `<g fill="${css("paper")}" fill-opacity="0.05" filter="url(#ragged)"><rect x="${fixed(cx - 1.4)}" y="0" width="2.8" height="${fixed(area.depth)}"/><rect x="0" y="${fixed(cy - 1.4)}" width="${fixed(area.width)}" height="2.8"/></g>`
  const bars = Array.from({ length: 7 }, (_, index) => `<line x1="${fixed(cx - 0.75 + index * 0.25)}" y1="${fixed(cy - 0.55)}" x2="${fixed(cx - 0.75 + index * 0.25)}" y2="${fixed(cy + 0.55)}"/>`).join("")
  const grate = `<rect x="${fixed(cx - 0.9)}" y="${fixed(cy - 0.7)}" width="1.8" height="1.4" fill="${LINE}" fill-opacity="0.55" stroke="none"/><g stroke="#5a5a60" stroke-width="0.07">${bars}</g>`
  return `${lanes}${grate}${scuffs(next, 40, area)}`
}

/** The cloister's walk: a band of darker stone one tile in from the walls, ruled on its inner side. */
const cloister: Engrave = (area) => {
  const band = 2
  const frame = `<path fill-rule="evenodd" fill="${LINE}" fill-opacity="0.16" stroke="none" d="M0 0 H${fixed(area.width)} V${fixed(area.depth)} H0 Z M${band} ${band} V${fixed(area.depth - band)} H${fixed(area.width - band)} V${band} Z"/>`
  const inner = `<rect x="${fixed(band + 0.15)}" y="${fixed(band + 0.15)}" width="${fixed(area.width - band * 2 - 0.3)}" height="${fixed(area.depth - band * 2 - 0.3)}"/>`
  const cross = `<line x1="${fixed(area.width / 2)}" y1="${band}" x2="${fixed(area.width / 2)}" y2="${fixed(area.depth - band)}" stroke-dasharray="0.6 0.4"/><line x1="${band}" y1="${fixed(area.depth / 2)}" x2="${fixed(area.width - band)}" y2="${fixed(area.depth / 2)}" stroke-dasharray="0.6 0.4"/>`
  return `${frame}${cut(`${inner}${cross}`, 0.045)}`
}

/** Where the gate's wall stood: a strip of broken footing across the middle, its stones split and scattered. */
const gate: Engrave = (area, next) => {
  const cy = area.depth / 2
  const footing = `<rect x="0" y="${fixed(cy - 1.1)}" width="${fixed(area.width)}" height="2.2" fill="${LINE}" fill-opacity="0.2" filter="url(#ragged)"/>`
  const stones = Array.from({ length: 18 }, () => {
    const x = between(next, 1, area.width - 1)
    const y = cy + between(next, -2.6, 2.6)
    const size = between(next, 0.12, 0.38)
    return `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(size)}" height="${fixed(size * between(next, 0.6, 1.3))}" transform="rotate(${fixed(next() * 90)} ${fixed(x)} ${fixed(y)})" fill="${css("concrete800")}" stroke="#2a2a2e" stroke-width="0.012"/>`
  }).join("")
  return `${footing}${cut(`<line x1="0" y1="${fixed(cy - 1.15)}" x2="${fixed(area.width)}" y2="${fixed(cy - 1.15)}"/><line x1="0" y1="${fixed(cy + 1.15)}" x2="${fixed(area.width)}" y2="${fixed(cy + 1.15)}"/>`, 0.05)}${stones}`
}

/** The old court's engraved rings with their ticks, as The Courtyard has them. */
const court: Engrave = (area) => {
  const cx = area.width / 2
  const cy = area.depth / 2
  return cut(`${ring(cx, cy, 3.4, 0.045)}${ring(cx, cy, 4.1, 0.03)}${ring(cx, cy, 7.2, 0.06, `stroke-dasharray="1.6 0.35 0.2 0.35"`)}${ring(cx, cy, 7.55, 0.025)}<g stroke-width="0.03">${ticks(cx, cy, 16, 3.75, 4.1, 4, 0.2)}</g>`, 0.045)
}

/** The great court is an arena: a wide ring of dark stone, ticked every 15°, a bright ring inside it, a scorched heart. */
const arena: Engrave = (area, next) => {
  const cx = area.width / 2
  const cy = area.depth / 2
  const band = `<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="9.6" fill="none" stroke="${LINE}" stroke-opacity="0.26" stroke-width="1.5"/>`
  const heart = `<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="3.2" fill="${LINE}" fill-opacity="0.18" filter="url(#ragged)"/>`
  const scorch = Array.from({ length: 16 }, () => {
    const angle = next() * Math.PI * 2
    const from = between(next, 1.2, 2.5)
    const to = between(next, 4, 8)
    return `<line x1="${fixed(cx + Math.cos(angle) * from)}" y1="${fixed(cy + Math.sin(angle) * from)}" x2="${fixed(cx + Math.cos(angle) * to)}" y2="${fixed(cy + Math.sin(angle) * to)}" stroke="${css("ink")}" stroke-opacity="${fixed(between(next, 0.1, 0.22))}" stroke-width="${fixed(between(next, 0.12, 0.3))}" stroke-linecap="round"/>`
  }).join("")
  const lines = `${ring(cx, cy, 10.4, 0.07)}${ring(cx, cy, 8.8, 0.04)}${ring(cx, cy, 6.2, 0.03, `stroke-dasharray="1.2 0.3 0.2 0.3"`)}<g stroke-width="0.05">${ticks(cx, cy, 24, 8.85, 10.35, 6, 0)}</g>`
  return `${band}${heart}<g filter="url(#bristles)">${scorch}</g>${cut(lines, 0.06, 0.55)}<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="9.6" fill="none" stroke="${css("paper")}" stroke-opacity="0.08" stroke-width="0.12"/>`
}

const ENGRAVINGS: Partial<Readonly<Record<TemplateId, Engrave>>> = {
  "courtyard.forecourt": forecourt,
  "courtyard.shrine": shrine,
  "courtyard.yard": yardWear,
  "courtyard.cloister": cloister,
  "courtyard.gate": gate,
  "courtyard.court": court,
  "courtyard.great": arena
}

/** Soft ink under every prop and along the foot of the walls. */
const contactShadows = (template: RoomTemplate, area: Area): string => {
  const hw = template.halfWidth
  const hd = template.halfDepth
  const blocks = template.blocks.map((block) =>
    `<rect x="${fixed(block.x - block.halfWidth + hw - 0.12)}" y="${fixed(block.z - block.halfDepth + hd - 0.12)}" width="${fixed(block.halfWidth * 2 + 0.24)}" height="${fixed(block.halfDepth * 2 + 0.24)}" rx="0.1"/>`).join("")
  const pillars = template.pillars.map((pillar) => `<circle cx="${fixed(pillar.x + hw)}" cy="${fixed(pillar.z + hd)}" r="${fixed(pillar.radius + 0.16)}"/>`).join("")
  const walls = `<rect x="-1" y="-1" width="${fixed(area.width + 2)}" height="${fixed(area.depth + 2)}" fill="none" stroke="${css("ink")}" stroke-width="1.6"/>`
  return `<g fill="${css("ink")}" opacity="0.62" filter="url(#soft)">${blocks}${pillars}${walls}</g>`
}

export const yardFloorSvg = (id: TemplateId, template: RoomTemplate): string => {
  const random = mulberry32.create(seedOf(id))
  const next: Next = () => mulberry32.sample(random)
  const area: Area = { width: template.halfWidth * 2, depth: template.halfDepth * 2 }
  const engrave = ENGRAVINGS[id] ?? court
  const big = area.width * area.depth
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fixed(area.width)} ${fixed(area.depth)}">
  <defs>
    ${tileShades(next)}
    <filter id="wobble" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="1.7" numOctaves="2" seed="${seedOf(id) % 97}" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.09" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    ${markFilters}
  </defs>
  <rect width="${fixed(area.width)}" height="${fixed(area.depth)}" fill="${SEAM.color}"/>
  <g filter="url(#wobble)">${tiles(next, area, template.tile)}</g>
  <rect width="${fixed(area.width)}" height="${fixed(area.depth)}" filter="url(#mottle)"/>
  ${engrave(area, next)}
  ${scuffs(next, Math.round(big / 9), area)}
  ${brushMarks(next, Math.round(big / 90), area)}
  ${cracks(next, Math.round(big / 24), area)}
  ${chips(next, Math.round(big / 32), area, template.tile)}
  ${stains(next, Math.round(big / 75), area)}
  ${contactShadows(template, area)}
  ${flecks(next, Math.round(big * 1.1), area)}
</svg>`
}
