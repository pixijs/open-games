/**
 * A race with nobody watching: the game's own trucks, physics, drift boost, rules and bot brain on a track's ground and
 * walls, stepped in `Race.update`'s order, with no renderer. The line search races candidates in it, and the bot checks
 * measure lines in it. A lone truck repeats exactly, whatever raced before it, so a line's score doesn't depend on
 * which worker raced it.
 */

import type { RigidBody } from 'crashcat';
import { rigidBody } from 'crashcat';

import { DriftBoost, ULTRA_SECONDS } from '../../DriftBoost';
import type { WallSpec } from '../../Physics';
import { PhysicsWorld, TRUCK_BALL_RADIUS } from '../../Physics';
import type { TrackDef } from '../../track/code';
import { rng } from '../../track/generate';
import { planVenue } from '../../track/plan';
import { Vehicle } from '../../Vehicle';
import { BotDriver } from '../BotDriver';
import type { CourseView } from '../course';
import type { RacerProgress, TrackSpot } from '../RaceRules';
import { createTrackSpot, gridSpot, RaceRules } from '../RaceRules';
import { BASE_ROUTE, Route } from '../route';
import type { TruckPose } from '../truck';
import { createTruckPose } from '../truck';
import type { RacingLine } from './RacingLine';

/** `Race.ts`'s figures, which a headless race must share to race the same. */
const LAUNCH_SECONDS = 0.8;
const LAUNCH_FLUFF = 0.15;
const COAST = 0.55;
const WALL_HIT = 1.5;
const TRUCK_HIT = 1;
const IMPACT_COOLDOWN = 0.25;
const RESPAWN_CLEARANCE = 1.3;
/** A truck slower than this is crawling, as the brain's stuck test has it. */
const CRAWL_SPEED = 1.2;
const IDLE = { x: 0, z: 0, touchActive: false } as const;
/** The longest frame the game steps, as `Game` caps it. */
const MAX_DT = 1 / 30;

/** A track as a headless race needs it: its route, and the venue's ground slab and walls. */
export interface SimTrack {
  readonly code: string;
  readonly route: Route;
  readonly ground: { readonly x: number; readonly z: number; readonly half: number };
  readonly walls: readonly WallSpec[];
}

/**
 * A track ready to race headless, with the same statics its venue builds.
 * @param def - The track.
 * @returns Its route, ground and walls.
 */
export function simTrack(def: TrackDef): SimTrack {
  const route = def.builtIn ? BASE_ROUTE : new Route(def.cells);
  // Trees don't collide, so any seed gives the same ground and walls.
  const plan = planVenue(def, route, 0);

  return { code: def.code, route, ground: plan.ground, walls: plan.walls };
}

/** One headless race. */
export interface SimOptions {
  /** Each bot's pace, 0 to 1 (more for a faster truck than the game's bots, as the search's fast condition races). */
  readonly paces: readonly number[];
  readonly line: RacingLine;
  readonly laps: number;
  /** Seconds a step, as one frame's. */
  readonly dt: number;
  /**
   * Each step's length wavers by up to this share of `dt` either way, as a real frame clock's does, drawn from
   * `seed`; never past the game's longest frame. 0 by default: every step is `dt`.
   */
  readonly jitter?: number;
  /** Seconds of racing after the green light before the race counts as unfinished. */
  readonly maxTime: number;
  /** Seconds on the grid before the green light. */
  readonly countdown?: number;
  /** Every bot launches with a boost, or each fluffs its start as `Race.go` has it, from `seed`. */
  readonly launch?: 'all' | 'random';
  readonly seed?: number;
  /**
   * The rubber band's reference held this far ahead of each bot (behind, when negative), so it races chased or eased;
   * null races the pack's average, as the title's bots do.
   */
  readonly lead?: number | null;
}

/** What one bot did. */
export interface SimBotResult {
  readonly pace: number;
  /** Every completed lap's time, the standing lap first. */
  readonly laps: readonly number[];
  /** Race time at the flag, or -1. */
  readonly finishTime: number;
  /** Hits at {@link WALL_HIT} m/s or more into a wall, one per {@link IMPACT_COOLDOWN} s, as `Race` reports them. */
  readonly wallHits: number;
  readonly truckHits: number;
  readonly backouts: number;
  readonly respawns: number;
  readonly ultras: number;
  /** Longest run of seconds below {@link CRAWL_SPEED} after leaving the grid. */
  readonly crawl: number;
}

