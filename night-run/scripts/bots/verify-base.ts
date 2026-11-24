/**
 * Night Run must race exactly as it first shipped: this checks the pure modules and the physics in Node, bit for bit,
 * against `reference/base.json`, recorded from that version's own route functions, rules, bot and walls.
 *
 * - The route: lap length, cells, the finish and arch points, and every point, projection and turn sampled over the
 *   lap, compared as the doubles' bytes.
 * - The venue's walls, from `planVenue`, every number.
 * - Races: a four-bot field over 2 laps, then one bot alone over 4 laps from the grid at paces 1, 0.92 and 0.85, at
 *   60 and 120 Hz, in `Race.update`'s order with the project's own `Vehicle`, `PhysicsWorld`, `DriftBoost`,
 *   `RaceRules` and `BotDriver`: every lap time, finish time, ultra and respawn, and where each truck ends up.
 * - A track switch as the game makes one: on one `PhysicsWorld`, Night Run, then the oval (its statics cleared and
 *   the oval's added, a field of bots racing it), then Night Run again, whose solo race must match the reference.
 *
 * It re-implements `Race.update`'s loop, so it can't see how `Race` and `Game` wire the course; the attract
 * fingerprint (`scripts/base/attract-fingerprint.mjs`) covers that in the browser.
 *
 * `--codes` checks the track and line formats instead: every suite code decodes and re-encodes, one bad case per
 * error is refused with that error, lines come back within 0.0014 m, and the room's limits are exactly Night Run's.
 *
 *   npx tsx scripts/bots/verify-base.ts [--codes]
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RigidBody } from 'crashcat';

import { DriftBoost, ULTRA_SECONDS } from '../../src/DriftBoost';
import { minLapMs, minProgress } from '../../src/net/messages';
import type { WallSpec } from '../../src/Physics';
import { PhysicsWorld, TRUCK_BALL_RADIUS } from '../../src/Physics';
import { BOT_SKILLS, BotDriver } from '../../src/race/BotDriver';
import type { CourseView } from '../../src/race/course';
import { baseLine, centreLine, decodeLine, encodeLine, lineFor, lineSize } from '../../src/race/line/RacingLine';
import type { RacerProgress, TrackSpot } from '../../src/race/RaceRules';
import { gridDistance, gridSpot, RaceRules } from '../../src/race/RaceRules';
import { ARCH_TOP, BASE_LAP_LENGTH, BASE_ROUTE, FINISH_LINE, Route } from '../../src/race/route';
import type { TruckPose } from '../../src/race/truck';
import { createTruckPose } from '../../src/race/truck';
import { BASE_PIECES } from '../../src/track/base';
import type { TrackDef, TrackError } from '../../src/track/code';
import {
  BASE_TRACK,
  BASE_TURNS,
  decodeTrack,
  encodeTurns,
  isTrackError,
  MAX_CELLS,
  roomTrackCode,
  trackFromTurns,
  turnsFromLoop,
} from '../../src/track/code';
import { generateTurns } from '../../src/track/generate';
import { buildWallColliders, piecesFor } from '../../src/track/pieces';
import type { VenuePlan } from '../../src/track/plan';
import { planVenue } from '../../src/track/plan';
import { Vehicle } from '../../src/Vehicle';

const here = path.dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);

  if (!ok) failures.push(name);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The check tracks, by name. */
