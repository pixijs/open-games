/**
 * The bot checks' tracks, from the 68 m oval to the 899 m serpentine that fills the board,
 * with what each threshold needs to know about them, and the thresholds themselves.
 */

import { refineBudget } from '../../src/race/line/search';
import { lineSize } from '../../src/race/line/RacingLine';
import { BASE_ROUTE, Route } from '../../src/race/route';
import type { TrackDef } from '../../src/track/code';
import { decodeTrack, isTrackError } from '../../src/track/code';

/** Every suite track's code, by name; Night Run's is its own turns' code, which decodes to the built-in track. */
export const SUITE_CODES: Readonly<Record<string, string>> = {
  base: '1gIkII8',
  oval: '1gCo8',
  hairpin: '1AKhgg8',
  esses: '1ACCmp8',
  longcomplex: '1AAaCAIy',
  'gen-1': '1AQQAAhUA',
  'gen-2': '1AFgEAFCShEUII8',
  'gen-3': '1ASoESAKQIAy',
  'gen-4': '1AFAF',
  'gen-7': '1AIASoAQAK8',
  'gen-11': '1ACgSIhy',
  wiggle: '1AIaplWKC',
  comb: '1AIoUoUoUogw',
  snake: '1AKAFAKAFAKAIAC',
  ring: '1AAIAACAAAIAACA',
  long500: '1AAIgCFoQBKUgCFoQBKUgCIA8',
  max: '1AAIAAKAQBAoAAFAgCAUAAKAQBAoAAFAgCAUAAKAACA',
};

/** The tracks the long-track calibration runs on. */
export const CALIBRATION_TRACKS = ['ring', 'snake', 'long500', 'max'] as const;

/** A suite track with what its thresholds read. */
export interface SuiteTrack {
  readonly name: string;
  /** The code the workers decode: the suite's, so Night Run's is `1gIkII8`. */
  readonly code: string;
  readonly def: TrackDef;
  readonly route: Route;
  readonly lap: number;
  /** Points in its line. */
  readonly size: number;
  /** U-turns a lap: two same-hand corners in a row. */
  readonly uTurns: number;
  /** Corner groups a lap: U-turns, and corners that aren't half of one. */
  readonly groups: number;
}

/**
 * A suite track by name.
 * @param name - Its name in {@link SUITE_CODES}.
 * @returns The track.
 */
export function suiteTrack(name: string): SuiteTrack {
  const code = SUITE_CODES[name];
  const def = code === undefined ? null : decodeTrack(code, name);

  if (def === null || isTrackError(def)) throw new Error(`No suite track ${name}`);

  const route = def.builtIn ? BASE_ROUTE : new Route(def.cells);
  const turns = def.turns;
  const n = turns.length;
  let uTurns = 0;
  let inU = 0;
  let corners = 0;

  for (let i = 0; i < n; i++) {
    const here = turns[i];
    const next = turns[(i + 1) % n];

    if (here === 'S') continue;

    corners++;

    if (here === next) {
      uTurns++;
      inU += 2;
    }
  }

  return {
    name,
    code,
    def,
    route,
    lap: route.lapLength,
    size: lineSize(route),
    uTurns,
    groups: uTurns + corners - inU,
  };
}

/** Every suite track, in the suite's order. */
export function suiteTracks(): SuiteTrack[] {
  return Object.keys(SUITE_CODES).map(suiteTrack);
}

/**
 * CMA-ES's candidates for a track's reference search: twice the game's budget, at least 3200.
 * @param track - The track.
 * @returns Candidates.
 */
export function referenceBudget(track: SuiteTrack): number {
  return Math.max(3200, 2 * refineBudget(track.route));
}

/** The per-track bars. */
export interface Bars {
  /** T3: the pace-1 mean lap's most over the reference's, as a share. */
  readonly pace: number;
  /** T4: the most over the reference at any one frame rate. */
  readonly pacePerRate: number;
  /** T5: the fewest ultras a lap. */
  readonly ultras: number;
  /** T6 and T10: the most hard wall hits a lap, alone and chased. */
  readonly walls: number;
  readonly wallsChased: number;
  /** T9: the heuristic stage's most over the reference. */
  readonly heuristic: number;
  /** T2: field respawns per km of bot driving, and the longest crawl in seconds. */
  readonly fieldRespawnsPerKm: number;
  readonly crawl: number;
}

/**
 * The bars a track's lines must meet.
 * @param track - The track.
 * @returns Its bars.
 */
export function barsFor(track: SuiteTrack): Bars {
  const walls = 0.12 * track.uTurns + (0.1 * track.lap) / 100;

  return {
    pace: track.lap <= 250 ? 0.03 : 0.05,
    pacePerRate: 0.1,
    ultras: Math.min((0.9 * track.lap) / 100, 0.5 * track.groups),
    walls,
    wallsChased: 3 * walls + 0.3,
    heuristic: 0.25,
    fieldRespawnsPerKm: 0.25,
    crawl: 0.5,
  };
}
