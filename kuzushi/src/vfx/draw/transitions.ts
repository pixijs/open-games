import { arrowheadPoints, DASH_NOTCH } from "../../art/arrowhead.ts"
import { between, INK, PAPER, pointsPath, rngOf } from "./pen.ts"

/**
 * The transition's drawings, all in ink or paper on clear: the brush wipe's leading edge (three boils of it), a
 * speed line, the hero held as a white dart drawing with its smear, and the slow mottle that keeps a covered frame
 * alive while the zone card holds.
 */

export const EDGE_SIZE = { width: 256, height: 1024 } as const

/**
 * The wipe's edge, ink filling its left side and breaking up to the right into dry-brush bristles, drops and a fine
 * spray, the way a loaded brush runs out at the front of a stroke. Drawn three times from different seeds and swapped
 * on twos, so the edge boils.
 */
export const wipeEdgeSvg = (seed: number): string => {
  const rng = rngOf(seed)
  const { width, height } = EDGE_SIZE
  const body = 92
  const waves = Array.from({ length: 3 }, () => ({ size: between(rng, 6, 16), period: between(rng, 90, 320), phase: rng() * Math.PI * 2 }))
  const front = (y: number) => body + waves.reduce((sum, wave) => sum + Math.sin((y / wave.period) * Math.PI * 2 + wave.phase) * wave.size, 0)
  const outline: Array<string> = [`M-20 -20`]
  for (let y = -20; y <= height + 20; y += 16) outline.push(`L${front(y).toFixed(1)} ${y}`)
  outline.push(`L-20 ${height + 20} Z`)
  const bristles: Array<string> = []
  let y = 0
  while (y < height) {
    const clump = rng() < 0.22
    const gap = clump ? between(rng, 8, 22) : between(rng, 1.5, 5)
    const thick = clump ? between(rng, 1.2, 3) : between(rng, 2.5, 9)
    const start = front(y) - 14
    const reach = start + 20 + Math.pow(rng(), 1.8) * 150
    const half = thick / 2
    bristles.push(`<path d="M${start.toFixed(1)} ${(y - half).toFixed(1)} L${(reach - half * 3).toFixed(1)} ${(y - half * 0.6).toFixed(1)} Q${reach.toFixed(1)} ${y.toFixed(1)} ${(reach - half * 3).toFixed(1)} ${(y + half * 0.6).toFixed(1)} L${start.toFixed(1)} ${(y + half).toFixed(1)} Z"/>`)
    y += thick + gap
  }
  const drops = Array.from({ length: 90 }, () => {
    const x = body + 30 + Math.pow(rng(), 1.3) * (width - body - 36)
    const r = between(rng, 0.8, 5) * (1 - ((x - body) / (width - body)) * 0.7)
    const stretch = between(rng, 1, 3.2)
    return `<ellipse cx="${x.toFixed(1)}" cy="${(rng() * height).toFixed(1)}" rx="${(r * stretch).toFixed(2)}" ry="${r.toFixed(2)}"/>`
  }).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="rag" x="-10%" y="-2%" width="120%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="0.004 0.06" numOctaves="2" seed="${seed % 97}" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
  <g fill="#ffffff" filter="url(#rag)">
    <path d="${outline.join(" ")}"/>
    ${bristles.join("")}
  </g>
  <g fill="#ffffff">${drops}</g>
</svg>`
}

export const STREAK_SIZE = { width: 512, height: 24 } as const

/** A speed line: a long white streak swelling from a fine tail to a blunt head. */
export const speedStreakSvg = (): string => {
  const { width, height } = STREAK_SIZE
  const mid = height / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <path d="M0 ${mid} Q${width * 0.7} ${mid - 3.5} ${width - 6} ${mid - 4} Q${width} ${mid} ${width - 6} ${mid + 4} Q${width * 0.7} ${mid + 3.5} 0 ${mid} Z" fill="#ffffff"/>
</svg>`
}

export const HERO_SIZE = 256

/** The hero held as a drawing: the dart pose in paper with a heavy ink rim, a hot white core, and a smear of streaks behind. */
export const heroDartSvg = (): string => {
  const size = HERO_SIZE
  const c = size / 2
  const points = arrowheadPoints(c + 54, c - 46, 30, DASH_NOTCH).map(([x, y]) => [x, y + c] as const)
  const outline = pointsPath(points)
  const smear = Array.from({ length: 7 }, (_, index) => {
    const y = c - 22 + index * 7.3
    const from = 10 + (index % 3) * 14
    return `<path d="M${from} ${y.toFixed(1)} L${c - 30} ${y.toFixed(1)}" stroke="#ffffff" stroke-opacity="${(0.35 + (index % 2) * 0.35).toFixed(2)}" stroke-width="${index % 2 === 0 ? 3 : 1.6}" stroke-linecap="round"/>`
  }).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <defs><filter id="soft"><feGaussianBlur stdDeviation="9"/></filter></defs>
  <path d="${outline}" fill="#ffffff" opacity="0.55" filter="url(#soft)"/>
  ${smear}
  <path d="${outline}" fill="${PAPER}" stroke="${INK}" stroke-width="9" stroke-linejoin="round"/>
  <path d="${pointsPath(arrowheadPoints(c + 34, c - 26, 13, DASH_NOTCH).map(([x, y]) => [x, y + c] as const))}" fill="#ffffff"/>
</svg>`
}

/**
 * A tile of the band's dry-brush grain: long streaks along the stroke where the ink runs thin, white on clear, laid
 * over the band at a low alpha so the ink reads as one great brush stroke and breathes while the zone card holds.
 */
export const inkMottleSvg = (): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <filter id="m" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.0039 0.09" numOctaves="3" seed="12" stitchTiles="stitch"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.4 0 0 0 -1.75"/>
    </filter>
  </defs>
  <rect width="512" height="512" filter="url(#m)"/>
</svg>`
