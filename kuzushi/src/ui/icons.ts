import type { EnemyKind } from "../sim/index.ts"

/** The board's legend shapes and the later enemies' silhouettes, as outline or solid icons in a 24-unit box. */
export type Shape =
  | "diamond" | "circle" | "triangle" | "square" | "ring" | "eye" | "needle" | "hexagon" | "smallHexagon"
  | "hand" | "cog" | "cross" | "slant" | "crest" | "orbit" | "seam"

const hexagonPath = (radius: number) =>
  `${Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i + Math.PI / 6
    return `${i === 0 ? "M" : "L"}${(12 + Math.cos(angle) * radius).toFixed(2)} ${(12 + Math.sin(angle) * radius).toFixed(2)}`
  }).join("")}Z`

const hexagon = (radius: number) => `<path d="${hexagonPath(radius)}"/>`

const cog = Array.from({ length: 8 }, (_, tooth) => {
  const at = (tooth / 8) * Math.PI * 2
  const step = Math.PI / 8
  return [[at - step * 0.55, 7.6], [at - step * 0.35, 10], [at + step * 0.35, 10], [at + step * 0.55, 7.6]] as const
}).flat().map(([angle, reach], index) => `${index === 0 ? "M" : "L"}${(12 + Math.cos(angle) * reach).toFixed(2)} ${(12 + Math.sin(angle) * reach).toFixed(2)}`).join("")

const paths: Record<Shape, string> = {
  diamond: `<path d="M12 2.5 21.5 12 12 21.5 2.5 12Z"/>`,
  circle: `<circle cx="12" cy="12" r="9"/>`,
  triangle: `<path d="M12 3 21.5 20H2.5Z"/>`,
  square: `<rect x="3.5" y="3.5" width="17" height="17"/>`,
  ring: `<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 0 0 19a9.5 9.5 0 1 0 0-19ZM12 7.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9Z"/>`,
  eye: `<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20ZM12 6.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11Z"/><circle cx="12" cy="12" r="2.8"/>`,
  needle: `<path d="M22 2 16.43 13.23 9.8 19 2 22 5 14.2 10.77 7.57Z"/>`,
  hexagon: hexagon(9.5),
  smallHexagon: hexagon(6),
  hand: `<circle cx="7" cy="12" r="4.2"/><path d="M7 9.4 22 12 7 14.6Z"/>`,
  cog: `<path fill-rule="evenodd" d="${cog}ZM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z"/>`,
  cross: `<path d="M9 2.5h6v6.5h6.5v6H15v6.5H9V15H2.5V9H9Z"/>`,
  slant: `<path d="M8.5 7.5H22l-6.5 9H2Z"/>`,
  crest: `<path fill-rule="evenodd" d="M2.5 2.5h19v19h-19ZM12 6.5 17.5 12 12 17.5 6.5 12Z"/>`,
  orbit: `<path fill-rule="evenodd" d="M12 1.5a10.5 10.5 0 1 0 0 21a10.5 10.5 0 1 0 0-21ZM12 3.6a8.4 8.4 0 1 1 0 16.8a8.4 8.4 0 1 1 0-16.8Z"/><circle cx="12" cy="12" r="5"/>`,
  seam: `<path fill-rule="evenodd" d="${hexagonPath(10)}M8.4 5.5 9.6 4.8 15.6 18.5 14.4 19.2Z"/>`
}

/** A shape's SVG markup in its 24-unit box, drawn in Pixi through kit/icon's contexts. */
export const shapeMarkup = (shape: Shape): string => paths[shape]

export const enemyShape = {
  chaser: "circle",
  shooter: "triangle",
  bruiser: "square",
  trickster: "diamond",
  orbiter: "ring",
  warden: "eye",
  lancer: "needle",
  splitter: "hexagon",
  splitling: "smallHexagon",
  sweeper: "hand",
  pulsar: "cog",
  leaper: "cross",
  cutter: "slant",
  gatekeeper: "crest",
  orrery: "orbit",
  sunder: "seam"
} as const satisfies Record<EnemyKind, Shape>
