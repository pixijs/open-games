/**
 * Are the bots competent on every suite track? Each track's lines at each
 * stage of the game's search are measured by `validate.ts` and held to the bars of `suite.ts`: the centreline, the
 * heuristic stage's pick and the refined line (Night Run: its shipped line), against the track's reference line from
 * `run-reference.ts`. The game's lines are the reference search's checkpoints at the game's budget, which are exactly
 * what the game's own search finds (seeded, exact scores); `--search` searches again at the game's budget and checks
 * that it found the same line. T7 is `verify-base.ts` and the attract fingerprint; T8 is timed in the browser.
 *
 * Writes `results/suite.md` and `results/suite.json`; exits non-zero on any miss.
 *
 *   npx tsx scripts/bots/run-suite.ts [name ...] [--workers N] [--search]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseLine } from '../../src/race/line/RacingLine';
import { HEURISTIC_EVALS } from '../../src/race/line/search';
import { RacePool, workerCount } from './pool';
import { readReference } from './reference';
import { runSearch } from './search';
import type { Bars, SuiteTrack } from './suite';
import { barsFor, SUITE_CODES, suiteTrack } from './suite';
import type { Validation } from './validate';
import { SOLO_RATES, validate } from './validate';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const names = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--workers');
const tracks = (names.length > 0 ? names : Object.keys(SUITE_CODES)).map(suiteTrack);
const pool = new RacePool(workerCount(argv));
const started = performance.now();

type Stage = 'centre' | 'heuristic' | 'refined' | 'shipped';

interface StageRow {
  readonly stage: Stage;
  readonly evals: number;
  readonly validation: Validation;
  /** Each criterion that applies, and whether it's met. */
  readonly checks: Record<string, { ok: boolean; value: number; bar: number }>;
}

interface TrackRow {
  readonly name: string;
  readonly lap: number;
  readonly size: number;
  readonly uTurns: number;
  readonly groups: number;
  readonly gameBudget: number;
  readonly referenceBudget: number;
  readonly bars: Bars;
  readonly reference: Validation;
  readonly searchedAgain: boolean | null;
  readonly stages: StageRow[];
}

function judge(stage: Stage, v: Validation, ref: Validation, bars: Bars): StageRow['checks'] {
  const checks: StageRow['checks'] = {};
  const set = (name: string, value: number, bar: number, ok = value <= bar) => (checks[name] = { ok, value, bar });
  const gap = v.meanPace1 / ref.meanPace1 - 1;
  const worstRate = Math.max(...v.pace1.map((t, i) => t / ref.pace1[i] - 1));
  const respawnsPerKm = v.field.km > 0 ? v.field.respawns / v.field.km : Infinity;
  const pressured = [v.solo, v.chased, v.eased];

  set('T1 failed laps', v.solo.failed + v.chased.failed + v.eased.failed + v.field.failed, 0);
  set(
    'T2 back-outs and respawns',
    pressured.reduce((a, t) => a + t.backouts + t.respawns, 0),
    0,
  );
  set('T2 field respawns per km', respawnsPerKm, bars.fieldRespawnsPerKm);
  set('T2 longest crawl s', Math.max(...pressured.map((t) => t.crawl)), bars.crawl);

  if (stage === 'refined' || stage === 'shipped') {
    set('T3 pace gap', gap, bars.pace);
    set('T4 worst rate gap', worstRate, bars.pacePerRate);
    set('T5 ultras a lap', v.solo.ultras / v.solo.laps, bars.ultras, v.solo.ultras / v.solo.laps >= bars.ultras);
    set('T6 walls a lap alone', v.solo.walls / v.solo.laps, bars.walls);
    set('T10 walls a lap chased', v.chased.walls / v.chased.laps, bars.wallsChased);
  }

  if (stage === 'heuristic') set('T9 pace gap', gap, bars.heuristic);

  return checks;
}

async function measure(track: SuiteTrack, search: boolean): Promise<TrackRow> {
  const reference = readReference(track.name);

  if (!reference) throw new Error(`No reference for ${track.name}: run run-reference.ts first`);

  const bars = barsFor(track);
  let searchedAgain: boolean | null = null;
  let refined = reference.refined;

  if (search && !track.def.builtIn) {
    const run = await runSearch(pool, track, {}, []);

    searchedAgain = run.best.offsets.every((v, i) => v === reference.refined[i]);
    refined = run.best.offsets;
  }

  const lines: [Stage, number, readonly number[]][] = track.def.builtIn
    ? [['shipped', 0, baseLine().offsets]]
    : [
        ['centre', 0, new Array<number>(track.size).fill(0)],
        ['heuristic', HEURISTIC_EVALS, reference.heuristic],
        ['refined', reference.gameBudget, refined],
      ];
  const [ref, ...validations] = await Promise.all([
    validate(pool, track, reference.offsets),
    ...lines.map(([, , offsets]) => validate(pool, track, offsets)),
  ]);

  console.log(`${track.name} measured, ${Math.round((performance.now() - started) / 1000)} s`);

  return {
    name: track.name,
    lap: track.lap,
    size: track.size,
    uTurns: track.uTurns,
    groups: track.groups,
    gameBudget: reference.gameBudget,
    referenceBudget: reference.budget,
    bars,
    reference: ref,
    searchedAgain,
    stages: lines.map(([stage, evals], i) => ({
      stage,
      evals,
      validation: validations[i],
      checks: judge(stage, validations[i], ref, bars),
    })),
  };
}

