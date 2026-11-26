import { css, hex, PALETTE, paletteOfKind } from "../art/palette.ts"
import type { EnemyKind } from "../sim/index.ts"
import type { Point } from "./geometry.ts"
import { RIM } from "./shapes.ts"
import type { Shape } from "./shapes.ts"

/**
 * Art for the actors' top faces and the soft sprites under them. Glyph SVGs are drawn in the cap's own frame,
 * -1 to 1 across the square of half size `extent` (x right, z down), with the outline drawn exactly where the
 * geometry's edge is, so the ink rim and inner lines line up with the solid.
 */

const fixed = (value: number) => value.toFixed(4)

const pathOf = (outline: ReadonlyArray<Point>, extent: number, scale = 1): string =>
  `M${outline.map(([x, z]) => `${fixed((x / extent) * scale)} ${fixed((z / extent) * scale)}`).join(" L")} Z`

/** Each kind's top markings, in its zone's accent (`accent`) and its deep tone (`deep`). */
const marksOf = (deep: string, accent: string): Readonly<Record<EnemyKind, string>> => ({
  chaser: `<circle r="0.3" fill="none" stroke="${deep}" stroke-width="0.07"/><circle r="0.1" fill="${css("ink")}" fill-opacity="0.85"/>`,
  shooter: `<circle cx="0.42" r="0.12" fill="${css("ink")}" fill-opacity="0.85"/><path d="M-0.35 0 H0.18" stroke="${deep}" stroke-width="0.07" stroke-linecap="round"/>`,
  bruiser: `<path d="M-0.34 -0.34 L0.34 0.34 M0.34 -0.34 L-0.34 0.34" stroke="${deep}" stroke-width="0.09" stroke-linecap="round"/><circle r="0.09" fill="${css("ink")}" fill-opacity="0.85"/>`,
  trickster: `<path d="M0.3 0 L0 0.34 L-0.3 0 L0 -0.34 Z" fill="${css("ink")}" fill-opacity="0.82"/><path d="M0.13 0 L0 0.15 L-0.13 0 L0 -0.15 Z" fill="${accent}"/>`,
  orbiter: `<circle r="0.76" fill="none" stroke="${deep}" stroke-width="0.06"/>${[0, 120, 240].map((turn) => `<path d="M0.6 0 H0.92" transform="rotate(${turn})" stroke="${css("ink")}" stroke-width="0.09" stroke-linecap="round"/>`).join("")}<circle r="0.53" fill="none" stroke="${css("ink")}" stroke-width="0.1"/>`,
  warden: `<circle r="0.88" fill="none" stroke="${deep}" stroke-width="0.05"/>${Array.from({ length: 12 }, (_, index) => `<circle cx="${(Math.cos((index * Math.PI) / 6 + 0.26) * 0.88).toFixed(3)}" cy="${(Math.sin((index * Math.PI) / 6 + 0.26) * 0.88).toFixed(3)}" r="0.035" fill="${css("ink")}"/>`).join("")}<circle r="0.66" fill="none" stroke="${css("ink")}" stroke-width="0.09"/><circle r="0.5" fill="none" stroke="${deep}" stroke-width="0.06"/><circle cx="0.12" r="0.3" fill="${css("ink")}"/><circle cx="0.2" cy="-0.1" r="0.07" fill="${css("paper")}"/>`,
  lancer: `<path d="M-0.5 0 H0.62" stroke="${deep}" stroke-width="0.05" stroke-linecap="round"/><path d="M0.7 0 L0.98 0" stroke="${css("paper")}" stroke-width="0.06" stroke-linecap="round"/><path d="M-0.36 -0.06 L-0.24 0 L-0.36 0.06" fill="none" stroke="${css("ink")}" stroke-width="0.04"/>`,
  splitter: `<path d="M0 -0.86 V0.86" stroke="${css("ink")}" stroke-width="0.09"/><path d="M0.42 -0.2 L0.56 0 L0.42 0.2 M-0.42 -0.2 L-0.56 0 L-0.42 0.2" fill="none" stroke="${deep}" stroke-width="0.07" stroke-linejoin="round"/><circle r="0.12" fill="${css("ink")}" fill-opacity="0.85"/>`,
  splitling: `<path d="M-0.3 0 H0.3" stroke="${css("ink")}" stroke-width="0.12"/><circle cx="0.32" r="0.14" fill="${css("ink")}" fill-opacity="0.85"/>`,
  sweeper: `<path d="M0.05 0 H0.86" stroke="${deep}" stroke-width="0.05" stroke-linecap="round"/><circle r="0.2" fill="none" stroke="${css("ink")}" stroke-width="0.07"/><circle r="0.07" fill="${css("ink")}"/>`,
  pulsar: `<circle r="0.48" fill="none" stroke="${deep}" stroke-width="0.06"/><circle r="0.3" fill="none" stroke="${css("ink")}" stroke-width="0.09"/><circle r="0.1" fill="${css("ink")}" fill-opacity="0.85"/>`,
  leaper: `<path d="M-0.62 0 H0.62 M0 -0.62 V0.62" stroke="${deep}" stroke-width="0.06" stroke-linecap="round"/><rect x="-0.16" y="-0.16" width="0.32" height="0.32" fill="${css("ink")}" fill-opacity="0.85"/>`,
  cutter: `<path d="M-0.7 0 H0.7" stroke="${css("ink")}" stroke-width="0.07" stroke-linecap="round"/><path d="M0.42 -0.12 L0.6 0 L0.42 0.12" fill="none" stroke="${deep}" stroke-width="0.05"/>`,
  gatekeeper: `<rect x="-0.62" y="-0.62" width="1.24" height="1.24" fill="none" stroke="${deep}" stroke-width="0.05"/><path d="M0 -0.42 L0.34 0 L0 0.42 L-0.34 0 Z" fill="${css("ink")}" fill-opacity="0.85"/><path d="M0.12 0 L0 0.15 L-0.12 0 L0 -0.15 Z" fill="${accent}"/>`,
  orrery: `<circle r="0.86" fill="none" stroke="${deep}" stroke-width="0.04"/><ellipse rx="0.78" ry="0.34" fill="none" stroke="${css("ink")}" stroke-width="0.05" transform="rotate(-24)"/><circle r="0.42" fill="none" stroke="${css("ink")}" stroke-width="0.08"/><circle cx="0.1" r="0.22" fill="${css("ink")}"/><circle cx="0.16" cy="-0.08" r="0.06" fill="${css("paper")}"/>`,
  sunder: `<path d="M-0.5 -0.86 L0.5 0.86" stroke="${css("ink")}" stroke-width="0.08"/>${[0, 60, 120, 180, 240, 300].map((turn) => `<path d="M0.62 0 H0.84" transform="rotate(${turn})" stroke="${deep}" stroke-width="0.07" stroke-linecap="round"/>`).join("")}<circle r="0.14" fill="${css("ink")}" fill-opacity="0.85"/>`
})

