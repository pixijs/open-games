import { Texture } from "pixi.js"

import { svgTextures } from "../../art/svg.ts"
import type { SvgEntry } from "../../art/svg.ts"
import { weaponIds, WEAPONS } from "../../sim/index.ts"
import type { DropKind, WeaponId, ZoneId } from "../../sim/index.ts"

/**
 * What the rooms' doors, altars and springs are drawn with, made once at install: the icon a marked door carries, each
 * weapon's kanji in a thin ring and its first move as an ink drawing, the Courtyard seal's brush stroke, the spring's
 * ripples, dry ring and rising burst, a clear's diamond and FOCUS drops, the gate's glare, the fan of light a doorway
 * spills into its room and its streaks, an open door's chevrons, the Spiral's dial faces, the Void's rifts of light,
 * and the grey a floor shows for the frame or two before its drawing lands.
 */

/** What a door's icon shows: the marked room behind it, or the zone gate. */
export type DoorIcon = "start" | "elite" | "weapon" | "spring" | "cache" | "gate" | `boss-${ZoneId}`

export interface RoomKit {
  readonly icons: Readonly<Record<DoorIcon, Texture>>
  /** A weapon's kanji in a thin ring, paper white on clear. */
  readonly kanji: Readonly<Record<WeaponId, Texture>>
  /** A weapon's first move drawn in ink on clear, for an altar's face. */
  readonly moves: Readonly<Record<WeaponId, Texture>>
  /** The ward a locked door casts on the floor before it: a ring of ticks round a clear middle, white with an ink rim. */
  readonly ward: Texture
  /** A thick dry-brush stroke in ink, ragged at both ends, on clear. */
  readonly stroke: Texture
  /** A thin white ring for the spring's ripples, a soft white disc for its pool, and the dry ink ring it leaves spent. */
  readonly ripple: Texture
  readonly pool: Texture
  readonly dry: Texture
  /** A white starburst of uneven rays, for a spring rising. */
  readonly burst: Texture
  /** A clear's drops, paper with an ink rim: the diamond (one diamond back) and FOCUS's four-point spark. */
  readonly drops: Readonly<Record<DropKind, Texture>>
  /** A tall soft white blade of light, brightest at its foot, for the gate's glare. */
  readonly glare: Texture
  /** A soft white fan of light spilling from a doorway at the drawing's foot, fading out at its sides and far end. */
  readonly fan: Texture
  /** Thin white streaks spreading through the fan from the same foot. */
  readonly rays: Texture
  /** Two paper chevrons with an ink rim pointing down the drawing, the near one bolder: an open door's way out. */
  readonly chevron: Texture
  /** A Spiral dial face (a pale plate, its rings and hour marks in ink) and its hand, an ink needle from the middle up. */
  readonly dial: { readonly face: Texture; readonly hand: Texture }
  /** A jagged rift down the drawing, white: its soft glow and its thin bright core, for the Void's seams of light. */
  readonly rift: { readonly glow: Texture; readonly core: Texture }
  /** A plain mid grey, the floor's stand-in while its drawing lands. */
  readonly grey: Texture
  /** Every texture above, for loading to hand to the GPU. */
  readonly all: ReadonlyArray<Texture>
  destroy(): void
}

