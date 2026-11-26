import { mulberry32 } from "math/random"

import { css } from "../art/palette.ts"
import { ARENA } from "../sim/index.ts"
import { brushMarks, chips, cracks, fixed, flecks, markFilters, scuffs, SEAM, stains, tileShades, tiles } from "./marks.ts"
import type { Next } from "./marks.ts"

/**
 * The courtyard floor inside the walls as one SVG, in world units (x + halfWidth, z + halfDepth), so nothing repeats:
 * worn stone tiles with wobbly seams and slight bevels, hairline cracks, corner chips, scuffs, ink stains and
 * splatter, dry-brush marks, an engraved ring at the centre, contact shadow round every prop, and paper flecks.
 */

export const FLOOR = {
  width: ARENA.halfWidth * 2,
  depth: ARENA.halfDepth * 2,
  /** Texels per world unit. */
  pixelsPerUnit: 72
} as const

const toSvg = (x: number, z: number) => [x + ARENA.halfWidth, z + ARENA.halfDepth] as const

const engraving = (): string => {
  const [cx, cy] = toSvg(0, 0)
  const ticks = Array.from({ length: 16 }, (_, index) => {
    const angle = (index / 16) * Math.PI * 2
    const inner = index % 4 === 0 ? 3.55 : 3.75
    return `<line x1="${fixed(cx + Math.cos(angle) * inner)}" y1="${fixed(cy + Math.sin(angle) * inner)}" x2="${fixed(cx + Math.cos(angle) * 4.1)}" y2="${fixed(cy + Math.sin(angle) * 4.1)}"/>`
  }).join("")
  return `<g fill="none" stroke="#18181b" stroke-opacity="0.42">
    <circle cx="${cx}" cy="${cy}" r="3.4" stroke-width="0.045"/>
    <circle cx="${cx}" cy="${cy}" r="4.1" stroke-width="0.03"/>
    <circle cx="${cx}" cy="${cy}" r="7.2" stroke-width="0.06" stroke-dasharray="1.6 0.35 0.2 0.35"/>
    <circle cx="${cx}" cy="${cy}" r="7.55" stroke-width="0.025" stroke-opacity="0.3"/>
    <g stroke-width="0.03">${ticks}</g>
  </g>
  <g fill="none" stroke="${css("paper")}" stroke-opacity="0.1" transform="translate(0.03 0.035)">
    <circle cx="${cx}" cy="${cy}" r="3.4" stroke-width="0.025"/>
    <circle cx="${cx}" cy="${cy}" r="7.2" stroke-width="0.03" stroke-dasharray="1.6 0.35 0.2 0.35"/>
  </g>`
}

const contactShadows = (): string => {
  const blocks = ARENA.blocks.map((block) => {
    const [x, y] = toSvg(block.x - block.halfWidth, block.z - block.halfDepth)
    return `<rect x="${fixed(x - 0.12)}" y="${fixed(y - 0.12)}" width="${fixed(block.halfWidth * 2 + 0.24)}" height="${fixed(block.halfDepth * 2 + 0.24)}" rx="0.1"/>`
  })
  const pillars = ARENA.pillars.map((pillar) => {
    const [x, y] = toSvg(pillar.x, pillar.z)
    return `<circle cx="${fixed(x)}" cy="${fixed(y)}" r="${fixed(pillar.radius + 0.14)}"/>`
  })
  const walls = `<rect x="-1" y="-1" width="${FLOOR.width + 2}" height="${FLOOR.depth + 2}" fill="none" stroke="${css("ink")}" stroke-width="1.6"/>`
  return `<g fill="${css("ink")}" opacity="0.62" filter="url(#soft)">${blocks.join("")}${pillars.join("")}${walls}</g>`
}

export const floorSvg = (): string => {
  const random = mulberry32.create(0x6b75)
  const next: Next = () => mulberry32.sample(random)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FLOOR.width} ${FLOOR.depth}">
  <defs>
    ${tileShades(next)}
    <filter id="wobble" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="1.7" numOctaves="2" seed="11" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.09" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    ${markFilters}
  </defs>
  <rect width="${FLOOR.width}" height="${FLOOR.depth}" fill="${SEAM.color}"/>
  <g filter="url(#wobble)">${tiles(next, FLOOR, ARENA.tile)}</g>
  <rect width="${FLOOR.width}" height="${FLOOR.depth}" filter="url(#mottle)"/>
  ${engraving()}
  ${scuffs(next, 90, FLOOR)}
  ${brushMarks(next, 9, FLOOR)}
  ${cracks(next, 34, FLOOR)}
  ${chips(next, 26, FLOOR, ARENA.tile)}
  ${stains(next, 11, FLOOR)}
  ${contactShadows()}
  ${flecks(next, 900, FLOOR)}
</svg>`
}
