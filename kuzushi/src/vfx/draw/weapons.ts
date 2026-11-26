import { hex } from "../../art/palette.ts"
import type { ZonePalette } from "../../art/palette.ts"
import { arc, between, blade, dryFilter, INK, line, PAPER, pointsPath, rngOf, roughFilter, star, svgDocument, taper } from "./pen.ts"

/**
 * The weapons' drawings. The atlas cells are paper white, so a tint gives any colour and the player's own marks stay
 * white (never danger); the strips are bent or stretched onto meshes. Each cell is drawn in -1..1, pointing +x.
 */

/** The slam's mark: a thin white ring with four ticks across it and a dashed ring inside. */
const slamRing = (id: string): string => {
  const ticks = [0, 1, 2, 3].map((index) => {
    const angle = (index * Math.PI) / 2 + Math.PI / 4
    const rng = rngOf(901 + index)
    return `<path d="${blade([Math.cos(angle) * 0.68, Math.sin(angle) * 0.68], [Math.cos(angle) * 0.99, Math.sin(angle) * 0.99], 0.07, 0.5, rng, 0.01)}" fill="${PAPER}"/>`
  }).join("")
  return `${roughFilter(`${id}-r`, 907, 3, 0.02)}<g filter="url(#${id}-r)">
<circle r="0.86" fill="none" stroke="${PAPER}" stroke-width="0.035"/>
<circle r="0.52" fill="none" stroke="${PAPER}" stroke-width="0.022" stroke-dasharray="0.09 0.07" opacity="0.8"/>${ticks}
<path d="M-0.08 0H0.08M0 -0.08V0.08" stroke="${PAPER}" stroke-width="0.03"/></g>`
}

/** A brush ring broken into strokes, all white: a burst's ring, tinted for its accent rim. */
const brushRing = (id: string): string => {
  const rng = rngOf(913)
  const strokes: Array<string> = []
  let angle = rng() * Math.PI
  while (angle < Math.PI * 2 + 0.3) {
    const span = between(rng, 0.7, 1.5)
    const width = between(rng, 0.06, 0.12)
    strokes.push(`<path d="${taper(arc(0, 0, (t) => 0.82 + 0.025 * Math.sin(t * 9), angle, angle + span, 20), (t) => width * Math.sin(t * Math.PI) ** 0.55)}" fill="${PAPER}"/>`)
    angle += span + between(rng, 0.06, 0.2)
  }
  return `${roughFilter(`${id}-r`, 917, 2.6, 0.035)}<g filter="url(#${id}-r)">${strokes.join("")}</g>`
}

/** A square seal stamp: a rough frame and a few heavy strokes inside, white so it tints to ink on the floor. */
const sealSquare = (id: string): string => {
  const rng = rngOf(929)
  const frame = pointsPath([[-0.66, -0.66], [0.66, -0.66], [0.66, 0.66], [-0.66, 0.66]])
  const inner = [
    blade([-0.38, -0.42], [-0.38, 0.44], 0.13, 0.5, rng, 0.03),
    blade([-0.38, -0.36], [-0.02, -0.36], 0.1, 0.5, rng, 0.02),
    blade([-0.38, 0.02], [-0.04, 0.02], 0.1, 0.5, rng, 0.02),
    blade([0.16, -0.44], [0.16, 0.46], 0.13, 0.4, rng, 0.03),
    blade([0.16, -0.38], [0.44, -0.38], 0.1, 0.5, rng, 0.02),
    blade([0.44, -0.38], [0.44, 0.14], 0.1, 0.5, rng, 0.02)
  ].map((path) => `<path d="${path}" fill="${PAPER}"/>`).join("")
  return `${roughFilter(`${id}-r`, 931, 4, 0.05)}<g filter="url(#${id}-r)"><path d="${frame}" fill="none" stroke="${PAPER}" stroke-width="0.13" stroke-linejoin="round"/>${inner}</g>`
}

const chevronPaper = (): string =>
  `<path d="M-0.5 -0.62L0.38 0L-0.5 0.62" fill="none" stroke="${PAPER}" stroke-width="0.17" stroke-linejoin="miter"/><path d="M-0.95 -0.62L-0.07 0L-0.95 0.62" fill="none" stroke="${PAPER}" stroke-width="0.09" opacity="0.55"/>`