/** The glyph's ink edge, in its own units, for a body with the usual rim; a thinner rim thins it in step. */
const EDGE = 0.11

const glyph = (outline: ReadonlyArray<Point>, extent: number, fill: string, marks: string, edge = EDGE): string => {
  const shape = pathOf(outline, extent)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 2 2">
  <defs>
    ${fill}
    <filter id="mottle" x="-1" y="-1" width="2" height="2" filterUnits="userSpaceOnUse">
      <feTurbulence type="fractalNoise" baseFrequency="3.5" numOctaves="3" seed="4"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0 0 0 -0.35"/>
    </filter>
    <clipPath id="inside"><path d="${shape}"/></clipPath>
  </defs>
  <rect x="-1" y="-1" width="2" height="2" fill="${css("ink")}"/>
  <path d="${shape}" fill="url(#body)"/>
  <g clip-path="url(#inside)">
    <rect x="-1" y="-1" width="2" height="2" filter="url(#mottle)" opacity="0.5"/>
    <path d="${pathOf(outline, extent, 0.74)}" fill="none" stroke="url(#inner)" stroke-width="0.05" stroke-linejoin="round"/>
    ${marks}
  </g>
  <path d="${shape}" fill="none" stroke="${css("ink")}" stroke-width="${fixed(edge)}" stroke-linejoin="round"/>
</svg>`
}

/** `color` mixed toward `toward` by `amount` (0 to 1), as a CSS hex string. */
const mix = (color: number, toward: number, amount: number): string => {
  const channel = (shift: number) => {
    const from = (color >> shift) & 255
    return Math.round(from + (((toward >> shift) & 255) - from) * amount)
  }
  return hex((channel(16) << 16) | (channel(8) << 8) | channel(0))
}

/** An enemy's top in its zone's accent: lit toward white at the upper left, deepening toward its deep tone. */
export const enemyGlyphSvg = (kind: EnemyKind, { outline, extent, rim }: Shape): string => {
  const { danger, dangerDeep } = paletteOfKind(kind)
  return glyph(
    outline,
    extent,
    `<radialGradient id="body" cx="-0.25" cy="-0.3" r="1.25" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${mix(danger, 0xffffff, 0.3)}"/><stop offset="0.45" stop-color="${hex(danger)}"/><stop offset="1" stop-color="${mix(danger, dangerDeep, 0.3)}"/>
    </radialGradient>
    <linearGradient id="inner" x1="-1" y1="-1" x2="1" y2="1" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${mix(danger, 0xffffff, 0.45)}"/><stop offset="1" stop-color="${hex(dangerDeep)}"/>
    </linearGradient>`,
    marksOf(hex(dangerDeep), hex(danger))[kind],
    (EDGE * rim) / RIM
  )
}

export const playerGlyphSvg = (outline: ReadonlyArray<Point>, extent: number): string =>
  glyph(
    outline,
    extent,
    `<radialGradient id="body" cx="0.2" cy="-0.1" r="1.3" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="${css("paper")}"/><stop offset="1" stop-color="#d9d5cc"/>
    </radialGradient>
    <linearGradient id="inner" x1="-1" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#b9b5ad"/><stop offset="1" stop-color="#e2ded6"/>
    </linearGradient>`,
    `<path d="M0.95 0 L-0.25 0" stroke="#a8a49c" stroke-width="0.035" stroke-linecap="round"/>`
  )

/** A soft round sprite in `color`, its opacity fading out from the middle through `stops` (offset, opacity). */
const blob = (color: string, stops: ReadonlyArray<readonly [offset: number, opacity: number]>): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 2 2">
  <defs><radialGradient id="g" r="1" cx="0" cy="0" gradientUnits="userSpaceOnUse">
    ${stops.map(([offset, opacity]) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`).join("")}
  </radialGradient></defs>
  <circle r="1" fill="url(#g)"/>
