/**
 * The scenery rules, checked in Node on every check track and on random ones from the editor's generator. Each plan is worked out by `planVenue`; this re-measures it with its own
 * arithmetic, so a rule that slips shows here rather than in a dark corner of somebody's track.
 *
 * 1. Towers: at most 24; masts clear of every road by 5.5 and 12 apart; lane dividers only on the shared barrier of
 *    two parallel straights, 8 from any other tower. `max`, `long500` and `comb` have dividers.
 * 2. Light: every road sample 5 m apart within 14 m of an aim point (`plan.dark` 0), and with every tower lit, at
 *    least 55% of the road, a metre at a time, gets the light of a quarter of Night Run's median (Night Run: 68%).
 * 3. The light pool: a truck lapping twice, from a cold start, always has the tower whose aim point is nearest the
 *    point 15 m ahead of it among the six lit.
 * 4. Tunnel posts at least 3.9 from every other road; 4 to 12 TV cranes with every road sample within 32 of one; no
 *    scenery on the road, a tower's foot, a crane or beside the tunnel, no forest beside a crane, at most 360 pieces;
 *    the same plan for the same seed, and the same towers, tunnel and cranes for any seed.
 *
 *   npx tsx scripts/venue/check-plans.ts [count]
 *
 * `count` random tracks, 500 by default, from seeds 1 up. Exits 1 on any failure.
 */

import { LampPool } from '../../src/look/set/LampPool';
import type { PointOut } from '../../src/race/route';
import { CELL, Route } from '../../src/race/route';
import type { TrackDef } from '../../src/track/code';
import { BASE_TRACK, decodeTrack, isTrackError, trackFromTurns } from '../../src/track/code';
import { generateTurns } from '../../src/track/generate';
import { TRACK_SUITE } from '../../src/track/hooks';
import type { VenuePlan } from '../../src/track/plan';
import {
  COVER_M,
  CRANE_REACH,
  GANTRY_LATERAL,
  LIT_E,
  MAX_SCENERY,
  MAX_TOWERS,
  planVenue,
  POST_CLEARANCE,
  SAMPLE_STEP,
  towerLamp,
  lampLightAt,
} from '../../src/track/plan';

const LIT_MIN = 0.55;
const MAST_CLEARANCE = 5.5;
const MAST_SPACING = 12;
const DIVIDER_SPACING = 8;
const LAMPS = 6;
const LAMP_LEAD = 15;
const MIN_CRANES = 4;
const MAX_CRANES = 12;
/** Tracks that pack their lanes so close that only lane dividers light their middles. */
const NEEDS_DIVIDERS = ['max', 'long500', 'comb'];
const EPS = 1e-9;

const count = Number(process.argv[2] ?? 500);
const failures: string[] = [];
const spot = { s: 0, lateral: 0, heading: 0 };
const p: PointOut = { x: 0, y: 0, z: 0 };
const q: PointOut = { x: 0, y: 0, z: 0 };

interface Row {
  name: string;
  cells: number;
  lap: number;
  masts: number;
  dividers: number;
  lit: number;
  tunnel: boolean;
  cranes: number;
  scenery: number;
  poolMoves: number;
  ms: number;
}

const key = (gx: number, gz: number): string => `${gx},${gz}`;
const cellOf = (point: PointOut): string => key(Math.floor(point.x / CELL), Math.floor(point.z / CELL));

function fail(name: string, message: string): void {
  failures.push(`${name}: ${message}`);
}

/** Whether the barrier `lateral` off the road at `s` is shared by two parallel straights, neither the finish. */
function onSharedBarrier(def: TrackDef, route: Route, s: number, lateral: number): boolean {
  const index = new Map(def.cells.map(([x, z], i) => [key(x, z), i]));
  const side = Math.sign(lateral);
  const n = def.cells.length;

  // A metre in from the barrier on either side, a little way along it either way.
  for (const along of [-0.9, 0.9]) {
    route.point(s + along, lateral - side, p);
    route.point(s + along, lateral + side, q);

    const own = index.get(cellOf(p));
    const across = index.get(cellOf(q));

    if (own === undefined || across === undefined || own === 0 || across === 0) return false;
    if (def.turns[own] !== 'S' || def.turns[across] !== 'S') return false;

    const axis = (i: number): boolean => def.cells[i][0] !== def.cells[(i + n - 1) % n][0];

    if (axis(own) !== axis(across)) return false;
  }

  return Math.abs(Math.abs(lateral) - CELL / 2) < 0.01;
}

