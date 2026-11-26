import { mulberry32 } from "math/random"

import { css } from "../../art/palette.ts"
import { DOORWAY, landingOf, onSide, sides } from "../../sim/index.ts"
import type { RoomTemplate, Side, Slab, TemplateId } from "../../sim/index.ts"
import { fixed, flecks, scuffs, stains } from "../marks.ts"
import type { Next } from "../marks.ts"
import { CORE, cracksOf, SLAB_DEFS, slabTop, TOPS } from "../void-floor.ts"
import type { Polyline } from "../void-floor.ts"
import { seedOf } from "./seed.ts"

/**
 * A Void room's slab tops as one SVG over its floor's box and the landings past each edge, in the template's units
 * before mirroring: the Void's grey stone with its grid, rule and worn lip, a mark engraved on the slab the room turns
 * on (an arrow ring where the zone begins, a shrine's squares, the seal, Sunder's split hexagon), chevrons on every
 * landing pointing out to its gate, and on every slab that will fall the hairline cracks it will break along.
 */

export const ISLAND_PIXELS = 52

/** The world rectangle the drawing covers: the floor's box and a landing's reach past each edge. */
export const islandArea = (template: Pick<RoomTemplate, "halfWidth" | "halfDepth">) => {
  const halfWidth = template.halfWidth + DOORWAY.recess
  const halfDepth = template.halfDepth + DOORWAY.recess
  return { x: -halfWidth, z: -halfDepth, width: halfWidth * 2, depth: halfDepth * 2 }
}

const slabsOf = (template: RoomTemplate): ReadonlyArray<Slab> => (template.floor.kind === "slabs" ? template.floor.slabs : [])

/** Each slab's cracks, by its index in the template, from the template's own seed; none on a slab that never falls. */
export const islandCracks = (id: TemplateId, template: RoomTemplate): ReadonlyArray<ReadonlyArray<Polyline>> =>
  slabsOf(template).map((slab, index) => cracksOf(slab, seedOf(id) + index * 97))

const LINE = "#2a2a2e"

type Mark = (cx: number, cy: number) => string

const engrave = (body: string, width: number) => `<g fill="none" stroke="${LINE}" stroke-opacity="0.55" stroke-width="${fixed(width)}">${body}</g>`

const seal: Mark = (cx, cy) => engrave(`<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="1.6"/><circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="2.15" stroke-width="0.025" stroke-dasharray="0.4 0.2"/><path d="M${fixed(cx - 2.6)} ${fixed(cy)} H${fixed(cx - 1.75)} M${fixed(cx + 1.75)} ${fixed(cy)} H${fixed(cx + 2.6)} M${fixed(cx)} ${fixed(cy - 2.6)} V${fixed(cy - 1.75)} M${fixed(cx)} ${fixed(cy + 1.75)} V${fixed(cy + 2.6)}"/>`, 0.05)

const threshold: Mark = (cx, cy) => engrave(`<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="2.2"/><circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="2.7" stroke-width="0.025" stroke-dasharray="0.9 0.25"/><path d="M${fixed(cx)} ${fixed(cy - 1.45)} L${fixed(cx + 1)} ${fixed(cy + 1.05)} L${fixed(cx)} ${fixed(cy + 0.5)} L${fixed(cx - 1)} ${fixed(cy + 1.05)} Z" stroke-linejoin="round"/>`, 0.05)

const squares: Mark = (cx, cy) => {
  const square = (half: number, turn: number) => `<rect x="${fixed(cx - half)}" y="${fixed(cy - half)}" width="${fixed(half * 2)}" height="${fixed(half * 2)}" transform="rotate(${turn} ${fixed(cx)} ${fixed(cy)})"/>`
  return engrave(`${square(2.4, 0)}${square(2.4, 45)}${square(1.1, 0)}<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="3.1" stroke-dasharray="0.3 0.25"/>`, 0.045)
}

