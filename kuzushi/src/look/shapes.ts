import { DASH_NOTCH, NOTCH } from "../art/arrowhead.ts"
import { Tuning } from "../sim/index.ts"
import type { EnemyKind } from "../sim/index.ts"
import { arrowheadOutline, circle, polygon, rhombus } from "./geometry.ts"
import type { Point } from "./geometry.ts"

/**
 * Each body's outline on the ground (pointing +x, facing 0), the half size of the square its art covers, its height,
 * and how far its ink rim reaches past it.
 */
export interface Shape {
  readonly outline: ReadonlyArray<Point>
  readonly extent: number
  readonly height: number
  readonly rim: number
}

const square = (half: number): ReadonlyArray<Point> => [[half, half], [-half, half], [-half, -half], [half, -half]]

/** How far the ink rim reaches past each body. */
export const RIM = 0.055

const extentOf = (outline: ReadonlyArray<Point>) => Math.max(...outline.map(([x, z]) => Math.max(Math.abs(x), Math.abs(z))))

const shape = (outline: ReadonlyArray<Point>, height: number, rim = RIM, extent = extentOf(outline)): Shape => ({ outline, extent, height, rim })

/**
 * The lancer: a needle 1.3 long and 0.3 wide, tapering to a point at both ends, widest just behind its tip. Its rim
 * is thinner than the rest, so the ink never outweighs the red on so narrow a body.
 */
const needle = (r: number): ReadonlyArray<Point> => [[r * 2.29, 0], [r * 0.71, r * 0.43], [r * -0.43, r * 0.37], [r * -1.43, 0], [r * -0.43, r * -0.37], [r * 0.71, r * -0.43]]

/** `count` points on an arc of radius `r` about the origin, from `from` to `to` radians. */
const arcPoints = (r: number, from: number, to: number, count: number): ReadonlyArray<Point> =>
  Array.from({ length: count }, (_, index): Point => {
    const angle = from + ((to - from) * index) / (count - 1)
    return [Math.cos(angle) * r, Math.sin(angle) * r]
  })

/** The sweeper: a clock hand, its pivot disc where it stands and a tapered arm 2.5 radii long. */
const hand = (r: number): ReadonlyArray<Point> =>
  [[r * 2.5, 0], [r * 0.7, r * 0.26], ...arcPoints(r * 0.84, 0.4, Math.PI * 2 - 0.4, 18), [r * 0.7, r * -0.26]]

/** The pulsar: a cog of eight teeth. */
const cog = (r: number): ReadonlyArray<Point> =>
  Array.from({ length: 8 }, (_, tooth) => {
    const at = (tooth / 8) * Math.PI * 2
    const step = Math.PI / 8
    return [[at - step * 0.55, r * 0.76], [at - step * 0.35, r], [at + step * 0.35, r], [at + step * 0.55, r * 0.76]] as const
  }).flat().map(([angle, reach]): Point => [Math.cos(angle) * reach, Math.sin(angle) * reach])

/** The leaper: a cross with arms of equal length. */
const cross = (r: number): ReadonlyArray<Point> => {
  const [arm, half] = [r * 1.15, r * 0.36]
  return [[arm, half], [half, half], [half, arm], [-half, arm], [-half, half], [-arm, half], [-arm, -half], [-half, -half], [-half, -arm], [half, -arm], [half, -half], [arm, -half]]
}

/** The cutter: a bar slanted at both ends, like a cut. */
const slant = (r: number): ReadonlyArray<Point> => [[r * 1.93, r * -0.38], [r * 1.18, r * 0.38], [r * -1.93, r * 0.38], [r * -1.18, r * -0.38]]

const radius = (kind: EnemyKind) => Tuning.ENEMY[kind].radius

export const PLAYER_SIZE = Tuning.PLAYER.radius
export const PLAYER_RIDGE = 0.07

/** The notch of each drawing the player's body steps through into a dash, from rest to the dart. */
export const DASH_KEYS: ReadonlyArray<number> = Array.from({ length: 5 }, (_, index) => NOTCH + ((DASH_NOTCH - NOTCH) * index) / 4)

export const SHAPES: Readonly<Record<EnemyKind | "player", Shape>> = {
  chaser: shape(circle(radius("chaser")), 0.3),
  shooter: shape(polygon(radius("shooter") * 1.32, 3), 0.3),
  bruiser: shape(square(radius("bruiser") * 0.96), 0.4),
  trickster: shape(rhombus(radius("trickster") * 2.8, radius("trickster") * 3.1), 0.28),
  orbiter: shape(circle(radius("orbiter")), 0.24),
  warden: shape(circle(radius("warden"), 56), 0.42),
  lancer: shape(needle(radius("lancer")), 0.26, 0.026),
  splitter: shape(polygon(radius("splitter") * 1.08, 6), 0.32),
  splitling: shape(polygon(radius("splitling") * 1.1, 6), 0.24),
  sweeper: shape(hand(radius("sweeper")), 0.26),
  pulsar: shape(cog(radius("pulsar")), 0.3),
  leaper: shape(cross(radius("leaper")), 0.28),
  cutter: shape(slant(radius("cutter")), 0.22),
  gatekeeper: shape(square(radius("gatekeeper") * 0.88), 0.9),
  orrery: shape(circle(radius("orrery"), 64), 0.7),
  sunder: shape(polygon(radius("sunder") * 1.05, 6), 0.8),
  // Its art covers the dart's longer back too, so every drawing of the dash maps its top the same way.
  player: shape(arrowheadOutline(PLAYER_SIZE), 0.18, RIM, Math.max(...DASH_KEYS.map((notch) => extentOf(arrowheadOutline(PLAYER_SIZE, notch)))))
}

/** The orbiter is a ring: its hole's radius. */
export const ORBITER_HOLE = radius("orbiter") * 0.52

/**
 * The warden is an eye in a broken shell: a core disc, and plates round it that close while it fires and open
 * after. Radii and the plates' share of each sixth of the circle.
 */
export const WARDEN_PARTS = { core: radius("warden") * 0.66, inner: radius("warden") * 0.76, outer: radius("warden"), plates: 6, span: 0.78, height: 0.5 } as const

/** Bodies that keep one orientation on screen whatever their facing, as the trickster's diamond does. */
export const FIXED: ReadonlySet<EnemyKind | "player"> = new Set(["trickster"])