function check(name: string, def: TrackDef): Row {
  const route = new Route(def.cells);
  const started = performance.now();
  const plan = planVenue(def, route, 1);
  const ms = performance.now() - started;
  const lap = route.lapLength;
  const feet = plan.towers.map((tower) => {
    route.point(tower.s, tower.lateral, p);

    return { x: p.x, z: p.z, kind: tower.kind };
  });

  // 1. Towers.
  if (plan.towers.length > MAX_TOWERS) fail(name, `${plan.towers.length} towers`);

  plan.towers.forEach((tower, i) => {
    const foot = feet[i];

    if (tower.kind === 'mast') {
      const clearance = Math.abs(route.project(foot.x, foot.z, spot).lateral);

      if (clearance < MAST_CLEARANCE - EPS) fail(name, `mast ${i} ${clearance.toFixed(2)} from the road`);
    } else if (!onSharedBarrier(def, route, tower.s, tower.lateral)) {
      fail(name, `divider ${i} at s ${tower.s.toFixed(1)} isn't on a shared straight barrier`);
    }

    for (let j = 0; j < i; j++) {
      const gap = Math.hypot(feet[j].x - foot.x, feet[j].z - foot.z);
      const need = tower.kind === 'mast' && feet[j].kind === 'mast' ? MAST_SPACING : DIVIDER_SPACING;

      if (gap < need - EPS) fail(name, `towers ${j} and ${i} ${gap.toFixed(2)} apart`);
    }
  });

  const dividers = plan.towers.filter((tower) => tower.kind === 'divider').length;

  if (NEEDS_DIVIDERS.includes(name) && dividers === 0) fail(name, 'no lane dividers');

  // 2. Light.
  const aims = plan.towers.map((tower) => {
    route.point(tower.aimS, tower.aimLateral, q);

    return { x: q.x, z: q.z };
  });
  let dark = 0;

  for (let s = 0; s < lap; s += SAMPLE_STEP) {
    route.point(s, 0, p);
    if (!aims.some((aim) => Math.hypot(aim.x - p.x, aim.z - p.z) <= COVER_M)) dark++;
  }

  if (dark > 0 || plan.dark !== 0) fail(name, `${dark} road samples beyond every aim point (plan says ${plan.dark})`);

  const lamps = plan.towers.map((tower) => towerLamp(tower, route));
  let lit = 0;
  let metres = 0;

  for (let s = 0; s < lap; s += 1, metres++) {
    route.point(s, 0, p);

    let light = 0;

    for (const lamp of lamps) light += lampLightAt(lamp, p.x, p.z);

    if (light >= LIT_E) lit++;
  }

  const litShare = lit / metres;

  if (litShare < LIT_MIN) fail(name, `${(litShare * 100).toFixed(1)}% of the road lit`);

  // 3. The light pool, over two laps from a cold start, a sample every quarter second.
  let poolMoves = 0;

  if (plan.towers.length > LAMPS) {
    const pool = new LampPool(
      aims.flatMap((aim) => [aim.x, aim.z]),
      LAMPS,
    );
    let last = [...pool.towers];

    for (let k = 0, s = 0; s < 2 * lap; k++, s += SAMPLE_STEP) {
      route.point(s + LAMP_LEAD, 0, p);
      pool.rank(p.x, p.z, k * 0.25);

      let nearest = 0;

      for (let t = 1; t < aims.length; t++) {
        if (Math.hypot(aims[t].x - p.x, aims[t].z - p.z) < Math.hypot(aims[nearest].x - p.x, aims[nearest].z - p.z)) {
          nearest = t;
        }
      }

      if (!pool.towers.includes(nearest)) fail(name, `at s ${s % lap} the nearest tower, ${nearest}, is dark`);

      if (k > 0) poolMoves += pool.towers.filter((tower, i) => tower !== last[i]).length;

      last = [...pool.towers];
    }
  }

  // 4. Tunnel, cranes and scenery.
  const reserved = new Set<string>();

  for (const s of plan.gantries) {
    for (const side of [-1, 1]) {
      route.point(s, side * GANTRY_LATERAL, p);

      const clearance = Math.abs(route.project(p.x, p.z, spot).lateral);

      if (clearance < POST_CLEARANCE - EPS)
        fail(name, `a tunnel post at s ${s.toFixed(1)} ${clearance.toFixed(2)} from a road`);

      route.point(s, side * CELL, p);
      reserved.add(cellOf(p));
    }
  }

  if (plan.tvSpots.length < MIN_CRANES || plan.tvSpots.length > MAX_CRANES) {
    fail(name, `${plan.tvSpots.length} TV cranes`);
  }

  let unseen = 0;

  for (let s = 0; s < lap; s += SAMPLE_STEP) {
    route.point(s, 0, p);
    if (!plan.tvSpots.some(([x, , z]) => Math.hypot(x - p.x, z - p.z) <= CRANE_REACH)) unseen++;
  }

  if (unseen > 0) fail(name, `${unseen} road samples further than ${CRANE_REACH} from every TV crane`);

  const cranes = new Set(plan.tvSpots.map(([x, , z]) => key(Math.floor(x / CELL), Math.floor(z / CELL))));
  const road = new Set(def.cells.map(([x, z]) => key(x, z)));

  for (const cell of cranes) reserved.add(cell);

  plan.towers.forEach((tower, i) => {
    if (tower.kind === 'mast') reserved.add(key(Math.floor(feet[i].x / CELL), Math.floor(feet[i].z / CELL)));
  });

  if (plan.scenery.length > MAX_SCENERY) fail(name, `${plan.scenery.length} scenery pieces`);

  for (const { gx, gz, key: model } of plan.scenery) {
    const cell = key(gx, gz);

    if (road.has(cell)) fail(name, `scenery on the road at ${cell}`);
    if (reserved.has(cell)) fail(name, `scenery on a reserved cell at ${cell}`);

    for (let dz = -1; dz <= 1 && model === 'decoration-forest'; dz++) {
      for (let dx = -1; dx <= 1; dx++)
        if (cranes.has(key(gx + dx, gz + dz))) fail(name, `forest beside a crane at ${cell}`);
    }
  }

  const again = planVenue(def, route, 1);
  const other = planVenue(def, route, 2);
  const fixed = (plan: VenuePlan) => JSON.stringify([plan.towers, plan.gantries, plan.flickerGantry, plan.tvSpots]);

  if (JSON.stringify(again) !== JSON.stringify(plan)) fail(name, 'the same seed made a different plan');
  if (fixed(other) !== fixed(plan)) fail(name, 'another seed moved the towers, tunnel or cranes');

  return {
    name,
    cells: def.cells.length,
    lap,
    masts: plan.towers.length - dividers,
    dividers,
    lit: litShare,
    tunnel: plan.gantries.length > 0,
    cranes: plan.tvSpots.length,
    scenery: plan.scenery.length,
    poolMoves,
    ms,
  };
}

