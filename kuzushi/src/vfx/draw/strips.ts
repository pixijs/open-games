import { between, blurFilter, dryFilter, INK, line, PAPER, RED, RED_DEEP, rngOf, roughFilter, svgDocument, taper } from "./pen.ts"

/**
 * The long drawings that are bent or stretched onto meshes: the slash stroke (u along the swing, v from the
 * outer edge at the top to the inner edge at the bottom), its glow, the erosion noise, telegraph lines and
 * rings, and the screen's focus lines.
 */

export const STROKE_SIZE = { width: 1024, height: 128 } as const

/**
 * One drawing of the slash stroke: white-hot across most of its width, with a thin red rim on the outer edge and
 * red only where it breaks up: the inner edge and the tail, which drag into dry-brush streaks.
 */
export const strokeSvg = (seed: number): string => {
  const { width, height } = STROKE_SIZE
  const rng = rngOf(seed)
  const streaks: Array<string> = []
  for (let index = 0; index < 24; index++) {
    const tail = index < 10
    const y = tail ? between(rng, 14, 120) : between(rng, 92, 124)
    const from = tail ? between(rng, 0, width * 0.12) : between(rng, 0, width * 0.7)
    const length = tail ? between(rng, 160, 380) : between(rng, 120, 420)
    const thick = between(rng, 2, 7)
    const color = rng() < 0.4 ? RED_DEEP : RED
    streaks.push(`<path d="${taper(line([from, y], [Math.min(width, from + length), y + between(rng, -4, 4)], 12, rng, 3), (t) => thick * Math.sin(Math.PI * t) ** 0.5)}" fill="${color}"/>`)
  }
  const sparks: Array<string> = []
  for (let index = 0; index < 8; index++) {
    const y = between(rng, 20, 80)
    const from = between(rng, width * 0.1, width * 0.5)
    sparks.push(`<path d="${taper(line([from, y], [from + between(rng, 60, 180), y], 8), (t) => between(rng, 2, 4) * Math.sin(Math.PI * t))}" fill="${PAPER}"/>`)
  }
  const core = taper(line([width * 0.02, 46], [width, 40], 40, rng, 5), (t) => 72 * (0.3 + 0.7 * t ** 0.5))
  const hot = taper(line([width * 0.25, 18], [width, 14], 30, rng, 2), (t) => 12 * Math.sin((Math.PI / 2) * Math.min(1, t * 1.6)))
  return svgDocument(width, height, `0 0 ${width} ${height}`, `<defs>
<linearGradient id="body" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}"><stop offset="0" stop-color="${RED}"/><stop offset="0.05" stop-color="${RED}"/><stop offset="0.1" stop-color="${PAPER}"/><stop offset="0.7" stop-color="${PAPER}"/><stop offset="0.82" stop-color="${RED}"/><stop offset="1" stop-color="${RED_DEEP}"/></linearGradient>
<linearGradient id="tail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${RED}" stop-opacity="0.95"/><stop offset="0.16" stop-color="${RED}" stop-opacity="0.55"/><stop offset="0.32" stop-color="${RED}" stop-opacity="0"/></linearGradient>
<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.3"/><stop offset="0.35" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="along" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="url(#fade)"/></mask>
${roughFilter("rough", seed, 0.025, 6, 2000)}
${dryFilter("dry", seed + 1, 0.0035, 0.16, 1.7, 2000)}
${dryFilter("tailDry", seed + 2, 0.004, 0.12, 1.2, 2000)}
</defs>
<g mask="url(#along)"><g filter="url(#rough)">
<rect x="0" y="0" width="${width}" height="${height * 0.8}" fill="url(#body)"/>
<g filter="url(#dry)"><rect x="0" y="${height * 0.72}" width="${width}" height="${height * 0.28}" fill="url(#body)"/></g>
<path d="${core}" fill="${PAPER}"/>
<path d="${hot}" fill="${PAPER}"/>
<g filter="url(#tailDry)"><rect x="0" y="0" width="${width}" height="${height}" fill="url(#tail)"/></g>
${streaks.join("")}
${sparks.join("")}
</g></g>`)
}

/** The soft light under a stroke, in `color` (red by default), added over the floor. */
export const strokeGlowSvg = (color: string = RED): string => svgDocument(512, 64, "0 0 512 64", `<defs>
<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset="0.3" stop-color="${color}" stop-opacity="1"/><stop offset="0.55" stop-color="${color}" stop-opacity="0.55"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>
<linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.45" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="64"><rect width="512" height="64" fill="url(#h)"/></mask></defs>
<rect width="512" height="64" fill="url(#v)" mask="url(#m)"/>`)

/** Streaky greyscale noise that tiles: what the strokes erode through. */
export const noiseSvg = (): string => svgDocument(256, 256, "0 0 256 256", `<filter id="n" x="0" y="0" width="1" height="1">
<feTurbulence type="fractalNoise" baseFrequency="0.012 0.06" numOctaves="4" seed="7" stitchTiles="stitch"/>
<feColorMatrix type="matrix" values="1.6 0 0 0 -0.3 1.6 0 0 0 -0.3 1.6 0 0 0 -0.3 0 0 0 0 1"/></filter>
<rect width="256" height="256" filter="url(#n)"/>`)