const svg = (box: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${body}</svg>`

/** Icons in the UI's 1px line style, on a 64 box: paper lines with an ink rim so they read on any floor. */
const icon = (body: string) => svg(64, `<g fill="none" stroke-linejoin="round" stroke-linecap="round"><g stroke="#0d0d0f" stroke-width="7" stroke-opacity="0.85">${body}</g><g stroke="#ffffff" stroke-width="3.2">${body}</g></g>`)

const ICONS: Readonly<Record<DoorIcon, string>> = {
  start: icon(`<circle cx="32" cy="32" r="22"/><path d="M23 46 V31 Q32 20 41 31 V46"/>`),
  elite: icon(`<path d="M12 46 L18 28 L24 46 Z M26 46 L32 20 L38 46 Z M40 46 L46 28 L52 46 Z"/><path d="M10 52 H54"/>`),
  weapon: icon(`<rect x="18" y="38" width="28" height="14"/><path d="M32 12 L40 22 L32 32 L24 22 Z"/>`),
  spring: icon(`<circle cx="32" cy="32" r="18"/><circle cx="32" cy="32" r="3" fill="#ffffff"/>`),
  cache: icon(`<path d="M32 8 L37.5 26.5 L56 32 L37.5 37.5 L32 56 L26.5 37.5 L8 32 L26.5 26.5 Z"/><path d="M32 26 L38 32 L32 38 L26 32 Z" fill="#ffffff"/>`),
  gate: icon(`<path d="M16 54 V22 Q32 6 48 22 V54"/><path d="M32 46 V24 M24 32 L32 24 L40 32"/>`),
  "boss-courtyard": icon(`<rect x="18" y="30" width="28" height="22"/><path d="M32 8 L40 18 L32 28 L24 18 Z"/><path d="M10 40 L18 30 V46 Z M54 40 L46 30 V46 Z"/>`),
  "boss-spiral": icon(`<circle cx="32" cy="32" r="8"/><ellipse cx="32" cy="32" rx="22" ry="10" transform="rotate(-20 32 32)"/><circle cx="52" cy="25" r="3.5"/>`),
  "boss-void": icon(`<path d="M32 10 L51 21 L51 43 L32 54 L13 43 L13 21 Z"/><path d="M8 42 L56 22"/>`)
}

/** Each weapon's first move in ink on a 128 box: the blade's crescent, the breaker's ringed mark, a dart's needle, a sigil's seal. */
const MOVES: Readonly<Record<WeaponId, string>> = {
  blade: `<path d="M18 86 Q60 20 112 40 Q66 38 30 92 Z" fill="#141417"/><path d="M26 84 Q62 32 104 42" stroke="#141417" stroke-width="2" fill="none" stroke-dasharray="6 4"/>`,
  breaker: `<circle cx="64" cy="64" r="34" fill="none" stroke="#141417" stroke-width="6"/><path d="M64 18 V36 M64 92 V110 M18 64 H36 M92 64 H110" stroke="#141417" stroke-width="6" stroke-linecap="round"/><circle cx="64" cy="64" r="8" fill="#141417"/>`,
  darts: `<path d="M14 92 L104 36 L112 32 L108 40 L18 96 Z" fill="#141417"/><path d="M22 100 L8 104 M28 106 L20 118" stroke="#141417" stroke-width="4" stroke-linecap="round"/><circle cx="40" cy="78" r="3" fill="#141417"/><circle cx="30" cy="84" r="2.4" fill="#141417"/>`,
  sigil: `<rect x="30" y="30" width="68" height="68" fill="none" stroke="#141417" stroke-width="6" transform="rotate(3 64 64)"/><circle cx="64" cy="64" r="20" fill="none" stroke="#141417" stroke-width="5"/><path d="M64 36 V92 M36 64 H92" stroke="#141417" stroke-width="4"/>`
}

const STROKE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256">
  <defs>
    <filter id="dry" x="-5%" y="-20%" width="110%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.32" numOctaves="3" seed="4" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 3.2 0 0 -1.2" result="bristles"/>
      <feComposite in="SourceGraphic" in2="bristles" operator="in" result="dry"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="9" result="edge"/>
      <feDisplacementMap in="dry" in2="edge" scale="14" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
  <g filter="url(#dry)" fill="#0d0d0f">
    <path d="M22 132 C70 70 180 58 300 62 C400 66 470 86 498 118 C470 166 380 196 270 194 C150 192 60 186 22 132 Z"/>
    <path d="M10 140 C40 120 60 126 84 132 C60 150 30 154 10 140 Z"/>
  </g>
  <g fill="#0d0d0f">
    <circle cx="486" cy="168" r="7"/><circle cx="500" cy="152" r="4"/><circle cx="470" cy="190" r="5"/><circle cx="24" cy="98" r="5"/><circle cx="12" cy="112" r="3"/>
  </g>
</svg>`

const WARD = (() => {
  const ticks = Array.from({ length: 16 }, (_, index) => {
    const angle = (index / 16) * Math.PI * 2
    const inner = index % 4 === 0 ? 46 : 52
    return `M${(64 + Math.cos(angle) * inner).toFixed(2)} ${(64 + Math.sin(angle) * inner).toFixed(2)} L${(64 + Math.cos(angle) * 58).toFixed(2)} ${(64 + Math.sin(angle) * 58).toFixed(2)}`
  }).join(" ")
  const body = `<circle cx="64" cy="64" r="58"/><circle cx="64" cy="64" r="40" stroke-dasharray="7 5"/><path d="${ticks}"/>`
  return svg(128, `<g fill="none" stroke-linecap="round"><g stroke="#0d0d0f" stroke-width="6" stroke-opacity="0.7">${body}</g><g stroke="#ffffff" stroke-width="2.6">${body}</g></g>`)
})()

const RIPPLE = svg(128, `<circle cx="64" cy="64" r="56" fill="none" stroke="#ffffff" stroke-width="4"/>`)
const POOL = svg(128, `<defs><radialGradient id="p"><stop offset="0" stop-color="#fff"/><stop offset="0.72" stop-color="#fff" stop-opacity="0.92"/><stop offset="0.86" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><circle cx="64" cy="64" r="64" fill="url(#p)"/>`)
const DRY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><filter id="d"><feTurbulence type="fractalNoise" baseFrequency="0.4 0.04" numOctaves="2" seed="3"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 2.6 0 0 -0.9"/><feComposite in="SourceGraphic" operator="in"/></filter></defs><circle cx="64" cy="64" r="54" fill="none" stroke="#0d0d0f" stroke-width="9" filter="url(#d)"/><circle cx="64" cy="64" r="46" fill="#0d0d0f" fill-opacity="0.35"/></svg>`
const BURST = (() => {
  const rays = 16
  const points = Array.from({ length: rays * 2 }, (_, index) => {
    const angle = (index / (rays * 2)) * Math.PI * 2
    const reach = index % 2 === 1 ? 20 : 44 + ((index * 37) % 11) * 1.8
    return `${(64 + Math.cos(angle) * reach).toFixed(2)},${(64 + Math.sin(angle) * reach).toFixed(2)}`
  }).join(" ")
  return svg(128, `<polygon points="${points}" fill="#ffffff"/>`)
})()
const DROPS: Readonly<Record<DropKind, string>> = {
  diamond: svg(64, `<path d="M32 5 L53 32 L32 59 L11 32 Z" fill="#ffffff" stroke="#0d0d0f" stroke-width="5" stroke-linejoin="round"/><path d="M11 32 H53 M32 5 L25 32 L32 59" fill="none" stroke="#0d0d0f" stroke-width="1.6" stroke-opacity="0.4"/>`),
  focus: svg(64, `<path d="M32 4 L38 26 L60 32 L38 38 L32 60 L26 38 L4 32 L26 26 Z" fill="#ffffff" stroke="#0d0d0f" stroke-width="4.5" stroke-linejoin="round"/><path d="M32 25 L39 32 L32 39 L25 32 Z" fill="#0d0d0f" fill-opacity="0.55"/>`)
}
const GLARE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 256"><defs><linearGradient id="v" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.25" stop-color="#fff"/><stop offset="0.75" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="m"><rect width="64" height="256" fill="url(#h)"/></mask></defs><rect width="64" height="256" fill="url(#v)" mask="url(#m)"/></svg>`

const FAN = svg(256, `<defs><linearGradient id="l" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="0.4" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="13"/></filter></defs><path d="M80 236 L176 236 L232 26 L24 26 Z" fill="url(#l)" filter="url(#b)"/>`)
const RAYS = (() => {
  const lines = [-0.62, -0.3, -0.08, 0.17, 0.44, 0.7].map((spread, index) => {
    const foot = 128 + spread * 64
    const end = 128 + spread * 160
    return `<path d="M${foot.toFixed(1)} 238 L${end.toFixed(1)} ${(40 + (index % 3) * 30).toFixed(1)}" stroke-width="${index % 2 === 0 ? 2.6 : 1.6}"/>`
  }).join("")
  return svg(256, `<defs><linearGradient id="r" gradientUnits="userSpaceOnUse" x1="0" y1="238" x2="0" y2="30"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><filter id="s" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.4"/></filter></defs><g stroke="url(#r)" stroke-linecap="round" fill="none" filter="url(#s)">${lines}</g>`)
})()
const CHEVRON = (() => {
  const near = "M14 62 L64 104 L114 62 L114 80 L64 120 L14 80 Z"
  const far = "M22 16 L64 52 L106 16 L106 30 L64 64 L22 30 Z"
  return svg(128, `<g stroke="#0d0d0f" stroke-width="9" stroke-linejoin="round" stroke-opacity="0.7" fill="#0d0d0f" fill-opacity="0.7"><path d="${near}"/><path d="${far}"/></g><g fill="#ffffff"><path d="${near}"/><path d="${far}" fill-opacity="0.6"/></g>`)
})()