const rows: Row[] = [];

for (const [name, code] of Object.entries(TRACK_SUITE)) {
  const def = decodeTrack(code);

  if (isTrackError(def)) {
    fail(name, `doesn't decode: ${def}`);
    continue;
  }

  // The suite's own Night Run is the curated venue, which keeps its own look; plan it as any other track too.
  rows.push(check(def.builtIn ? `${name} (rules)` : name, def.builtIn ? { ...BASE_TRACK, code, builtIn: false } : def));
}

const generated: Row[] = [];

for (let seed = 1; seed <= count; seed++) {
  const def = trackFromTurns(generateTurns(seed));

  if (isTrackError(def)) {
    fail(`seed ${seed}`, `generated an invalid track: ${def}`);
    continue;
  }

  generated.push(check(`seed ${seed}`, def.builtIn ? { ...def, builtIn: false } : def));
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);

console.log('track         cells   lap  masts div  lit%  tunnel cranes scenery moves/2 laps  ms');

for (const row of rows) {
  console.log(
    `${row.name.padEnd(12)} ${pad(row.cells, 5)} ${pad(row.lap.toFixed(0), 5)} ${pad(row.masts, 6)} ${pad(row.dividers, 3)} ${pad((row.lit * 100).toFixed(1), 5)} ${pad(row.tunnel ? 'yes' : 'no', 7)} ${pad(row.cranes, 6)} ${pad(row.scenery, 7)} ${pad(row.poolMoves, 12)} ${pad(row.ms.toFixed(1), 5)}`,
  );
}

const worst = <K extends keyof Row>(field: K, pick: (a: number, b: number) => number): number =>
  generated.reduce(
    (best, row) => pick(best, row[field] as number),
    generated.length ? (generated[0][field] as number) : 0,
  );

console.log(
  `\n${generated.length} random tracks: lit ${(worst('lit', Math.min) * 100).toFixed(1)}% at least, ` +
    `${worst('masts', Math.max)} masts and ${worst('dividers', Math.max)} dividers at most, ` +
    `${generated.filter((row) => row.tunnel).length} with a tunnel, ${worst('cranes', Math.max)} cranes and ` +
    `${worst('scenery', Math.max)} scenery pieces at most, planned in ${worst('ms', Math.max).toFixed(1)} ms at worst`,
);

if (failures.length > 0) {
  console.log(`\n${failures.length} failures:`);
  for (const failure of failures.slice(0, 50)) console.log(`  ${failure}`);
  process.exit(1);
}

console.log('\nEvery plan passes.');
