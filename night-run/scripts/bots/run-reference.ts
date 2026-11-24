/**
 * The reference lines the bot checks measure against: for each suite track, the game's own
 * search run for twice its budget (at least 3200 CMA-ES candidates), keeping the line that races the search's panel
 * best, as the game does. The search is seeded and a line's score exact, so its first stretch is exactly the game's:
 * the line at the game's budget is kept as a checkpoint, with the heuristic stage's and the calibration's.
 *
 * Writes `reference/best-<name>.json`. Run once, and again whenever the physics, the bot or the objective changes.
 *
 *   npx tsx scripts/bots/run-reference.ts [name ...] [--workers N] [--concurrency N]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HEURISTIC_EVALS, LineSearch, searchBudget } from '../../src/race/line/search';
import { RacePool, workerCount } from './pool';
import type { Checkpoint } from './search';
import { runSearch } from './search';
import { referenceBudget, SUITE_CODES, suiteTrack } from './suite';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const names = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const tracks = (names.length > 0 ? names : Object.keys(SUITE_CODES)).map(suiteTrack);
// The longest searches first, so the last to finish isn't one long track on its own.
const order = tracks.slice().sort((a, b) => referenceBudget(b) * b.lap - referenceBudget(a) * a.lap);
const pool = new RacePool(workerCount(argv));
const concurrency = Number(option('--concurrency') ?? 3);
const started = performance.now();

mkdirSync(path.join(here, 'reference'), { recursive: true });
console.log(`${order.length} tracks on ${pool.size} threads, ${concurrency} at a time`);

const round = (v: number) => Math.round(v * 1e4) / 1e4;
const brief = (c: Checkpoint) => ({ ...c, offsets: c.offsets.map(round), seconds: Math.round(c.seconds) });

async function reference(name: string): Promise<void> {
  const track = suiteTrack(name);
  const budget = referenceBudget(track);
  const game = searchBudget(track.route);
  // The search's line changes only when CMA-ES's mean races the panel, so each mark is the first such race past it.
  const marks = [200, 400, 800, 1600, 3200, 6400]
    .map((c) => new LineSearch(track.route, { refineBudget: c }).budget)
    .concat(HEURISTIC_EVALS, game);
  const run = await runSearch(pool, track, { refineBudget: budget }, marks, (c) =>
    console.log(
      `${name.padEnd(12)} ${String(c.evals).padStart(6)} candidates  score ${c.total.toFixed(2).padStart(7)}  ` +
        `walls ${c.wallHits}  ultras ${c.ultras}  ${Math.round(c.seconds)} s`,
    ),
  );

  writeFileSync(
    path.join(here, `reference/best-${name}.json`),
    `${JSON.stringify(
      {
        name,
        code: track.code,
        lap: track.lap,
        size: track.size,
        gameBudget: game,
        budget: run.budget,
        evals: run.evals,
        seconds: Math.round(run.seconds),
        threads: pool.size,
        concurrency,
        total: run.best.total,
        lapSeconds: run.best.lapSeconds,
        // The line itself at full precision: it's the reference the checks race.
        offsets: run.best.offsets,
        checkpoints: run.checkpoints.map(brief),
        heuristic: run.checkpoints.find((c) => c.evals === HEURISTIC_EVALS)!.offsets,
        refined: run.checkpoints.find((c) => c.evals === game)!.offsets,
      },
      null,
      1,
    )}\n`,
  );
}

const queue = order.map((t) => t.name);

await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) await reference(name);
  }),
);
await pool.close();
console.log(`done in ${((performance.now() - started) / 60000).toFixed(1)} min`);
