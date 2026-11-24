/**
 * The long-track calibration with the shipped search: on `ring`, `snake`, `long500` and
 * `max`, the game's staged search (centreline, heuristic grid, CMA-ES over the whole line to the game's budget),
 * every checkpoint measured away from the search's conditions by `validate.ts`, and T3 checked against the track's
 * reference. On `max` it also races separable CMA-ES (the game's form past 200 points) against full CMA-ES to 800
 * candidates, and times each form's own work per candidate.
 *
 * The staged search's checkpoints come from the reference search, which runs the same seeded search further, so its
 * first stretch is exactly the game's; a track with no reference yet is searched here.
 *
 * Writes `results/calibration.md`.
 *
 *   npx tsx scripts/bots/run-calibrate.ts [--workers N]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cma } from '../../src/race/line/cma';
import { LINE_LIMIT } from '../../src/race/line/RacingLine';
import { HEURISTIC_EVALS, LINE_PANEL, LineSearch, searchBudget } from '../../src/race/line/search';
import { RacePool, workerCount } from './pool';
import { readReference } from './reference';
import { runSearch } from './search';
import type { SuiteTrack } from './suite';
import { barsFor, CALIBRATION_TRACKS, suiteTrack } from './suite';
import type { Validation } from './validate';
import { validate } from './validate';

const here = path.dirname(fileURLToPath(import.meta.url));
const pool = new RacePool(workerCount(process.argv));
const started = performance.now();
const MARKS = [0, 200, 400, 800, 1600, 3200, 6400];

interface Point {
  readonly label: string;
  readonly evals: number;
  readonly offsets: readonly number[];
  readonly total: number;
  readonly walls: number;
  validation?: Validation;
}

/**
 * The search's count once CMA-ES has had some candidates: the first race of the panel past them, as the line changes
 * only then.
 */
function evalsAt(track: SuiteTrack, candidates: number): number {
  return candidates === 0 ? HEURISTIC_EVALS : new LineSearch(track.route, { refineBudget: candidates }).budget;
}

/** The staged search's checkpoints on a track, the centreline first and the reference last. */
async function stages(track: SuiteTrack): Promise<{ points: Point[]; reference: Point }> {
  const game = searchBudget(track.route);
  const marks = MARKS.map((c) => evalsAt(track, c)).filter((c) => c < game);
  const stored = readReference(track.name);
  const checkpoints =
    stored?.checkpoints ?? (await runSearch(pool, track, {}, [...marks, game])).checkpoints.map((c) => ({ ...c }));
  const centre = new Array<number>(track.size).fill(0);
  const centreScore = await pool.score(track.code, centre, LINE_PANEL);
  const points: Point[] = [
    { label: 'centreline', evals: 1, offsets: centre, total: centreScore.total, walls: centreScore.wallHits },
  ];

  for (const c of checkpoints) {
    if (!marks.includes(c.evals) && c.evals !== game) continue;

    const label = c.evals === HEURISTIC_EVALS ? 'heuristic' : c.evals === game ? 'refined' : 'whole line';
    // The stored checkpoints are rounded; the game's refined and heuristic lines are kept whole.
    const offsets =
      stored && label === 'refined' ? stored.refined : stored && label === 'heuristic' ? stored.heuristic : c.offsets;

    points.push({ label, evals: c.evals, offsets, total: c.total, walls: c.wallHits });
  }

  const reference: Point = stored
    ? { label: 'reference', evals: stored.evals, offsets: stored.offsets, total: stored.total, walls: NaN }
    : points.at(-1)!;

  return { points, reference };
}

/** Each form's own work per candidate on `max`, with a free scorer: what the coordinator adds to the races. */
function cmaWork(size: number, separable: boolean): number {
  const cma = new Cma(new Array<number>(size).fill(0), { sigma: 0.8, limit: LINE_LIMIT, seed: 7, separable });
  const t0 = performance.now();
  let evals = 0;

  while (evals < 400) {
    const lines = cma.ask();

    cma.tell(lines.map((line) => line.reduce((a, v) => a + (v - 1) ** 2, 0)));
    evals += lines.length;
  }

  return (performance.now() - t0) / evals;
}

const f = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');
const out: string[] = [
  '# Calibration on long tracks',
  '',
  '`npx tsx scripts/bots/run-calibrate.ts`: the shipped search on `ring`, `snake`, `long500` and `max`.',
  "Every checkpoint is measured by `validate.ts`: pace is the pace-1 bot's best flying lap,",
  "the mean over 30, 60, 120, 144 and 240 Hz, against the track's reference; walls are hard hits a lap alone and",
  'chased; incidents are failed laps, respawns and back-outs alone, chased, eased and in the field. Search score is',
  "the line's score on the search's panel (race time over its six conditions plus costs; lower is better).",
  '',
];
const misses: string[] = [];
const tracks = CALIBRATION_TRACKS.map(suiteTrack);
const staged = await Promise.all(tracks.map(stages));

