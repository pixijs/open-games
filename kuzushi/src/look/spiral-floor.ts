import { mulberry32 } from "math/random"

import { css } from "../art/palette.ts"
import { stageOf } from "../sim/index.ts"
import { brushMarks, cracks, fixed, flecks, markFilters, scuffs, stains } from "./marks.ts"
import type { Next } from "./marks.ts"
import { burns, DIAL_SEAM, dialRim, flagstones, groove } from "./rooms/dial-floor.ts"
import type { StoneRing } from "./rooms/dial-floor.ts"

/**
 * The Spiral's round floor as one SVG, in world units (x + radius, z + radius): flagstones laid in rings that
 * alternate pale and dark like a target, a spiral groove engraved from the rim to the spire through every pillar's
 * foot, the rim marked like a dial, faint hour lines, burn streaks the beam has left round the spire, contact shadow
 * round every prop, and the same wear as the Courtyard.
 */

const LAYOUT = stageOf("spiral").layout
const RADIUS = LAYOUT.floor.kind === "round" ? LAYOUT.floor.radius : LAYOUT.halfWidth
export const SPIRAL_FLOOR = { size: RADIUS * 2, pixels: 2048 } as const

const AREA = { width: SPIRAL_FLOOR.size, depth: SPIRAL_FLOOR.size } as const
const toSvg = (x: number, z: number) => [x + RADIUS, z + RADIUS] as const

/** Where each ring of stones starts and ends, from the spire out, and whether it is laid in pale stone. */
const RINGS: ReadonlyArray<StoneRing> = [
  [2, 3.3, false],
  [3.3, 4.7, true],
  [4.7, 6.3, false],
  [6.3, 8, true],
  [8, 9.8, false],
  [9.8, 11.7, true],
  [11.7, 13.5, false],
  [13.5, RADIUS, true]
]

/** The spiral through the pillars' feet: distance falls 1.27 units every 52° turned clockwise on screen. */
const spiralRadius = (degrees: number) => 12.4 - ((degrees - 150) * 1.267) / 52
const SPIRAL_FROM = 150 - ((RADIUS - 0.4 - 12.4) * 52) / 1.267
const SPIRAL_TO = 150 + ((12.4 - 2.25) * 52) / 1.267

const spiralPoints = (): ReadonlyArray<readonly [number, number]> => {
  const points: Array<readonly [number, number]> = []
  for (let degrees = SPIRAL_FROM; degrees <= SPIRAL_TO; degrees += 1.5) {
    const radius = spiralRadius(degrees)
    const angle = (degrees * Math.PI) / 180
    points.push(toSvg(Math.cos(angle) * radius, Math.sin(angle) * radius))
  }
  return points
}

const contactShadows = (): string => {
  const [cx, cy] = toSvg(0, 0)
  const pillars = LAYOUT.pillars.map((pillar) => {
    const [x, y] = toSvg(pillar.x, pillar.z)
    return `<circle cx="${fixed(x)}" cy="${fixed(y)}" r="${fixed(pillar.radius + (pillar.radius > 1.5 ? 0.45 : 0.24))}"/>`
  }).join("")
  return `<g fill="${css("ink")}" opacity="0.6" filter="url(#soft)">${pillars}<circle cx="${cx}" cy="${cy}" r="${RADIUS + 0.55}" fill="none" stroke="${css("ink")}" stroke-width="1.5"/></g>`
}

export const spiralFloorSvg = (): string => {
  const random = mulberry32.create(0x5917)
  const next: Next = () => mulberry32.sample(random)
  const size = SPIRAL_FLOOR.size
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <defs>
    <filter id="wobble" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="1.7" numOctaves="2" seed="17" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.08" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    ${markFilters}
  </defs>
  <rect width="${size}" height="${size}" fill="${DIAL_SEAM}"/>
  <g filter="url(#wobble)">${flagstones(next, RADIUS, RINGS)}</g>
  <rect width="${size}" height="${size}" filter="url(#mottle)"/>
  ${dialRim(RADIUS, 3.4)}
  ${burns(next, RADIUS, 2)}
  ${groove(spiralPoints())}
  ${scuffs(next, 110, AREA)}
  ${brushMarks(next, 10, AREA)}
  ${cracks(next, 40, AREA)}
  ${stains(next, 9, AREA)}
  ${contactShadows()}
  ${flecks(next, 1100, AREA)}
</svg>`
}
