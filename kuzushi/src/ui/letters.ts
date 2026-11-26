import type { BrushOptions, Point } from "./brush.ts"

/** One stroke of a brush letter, in a 100-unit cap height with y down, before the slant. */
export interface LetterStroke {
  readonly points: ReadonlyArray<Point>
  readonly brush: Omit<BrushOptions, "seed">
}

export interface Letter {
  /** Horizontal space the letter takes, before the gap to the next. */
  readonly advance: number
  readonly strokes: ReadonlyArray<LetterStroke>
}

const heavy = 21
const light = 14

const K: Letter = {
  advance: 66,
  strokes: [
    { points: [[13, -3], [12, 30], [11, 66], [9, 101]], brush: { width: heavy, release: 0.22, dry: 0.3 } },
    { points: [[66, -4], [52, 14], [34, 34], [17, 52]], brush: { width: light, start: 1.1, attack: 0.02, release: 0.55, dry: 0.18, bristles: 5 } },
    { points: [[22, 44], [36, 60], [52, 80], [70, 103]], brush: { width: heavy - 2, start: 0.55, attack: 0.14, release: 0.3, dry: 0.42 } }
  ]
}

const U = (bend: number): Letter => ({
  advance: 66,
  strokes: [
    { points: [[12, -3], [12, 36], [13, 70], [22 + bend, 92], [38, 99], [54, 91]], brush: { width: heavy, release: 0.24, dry: 0.22 } },
    { points: [[62, -4], [62, 36], [61, 72], [59, 103]], brush: { width: light + 1, start: 0.9, release: 0.3, dry: 0.42, bristles: 6 } }
  ]
})

const Z: Letter = {
  advance: 64,
  strokes: [
    { points: [[3, 6], [26, 2], [50, 1], [63, 2]], brush: { width: light, start: 0.8, release: 0.3, dry: 0.34, bristles: 5 } },
    { points: [[60, 4], [44, 30], [24, 62], [6, 94]], brush: { width: heavy, start: 0.7, release: 0.18, dry: 0.12 } },
    { points: [[1, 95], [24, 93], [50, 92], [80, 95]], brush: { width: light + 3, start: 0.85, release: 0.42, dry: 0.5, bristles: 8 } }
  ]
}

const S: Letter = {
  advance: 60,
  strokes: [
    {
      points: [[60, 12], [48, 1], [26, 0], [10, 13], [12, 33], [32, 47], [52, 60], [56, 81], [42, 97], [18, 100], [-2, 88]],
      brush: { width: heavy - 1, start: 0.6, attack: 0.08, release: 0.26, dry: 0.3, wobble: 0.18 }
    }
  ]
}

const H: Letter = {
  advance: 70,
  strokes: [
    { points: [[12, -3], [11, 48], [9, 102]], brush: { width: heavy, release: 0.2, dry: 0.3 } },
    { points: [[62, -4], [61, 48], [59, 103]], brush: { width: heavy - 1, release: 0.24, dry: 0.36 } },
    { points: [[2, 54], [30, 50], [56, 47], [80, 43]], brush: { width: light - 1, start: 0.85, release: 0.4, dry: 0.5, bristles: 6 } }
  ]
}

const I: Letter = {
  advance: 26,
  strokes: [
    { points: [[14, -5], [12, 48], [10, 105]], brush: { width: heavy + 1, release: 0.3, dry: 0.46, bristles: 8 } }
  ]
}

/** K U Z U S H I, written as brush strokes in the order a hand would draw them. */
export const KUZUSHI: ReadonlyArray<Letter> = [K, U(0), Z, U(3), S, H, I]

/** Space between letters, in letter units. */
export const LETTER_GAP = 8

/** How far the top of a letter leans right per unit of height. */
export const SLANT = 0.2