/** Sunder's mark: a great hexagon split by its seam, ringed. */
const split: Mark = (cx, cy) => {
  const corners = Array.from({ length: 6 }, (_, index) => {
    const angle = (index / 6) * Math.PI * 2
    return `${fixed(cx + Math.cos(angle) * 3.2)},${fixed(cy + Math.sin(angle) * 3.2)}`
  }).join(" ")
  return `${engrave(`<polygon points="${corners}"/><circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="3.6" stroke-width="0.03" stroke-dasharray="0.5 0.2"/><line x1="${fixed(cx - 4)}" y1="${fixed(cy + 1.4)}" x2="${fixed(cx + 4)}" y2="${fixed(cy - 1.4)}" stroke-width="0.09"/>`, 0.06)}<line x1="${fixed(cx - 3.95)}" y1="${fixed(cy + 1.45)}" x2="${fixed(cx + 4.05)}" y2="${fixed(cy - 1.35)}" stroke="${css("paper")}" stroke-opacity="0.18" stroke-width="0.04"/>`
}

const MARKS: Partial<Readonly<Record<TemplateId, Mark>>> = {
  "void.threshold": threshold,
  "void.shrine": squares,
  "void.abyss": split
}

/** Chevrons along a landing, pointing out toward its gate. */
const chevrons = (slab: Slab, side: Side, origin: { readonly x: number; readonly z: number }): string => {
  const out = onSide(side, 1)
  const across = onSide(side, 0, 1)
  return [-0.45, 0.35].map((along) => {
    const x = slab.x - origin.x + out.x * along
    const y = slab.z - origin.z + out.z * along
    const tip = `${fixed(x + out.x * 0.3)},${fixed(y + out.z * 0.3)}`
    const left = `${fixed(x - out.x * 0.15 + across.x * 0.6)},${fixed(y - out.z * 0.15 + across.z * 0.6)}`
    const right = `${fixed(x - out.x * 0.15 - across.x * 0.6)},${fixed(y - out.z * 0.15 - across.z * 0.6)}`
    return `<polyline points="${left} ${tip} ${right}" fill="none" stroke="${LINE}" stroke-opacity="0.6" stroke-width="0.07" stroke-linejoin="round"/>`
  }).join("")
}

export const islandFloorSvg = (id: TemplateId, template: RoomTemplate): string => {
  const random = mulberry32.create(seedOf(id))
  const next: Next = () => mulberry32.sample(random)
  const area = islandArea(template)
  const slabs = slabsOf(template)
  const cracks = islandCracks(id, template)
  const core = slabs.reduce((best, slab, index) => (slab.halfWidth * slab.halfDepth > (slabs[best]?.halfWidth ?? 0) * (slabs[best]?.halfDepth ?? 0) ? index : best), 0)
  const mark = MARKS[id] ?? seal
  const tops = slabs.map((slab, index) => slabTop(next, slab, area, index === core ? CORE : (TOPS[index % TOPS.length] ?? TOPS[0]), cracks[index] ?? [], index === core ? mark : () => "")).join("")
  const landings = sides.map((side) => {
    const slab = landingOf(template, side)
    return `${slabTop(next, slab, area, "#5e5e64", [], () => "")}${chevrons(slab, side, area)}`
  }).join("")
  const sized = { width: area.width, depth: area.depth }
  const big = area.width * area.depth
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fixed(area.width)} ${fixed(area.depth)}">
  <defs>${SLAB_DEFS}</defs>
  <rect width="${fixed(area.width)}" height="${fixed(area.depth)}" fill="#2a2a2e"/>
  ${tops}
  ${landings}
  <rect width="${fixed(area.width)}" height="${fixed(area.depth)}" filter="url(#mottle)" opacity="0.7"/>
  ${scuffs(next, Math.round(big / 6), sized)}
  ${stains(next, Math.round(big / 120), sized)}
  ${flecks(next, Math.round(big * 1.2), sized)}
</svg>`
}