const DIAL_FACE = (() => {
  const marks = Array.from({ length: 12 }, (_, hour) => {
    const angle = (hour / 12) * Math.PI * 2
    const long = hour % 3 === 0
    const inner = long ? 88 : 98
    const point = (reach: number) => `${(128 + Math.sin(angle) * reach).toFixed(1)} ${(128 - Math.cos(angle) * reach).toFixed(1)}`
    return `<path d="M${point(inner)} L${point(112)}" stroke-width="${long ? 9 : 4}"/>`
  }).join("")
  return svg(256, `<circle cx="128" cy="128" r="124" fill="#ffffff"/><g fill="none" stroke="#0d0d0f" stroke-linecap="round"><circle cx="128" cy="128" r="118" stroke-width="6"/><circle cx="128" cy="128" r="76" stroke-width="2.5" stroke-dasharray="5 7"/><circle cx="128" cy="128" r="44" stroke-width="3"/>${marks}</g><path d="M128 4 L136 20 L120 20 Z" fill="#0d0d0f"/>`)
})()
const DIAL_HAND = svg(256, `<path d="M124 128 L128 34 L132 128 Z" fill="#0d0d0f"/><circle cx="128" cy="128" r="11" fill="#0d0d0f"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`)

/** The rift's jagged line down a 64 by 512 box, from a fixed walk across its middle. */
const RIFT_PATH = (() => {
  const steps = 22
  const points = Array.from({ length: steps + 1 }, (_, index) => {
    const y = 16 + (index / steps) * 480
    const swing = Math.sin(index * 2.3) * 9 + Math.sin(index * 5.1) * 5
    return `${(32 + swing * Math.sin((index / steps) * Math.PI)).toFixed(1)} ${y.toFixed(1)}`
  })
  return `M${points.join(" L")}`
})()
const RIFT_FADE = `<linearGradient id="f" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="512"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.2" stop-color="#fff"/><stop offset="0.75" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
const RIFT_GLOW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 512"><defs>${RIFT_FADE}<filter id="b" x="-60%" y="-10%" width="220%" height="120%"><feGaussianBlur stdDeviation="7"/></filter></defs><path d="${RIFT_PATH}" fill="none" stroke="url(#f)" stroke-width="14" stroke-linejoin="round" filter="url(#b)"/></svg>`
const RIFT_CORE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 512"><defs>${RIFT_FADE}</defs><path d="${RIFT_PATH}" fill="none" stroke="url(#f)" stroke-width="3" stroke-linejoin="round"/></svg>`

const KANJI_FONT = '"Yuji Boku", "Hiragino Mincho ProN", "Yu Mincho", serif'
const FONT_WAIT = 2500

/** A weapon's kanji brush-lettered in paper white inside a thin ring, from the UI's brush face once it has loaded. */
const kanjiTextures = async (size: number): Promise<Readonly<Record<WeaponId, Texture>>> => {
  const font = `${Math.round(size * 0.5)}px ${KANJI_FONT}`
  await Promise.race([document.fonts.load(font, "刃砕矢印").catch(() => []), new Promise((resolve) => window.setTimeout(resolve, FONT_WAIT))])
  const make = (weapon: WeaponId): Texture => {
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext("2d")
    if (context === null) return Texture.WHITE
    context.strokeStyle = "#ffffff"
    context.lineWidth = size * 0.022
    context.beginPath()
    context.arc(size / 2, size / 2, size * 0.44, 0, Math.PI * 2)
    context.stroke()
    context.font = font
    context.textAlign = "center"
    context.textBaseline = "middle"
    context.fillStyle = "#ffffff"
    context.fillText(WEAPONS[weapon].kanji, size / 2, size * 0.53)
    const texture = Texture.from(canvas)
    texture.label = `altar-${weapon}`
    texture.source.autoGenerateMipmaps = true
    texture.source.updateMipmaps()
    return texture
  }
  return { blade: make("blade"), breaker: make("breaker"), darts: make("darts"), sigil: make("sigil") }
}

export const loadRoomKit = async (): Promise<RoomKit> => {
  const iconNames = Object.keys(ICONS) as Array<DoorIcon>
  const [icons, moves, rest, kanji, drops] = await Promise.all([
    svgTextures(Object.fromEntries(iconNames.map((name): [DoorIcon, SvgEntry] => [name, [ICONS[name], { width: 128, mipmaps: true, label: `door-${name}` }]])) as Record<DoorIcon, SvgEntry>),
    svgTextures(Object.fromEntries(weaponIds.map((weapon): [WeaponId, SvgEntry] => [weapon, [svg(128, MOVES[weapon]), { width: 256, mipmaps: true, label: `altar-move-${weapon}` }]])) as Record<WeaponId, SvgEntry>),
    svgTextures({
      ward: [WARD, { width: 256, mipmaps: true, label: "door-ward" }],
      stroke: [STROKE, { width: 512, height: 256, mipmaps: true, label: "seal-stroke" }],
      ripple: [RIPPLE, { width: 256, mipmaps: true, label: "spring-ripple" }],
      pool: [POOL, { width: 256, label: "spring-pool" }],
      dry: [DRY, { width: 256, mipmaps: true, label: "spring-dry" }],
      burst: [BURST, { width: 256, mipmaps: true, label: "spring-burst" }],
      glare: [GLARE, { width: 64, height: 256, label: "gate-glare" }],
      fan: [FAN, { width: 256, label: "door-fan" }],
      rays: [RAYS, { width: 256, mipmaps: true, label: "door-rays" }],
      chevron: [CHEVRON, { width: 128, mipmaps: true, label: "door-chevron" }],
      dialFace: [DIAL_FACE, { width: 256, mipmaps: true, label: "dial-face" }],
      dialHand: [DIAL_HAND, { width: 256, mipmaps: true, label: "dial-hand" }],
      riftGlow: [RIFT_GLOW, { width: 64, height: 512, label: "rift-glow" }],
      riftCore: [RIFT_CORE, { width: 64, height: 512, mipmaps: true, label: "rift-core" }],
      grey: [svg(4, `<rect width="4" height="4" fill="#626268"/>`), { width: 4, label: "floor-standin" }]
    }),
    kanjiTextures(256),
    svgTextures({
      diamond: [DROPS.diamond, { width: 128, mipmaps: true, label: "drop-diamond" }],
      focus: [DROPS.focus, { width: 128, mipmaps: true, label: "drop-focus" }]
    })
  ])
  const { riftGlow, riftCore, dialFace, dialHand, ...shared } = rest
  const all = [...Object.values(icons), ...Object.values(moves), ...Object.values(rest), ...Object.values(kanji), ...Object.values(drops)]
  return {
    icons,
    kanji,
    moves,
    drops,
    ...shared,
    rift: { glow: riftGlow, core: riftCore },
    dial: { face: dialFace, hand: dialHand },
    all,
    destroy: () => {
      for (const texture of all) texture.destroy(true)
    }
  }
}
