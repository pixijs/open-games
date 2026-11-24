/**
 * The search's quick first pick: lines that aim toward the inside of each bend, a grid of how far, how smoothly and how
 * early. No one setting suits every track (the truck slides through most bends, so geometry alone can't say where to
 * aim), so the search races all of them and the centreline, and keeps the best. Pure.
 */

import type { Route } from '../route';
import { cos } from './portable';
import { LINE_LIMIT } from './RacingLine';

/** Metres between the samples a bend's signal is smoothed over. */
const TAP = 0.5;

/** The grid: metres toward the inside, metres of smoothing either side, and metres earlier than the bend. */
const AMPS = [1.5, 2.85, 4.5];
const WINDOWS = [0, 3, 6];
const SHIFTS = [-4, -2, 0, 2, 4, 6];

/** Candidates the heuristic stage races: the centreline and the grid's 54. */
export const HEURISTIC_CANDIDATES = 1 + AMPS.length * WINDOWS.length * SHIFTS.length;

/**
 * A line toward the inside of the bends: the route's turn (+1 right, -1 left, 0 straight) smoothed over `window`
 * metres either side, read `shift` metres on, scaled to `amp` metres and kept on the road.
 * @param route - The track's route.
 * @param size - Points in the line.
 * @param amp - Metres toward the inside in the middle of a bend, before the clamp to the road.
 * @param window - Metres of smoothing either side.
 * @param shift - Metres on from each point that it reads the bend: positive turns in early.
 * @returns The line's offsets.
 */
export function insideLine(route: Route, size: number, amp: number, window: number, shift: number): number[] {
  const offsets: number[] = [];
  const taps = Math.max(1, Math.round(window / TAP));

  for (let i = 0; i < size; i++) {
    const s = (i * route.lapLength) / size + shift;
    let sum = 0;
    let weights = 0;

    for (let t = -taps; t <= taps; t++) {
      const w = 0.5 + 0.5 * cos((Math.PI * t) / (taps + 1));

      sum += w * route.turn(s + t * TAP);
      weights += w;
    }

    offsets.push(Math.max(-LINE_LIMIT, Math.min(LINE_LIMIT, (amp * sum) / weights)));
  }

  return offsets;
}

/**
 * Every line the heuristic stage races, the centreline first so it wins a tie.
 * @param route - The track's route.
 * @param size - Points in each line.
 * @returns {@link HEURISTIC_CANDIDATES} lines.
 */
export function heuristicLines(route: Route, size: number): number[][] {
  const lines: number[][] = [new Array<number>(size).fill(0)];

  for (const amp of AMPS) {
    for (const window of WINDOWS) {
      for (const shift of SHIFTS) lines.push(insideLine(route, size, amp, window, shift));
    }
  }

  return lines;
}
