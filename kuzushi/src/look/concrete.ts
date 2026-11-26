import { mulberry32 } from "math/random"

/**
 * A seamless tile of concrete grain, mid grey on average, that the ink material maps over every surface in world
 * space: stitched fractal noise, air pits with a lit lip, aggregate specks and fine paper tooth.
 */
export const CONCRETE_SIZE = 512

const fixed = (value: number) => value.toFixed(2)

/** Draws `shape(x, y)` and its copies across the tile's edges, so features that cross an edge tile cleanly. */
const wrapped = (x: number, y: number, reach: number, shape: (x: number, y: number) => string): string => {
  const copies: Array<string> = []
  for (const dx of [-CONCRETE_SIZE, 0, CONCRETE_SIZE]) {
    for (const dy of [-CONCRETE_SIZE, 0, CONCRETE_SIZE]) {
      const cx = x + dx
      const cy = y + dy
      if (cx > -reach && cx < CONCRETE_SIZE + reach && cy > -reach && cy < CONCRETE_SIZE + reach) copies.push(shape(cx, cy))
    }
  }
  return copies.join("")
}

export const concreteSvg = (): string => {
  const random = mulberry32.create(0xc0c0)
  const next = () => mulberry32.sample(random)
  const pits = Array.from({ length: 46 }, () => {
    const r = 1.2 + next() * next() * 5
    return wrapped(next() * CONCRETE_SIZE, next() * CONCRETE_SIZE, r * 2, (x, y) =>
      `<circle cx="${fixed(x + r * 0.35)}" cy="${fixed(y + r * 0.35)}" r="${fixed(r)}" fill="#c4c4c4" fill-opacity="0.5"/><circle cx="${fixed(x)}" cy="${fixed(y)}" r="${fixed(r)}" fill="#333333" fill-opacity="0.6"/>`)
  }).join("")
  const specks = Array.from({ length: 260 }, () => {
    const r = 0.6 + next() * 1.8
    const shade = next() < 0.5 ? "#e6e6e6" : "#3a3a3a"
    const opacity = fixed(0.25 + next() * 0.4)
    return wrapped(next() * CONCRETE_SIZE, next() * CONCRETE_SIZE, r * 2, (x, y) => `<circle cx="${fixed(x)}" cy="${fixed(y)}" r="${fixed(r)}" fill="${shade}" fill-opacity="${opacity}"/>`)
  }).join("")
  const box = `x="0" y="0" width="${CONCRETE_SIZE}" height="${CONCRETE_SIZE}"`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CONCRETE_SIZE} ${CONCRETE_SIZE}">
  <defs>
    <filter id="cloud" filterUnits="userSpaceOnUse" ${box}>
      <feTurbulence type="fractalNoise" baseFrequency="0.0078125" numOctaves="5" seed="3" stitchTiles="stitch"/>
      <feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1"/>
      <feComponentTransfer><feFuncR type="linear" slope="1.15" intercept="-0.075"/><feFuncG type="linear" slope="1.15" intercept="-0.075"/><feFuncB type="linear" slope="1.15" intercept="-0.075"/></feComponentTransfer>
    </filter>
    <filter id="tooth" filterUnits="userSpaceOnUse" ${box}>
      <feTurbulence type="fractalNoise" baseFrequency="0.25" numOctaves="2" seed="9" stitchTiles="stitch"/>
      <feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1"/>
    </filter>
  </defs>
  <rect ${box} filter="url(#cloud)"/>
  <rect ${box} filter="url(#tooth)" opacity="0.35"/>
  ${pits}
  ${specks}
</svg>`
}
