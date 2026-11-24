/**
 * Measures a line away from the search's own conditions: the game's three bot paces alone
 * at five frame rates; chased, with the rubber band's reference held 30 m ahead so the bot races at its most top
 * speed, and eased, held 25 m behind so it lifts and brakes for corners; and a four-bot field over three seeds.
 */

import { BOT_SKILLS } from '../../src/race/BotDriver';
import { LONG_LAP, raceLimit } from '../../src/race/line/search';
import type { SimResult } from '../../src/race/line/sim';
import type { RacePool } from './pool';
import type { SuiteTrack } from './suite';

/** Frame rates the solo laps run at, and the pace whose best flying lap is the line's pace. */
export const SOLO_RATES = [30, 60, 120, 144, 240] as const;
const PACES = [1, 0.92, 0.85] as const;
/** Chased and eased: these paces at these rates, 3 laps each, the reference held this far ahead or behind. */
const PRESSURE_PACES = [1, 0.85] as const;
const PRESSURE_RATES = [30, 60, 144] as const;
const PRESSURE_LAPS = 3;
const CHASED_LEAD = 30;
const EASED_LEAD = -25;
const FIELD_SEEDS = [1, 2, 3] as const;

/** Incidents over a set of races. */
export interface Tally {
  /** Laps completed, and laps short of what was raced. */
  laps: number;
  failed: number;
  walls: number;
  respawns: number;
  backouts: number;
  ultras: number;
  /** Longest crawl, seconds. */
  crawl: number;
}

/** What a line did. */
export interface Validation {
  /** The pace-1 bot's best flying lap at each of {@link SOLO_RATES}, and their mean. */
  readonly pace1: readonly number[];
  readonly meanPace1: number;
  readonly solo: Tally;
  readonly chased: Tally;
  readonly eased: Tally;
  readonly field: Tally & {
    /** Mean finish time of the winner and of the last bot over the seeds; NaN when one didn't finish. */
    winner: number;
    last: number;
    /** Kilometres of bot driving, from completed laps. */
    km: number;
  };
}

const tally = (): Tally => ({ laps: 0, failed: 0, walls: 0, respawns: 0, backouts: 0, ultras: 0, crawl: 0 });

function add(into: Tally, result: SimResult, laps: number): void {
  for (const bot of result.bots) {
    into.laps += bot.laps.length;
    into.failed += laps - bot.laps.length;
    into.walls += bot.wallHits;
    into.respawns += bot.respawns;
    into.backouts += bot.backouts;
    into.ultras += bot.ultras;
    into.crawl = Math.max(into.crawl, bot.crawl);
  }
}

/**
 * Race a line every way the bot checks measure it, on the pool.
 * @param pool - Where it races.
 * @param track - The track.
 * @param offsets - The line.
 * @returns What it did.
 */
export async function validate(pool: RacePool, track: SuiteTrack, offsets: readonly number[]): Promise<Validation> {
  const long = track.lap >= LONG_LAP;
  const soloLaps = long ? 2 : 4;
  const fieldLaps = long ? 2 : 3;
  const race = (paces: readonly number[], laps: number, hz: number, extra: { lead?: number; seed?: number } = {}) =>
    pool.race(track.code, {
      offsets,
      paces,
      laps,
      dt: 1 / hz,
      maxTime: raceLimit(track.route, laps),
      launch: paces.length > 1 ? 'random' : 'all',
      seed: extra.seed,
      lead: extra.lead ?? null,
    });

  const solo = SOLO_RATES.map((hz) => PACES.map((pace) => race([pace], soloLaps, hz)));
  const chased = PRESSURE_RATES.flatMap((hz) =>
    PRESSURE_PACES.map((pace) => race([pace], PRESSURE_LAPS, hz, { lead: CHASED_LEAD })),
  );
  const eased = PRESSURE_RATES.flatMap((hz) =>
    PRESSURE_PACES.map((pace) => race([pace], PRESSURE_LAPS, hz, { lead: EASED_LEAD })),
  );
  const field = FIELD_SEEDS.map((seed) =>
    race(
      BOT_SKILLS.map((skill) => skill.pace),
      fieldLaps,
      60,
      { seed },
    ),
  );

  const soloResults = await Promise.all(solo.map((rate) => Promise.all(rate)));
  const pace1 = soloResults.map(([pace1Run]) => {
    const flying = pace1Run.bots[0].laps.slice(1);

    return flying.length > 0 ? Math.min(...flying) : NaN;
  });
  const soloTally = tally();

  for (const rate of soloResults) for (const result of rate) add(soloTally, result, soloLaps);

  const chasedTally = tally();
  const easedTally = tally();

  for (const result of await Promise.all(chased)) add(chasedTally, result, PRESSURE_LAPS);
  for (const result of await Promise.all(eased)) add(easedTally, result, PRESSURE_LAPS);

  const fieldTally = { ...tally(), winner: 0, last: 0, km: 0 };

  for (const result of await Promise.all(field)) {
    const times = result.bots.map((bot) => bot.finishTime);

    add(fieldTally, result, fieldLaps);
    fieldTally.winner += Math.min(...times.filter((t) => t > 0)) / FIELD_SEEDS.length;
    fieldTally.last += (times.every((t) => t > 0) ? Math.max(...times) : NaN) / FIELD_SEEDS.length;
  }

  fieldTally.km = (fieldTally.laps * track.lap) / 1000;

  return {
    pace1,
    meanPace1: pace1.reduce((a, b) => a + b, 0) / pace1.length,
    solo: soloTally,
    chased: chasedTally,
    eased: easedTally,
    field: fieldTally,
  };
}