/** A muzzle flash: a four-point star long along +x, a hot core and a thin ring. */
const muzzle = (id: string): string => {
  const rng = rngOf(941)
  return `${roughFilter(`${id}-r`, 943, 3, 0.02)}<g filter="url(#${id}-r)">
<path d="${star(4, 0.1, (angle) => 0.4 + 0.58 * Math.abs(Math.cos(angle)) ** 3, rng, 0.05)}" fill="${PAPER}"/>
<circle r="0.16" fill="${PAPER}"/><circle r="0.42" fill="none" stroke="${PAPER}" stroke-width="0.035" stroke-dasharray="0.16 0.08"/></g>`
}

export const WEAPON_CELLS = [
  { name: "slamRing", size: 512, draw: slamRing },
  { name: "brushRing", size: 512, draw: brushRing },
  { name: "sealSquare", size: 256, draw: sealSquare },
  { name: "chevronPaper", size: 256, draw: chevronPaper },
  { name: "muzzle", size: 256, draw: muzzle }
] as const

export const HEAVY_STROKE_SIZE = { width: 1024, height: 128 } as const

/**
 * The breaker's cleave: a fat stroke, white-hot along its outer two thirds, an accent rim on the outer edge, and a
 * heavy dry brush of ink and deep accent dragged through its inner third and its tail.
 */
export const heavyStrokeSvg = (seed: number, palette: ZonePalette): string => {
  const { width, height } = HEAVY_STROKE_SIZE
  const rng = rngOf(seed)
  const accent = hex(palette.danger)
  const deep = hex(palette.dangerDeep)
  const streaks: Array<string> = []
  for (let index = 0; index < 34; index++) {
    const tail = index < 12
    const y = tail ? between(rng, 10, 124) : between(rng, 70, 126)
    const from = tail ? between(rng, 0, width * 0.15) : between(rng, 0, width * 0.8)
    const length = tail ? between(rng, 200, 460) : between(rng, 140, 520)
    const thick = between(rng, 3, 10)
    const color = rng() < 0.45 ? INK : rng() < 0.5 ? deep : accent
    streaks.push(`<path d="${taper(line([from, y], [Math.min(width, from + length), y + between(rng, -5, 5)], 12, rng, 4), (t) => thick * Math.sin(Math.PI * t) ** 0.5)}" fill="${color}"/>`)
  }
  const core = taper(line([width * 0.03, 34], [width, 30], 40, rng, 6), (t) => 48 * (0.3 + 0.7 * t ** 0.5))
  const hot = taper(line([width * 0.3, 14], [width, 12], 30, rng, 2), (t) => 10 * Math.sin((Math.PI / 2) * Math.min(1, t * 1.6)))
  return svgDocument(width, height, `0 0 ${width} ${height}`, `<defs>
<linearGradient id="body" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}"><stop offset="0" stop-color="${accent}"/><stop offset="0.07" stop-color="${accent}"/><stop offset="0.12" stop-color="${PAPER}"/><stop offset="0.46" stop-color="${PAPER}"/><stop offset="0.54" stop-color="${deep}"/><stop offset="0.66" stop-color="${INK}"/><stop offset="1" stop-color="${INK}"/></linearGradient>
<linearGradient id="tail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${INK}" stop-opacity="0.95"/><stop offset="0.2" stop-color="${deep}" stop-opacity="0.6"/><stop offset="0.38" stop-color="${deep}" stop-opacity="0"/></linearGradient>
<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="0.3" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="along" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="url(#fade)"/></mask>
${roughFilter("rough", seed, 0.03, 9, 2000)}
${dryFilter("dry", seed + 1, 0.003, 0.2, 1.5, 2000)}
${dryFilter("tailDry", seed + 2, 0.0035, 0.14, 1.1, 2000)}
</defs>
<g mask="url(#along)"><g filter="url(#rough)">
<rect x="0" y="0" width="${width}" height="${height * 0.6}" fill="url(#body)"/>
<g filter="url(#dry)"><rect x="0" y="${height * 0.52}" width="${width}" height="${height * 0.48}" fill="url(#body)"/></g>
<path d="${core}" fill="${PAPER}"/>
<path d="${hot}" fill="${PAPER}"/>
<g filter="url(#tailDry)"><rect x="0" y="0" width="${width}" height="${height}" fill="url(#tail)"/></g>
${streaks.join("")}
</g></g>`)
}

