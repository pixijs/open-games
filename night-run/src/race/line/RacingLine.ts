/**
 * A racing line: where a bot aims across the road, as offsets to the right of the centreline at evenly spaced points
 * round the lap from the finish line, read smoothly between them. Night Run's was searched for once and ships; a
 * custom track's is searched for on the host. Pure.
 */

import { BASE_OFFSETS } from '../../track/base';
import type { Route } from '../route';
import { BASE_LAP_LENGTH } from '../route';

/** A line's points, and how far apart they sit along the route. */
export interface RacingLine {
  readonly offsets: readonly number[];
  /** Route distance between points: the lap over the point count. */
  readonly spacing: number;
}

/** How far apart a line's points sit, near enough, on every track: Night Run's spacing, about 2.505 m. */
export const LINE_STEP = BASE_LAP_LENGTH / BASE_OFFSETS.length;
/** How far either side of the centreline a line may aim, and so the range its code covers. */
export const LINE_LIMIT = 2.85;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LINE_VERSION = '1';
/** An offset's code: 12 bits over -{@link LINE_LIMIT} to {@link LINE_LIMIT}, two characters. */
const LEVELS = 4095;

const BASE_LINE: RacingLine = { offsets: BASE_OFFSETS, spacing: BASE_LAP_LENGTH / BASE_OFFSETS.length };

/**
 * How many points a track's line has: one per {@link LINE_STEP} of lap, at least 8.
 * @param route - The track's route.
 * @returns The point count: 27 on the smallest oval, 359 on the largest track.
 */
export function lineSize(route: Route): number {
  return Math.max(8, Math.round(route.lapLength / LINE_STEP));
}

/**
 * Night Run's shipped line, the same object every time.
 * @returns The line.
 */
export function baseLine(): RacingLine {
  return BASE_LINE;
}

/**
 * A line of points spread evenly round a track's lap.
 * @param route - The track's route.
 * @param offsets - The points, any count.
 * @returns The line.
 */
export function lineFor(route: Route, offsets: readonly number[]): RacingLine {
  return { offsets, spacing: route.lapLength / offsets.length };
}

/**
 * The centreline: every point at 0, {@link lineSize} of them.
 * @param route - The track's route.
 * @returns The line.
 */
export function centreLine(route: Route): RacingLine {
  return lineFor(route, new Array<number>(lineSize(route)).fill(0));
}

/**
 * Where a line aims at route distance `s`: a Catmull-Rom spline through its points.
 * @param line - The line.
 * @param route - The route it runs round.
 * @param s - Route distance.
 * @returns Offset to the driver's right.
 */
export function lineAt(line: RacingLine, route: Route, s: number): number {
  const offsets = line.offsets;
  const n = offsets.length;
  const u = route.wrap(s) / line.spacing;
  const i = Math.floor(u);
  const f = u - i;
  const a = offsets[(i + n - 1) % n];
  const b = offsets[i % n];
  const c = offsets[(i + 1) % n];
  const d = offsets[(i + 2) % n];

  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
}

/**
 * A line as text, for keeping: `1`, then two base64url characters per point, each point quantised to 12 bits over
 * -{@link LINE_LIMIT} to {@link LINE_LIMIT}, so it comes back within 0.0007 m.
 * @param line - The line.
 * @returns Its code.
 */
export function encodeLine(line: RacingLine): string {
  let text = LINE_VERSION;

  for (const offset of line.offsets) {
    const clamped = Math.max(-LINE_LIMIT, Math.min(LINE_LIMIT, offset));
    const q = Math.round(((clamped + LINE_LIMIT) / (2 * LINE_LIMIT)) * LEVELS);

    text += B64URL[q >> 6] + B64URL[q & 63];
  }

  return text;
}

/**
 * A line from its code, for one track.
 * @param text - What {@link encodeLine} made; anything else, as a corrupt cache may hold, is refused.
 * @param route - The track it's for.
 * @returns The line, or null unless the code is well formed with exactly {@link lineSize} points for that track.
 */
export function decodeLine(text: string, route: Route): RacingLine | null {
  if (
    typeof text !== 'string' ||
    text[0] !== LINE_VERSION ||
    (text.length - 1) % 2 !== 0 ||
    (text.length - 1) / 2 !== lineSize(route)
  )
    return null;

  const offsets: number[] = [];

  for (let i = 1; i < text.length; i += 2) {
    const high = B64URL.indexOf(text[i]);
    const low = B64URL.indexOf(text[i + 1]);
    const q = (high << 6) | low;

    if (high < 0 || low < 0 || q > LEVELS) return null;

    offsets.push((q / LEVELS) * 2 * LINE_LIMIT - LINE_LIMIT);
  }

  return lineFor(route, offsets);
}
