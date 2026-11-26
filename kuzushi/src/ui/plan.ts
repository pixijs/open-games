import { arrowheadPoints } from "../art/arrowhead.ts"
import type { ArenaLayout, Block, Pillar, Slab } from "../sim/index.ts"

/** How far a prop's shadow reaches down-right per unit of its height, as the low sun throws it in play. */
const SHADOW = 0.32

/** Ground units of black kept round a floor with no wall, so its slabs never touch the card's edge. */
const MARGIN = 1

const n = (value: number) => value.toFixed(2)

const rect = (x: number, z: number, halfWidth: number, halfDepth: number, extra = "") =>
  `<rect x="${n(x - halfWidth)}" y="${n(z - halfDepth)}" width="${n(halfWidth * 2)}" height="${n(halfDepth * 2)}"${extra}/>`

const blockShadow = (block: Block) => {
  const reach = block.height * SHADOW
  const { x, z, halfWidth: w, halfDepth: d } = block
  const points = [[x - w, z - d], [x + w, z - d], [x + w + reach, z - d + reach], [x + w + reach, z + d + reach], [x - w + reach, z + d + reach], [x - w, z + d]]
  return `<polygon points="${points.map(([px = 0, pz = 0]) => `${n(px)},${n(pz)}`).join(" ")}"/>`
}

const pillarShadow = (pillar: Pillar) => {
  const reach = Math.min(pillar.height, 9) * SHADOW
  return `<line x1="${n(pillar.x)}" y1="${n(pillar.z)}" x2="${n(pillar.x + reach)}" y2="${n(pillar.z + reach)}" stroke-width="${n(pillar.radius * 2)}" stroke-linecap="round"/>`
}

/** Tile lines every `tile` units across the box of half size (w, d). */
const tiles = (w: number, d: number, tile: number) => {
  const lines: Array<string> = []
  for (let x = -w + tile; x < w; x += tile) lines.push(`M${n(x)} ${n(-d)}V${n(d)}`)
  for (let z = -d + tile; z < d; z += tile) lines.push(`M${n(-w)} ${n(z)}H${n(w)}`)
  return lines.join("")
}

/** The floor, its wall and its tiles, by the floor's shape. Slabs that fall during the stage are outlined dashed. */
const ground = (layout: ArenaLayout, id: string) => {
  const { halfWidth: w, halfDepth: d, wall, tile } = layout
  const floor = layout.floor
  switch (floor.kind) {
    case "rect":
      return `${rect(0, 0, w + wall, d + wall, ` class="k-plan-wall"`)}${rect(0, 0, w, d, ` class="k-plan-floor"`)}<path class="k-plan-tiles" d="${tiles(w, d, tile)}"/>`
    case "round":
      return `<defs><clipPath id="${id}"><circle r="${n(floor.radius)}"/></clipPath></defs>` +
        `<circle class="k-plan-wall" r="${n(floor.radius + wall)}"/><circle class="k-plan-floor" r="${n(floor.radius)}"/>` +
        `<path class="k-plan-tiles" clip-path="url(#${id})" d="${tiles(w, d, tile)}"/>`
    case "slabs":
      return floor.slabs.map((slab: Slab) => rect(slab.x, slab.z, slab.halfWidth, slab.halfDepth, ` class="k-plan-floor${slab.fallsAfter === null ? "" : " is-falling"}"`)).join("")
  }
}

/**
 * A small top-down plan of an arena from its layout, drawn the way the board's arena row shows them: the floor
 * inside its wall (a disc, or slabs over black), blocks and pillars with their long shadows, accent dots where enemies
 * come in, an accent ring at a landmark beyond the floor, and the player's start as a white arrowhead. North is up.
 * Its colours come from rules for its `k-plan-*` classes that the drawing it sits in supplies (the zone's palette on
 * its card in START's zones).
 */
export const planSvg = (layout: ArenaLayout, id: string): string => {
  const reachX = layout.halfWidth + Math.max(layout.wall, MARGIN)
  const reachZ = layout.halfDepth + Math.max(layout.wall, MARGIN)
  const { start, beacon } = layout
  const arrow = `M${arrowheadPoints(0.9, -0.6, 0.6).map(([along, across]) => `${n(start.x + across)} ${n(start.z - along)}`).join("L")}Z`
  const marker = beacon === null || Math.abs(beacon.x) > reachX || Math.abs(beacon.z) > reachZ ? "" : `<circle class="k-plan-beacon" cx="${n(beacon.x)}" cy="${n(beacon.z)}" r="0.7"/>`
  return `<svg class="k-plan" viewBox="${n(-reachX)} ${n(-reachZ)} ${n(reachX * 2)} ${n(reachZ * 2)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  ${ground(layout, `k-plan-${id}`)}
  <g class="k-plan-shadow">${layout.blocks.map(blockShadow).join("")}${layout.pillars.map(pillarShadow).join("")}</g>
  <g class="k-plan-props">${layout.blocks.map((block) => rect(block.x, block.z, block.halfWidth, block.halfDepth)).join("")}${layout.pillars.map((pillar) => `<circle cx="${n(pillar.x)}" cy="${n(pillar.z)}" r="${n(pillar.radius)}"/>`).join("")}</g>
  <g class="k-plan-spawns">${layout.spawnPoints.map((spawn) => `<circle cx="${n(spawn.x)}" cy="${n(spawn.z)}" r="0.42"/>`).join("")}</g>
  ${marker}
  <path class="k-plan-start" d="${arrow}"/>
</svg>`
}
