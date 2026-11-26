import type { Texture } from "pixi.js"

import { css } from "../art/palette.ts"
import { svgTextures } from "../art/svg.ts"

/**
 * The red sun low behind the courtyard: a disc in the accent red with a deep red rim, a halo fading out round it,
 * and dry ink cloud bands drawn across its lower half.
 */
const sunSvg = (): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="disc" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${css("red")}"/><stop offset="0.82" stop-color="${css("red")}"/><stop offset="1" stop-color="${css("redDeep")}"/>
    </radialGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.62" stop-color="${css("red")}" stop-opacity="0.5"/><stop offset="0.7" stop-color="${css("red")}" stop-opacity="0.16"/><stop offset="1" stop-color="${css("red")}" stop-opacity="0"/>
    </radialGradient>
    <filter id="dry" x="-10%" y="-60%" width="120%" height="220%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.18" numOctaves="3" seed="11" result="warp"/>
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="18" xChannelSelector="R" yChannelSelector="G" result="rough"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.004 0.6" numOctaves="2" seed="3" result="streaks"/>
      <feColorMatrix in="streaks" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -9 6.4" result="gaps"/>
      <feComposite in="rough" in2="gaps" operator="in"/>
    </filter>
  </defs>
  <circle cx="256" cy="256" r="256" fill="url(#halo)"/>
  <circle cx="256" cy="256" r="160" fill="url(#disc)"/>
  <g fill="${css("ink")}" filter="url(#dry)">
    <rect x="40" y="300" width="380" height="15" rx="7"/>
    <rect x="140" y="330" width="330" height="9" rx="4"/>
    <rect x="70" y="352" width="250" height="22" rx="11"/>
    <rect x="200" y="214" width="200" height="5" rx="2"/>
  </g>
</svg>`

/** A soft, torn-edged ink blob: the shadow of a cloud drifting over the courtyard. */
const cloudSvg = (seed: number): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 128">
  <defs>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="${seed}" result="warp"/>
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="40" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="9"/>
    </filter>
  </defs>
  <ellipse cx="128" cy="64" rx="92" ry="34" fill="${css("ink")}" filter="url(#soft)"/>
</svg>`

export type TitleTextures = Readonly<Record<"sun" | "cloud0" | "cloud1", Texture>>

export const loadTitleTextures = (): Promise<TitleTextures> => svgTextures({
  sun: [sunSvg(), { width: 1024, label: "title-sun", mipmaps: true }],
  cloud0: [cloudSvg(4), { width: 256, label: "title-cloud0" }],
  cloud1: [cloudSvg(19), { width: 256, label: "title-cloud1" }]
})
