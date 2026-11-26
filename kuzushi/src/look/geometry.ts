import { Geometry3D } from "@pixi/3d"

import { arrowheadPoints, NOTCH, notchAt } from "../art/arrowhead.ts"

/** A point on the ground plane: x, then z. */
export type Point = readonly [x: number, z: number]
type Vec = readonly [number, number, number]

interface Builder {
  readonly positions: Array<number>
  readonly normals: Array<number>
  readonly uvs: Array<number>
}

const subtract = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = (a: Vec): Vec => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / length, a[1] / length, a[2] / length]
}

/** One flat triangle, wound so its face (and normal) points along `outward`. */
const triangle = (builder: Builder, a: Vec, b: Vec, c: Vec, outward: Vec, uv: (point: Vec) => readonly [number, number]) => {
  const normal = normalize(cross(subtract(b, a), subtract(c, a)))
  const flip = dot(normal, outward) < 0
  const corners = flip ? [a, c, b] : [a, b, c]
  const facing = flip ? ([-normal[0], -normal[1], -normal[2]] as const) : normal
  for (const corner of corners) {
    builder.positions.push(corner[0], corner[1], corner[2])
    builder.normals.push(facing[0], facing[1], facing[2])
    builder.uvs.push(...uv(corner))
  }
}

const build = (builder: Builder) =>
  new Geometry3D({ positions: new Float32Array(builder.positions), normals: new Float32Array(builder.normals), uvs: new Float32Array(builder.uvs) })

const centroid = (outline: ReadonlyArray<Point>): Point => {
  const sum = outline.reduce<[number, number]>((total, [x, z]) => [total[0] + x, total[1] + z], [0, 0])
  return [sum[0] / outline.length, sum[1] / outline.length]
}

/** The top cap maps the square from -extent to extent onto UV 0 to 1: x along u, z along v. */
const capUv = (extent: number) => (point: Vec): readonly [number, number] => [point[0] / (extent * 2) + 0.5, point[2] / (extent * 2) + 0.5]

/** Vertical walls from `bottom` up to every edge of a ring of top corners, each facing away from `middle`. */
const walls = (builder: Builder, tops: ReadonlyArray<Vec>, middle: Point, bottom = 0) => {
  tops.forEach((top, index) => {
    const next = tops[(index + 1) % tops.length] ?? top
    const midX = (top[0] + next[0]) / 2
    const midZ = (top[2] + next[2]) / 2
    const outward: Vec = [midX - middle[0], 0, midZ - middle[1]]
    const footA: Vec = [top[0], bottom, top[2]]
    const footB: Vec = [next[0], bottom, next[2]]
    const sideUv = (point: Vec): readonly [number, number] => [0, 1 - point[1]]
    triangle(builder, footA, footB, next, outward, sideUv)
    triangle(builder, footA, next, top, outward, sideUv)
  })
}

/**
 * A flat shape standing on the floor: `outline` (star-shaped about its centroid) raised from `bottom` to `height`,
 * with a top cap textured over the square of half size `extent`. No bottom face: it is never seen.
 */
export const extrude = (outline: ReadonlyArray<Point>, height: number, extent: number, bottom = 0): Geometry3D => {
  const builder: Builder = { positions: [], normals: [], uvs: [] }
  const middle = centroid(outline)
  const tops = outline.map(([x, z]): Vec => [x, height, z])
  const center: Vec = [middle[0], height, middle[1]]
  tops.forEach((top, index) => triangle(builder, center, top, tops[(index + 1) % tops.length] ?? top, [0, 1, 0], capUv(extent)))
  walls(builder, tops, middle, bottom)
  return build(builder)
}

/** The arrowhead's tip, back corners and half width, in multiples of its size. */
const ARROW = { tip: 1.25, back: -0.8, half: 0.86 } as const

/**
 * The player's arrowhead, pointing +x: a tip, two back corners and a notch (see src/art/arrowhead.ts), its top
 * folded along the spine like a paper dart so one half catches the light and the other doesn't.
 */
export const arrowhead = (size: number, height: number, ridge: number, extent: number, notchShare = NOTCH): Geometry3D => {
  const builder: Builder = { positions: [], normals: [], uvs: [] }
  const tip: Vec = [size * ARROW.tip, height + ridge, 0]
  const left: Vec = [size * ARROW.back, height, -size * ARROW.half]
  const notch: Vec = [size * notchAt(ARROW.tip, ARROW.back, notchShare), height + ridge * 0.7, 0]
  const right: Vec = [size * ARROW.back, height, size * ARROW.half]
  const uv = capUv(extent)
  triangle(builder, tip, left, notch, [0, 1, 0], uv)
  triangle(builder, tip, notch, right, [0, 1, 0], uv)
  walls(builder, [tip, left, notch, right], [size * 0.15, 0])
  return build(builder)
}

