import { simplex2d } from "math/noise"
import { mulberry32 } from "math/random"

export type Point = readonly [x: number, y: number]

export interface BrushOptions {
  /** Full width of the stroke at full pressure, in the drawing's units. */
  readonly width: number
  /** Seeds the pressure wobble, the edge noise and the bristles, so the same stroke always draws the same way. */
  readonly seed: number
  /** Width at the very start, as a fraction of `width`: a blunt press below 1. Default 0.75. */
  readonly start?: number
  /** Share of the length the press takes to reach full width. Default 0.06. */
  readonly attack?: number
  /** Share of the length that tapers to a point at the end. Default 0.3. */
  readonly release?: number
  /** Share of the length at the end that splits into dry bristles, 0 for a wet stroke. Default 0.3. */
  readonly dry?: number
  /** How many bristles the dry end splits into. Default 7. */
  readonly bristles?: number
  /** Edge noise, as a fraction of the width. Default 0.07. */
  readonly rough?: number
  /** How far the pressure wanders along the stroke, as a fraction of the width. Default 0.12. */
  readonly wobble?: number
  /** How many dry hairlines run through the body toward the end. Default 0. */
  readonly streaks?: number
}

export interface BrushStroke {
  /** Filled outlines: the wet body first, then each bristle. */
  readonly shapes: ReadonlyArray<string>
  /**
   * Every outline as one path, all wound the same way, so where the bristles lie over the body paints once. Fill it
   * instead of `shapes` with a translucent colour or a gradient: drawn one by one, the overlap doubles the alpha and
   * each bristle restarts the gradient, which shows as a hard edge where the brush runs dry.
   */
  readonly ink: string
  /** The centreline's 72 samples, evenly spaced along it. */
  readonly points: ReadonlyArray<Point>
  /** Open lines along the stroke where the brush ran dry; cut them out of the ink with a mask. */
  readonly streaks: ReadonlyArray<string>
  /** Where the stroke ends, after the last bristle. */
  readonly end: Point
}

const SAMPLES = 72
const STEP = 1 / (SAMPLES - 1)

const catmullRom = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const t2 = t * t
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t2 * t)
}

/** A smooth curve through `points`, resampled to `SAMPLES` points evenly spaced along its length. */
const spineThrough = (points: ReadonlyArray<Point>): Array<Point> => {
  if (points.length < 2) throw new Error("A brush stroke needs at least two points")
  const at = (index: number): Point => points[Math.max(0, Math.min(points.length - 1, index))] as Point
  const dense: Array<Point> = []
  for (let segment = 0; segment < points.length - 1; segment++) {
    const [a, b, c, d] = [at(segment - 1), at(segment), at(segment + 1), at(segment + 2)]
    for (let i = 0; i < 24; i++) {
      const t = i / 24
      dense.push([catmullRom(a[0], b[0], c[0], d[0], t), catmullRom(a[1], b[1], c[1], d[1], t)])
    }
  }
  dense.push(at(points.length - 1))
  const lengths = [0]
  for (let i = 1; i < dense.length; i++) {
    const [ax, ay] = dense[i - 1] as Point
    const [bx, by] = dense[i] as Point
    lengths.push((lengths[i - 1] as number) + Math.hypot(bx - ax, by - ay))
  }
  const total = lengths[lengths.length - 1] as number
  const even: Array<Point> = []
  let cursor = 1
  for (let i = 0; i < SAMPLES; i++) {
    const target = total * i * STEP
    while (cursor < dense.length - 1 && (lengths[cursor] as number) < target) cursor++
    const [ax, ay] = dense[cursor - 1] as Point
    const [bx, by] = dense[cursor] as Point
    const from = lengths[cursor - 1] as number
    const span = (lengths[cursor] as number) - from
    const k = span > 0 ? (target - from) / span : 0
    even.push([ax + (bx - ax) * k, ay + (by - ay) * k])
  }
  return even
}

const normalsOf = (spine: ReadonlyArray<Point>): Array<Point> => spine.map((_, i) => {
  const [ax, ay] = spine[Math.max(0, i - 1)] as Point
  const [bx, by] = spine[Math.min(spine.length - 1, i + 1)] as Point
  const length = Math.hypot(bx - ax, by - ay) || 1
  return [-(by - ay) / length, (bx - ax) / length]
})

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

const fixed = (value: number): string => (Math.round(value * 10) / 10).toString()

const outline = (left: ReadonlyArray<Point>, right: ReadonlyArray<Point>): string => {
  const points = [...left, ...right.toReversed()]
  return `M${points.map(([x, y]) => `${fixed(x)} ${fixed(y)}`).join("L")}Z`
}