export const RING_STROKE_SIZE = { width: 1024, height: 64 } as const

/** The sigil's ring, inked round as its delay runs: one white brush stroke, dry where the brush starts and lifts. */
export const inkRingSvg = (seed: number): string => {
  const { width, height } = RING_STROKE_SIZE
  const rng = rngOf(seed)
  const body = taper(line([0, 30], [width, 33], 48, rng, 3), (t) => 22 * (0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.4))
  const hairs = Array.from({ length: 10 }, () => {
    const y = between(rng, 20, 44)
    const from = between(rng, 0, width * 0.2)
    return `<path d="${taper(line([from, y], [from + between(rng, 120, 320), y], 10, rng, 2), (t) => between(rng, 1.5, 3) * Math.sin(Math.PI * t))}" fill="${PAPER}"/>`
  }).join("")
  return svgDocument(width, height, `0 0 ${width} ${height}`, `<defs>
${roughFilter("rough", seed, 0.04, 5, 2000)}
${dryFilter("dry", seed + 3, 0.004, 0.25, 1.45, 2000)}
<linearGradient id="ends" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.14" stop-color="#fff" stop-opacity="0"/><stop offset="0.9" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>
<linearGradient id="middle" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.14" stop-color="#fff" stop-opacity="1"/><stop offset="0.9" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<mask id="endMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="url(#ends)"/></mask>
<mask id="midMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="url(#middle)"/></mask>
</defs>
<g filter="url(#rough)"><g mask="url(#midMask)"><path d="${body}" fill="${PAPER}"/></g>${hairs}</g>
<g mask="url(#endMask)"><g filter="url(#dry)"><path d="${body}" fill="${PAPER}"/></g></g>`)
}

export const STREAK_SIZE = { width: 1024, height: 64 } as const

/** The pierce's line, held for two drawings: a white-hot core edged in ink, dragging dry brush toward where it left. */
export const pierceStreakSvg = (): string => {
  const { width, height } = STREAK_SIZE
  const rng = rngOf(951)
  const core = taper(line([0, 32], [width, 32], 40, rng, 1.5), (t) => 3 + 15 * t ** 0.6)
  const edge = taper(line([0, 32], [width, 32], 40, rng, 1.5), (t) => 6 + 22 * t ** 0.6)
  const ticks = Array.from({ length: 16 }, () => {
    const y = between(rng, 6, 58)
    const from = between(rng, 0, width * 0.9)
    return `<path d="${taper(line([from, y], [from + between(rng, 50, 180), y], 8), (t) => between(rng, 1.5, 3.5) * Math.sin(Math.PI * t))}" fill="${PAPER}" opacity="0.85"/>`
  }).join("")
  return svgDocument(width, height, `0 0 ${width} ${height}`, `<defs>
${roughFilter("rough", 953, 0.05, 3, 2000)}
${dryFilter("dry", 955, 0.004, 0.3, 1.2, 2000)}
<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.8"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="along" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="url(#fade)"/></mask>
</defs>
<g mask="url(#along)"><g filter="url(#rough)"><g filter="url(#dry)"><path d="${edge}" fill="${INK}" opacity="0.85"/></g><path d="${core}" fill="${PAPER}"/>${ticks}</g></g>`)
}

export const AIM_LINE_SIZE = { width: 512, height: 32 } as const

/** The darts' aim line while charging: a white hairline with ticks every unit-ish, brightest at its far end. */
export const aimLineSvg = (): string => {
  const { width, height } = AIM_LINE_SIZE
  const ticks = Array.from({ length: 12 }, (_, index) => `<rect x="${20 + index * 42}" y="10" width="3" height="12" fill="${PAPER}" opacity="0.8"/>`).join("")
  return svgDocument(width, height, `0 0 ${width} ${height}`, `<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="url(#g)"/></mask></defs>
<g mask="url(#m)"><rect x="0" y="13" width="${width}" height="6" fill="${INK}" opacity="0.5"/><rect x="0" y="14" width="${width}" height="4" fill="${PAPER}"/>${ticks}</g>`)
}