const rows = await Promise.all(tracks.map((track) => measure(track, argv.includes('--search'))));

await pool.close();

// -- The report

const f = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');
const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const mark = (row: StageRow, name: string, text: string) => {
  const check = row.checks[name];

  return check && !check.ok ? `**${text} FAIL**` : text;
};
const misses: string[] = [];
const lines: string[] = [
  '# Bot competence on the suite',
  '',
  `\`npx tsx scripts/bots/run-suite.ts\`, ${pool.size} threads, ${((performance.now() - started) / 60000).toFixed(1)} min.`,
  "Thresholds are in `suite.ts`. Pace is the pace-1 bot's best flying lap, the mean over 30, 60, 120, 144",
  "and 240 Hz, against the track's reference line (`reference/best-<name>.json`). Walls are hard hits a lap; bars in",
  'brackets. A miss is marked FAIL.',
  '',
  '| Track | Lap m | U / G | Line | Candidates | Pace-1 mean s (gap) | Worst rate gap | Failed laps | Back-outs + respawns | Field respawns / km | Longest crawl s | Ultras a lap [T5] | Walls alone [T6] | Walls chased [T10] | Eased: walls, respawns | Field winner / last s |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];

for (const row of rows) {
  const ref = row.reference;

  lines.push(
    `| ${row.name} | ${f(row.lap, 1)} | ${row.uTurns} / ${row.groups} | reference | ${row.referenceBudget} | ${f(ref.meanPace1)} | | | | | | ${f(ref.solo.ultras / ref.solo.laps)} | ${f(ref.solo.walls / ref.solo.laps, 3)} | ${f(ref.chased.walls / ref.chased.laps)} | | ${f(ref.field.winner)} / ${f(ref.field.last)} |`,
  );

  for (const stage of row.stages) {
    const v = stage.validation;
    const failed = v.solo.failed + v.chased.failed + v.eased.failed + v.field.failed;
    const incidents = [v.solo, v.chased, v.eased].reduce((a, t) => a + t.backouts + t.respawns, 0);
    const crawl = Math.max(v.solo.crawl, v.chased.crawl, v.eased.crawl);
    const gap = v.meanPace1 / ref.meanPace1 - 1;
    const worst = Math.max(...v.pace1.map((t, i) => t / ref.pace1[i] - 1));
    const paceName = stage.stage === 'heuristic' ? 'T9 pace gap' : 'T3 pace gap';

    lines.push(
      `| | | | ${stage.stage} | ${stage.evals || ''} | ${mark(stage, paceName, `${f(v.meanPace1)} (${pct(gap)})`)} | ${mark(stage, 'T4 worst rate gap', pct(worst))} | ${mark(stage, 'T1 failed laps', String(failed))} | ${mark(stage, 'T2 back-outs and respawns', String(incidents))} | ${mark(stage, 'T2 field respawns per km', f(v.field.respawns / v.field.km))} | ${mark(stage, 'T2 longest crawl s', f(crawl))} | ${mark(stage, 'T5 ultras a lap', `${f(v.solo.ultras / v.solo.laps)} [${f(row.bars.ultras)}]`)} | ${mark(stage, 'T6 walls a lap alone', `${f(v.solo.walls / v.solo.laps, 3)} [${f(row.bars.walls, 3)}]`)} | ${mark(stage, 'T10 walls a lap chased', `${f(v.chased.walls / v.chased.laps)} [${f(row.bars.wallsChased)}]`)} | ${f(v.eased.walls / v.eased.laps)}, ${v.eased.respawns} | ${f(v.field.winner)} / ${f(v.field.last)} |`,
    );

    for (const [name, check] of Object.entries(stage.checks)) {
      if (!check.ok) misses.push(`${row.name} ${stage.stage}: ${name} ${f(check.value, 3)} against ${f(check.bar, 3)}`);
    }
  }
}

lines.push('', '## Pace-1 best flying lap at each rate (s)', '', `| Track | Line | ${SOLO_RATES.join(' Hz | ')} Hz |`);
lines.push(`|---|---|${SOLO_RATES.map(() => '---|').join('')}`);

for (const row of rows) {
  lines.push(`| ${row.name} | reference | ${row.reference.pace1.map((t) => f(t, 3)).join(' | ')} |`);

  for (const stage of row.stages)
    lines.push(`| | ${stage.stage} | ${stage.validation.pace1.map((t) => f(t, 3)).join(' | ')} |`);
}

const again = rows.filter((row) => row.searchedAgain !== null);

if (again.length > 0) {
  lines.push(
    '',
    '## Searched again at the game budget',
    '',
    ...again.map(
      (row) => `- ${row.name}: ${row.searchedAgain ? 'the same line as the reference checkpoint' : 'DIFFERENT'}`,
    ),
  );

  for (const row of again) if (!row.searchedAgain) misses.push(`${row.name}: the search found a different line`);
}

lines.push('', misses.length === 0 ? 'Every bar met.' : `## Misses\n\n${misses.map((m) => `- ${m}`).join('\n')}`, '');

mkdirSync(path.join(here, 'results'), { recursive: true });

if (names.length === 0) {
  writeFileSync(path.join(here, 'results/suite.md'), lines.join('\n'));
  writeFileSync(path.join(here, 'results/suite.json'), `${JSON.stringify(rows, null, 1)}\n`);
}

console.log(lines.join('\n'));
process.exitCode = misses.length === 0 ? 0 : 1;
