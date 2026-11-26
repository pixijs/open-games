/**
 * The player's arrowhead, pointing +x: a tip, two back corners and a notch between them. Every drawing of it takes
 * its notch from here: the body, its rim, top art and title backlight, its afterimages and fragments, the stage map's
 * start marker and the lab's sketch.
 */

/** How far the notch reaches in from the back corners toward the tip, as a share of the length. 0 is a straight back. */
export const NOTCH = 0.12

/** The notch through a dash: below 0 the back points out, so the body stretches into a dart. */
export const DASH_NOTCH = -0.3

/** Where the notch sits on the spine of an arrowhead with its tip at `tip` and its back corners at `back`. */
export const notchAt = (tip: number, back: number, notch = NOTCH): number => back + (tip - back) * notch

/** The outline with its tip at `tip` and back corners at `back`, `half` either side of the spine: tip, corner, notch, corner. */
export const arrowheadPoints = (tip: number, back: number, half: number, notch = NOTCH): Array<readonly [number, number]> => [
  [tip, 0],
  [back, -half],
  [notchAt(tip, back, notch), 0],
  [back, half]
]
