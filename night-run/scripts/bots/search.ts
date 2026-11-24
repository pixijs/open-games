/**
 * The game's line search driven from Node: `LineSearch`, unchanged, with each batch raced across the pool's threads,
 * and the line the bots would race kept at checkpoints along the way. A line's score doesn't depend on which thread
 * raced it, so a search here finds exactly the lines the game's workers would on the same engine.
 */

import type { LineSearchOptions, SearchBest } from '../../src/race/line/search';
import { LineSearch } from '../../src/race/line/search';
import type { RacePool } from './pool';
import type { SuiteTrack } from './suite';

/** The line the bots would race once a search has scored `evals` candidates. */
export interface Checkpoint extends SearchBest {
  readonly evals: number;
  /** Seconds since the search started. */
  readonly seconds: number;
}

/** A finished search. */
export interface SearchRun {
  readonly evals: number;
  readonly budget: number;
  readonly best: Checkpoint;
  readonly checkpoints: readonly Checkpoint[];
  readonly seconds: number;
}

/**
 * Run the search on a track, scoring each batch on the pool.
 * @param pool - Where candidates race.
 * @param track - The track.
 * @param options - The search's options, as the game's.
 * @param checkpoints - Candidate counts to keep the line at: the first count it reaches at or past each.
 * @param log - Told of each checkpoint as it's reached.
 * @returns The search's line and checkpoints.
 */
export async function runSearch(
  pool: RacePool,
  track: SuiteTrack,
  options: LineSearchOptions,
  checkpoints: readonly number[],
  log?: (checkpoint: Checkpoint) => void,
): Promise<SearchRun> {
  const search = new LineSearch(track.route, options);
  const marks = [...new Set(checkpoints)].filter((c) => c <= search.budget).sort((a, b) => a - b);
  const kept: Checkpoint[] = [];
  const started = performance.now();
  const keep = () => {
    const checkpoint: Checkpoint = {
      ...search.best,
      evals: search.evals,
      seconds: (performance.now() - started) / 1000,
    };

    kept.push(checkpoint);
    log?.(checkpoint);
  };

  for (let batch = search.ask(); batch; batch = search.ask()) {
    const { lines, conditions } = batch;
    const scores = await Promise.all(lines.map((offsets) => pool.score(track.code, offsets, conditions)));

    search.tell(scores);

    while (marks.length > 0 && search.evals >= marks[0]) {
      marks.shift();
      keep();
    }
  }

  if (kept.at(-1)?.evals !== search.evals) keep();

  return {
    evals: search.evals,
    budget: search.budget,
    best: kept.at(-1)!,
    checkpoints: kept,
    seconds: (performance.now() - started) / 1000,
  };
}