await Promise.all(
  staged.flatMap(({ points, reference }, i) =>
    [...points, reference].map(async (point) => (point.validation = await validate(pool, tracks[i], point.offsets))),
  ),
);

for (let i = 0; i < tracks.length; i++) {
  const track = tracks[i];
  const { points, reference } = staged[i];
  const ref = reference.validation!;
  const bars = barsFor(track);

  out.push(
    `## ${track.name}: ${f(track.lap, 1)} m, ${track.size} points, game budget ${searchBudget(track.route)}`,
    '',
    '| Line | Candidates | Search score (walls) | Pace-1 mean s (gap) | Walls a lap: alone / chased | Ultras per 100 m | Incidents: alone / chased / eased / field | Longest crawl s |',
    '|---|---|---|---|---|---|---|---|',
  );

  for (const point of [...points, reference]) {
    const v = point.validation!;
    const gap = v.meanPace1 / ref.meanPace1 - 1;
    const incidents = [v.solo, v.chased, v.eased, v.field].map((t) => t.failed + t.respawns + t.backouts).join(' / ');

    out.push(
      `| ${point.label} | ${point.evals} | ${f(point.total)} (${Number.isNaN(point.walls) ? '' : point.walls}) | ${f(v.meanPace1)} (${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%) | ${f(v.solo.walls / v.solo.laps, 3)} / ${f(v.chased.walls / v.chased.laps)} | ${f(((v.solo.ultras / v.solo.laps) * 100) / track.lap)} | ${incidents} | ${f(Math.max(v.solo.crawl, v.chased.crawl, v.eased.crawl))} |`,
    );

    if (point.label === 'refined' && gap > bars.pace) {
      misses.push(
        `${track.name}: the refined line is ${(gap * 100).toFixed(1)}% off the reference (T3 ${bars.pace * 100}%)`,
      );
    }
  }

  out.push('');
}

// -- Separable against full CMA-ES on max, 800 candidates each from the same heuristic line.

const max = tracks[CALIBRATION_TRACKS.indexOf('max')];
const at = evalsAt(max, 800);
const separable = staged[CALIBRATION_TRACKS.indexOf('max')].points.find((p) => p.evals === at)!;
const fullRun = await runSearch(pool, max, { refineBudget: 800, separable: false }, [at]);
const full: Point = {
  label: 'full',
  evals: at,
  offsets: fullRun.best.offsets,
  total: fullRun.best.total,
  walls: fullRun.best.wallHits,
};

full.validation = await validate(pool, max, full.offsets);

const work = { separable: cmaWork(max.size, true), full: cmaWork(max.size, false) };
const sepPace = separable.validation!.meanPace1;
const fullPace = full.validation.meanPace1;

out.push(
  '## Separable against full CMA-ES on max, 800 candidates',
  '',
  '| Form | Search score (walls) | Pace-1 mean s | Walls a lap alone / chased | CMA-ES work per candidate |',
  '|---|---|---|---|---|',
  `| separable (the game's past 200 points) | ${f(separable.total)} (${separable.walls}) | ${f(sepPace)} | ${f(separable.validation!.solo.walls / separable.validation!.solo.laps, 3)} / ${f(separable.validation!.chased.walls / separable.validation!.chased.laps)} | ${f(work.separable)} ms |`,
  `| full | ${f(full.total)} (${full.walls}) | ${f(fullPace)} | ${f(full.validation.solo.walls / full.validation.solo.laps, 3)} / ${f(full.validation.chased.walls / full.validation.chased.laps)} | ${f(work.full)} ms |`,
  '',
  separable.total <= full.total
    ? 'The separable form scores no worse than the full one at 800 candidates, for a fraction of the work, so it stays.'
    : `The separable form scores ${f(separable.total - full.total)} worse than the full one at 800 candidates.`,
  '',
);

if (separable.total > full.total) misses.push('max: separable CMA-ES scores worse than full at 800 candidates');

out.push(
  misses.length === 0
    ? 'Every refined line is within T3 of its reference.'
    : `## Misses\n\n${misses.map((m) => `- ${m}`).join('\n')}`,
  '',
  `${pool.size} threads, ${((performance.now() - started) / 60000).toFixed(1)} min.`,
  '',
);

await pool.close();
mkdirSync(path.join(here, 'results'), { recursive: true });
writeFileSync(path.join(here, 'results/calibration.md'), out.join('\n'));
console.log(out.join('\n'));
process.exitCode = misses.length === 0 ? 0 : 1;
