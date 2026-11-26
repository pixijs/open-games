import type { Vec3 } from "math"

import type { TitleShot } from "../camera/index.ts"
import { titlePan, titleShotAt } from "../camera/title-pan.ts"

/**
 * Where the title's key art stands in the courtyard, in ground units, and the designed shots that film it. The
 * hero rests in the floor's centre circle; the ring of shapes closes on it from `RING.wide` to `RING.close`; the
 * clash dash runs `DASH` units east through the ring, a little south of east (`side` 1) or north of it (-1),
 * alternating every loop, so the ring stays between the menu and the hero.
 */
export const HERO = { x: 0, z: 0.5 } as const

/**
 * The ring's radius as it re-forms and when it has closed in, and where its first shape stands (radians): turned so
 * the hero shot's lens falls between two shapes.
 */
export const RING = { wide: 6.2, close: 4.1, turn: 1.63 } as const
export const DASH = 6.8

/** Shape `index` of `count` round the ring: its angle round the hero (radians), and how far its radius leans off the ring's. */
export const ringPlace = (index: number, count: number): { readonly angle: number; readonly lean: number } => ({
  angle: (index / count) * Math.PI * 2 + RING.turn,
  lean: ((index * 7) % 5) * 0.18 - 0.36
})

/**
 * Which way the sun lies from the hero on the ground: due south, where the courtyard's backdrop is kept low, so from
 * the hero shot's lens it rises whole over the south wall with the low spires dark across its foot.
 */
const SUN_BEARING = { x: 0, z: 1 } as const

/** How far behind the hero, away from the sun, the hero shot's lens stands, and how high: clear of the low wall at (-3, -10). */
const HERO_LENS = { back: 7, height: 0.6 } as const

/**
 * The hero's pose in the hero shot: stood up on its tail with its face to the lens, as the board's key art draws it,
 * this much larger than in play, leaning `lean` and turned `turn` (radians) off square so it stands in the scene as a
 * figure, its edge lit red `backlight` units wide by the sun behind it.
 */
export const STAND = { scale: 1.2, lean: 0.21, turn: 0.32, backlight: 0.08 } as const

/** The red sun, low behind the courtyard on that bearing: centre and the size of its square (the disc is 0.31 of it). */
export const SUN = { x: HERO.x + SUN_BEARING.x * 96, y: 15, z: HERO.z + SUN_BEARING.z * 96, size: 50 } as const

/** The sun's bearing on the ground, simulation radians: the hero faces it to stand with its face to the hero shot's lens. */
export const SUN_FACING = Math.atan2(SUN_BEARING.z, SUN_BEARING.x)

/**
 * How far right of centre the subject sits, as a share of the half-width: the middle of the scene's half, clear of the
 * title's menu column, where it holds still under an open panel's sheet.
 */
export const FRAMING = { menu: 0.5, panel: 0.5 } as const

/** Which of the title's designed shots this is: the hero shot holds the hero's standing pose. */
type ShotKind = "hero" | "wide" | "clash" | "launch"

export interface Shot extends TitleShot {
  readonly kind: ShotKind
}

/** The dash's direction on the ground (simulation radians) for `side`. */
export const dashAngle = (side: 1 | -1): number => side * 0.3

const at = (x: number, y: number, z: number): Vec3 => [HERO.x + x, y, HERO.z + z]

/** A point `back` units from the hero away from the sun, `y` high. */
const behind = (back: number, y: number): Vec3 => [HERO.x - SUN_BEARING.x * back, y, HERO.z - SUN_BEARING.z * back]

/**
 * Low behind the hero, looking past it at the sun: the hero stands with its head inside the red disc, a monolith and
 * a pillar dark either side, the ring small beyond. Nothing of the courtyard stands within 3 units in front of the lens.
 */
export const heroShot = (): Shot => ({
  kind: "hero",
  from: behind(HERO_LENS.back, HERO_LENS.height),
  to: behind(HERO_LENS.back - 0.6, HERO_LENS.height - 0.05),
  lookFrom: behind(-20, 3.2),
  lookTo: behind(-20, 3),
  fov: 36,
  seconds: 3.2,
  roll: -2
})