/** A telegraph line: a hairline with a glow and tick marks, from the attacker at u = 0. */
export const telegraphLineSvg = (accent: string): string => {
  const ticks = Array.from({ length: 15 }, (_, index) => {
    const x = 24 + index * 32
    return `<rect x="${x}" y="22" width="3" height="20" fill="${accent}" opacity="0.8"/>`
  }).join("")
  return svgDocument(512, 64, "0 0 512 64", `<defs>${blurFilter("g", 5, 1000)}</defs>
<rect x="0" y="24" width="512" height="16" fill="${accent}" opacity="0.55" filter="url(#g)"/>
${ticks}
<rect x="0" y="29.5" width="512" height="5" fill="${accent}"/>
<rect x="0" y="31" width="512" height="2" fill="${PAPER}" opacity="0.85"/>`)
}

/**
 * A telegraph line for a pale floor, where a red glow and a paper hairline wash out: a solid red stroke edged in ink,
 * about 3 pixels of red and 1 of ink either side at the play camera's distance.
 */
export const telegraphLinePaleSvg = (accent: string): string => svgDocument(512, 64, "0 0 512 64", `<rect x="0" y="22" width="512" height="20" fill="${INK}"/>
<rect x="0" y="26" width="512" height="12" fill="${accent}"/>`)

/** A telegraph ring: a double outline with ticks, the danger edge of a slam. */
export const telegraphRingSvg = (accent: string): string => {
  const ticks = Array.from({ length: 36 }, (_, index) => {
    const angle = (index / 36) * Math.PI * 2
    const r0 = index % 3 === 0 ? 210 : 224
    return `<path d="M${256 + Math.cos(angle) * r0} ${256 + Math.sin(angle) * r0}L${256 + Math.cos(angle) * 240} ${256 + Math.sin(angle) * 240}" stroke="${accent}" stroke-width="${index % 3 === 0 ? 4 : 2}"/>`
  }).join("")
  return svgDocument(512, 512, "0 0 512 512", `<defs>${blurFilter("g", 6, 1000)}</defs>
<circle cx="256" cy="256" r="246" fill="none" stroke="${accent}" stroke-width="14" opacity="0.5" filter="url(#g)"/>
${ticks}
<circle cx="256" cy="256" r="246" fill="none" stroke="${accent}" stroke-width="5"/>
<circle cx="256" cy="256" r="246" fill="none" stroke="${PAPER}" stroke-width="1.5" opacity="0.8"/>
<circle cx="256" cy="256" r="200" fill="none" stroke="${accent}" stroke-width="1.5" stroke-dasharray="6 10" opacity="0.7"/>`)
}

/** One drawing of the radial focus lines: white wedges closing on a clear centre, for a screen-sized sprite. */
export const focusLinesSvg = (seed: number): string => {
  const rng = rngOf(seed)
  const wedges: Array<string> = []
  for (let index = 0; index < 150; index++) {
    const angle = rng() * Math.PI * 2
    const inner = between(rng, 0.42, 0.9) + (rng() < 0.15 ? -0.12 : 0)
    const width = between(rng, 0.006, 0.03) * (rng() < 0.1 ? 2.5 : 1)
    const spine = line([Math.cos(angle) * inner, Math.sin(angle) * inner], [Math.cos(angle) * 1.5, Math.sin(angle) * 1.5], 6)
    wedges.push(`<path d="${taper(spine, (t) => width * t)}" fill="${PAPER}"/>`)
  }
  return svgDocument(1024, 1024, "-1 -1 2 2", wedges.join(""))
}

/** A straight brush slash for the screen: the special's final cut, a red body round a white core, dry at its tail. */
export const SCREEN_SLASH_SIZE = { width: 2048, height: 192 } as const

export const screenSlashSvg = (seed: number): string => {
  const { width, height } = SCREEN_SLASH_SIZE
  const middle = height / 2
  const rng = rngOf(seed)
  const body = taper(line([0, middle + 6], [width - 6, middle - 4], 40, rng, 8), (t) => 130 * Math.sin(Math.PI * Math.min(1, t ** 1.3 / 0.75) * 0.5) * (t > 0.86 ? (1 - t) / 0.14 : 1))
  const core = taper(line([width * 0.2, middle + 2], [width - 10, middle - 4], 30, rng, 3), (t) => 46 * Math.sin((Math.PI / 2) * Math.min(1, t * 1.4)) * (t > 0.9 ? (1 - t) / 0.1 : 1))
  const streaks = Array.from({ length: 22 }, () => {
    const y = middle + between(rng, -58, 58)
    const from = between(rng, 0, width * 0.45)
    const length = between(rng, 200, 700)
    return `<path d="${taper(line([from, y], [from + length, y + between(rng, -6, 6)], 10, rng, 3), (t) => between(rng, 3, 9) * Math.sin(Math.PI * t))}" fill="${rng() < 0.3 ? RED_DEEP : RED}"/>`
  }).join("")
  return svgDocument(width, height, `0 0 ${width} ${height}`, `<defs>${roughFilter("r", seed, 0.02, 9, 4000)}${dryFilter("d", seed + 3, 0.002, 0.09, 1.5, 4000)}
<linearGradient id="dry" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.3" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="url(#dry)"/></mask></defs>
<g filter="url(#r)"><g filter="url(#d)"><path d="${body}" fill="${RED}"/></g><g mask="url(#m)"><path d="${body}" fill="${RED}"/></g>${streaks}<path d="${core}" fill="${PAPER}"/></g>`)
}

/** A soft frame round the screen, faint in the middle: tinted ink or red for a pulse on a blow. */
export const vignetteSvg = (): string => svgDocument(256, 256, "0 0 256 256", `<defs>
<radialGradient id="v" cx="0.5" cy="0.5" r="0.71"><stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.16"/><stop offset="0.85" stop-color="#fff" stop-opacity="0.6"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></radialGradient></defs>
<rect width="256" height="256" fill="url(#v)"/>`)