/** What a headless race came to. */
export interface SimResult {
  readonly bots: readonly SimBotResult[];
  /** Race time when it stopped. */
  readonly time: number;
  /** Whether every bot took the flag. */
  readonly finished: boolean;
  /** Physics steps taken, the countdown's included. */
  readonly steps: number;
}

interface SimBot {
  readonly id: string;
  readonly pace: number;
  readonly body: RigidBody;
  readonly vehicle: Vehicle;
  readonly boost: DriftBoost;
  readonly brain: BotDriver;
  readonly pose: TruckPose;
  readonly progress: RacerProgress;
  readonly laps: number[];
  finishTime: number;
  impactCooldown: number;
  wallHits: number;
  truckHits: number;
  respawns: number;
  ultras: number;
  slowFor: number;
  crawl: number;
}

/** A headless race that runs a slice at a time, so a worker can stop between slices. */
export class HeadlessRace {
  private readonly _options: SimOptions;
  private readonly _physics = new PhysicsWorld();
  private readonly _rules: RaceRules;
  private readonly _course: CourseView;
  private readonly _bots: SimBot[] = [];
  private readonly _spot: TrackSpot = createTrackSpot();
  private readonly _countdown: number;
  /** Draws each step's waver, when the frame clock wavers. */
  private readonly _clock: (() => number) | null;
  private _idle = 0;
  private _driving = false;
  private _done = false;
  private _steps = 0;

  /**
   * @param track - Where it's raced.
   * @param options - Who races, on what line, for how long.
   */
  constructor(track: SimTrack, options: SimOptions) {
    const { route } = track;
    const physics = this._physics;
    const spot = this._spot;
    const { x, z, half } = track.ground;

    forgetSweptImpulse();
    this._options = options;
    // Its own stream, so a wavering clock leaves the launches `seed` draws as they were.
    this._clock = options.jitter ? rng(((options.seed ?? 1) * 0x9e3779b1) >>> 0) : null;
    this._course = { route, line: options.line };
    this._rules = new RaceRules(this._course, options.laps);
    this._countdown = options.countdown ?? 1;

    physics.addStaticGround([x, -0.125, z], [half, 0.01, half]);

    for (const wall of track.walls) physics.addStaticBox(wall);

    const byBody = new Map<RigidBody, SimBot>();

    options.paces.forEach((pace, i) => {
      gridSpot(route, i, spot);

      const body = physics.addTruckBall(spot.x, spot.y + TRUCK_BALL_RADIUS, spot.z, false, null);
      const bot: SimBot = {
        id: `bot-${i}`,
        pace,
        body,
        vehicle: new Vehicle(physics, body),
        boost: new DriftBoost(),
        brain: new BotDriver({ pace }),
        pose: createTruckPose(),
        progress: this._rules.add(`bot-${i}`, i),
        laps: [],
        finishTime: -1,
        impactCooldown: 0,
        wallHits: 0,
        truckHits: 0,
        respawns: 0,
        ultras: 0,
        slowFor: 0,
        crawl: 0,
      };

      byBody.set(body, bot);
      this._bots.push(bot);
      this._place(bot, spot);
    });

    // Race.toGrid: the rules reset, every truck back on its slot with a clear head.
    this._rules.reset(options.laps);

    for (let i = 0; i < this._bots.length; i++) {
      const bot = this._bots[i];

      this._place(bot, gridSpot(route, i, spot));
      bot.boost.reset();
      bot.brain.reset();
    }

    this._rules.onLap = (entry, lapTime) => this._botOf(entry).laps.push(lapTime);
    this._rules.onFinish = (entry) => {
      const bot = this._botOf(entry);

      bot.laps.push(entry.lastLap);
      bot.finishTime = entry.finishTime;
    };

    physics.listener = {
      onContactAdded: (bodyA, bodyB, manifold, settings) => {
        const a = byBody.get(bodyA);
        const b = byBody.get(bodyB);
        const normal = manifold.worldSpaceNormal;

        if (a && b) {
          settings.combinedFriction = 0;
          settings.combinedRestitution = 0.35;
          this._truckHit(a, b, normal);
        } else if (a || b) {
          this._wallHit((a ?? b)!, a ? 1 : -1, normal);
        }
      },
      onContactPersisted: (bodyA, bodyB, _manifold, settings) => {
        if (byBody.has(bodyA) && byBody.has(bodyB)) {
          settings.combinedFriction = 0;
          settings.combinedRestitution = 0.35;
        }
      },
    };
  }