/** High over the courtyard's south, looking down on the ring closing in, as the board's main frame does. */
export const wideShot = (): Shot => ({
  kind: "wide",
  from: at(5.5, 18, 14),
  to: at(4.8, 16.6, 12.8),
  lookFrom: at(0, 0, 0.2),
  lookTo: at(0, 0, 0.2),
  fov: 40,
  seconds: 2.4,
  roll: 0
})

/**
 * From the south, about 35° down and rolled, on the middle of the dash: the ring bursting on the left, the hero where
 * the dash ends on the right, seen from high enough that its arrowhead reads as a shape.
 */
export const clashShot = (side: 1 | -1): Shot => {
  const angle = dashAngle(side)
  const x = HERO.x + Math.cos(angle) * DASH * 0.5
  const z = HERO.z + Math.sin(angle) * DASH * 0.5
  return {
    kind: "clash",
    from: [x + 1.2, 6.2, z + 8.6],
    to: [x + 1, 5.7, z + 7.8],
    lookFrom: [x + 0.8, 0.4, z],
    lookTo: [x + 0.9, 0.4, z],
    fov: 44,
    seconds: 1.8,
    roll: 5 * side
  }
}

/**
 * In front of the hero facing `facing`, high enough that the arrowhead reads as a chevron coming on: it dashes
 * straight at the lens when a zone is chosen.
 */
export const launchShot = (facing: number): Shot => {
  const x = HERO.x + Math.cos(facing) * 6
  const z = HERO.z + Math.sin(facing) * 6
  return {
    kind: "launch",
    from: [x, 2, z],
    to: [x, 1.9, z],
    lookFrom: [HERO.x, 0.3, HERO.z],
    lookTo: [HERO.x, 0.3, HERO.z],
    fov: 48,
    seconds: 1,
    roll: 0
  }
}

/** Nearer the lens than this, a shape of the ring fills the shot as a blur: it is left out. */
const NEAR_LENS = 3.2
/** Seen less than this far above edge-on (radians), a flat shape of the ring reads as a slab: it is left out. */
const GRAZING = (10 * Math.PI) / 180
/** Where the title's menu column ends, as a share of the screen's width from the left edge. */
export const MENU_COLUMN = 0.49

const _lens: Vec3 = [0, 0, 0]
const _look: Vec3 = [0, 0, 0]

/**
 * Whether ground point (x, z) should be left out of `shot` at `time` seconds into it, with the subject `side` of the
 * half-width right of centre on a screen `aspect` wide: within `NEAR_LENS` of the lens, seen nearly edge-on, behind
 * it, or left of `column` (a share of the screen's width: the menu's column). The lens moves as the rig moves it (an ease-out from `from` to `to`), so the answer
 * holds for the frame on screen.
 */
export const outOfShot = (shot: Shot, time: number, side: number, aspect: number, x: number, z: number, column = MENU_COLUMN): boolean => {
  titleShotAt(shot, time, _lens, _look)
  const [lx, ly, lz] = _lens
  const tan = Math.tan((shot.fov * Math.PI) / 360)
  const pan = titlePan(side, shot.fov, aspect, _lens, _look)
  const ax = _look[0] - lx
  const az = _look[2] - lz
  const fx = ax * Math.cos(pan) + az * Math.sin(pan)
  const fz = -ax * Math.sin(pan) + az * Math.cos(pan)
  const fy = _look[1] - ly
  const length = Math.hypot(fx, fy, fz) || 1
  const vx = x - lx
  const vy = 0.2 - ly
  const vz = z - lz
  if (Math.hypot(vx, vy, vz) < NEAR_LENS || Math.atan2(-vy, Math.hypot(vx, vz)) < GRAZING) return true
  const depth = (vx * fx + vy * fy + vz * fz) / length
  if (depth <= 0.1) return true
  const right = (vx * -fz + vz * fx) / (Math.hypot(fx, fz) || 1)
  return right / (depth * tan * aspect) < column * 2 - 1
}