</svg>`

/** The contact shadow under every actor. */
export const shadowSvg = (): string => blob(css("ink"), [[0, 0.82], [0.45, 0.62], [0.75, 0.25], [1, 0]])

/** Light pooled on the floor under glowing things; tinted and brightened by its material. */
export const glowSvg = (): string => blob("#ffffff", [[0, 1], [0.2, 0.55], [0.5, 0.18], [1, 0]])

/** An enemy shot: a white-hot core in an orb of the zone's accent (`accent`, `deep`) with a soft halo. */
export const orbSvg = (accent: number = PALETTE.red, deep: number = PALETTE.redDeep): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 2 2">
  <defs><radialGradient id="g" r="1" cx="0" cy="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#ffffff"/><stop offset="0.08" stop-color="${mix(accent, 0xffffff, 0.92)}"/><stop offset="0.17" stop-color="${mix(accent, 0xffffff, 0.45)}"/>
    <stop offset="0.26" stop-color="${hex(accent)}"/><stop offset="0.48" stop-color="${hex(accent)}" stop-opacity="0.85"/>
    <stop offset="0.62" stop-color="${hex(deep)}" stop-opacity="0.35"/><stop offset="1" stop-color="${hex(deep)}" stop-opacity="0"/>
  </radialGradient></defs>
  <circle r="1" fill="url(#g)"/>
  <circle r="0.44" fill="none" stroke="${css("ink")}" stroke-opacity="0.55" stroke-width="0.05"/>
</svg>`

/**
 * An enemy shot over a pale floor, laid over it rather than added: a deep core in an orb of the accent with an ink rim,
 * and a soft halo, so it holds its shape on paper white.
 */
export const orbPaleSvg = (accent: number, deep: number): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 2 2">
  <defs><radialGradient id="g" r="1" cx="0" cy="0" gradientUnits="userSpaceOnUse">
    <stop offset="0.5" stop-color="${hex(accent)}" stop-opacity="0.5"/><stop offset="0.75" stop-color="${hex(accent)}" stop-opacity="0.16"/><stop offset="1" stop-color="${hex(accent)}" stop-opacity="0"/>
  </radialGradient></defs>
  <circle r="1" fill="url(#g)"/>
  <circle r="0.46" fill="${css("ink")}"/>
  <circle r="0.38" fill="${hex(accent)}"/>
  <circle r="0.2" fill="${hex(deep)}"/>
  <circle cx="-0.1" cy="-0.12" r="0.07" fill="${css("paper")}" fill-opacity="0.9"/>
</svg>`

/** The tail behind a shot: bright at the head (+x), thinning and fading to nothing behind it. */
export const streakSvg = (): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 1">
  <defs>
    <linearGradient id="fade" x1="4" y1="0" x2="0" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="1"/><stop offset="0.25" stop-color="#ffffff" stop-opacity="0.6"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path d="M4 0.5 L0 0.47 L0 0.53 Z" fill="url(#fade)"/>
  <path d="M4 0.5 C3 0.12 1.5 0.38 0 0.49 L0 0.51 C1.5 0.62 3 0.88 4 0.5 Z" fill="url(#fade)" opacity="0.55"/>
</svg>`

/** A torn paper fleck drifting in the air: an irregular white chip with a darker fold. */
export const fleckSvg = (): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 2 2">
  <path d="M-0.7 -0.35 L0.15 -0.8 L0.8 -0.2 L0.55 0.6 L-0.25 0.75 L-0.85 0.2 Z" fill="${css("paper")}"/>
  <path d="M0.15 -0.8 L0.55 0.6 L-0.25 0.75 Z" fill="#cfcbc3"/>
</svg>`