  /** Physics steps taken so far. */
  public get steps(): number {
    return this._steps;
  }

  /**
   * Race on.
   * @param maxSteps - Steps to take at most in this slice.
   * @returns Whether the race is over: every bot finished, or the time ran out.
   */
  public advance(maxSteps: number): boolean {
    const { dt: frame, maxTime, jitter = 0 } = this._options;
    const clock = this._clock;

    if (this._done) return true;

    for (let i = 0; i < maxSteps; i++) {
      const dt = clock ? Math.min(MAX_DT, frame * (1 + jitter * (2 * clock() - 1))) : frame;

      // Summed step by step, as a frame clock adds up, so the grid wait takes the same steps as the base check's.
      if (!this._driving && this._idle < this._countdown) {
        this._step(dt);
        this._idle += dt;
        continue;
      }

      if (!this._driving) this._go();

      if (this._bots.every((bot) => bot.progress.finished) || this._rules.time >= maxTime) {
        this._done = true;
        break;
      }

      this._step(dt);
    }

    return this._done;
  }

  /** What the race came to so far. */
  public result(): SimResult {
    return {
      bots: this._bots.map((bot) => ({
        pace: bot.pace,
        laps: bot.laps.slice(),
        finishTime: bot.finishTime,
        wallHits: bot.wallHits,
        truckHits: bot.truckHits,
        backouts: bot.brain.backouts,
        respawns: bot.respawns,
        ultras: bot.ultras,
        crawl: bot.crawl,
      })),
      time: this._rules.time,
      finished: this._bots.every((bot) => bot.progress.finished),
      steps: this._steps,
    };
  }

  /** `Race.go`: the clock starts and each bot launches, or fluffs its start. */
  private _go(): void {
    const random = rng(this._options.seed ?? 1);

    this._rules.start();
    this._driving = true;

    for (const bot of this._bots) {
      const launch = this._options.launch === 'random' ? random() >= LAUNCH_FLUFF : true;

      if (launch) bot.vehicle.boost(LAUNCH_SECONDS);
    }
  }

  /** One frame of `Race.update`, with the pack's average or the held lead as each bot's reference. */
  private _step(dt: number): void {
    const bots = this._bots;
    const rules = this._rules;
    const lead = this._options.lead ?? null;
    let sum = 0;

    this._steps++;

    for (const bot of bots) sum += bot.progress.distance;

    const average = bots.length > 0 ? sum / bots.length : 0;

    for (const bot of bots) {
      let input: { x: number; z: number; touchActive: boolean } = IDLE;

      bot.impactCooldown = Math.max(0, bot.impactCooldown - dt);

      if (this._driving) {
        const reference = lead === null ? average : bot.progress.distance + lead;

        input = bot.brain.update(dt, bot.pose, bot.progress, rules.entries, reference, this._course);
        bot.vehicle.topSpeedScale = bot.brain.speedScale;

        if (bot.progress.finished) input.z = Math.min(input.z, COAST);
      }

      bot.vehicle.drive(dt, input);
    }

    this._physics.step(dt);

    for (const bot of bots) {
      bot.vehicle.settle(dt);

      if (this._driving && !bot.progress.finished && bot.boost.update(dt, bot.vehicle)) {
        bot.vehicle.boost(ULTRA_SECONDS);
        bot.ultras++;
      }

      bot.vehicle.writePose(bot.pose, bot.boost.stage);
      rules.observe(bot.id, bot.pose.x, bot.pose.y, bot.pose.z, dt);
    }

    rules.update(dt);

    for (const bot of bots) {
      const progress = bot.progress;

      if (this._driving && !progress.finished) {
        bot.slowFor = bot.pose.speed < CRAWL_SPEED && progress.distance > 0 ? bot.slowFor + dt : 0;
        bot.crawl = Math.max(bot.crawl, bot.slowFor);
      }

      if (progress.offTrack || progress.stuck) this._respawn(bot);
    }
  }