/** The arrowhead's outline on the ground, for its ink rim and its art: tip, corner, notch, corner. */
export const arrowheadOutline = (size: number, notch = NOTCH): ReadonlyArray<Point> =>
  arrowheadPoints(size * ARROW.tip, size * ARROW.back, size * ARROW.half, notch)

export const circle = (radius: number, segments = 40): ReadonlyArray<Point> =>
  Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const
  })

/** A regular polygon with a corner at +x. */
export const polygon = (radius: number, sides: number): ReadonlyArray<Point> => circle(radius, sides)

/** A rhombus pointing +x, `length` from tip to tip and `width` across. */
export const rhombus = (length: number, width: number): ReadonlyArray<Point> => [
  [length / 2, 0],
  [0, width / 2],
  [-length / 2, 0],
  [0, -width / 2]
]

/** Grows a closed outline by `amount`, mitring every corner. */
export const grow = (outline: ReadonlyArray<Point>, amount: number): ReadonlyArray<Point> => {
  const middle = centroid(outline)
  const edgeNormal = (a: Point, b: Point): Point => {
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const length = Math.hypot(dx, dz) || 1
    const nx = dz / length
    const nz = -dx / length
    const outward = (a[0] + b[0]) / 2 - middle[0]
    const outwardZ = (a[1] + b[1]) / 2 - middle[1]
    return nx * outward + nz * outwardZ >= 0 ? [nx, nz] : [-nx, -nz]
  }
  return outline.map((point, index) => {
    const before = outline[(index - 1 + outline.length) % outline.length] ?? point
    const after = outline[(index + 1) % outline.length] ?? point
    const n1 = edgeNormal(before, point)
    const n2 = edgeNormal(point, after)
    const mx = n1[0] + n2[0]
    const mz = n1[1] + n2[1]
    const length = Math.hypot(mx, mz) || 1
    const reach = amount / Math.max(0.3, (mx / length) * n1[0] + (mz / length) * n1[1])
    return [point[0] + (mx / length) * reach, point[1] + (mz / length) * reach] as const
  })
}

/**
 * A ring from `inner` to `outer` radius, standing from `bottom` to `height`, between angles `from` and `to` (a whole
 * ring by default), with its top textured over the square of half size `extent` like `extrude`. Partial rings get end
 * walls: the warden's shell plates.
 */
export const ring = (inner: number, outer: number, height: number, extent: number, from = 0, to = Math.PI * 2, bottom = 0, segments = 40): Geometry3D => {
  const builder: Builder = { positions: [], normals: [], uvs: [] }
  const uv = capUv(extent)
  const whole = Math.abs(to - from) >= Math.PI * 2 - 1e-6
  const steps = Math.max(3, Math.ceil((segments * Math.abs(to - from)) / (Math.PI * 2)))
  const at = (radius: number, angle: number, y: number): Vec => [Math.cos(angle) * radius, y, Math.sin(angle) * radius]
  const sideUv = (point: Vec): readonly [number, number] => [0, 1 - point[1]]
  for (let index = 0; index < steps; index++) {
    const a = from + ((to - from) * index) / steps
    const b = from + ((to - from) * (index + 1)) / steps
    const mid = (a + b) / 2
    const outward: Vec = [Math.cos(mid), 0, Math.sin(mid)]
    const inward: Vec = [-outward[0], 0, -outward[2]]
    triangle(builder, at(inner, a, height), at(outer, a, height), at(outer, b, height), [0, 1, 0], uv)
    triangle(builder, at(inner, a, height), at(outer, b, height), at(inner, b, height), [0, 1, 0], uv)
    triangle(builder, at(outer, a, bottom), at(outer, b, bottom), at(outer, b, height), outward, sideUv)
    triangle(builder, at(outer, a, bottom), at(outer, b, height), at(outer, a, height), outward, sideUv)
    triangle(builder, at(inner, a, bottom), at(inner, b, bottom), at(inner, b, height), inward, sideUv)
    triangle(builder, at(inner, a, bottom), at(inner, b, height), at(inner, a, height), inward, sideUv)
  }
  if (!whole) {
    for (const [angle, sign] of [[from, -1], [to, 1]] as const) {
      const facing: Vec = [-Math.sin(angle) * sign, 0, Math.cos(angle) * sign]
      triangle(builder, at(inner, angle, bottom), at(outer, angle, bottom), at(outer, angle, height), facing, sideUv)
      triangle(builder, at(inner, angle, bottom), at(outer, angle, height), at(inner, angle, height), facing, sideUv)
    }
  }
  return build(builder)
}