/**
 * A hand-made brush stroke through `points`: a blunt press, a body whose pressure wanders, ragged edges,
 * and a tail that splits into dry bristles. Returns filled outlines, so it renders with `fill` alone.
 */
export const brushStroke = (points: ReadonlyArray<Point>, options: BrushOptions): BrushStroke => {
  const { width, seed } = options
  const start = options.start ?? 0.75
  const attack = options.attack ?? 0.06
  const release = options.release ?? 0.3
  const dry = options.dry ?? 0.3
  const bristleCount = options.bristles ?? 7
  const rough = options.rough ?? 0.07
  const wobble = options.wobble ?? 0.12
  const noise = simplex2d.create(seed)
  const random = mulberry32.create(seed * 7919 + 17)
  const next = () => mulberry32.sample(random)

  const spine = spineThrough(points)
  const normals = normalsOf(spine)
  const pressure = (t: number): number => {
    const press = start + (1 - start) * smoothstep(0, attack, t)
    const lift = Math.pow(Math.max(0, Math.min(1, (1 - t) / release)), 0.7)
    return press * lift * (1 + wobble * simplex2d.sample(noise, t * 2.6, 0.5))
  }
  const dryFrom = 1 - dry
  const offset = (index: number, across: number): Point => {
    const [x, y] = spine[index] as Point
    const [nx, ny] = normals[index] as Point
    return [x + nx * across, y + ny * across]
  }

  const left: Array<Point> = []
  const right: Array<Point> = []
  for (let i = 0; i < SAMPLES; i++) {
    const t = i * STEP
    const fade = dry > 0 ? 1 - smoothstep(dryFrom, Math.min(1, dryFrom + dry * 0.45), t) : 1
    const half = (width / 2) * pressure(t) * fade
    left.push(offset(i, half * (1 + rough * simplex2d.sample(noise, t * 18, 3.1))))
    right.push(offset(i, -half * (1 + rough * simplex2d.sample(noise, t * 18, 7.7))))
  }
  const shapes = [outline(left, right)]

  let end = spine[SAMPLES - 1] as Point
  if (dry > 0) {
    const first = Math.max(0, Math.floor((dryFrom - 0.08) * (SAMPLES - 1)))
    for (let b = 0; b < bristleCount; b++) {
      const lane = bristleCount === 1 ? 0 : (b / (bristleCount - 1)) * 2 - 1
      const across = lane * 0.86 + (next() - 0.5) * 0.18
      const reach = dryFrom + dry * (0.3 + next() * 0.7)
      const last = Math.min(SAMPLES - 1, Math.round(reach * (SAMPLES - 1)))
      const thickness = (width / bristleCount) * (0.55 + next() * 0.75)
      const bristleLeft: Array<Point> = []
      const bristleRight: Array<Point> = []
      for (let i = first; i <= last; i++) {
        const t = i * STEP
        const spread = (width / 2) * Math.max(pressure(t), 0.4 * start)
        const along = (i - first) / Math.max(1, last - first)
        const half = (thickness / 2) * Math.pow(1 - along, 0.85)
        const centre = across * spread
        bristleLeft.push(offset(i, centre + half))
        bristleRight.push(offset(i, centre - half))
      }
      shapes.push(outline(bristleLeft, bristleRight))
      if (last === SAMPLES - 1) end = spine[last] as Point
    }
  }

  const streaks: Array<string> = []
  const streakCount = options.streaks ?? 0
  for (let k = 0; k < streakCount; k++) {
    const lane = (next() * 2 - 1) * 0.7
    const from = Math.floor(Math.max(0.2, dryFrom - 0.1 - next() * 0.4) * (SAMPLES - 1))
    const line: Array<Point> = []
    for (let i = from; i < SAMPLES; i++) line.push(offset(i, lane * (width / 2) * Math.max(pressure(i * STEP), 0.4 * start)))
    streaks.push(`M${line.map(([x, y]) => `${fixed(x)} ${fixed(y)}`).join("L")}`)
  }

  return {
    shapes,
    ink: shapes.join(""),
    points: spine,
    streaks,
    end
  }
}

/** brushStroke outlines as SVG `<path>` elements. */
export const svgPaths = (shapes: ReadonlyArray<string>): string => shapes.map((d) => `<path d="${d}"/>`).join("")

/** Slants a drawing forward like fast brush lettering: the top leans right by `slant` per unit of height. */
export const lean = (points: ReadonlyArray<Point>, slant: number, baseline: number): Array<Point> =>
  points.map(([x, y]) => [x + (baseline - y) * slant, y])