  /** `Race.respawn`: back on the road near where it left it, clear of anyone already there. */
  private _respawn(bot: SimBot): void {
    const spot = this._spot;

    if (!this._rules.respawnSpot(bot.id, spot)) return;

    for (const other of this._bots) {
      if (other === bot) continue;

      if (Math.hypot(other.pose.x - spot.x, other.pose.z - spot.z) < RESPAWN_CLEARANCE) {
        bot.progress.lateral = other.progress.lateral > 0 ? -1.6 : 1.6;
        this._rules.respawnSpot(bot.id, spot);
      }
    }

    this._place(bot, spot);
    bot.boost.reset();
    bot.brain.reset();
    bot.respawns++;
  }

  /** `Race._place` for a driven truck. */
  private _place(bot: SimBot, spot: TrackSpot): void {
    bot.vehicle.place(spot.x, spot.y, spot.z, spot.yaw);
    bot.vehicle.writePose(bot.pose, 0);
    this._rules.forgetMotion(bot.id);
  }

  private _botOf(entry: RacerProgress): SimBot {
    return this._bots.find((bot) => bot.progress === entry)!;
  }

  /** `Race._truckHit`'s count. */
  private _truckHit(a: SimBot, b: SimBot, normal: ArrayLike<number>): void {
    if (a.impactCooldown > 0 && b.impactCooldown > 0) return;

    const va = a.body.motionProperties.linearVelocity;
    const vb = b.body.motionProperties.linearVelocity;
    const closing = (va[0] - vb[0]) * normal[0] + (va[2] - vb[2]) * normal[2];

    if (Math.abs(closing) < TRUCK_HIT) return;

    a.impactCooldown = b.impactCooldown = IMPACT_COOLDOWN;
    a.truckHits++;
    b.truckHits++;
  }

  /** `Race._wallHit`'s count; the ground doesn't count. */
  private _wallHit(bot: SimBot, sign: number, normal: ArrayLike<number>): void {
    if (Math.abs(normal[1]) > 0.7 || bot.impactCooldown > 0) return;

    const v = bot.body.motionProperties.linearVelocity;
    const into = v[0] * normal[0] * sign + v[2] * normal[2] * sign;

    if (into < WALL_HIT) return;

    bot.impactCooldown = IMPACT_COOLDOWN;
    bot.wallHits++;
  }
}

/**
 * Zero the impulse crashcat 0.0.4 carries from one swept (CCD) contact to the next. Its `applyCCD` solves each such
 * contact on one module-wide scratch constraint without clearing the impulse the last one left, so a truck's bounce
 * rounds differently depending on whatever raced before it on the thread: the same field race, or a fast truck's wall
 * hit, came out differently the second time it ran. A swept contact with no mass on either side deactivates the
 * scratch constraint, which zeroes its impulse, so each headless race starts as on a fresh thread. Night Run's own
 * `Race` runs the library as it is.
 */
function forgetSweptImpulse(): void {
  const physics = new PhysicsWorld();
  const ball = physics.addTruckBall(0, 1.5, 0, false, null);
  const motion = ball.motionProperties;

  physics.addStaticGround([0, -0.5, 0], [4, 0.5, 4]);
  motion.invMass = 0;
  motion.invInertiaDiagonal[0] = motion.invInertiaDiagonal[1] = motion.invInertiaDiagonal[2] = 0;
  // Fast, and across the ground too, so the swept friction constraint is deactivated as well.
  rigidBody.setLinearVelocity(physics.world, ball, [12, -60, 0]);
  physics.step(1 / 30);
}

/**
 * A headless race from the grid to the flag, or until its time runs out.
 * @param track - Where it's raced.
 * @param options - Who races, on what line, for how long.
 * @returns What it came to.
 */
export function runRace(track: SimTrack, options: SimOptions): SimResult {
  const race = new HeadlessRace(track, options);

  while (!race.advance(4096));

  return race.result();
}