const SUITE: Readonly<Record<string, string>> = {
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

// -- The race loop: Race.update's order (src/Race.ts), with Race._place's forgetMotion on every placement.

const LAUNCH_SECONDS = 0.8;
const COAST = 0.55;
const RESPAWN_CLEARANCE = 1.3;
const IDLE = { x: 0, z: 0, touchActive: false };

interface SimRacer {
  id: string;
  body: RigidBody;
  vehicle: Vehicle;
  boost: DriftBoost;
  brain: BotDriver;
  pose: TruckPose;
  progress: RacerProgress;
  laps: number[];
  finishTime: number;
  respawns: number;
  ultras: number;
}

/** Put a venue's ground and walls on a world in place of whatever track's were there, as `Venue.build` does. */
function setStatics(physics: PhysicsWorld, plan: VenuePlan): PhysicsWorld {
  const { x, z, half } = plan.ground;

  physics.clearStatics();
  physics.addStaticGround([x, -0.125, z], [half, 0.01, half]);

  for (const wall of plan.walls) physics.addStaticBox(wall);

  return physics;
}

/**
 * A race of bots from the grid, one per pace, on a world that has its track's statics. The trucks' balls stay on it
 * afterwards, as the game's do until the next staging clears the race.
 */
function race(course: CourseView, physics: PhysicsWorld, paces: readonly number[], laps: number, dt: number) {
  const rules = new RaceRules(course, laps);
  const spot: TrackSpot = { x: 0, y: 0, z: 0, yaw: 0 };
  const racers: SimRacer[] = paces.map((pace, i) => {
    gridSpot(course.route, i, spot);

    const body = physics.addTruckBall(spot.x, spot.y + TRUCK_BALL_RADIUS, spot.z, false, null);

    return {
      id: `bot${i}`,
      body,
      vehicle: new Vehicle(physics, body),
      boost: new DriftBoost(),
      brain: new BotDriver({ pace }),
      pose: createTruckPose(),
      progress: rules.add(`bot${i}`, i),
      laps: [],
      finishTime: -1,
      respawns: 0,
      ultras: 0,
    };
  });
  const place = (r: SimRacer, s: TrackSpot) => {
    r.vehicle.place(s.x, s.y, s.z, s.yaw);
    r.vehicle.writePose(r.pose, 0);
    rules.forgetMotion(r.id);
  };

  racers.forEach((r, i) => place(r, gridSpot(course.route, i, spot)));
  rules.reset(laps);
  racers.forEach((r, i) => {
    place(r, gridSpot(course.route, i, spot));
    r.boost.reset();
    r.brain.reset();
  });

  rules.onLap = (entry, lapTime) => racers.find((r) => r.progress === entry)!.laps.push(lapTime);
  rules.onFinish = (entry) => {
    const r = racers.find((x) => x.progress === entry)!;

    r.laps.push(entry.lastLap);
    r.finishTime = entry.finishTime;
  };

  let driving = false;
  let steps = 0;

  const respawn = (r: SimRacer) => {
    if (!rules.respawnSpot(r.id, spot)) return;

    for (const other of racers) {
      if (other === r) continue;

      if (Math.hypot(other.pose.x - spot.x, other.pose.z - spot.z) < RESPAWN_CLEARANCE) {
        r.progress.lateral = other.progress.lateral > 0 ? -1.6 : 1.6;
        rules.respawnSpot(r.id, spot);
      }
    }

    place(r, spot);
    r.boost.reset();
    r.brain.reset();
    r.respawns++;
  };

  const step = () => {
    steps++;

    // Race._rubberBand with nobody but bots: everyone races the pack's average.
    let sum = 0;

    for (const r of racers) sum += r.progress.distance;

    const reference = racers.length > 0 ? sum / racers.length : 0;

    for (const r of racers) {
      let input = IDLE;

      if (driving) {
        input = r.brain.update(dt, r.pose, r.progress, rules.entries, reference, course);
        r.vehicle.topSpeedScale = r.brain.speedScale;

        if (r.progress.finished) input.z = Math.min(input.z, COAST);
      }

      r.vehicle.drive(dt, input);
    }

    physics.step(dt);

    for (const r of racers) {
      r.vehicle.settle(dt);

      if (driving && !r.progress.finished && r.boost.update(dt, r.vehicle)) {
        r.vehicle.boost(ULTRA_SECONDS);
        r.ultras++;
      }

      r.vehicle.writePose(r.pose, r.boost.stage);
      rules.observe(r.id, r.pose.x, r.pose.y, r.pose.z, dt);
    }

    rules.update(dt);

    for (const r of racers) {
      if (r.progress.offTrack || r.progress.stuck) respawn(r);
    }
  };

  for (let t = 0; t < 1; t += dt) step();

  rules.start();
  driving = true;

  for (const r of racers) r.vehicle.boost(LAUNCH_SECONDS);

  while (rules.time < 120 && !racers.every((r) => r.progress.finished)) step();

  const results = racers.map((r, i) => ({
    pace: paces[i],
    laps: r.laps,
    finishTime: r.finishTime,
    respawns: r.respawns,
    ultras: r.ultras,
    distance: r.progress.distance,
    end: [r.pose.x, r.pose.y, r.pose.z, r.pose.yaw, r.pose.speed],
    steps,
  }));

  return { results, bodies: racers.map((r) => r.body) };
}

/** A sample stream's fingerprint: the doubles' own bytes, so any change in any bit shows. */
function digest(values: number[]): { count: number; sha256: string } {
  return {
    count: values.length,
    sha256: createHash('sha256')
      .update(new Uint8Array(new Float64Array(values).buffer))
      .digest('hex'),
  };
}

function verifyBase(): void {
  const reference = JSON.parse(readFileSync(path.join(here, 'reference/base.json'), 'utf8'));
  const route = BASE_ROUTE;
  const course: CourseView = { route, line: baseLine() };
  const plan = planVenue(BASE_TRACK, route, 0);

  check('lap length', route.lapLength === reference.lapLength, `${route.lapLength}`);
  check('cells', same(BASE_TRACK.cells, reference.cells));
  check('finish line and arch top', same(FINISH_LINE, reference.finishLine) && same(ARCH_TOP, reference.archTop));
  check('walls', same(plan.walls, reference.walls), `${plan.walls.length} walls`);

  const point = { x: 0, y: 0, z: 0 };
  const points: number[] = [];

  for (let s = -10; s < route.lapLength + 10; s += 0.37) {
    for (const lateral of [-2, 0, 1.5]) {
      const yaw = route.point(s, lateral, point);

      points.push(point.x, point.z, yaw);
    }
  }

  const spot = { s: 0, lateral: 0, heading: 0 };
  const projections: number[] = [];

  for (let x = -30; x <= 10; x += 0.9) {
    for (let z = -30; z <= 25; z += 0.9) {
      route.project(x, z, spot);
      projections.push(spot.s, spot.lateral, spot.heading);
    }
  }

  const turns: number[] = [];

  for (let s = -5; s < route.lapLength + 5; s += 0.29)
    turns.push(route.turn(s), route.distanceToTurn(s, 20), route.wrap(s));

  check('route points', same(digest(points), reference.samples.points));
  check('route projections', same(digest(projections), reference.samples.projections));
  check('route turns', same(digest(turns), reference.samples.turns));

  const grid = [0, 1, 2, 3].map((slot) => {
    const g = gridSpot(route, slot, { x: 0, y: 0, z: 0, yaw: 0 });

    return [g.x, g.y, g.z, g.yaw, gridDistance(slot)];
  });

  check('grid', same(grid, reference.grid));

  // The field first, as recorded: trucks that touch leave state in crashcat that later worlds inherit.
  const field = race(
    course,
    setStatics(new PhysicsWorld(), plan),
    BOT_SKILLS.map((skill) => skill.pace),
    2,
    1 / 60,
  ).results;

  check(
    'field, 2 laps at 60 Hz',
    same(field, reference.field),
    field.map((r) => `${r.pace}: ${r.laps.map((t) => t.toFixed(3)).join(' ')}`).join(' | '),
  );

  for (const hz of [60, 120]) {
    for (const pace of [1, 0.92, 0.85]) {
      const key = `${pace}@${hz}`;
      const [solo] = race(course, setStatics(new PhysicsWorld(), plan), [pace], 4, 1 / hz).results;

      check(`solo ${key}`, same(solo, reference.solo[key]), solo.laps.map((t) => t.toFixed(4)).join(' '));
    }
  }

  roundTrip(reference, course, plan);
}

/**
 * Night Run, the oval and Night Run again on one world, as the game switches tracks: each venue's statics replace the
 * last's while the last race's trucks still stand, then the next race clears those and seats its own. Night Run's
 * solo race after the trip must be the reference's.
 */
function roundTrip(reference: { solo: Record<string, unknown> }, course: CourseView, plan: VenuePlan): void {
  const oval = decodeTrack(SUITE.oval) as TrackDef;
  const ovalRoute = new Route(oval.cells);
  const ovalPlan = planVenue(oval, ovalRoute, 1);
  const physics = new PhysicsWorld();
  let parked: RigidBody[] = [];
  const leg = (venue: VenuePlan, on: CourseView, paces: readonly number[], laps: number) => {
    setStatics(physics, venue);

    for (const body of parked) physics.removeBody(body);

    const { results, bodies } = race(on, physics, paces, laps, 1 / 60);

    parked = bodies;

    return results;
  };

  leg(plan, course, [1], 1);

  const field = leg(
    ovalPlan,
    { route: ovalRoute, line: centreLine(ovalRoute) },
    BOT_SKILLS.map((skill) => skill.pace),
    2,
  );

  check(
    'oval field on the switched world',
    physics.staticCount === ovalPlan.walls.length + 1 && field.every((r) => r.finishTime > 0 && r.respawns === 0),
    `${ovalPlan.walls.length} walls; ${field.map((r) => `${r.pace}: ${r.laps.map((t) => t.toFixed(3)).join(' ')}`).join(' | ')}`,
  );

  const [solo] = leg(plan, course, [1], 4);

  check(
    'solo 1@60 after Night Run, the oval and Night Run on one world',
    physics.staticCount === plan.walls.length + 1 && same(solo, reference.solo['1@60']),
    solo.laps.map((t) => t.toFixed(4)).join(' '),
  );
}

function verifyCodes(): void {
  const decoded: Record<string, TrackDef> = {};

  for (const [name, code] of Object.entries(SUITE)) {
    const def = decodeTrack(code, name);

    if (isTrackError(def)) {
      check(`suite ${name} decodes`, false, def);
      continue;
    }

    decoded[name] = def;

    const again = name === 'base' ? def.code === '' : encodeTurns(def.turns) === code && def.code === code;

    check(`suite ${name}`, again, `${def.turns.length} cells, ${new Route(def.cells).lapLength.toFixed(1)} m`);
  }

  check('max is the largest track', decoded.max?.turns.length === MAX_CELLS && SUITE.max.length === 43);
  check('Night Run by code', decodeTrack('') === BASE_TRACK && decodeTrack('1gIkII8') === BASE_TRACK);
  check('Night Run turns from its cells', turnsFromLoop(BASE_TRACK.cells, 0) === BASE_TURNS);

  const derived = buildWallColliders(piecesFor(BASE_TRACK.cells));
  const shipped = buildWallColliders(BASE_PIECES);
  // A box turned half a turn is the same box, so compare each box's axis modulo half a turn.
  const key = (w: WallSpec) => {
    const yaw = 2 * Math.atan2(w.quaternion[1], w.quaternion[3]);

    return [...w.position, ...w.halfExtents, Math.cos(2 * yaw), Math.sin(2 * yaw)]
      .map((v) => (v + 1e-9).toFixed(6))
      .join(',');
  };

  check(
    'derived pieces make Night Run walls',
    same(derived.map(key).sort(), shipped.map(key).sort()),
    `${derived.length} walls`,
  );

  const turns = (code: string) => (isTrackError(decodeTrack(code)) ? '' : (decodeTrack(code) as TrackDef).turns);
  const oval = turns(SUITE.oval);
  const tall = 'S'.repeat(12) + 'RR' + 'S'.repeat(13) + 'RR' + 'S';
  const bad: [TrackError, string][] = [
    ['version', '2gIkII8'],
    ['characters', '1gI!II8'],
    ['characters', `1${'A'.repeat(64)}`],
    ['characters', `${SUITE.base}_`],
    ['length', '1g'],
    ['open', encodeTurns('SSRSSSSSSS')],
    ['crossing', encodeTurns(oval + oval)],
    ['start', encodeTurns(oval.slice(1) + oval[0])],
    ['size', encodeTurns(tall)],
  ];

  for (const [error, code] of bad)
    check(`refuses ${code} as ${error}`, decodeTrack(code) === error, `${decodeTrack(code)}`);

  check('refuses turns with other letters', trackFromTurns('SSRRSSSRRX') === 'characters');

  let generated = 0;

  for (let seed = 1; seed <= 300; seed++) if (!isTrackError(trackFromTurns(generateTurns(seed)))) generated++;

  check('generated tracks are valid', generated === 300, `${generated} of 300 seeds`);

  for (const name of ['oval', 'gen-2', 'max']) {
    const route = new Route(decoded[name].cells);
    const n = lineSize(route);
    const offsets = Array.from({ length: n }, (_, i) => 2.85 * Math.sin(i * 1.7) * Math.cos(i * 0.31));
    const line = decodeLine(encodeLine(lineFor(route, offsets)), route);
    const worst = line ? Math.max(...offsets.map((o, i) => Math.abs(o - line.offsets[i]))) : Infinity;

    check(`line round trip on ${name}`, worst <= 0.0014, `${n} offsets, worst ${worst.toExponential(2)} m`);
    check(
      `line for another track refused on ${name}`,
      decodeLine(encodeLine(lineFor(route, offsets.slice(1))), route) === null,
    );
  }

  check('base line size', lineSize(BASE_ROUTE) === 44 && baseLine().offsets.length === 44);
  check("roomTrackCode(undefined) === ''", roomTrackCode(undefined) === '' && roomTrackCode(7) === '');
  check('minProgress(BASE_LAP_LENGTH) === -0.05', minProgress(BASE_LAP_LENGTH) === -0.05);
  check('minLapMs(BASE_LAP_LENGTH) === 3000', minLapMs(BASE_LAP_LENGTH) === 3000);
}

if (process.argv.includes('--codes')) verifyCodes();
else verifyBase();

console.log(failures.length === 0 ? '\nall exact' : `\n${failures.length} failed: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
