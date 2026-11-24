/**
 * The racing-line search for a custom track, and how it scores a line. A candidate is raced alone from the grid in the
 * headless race at a few conditions, each a top speed, a frame rate and a frame clock that wavers as a real one does,
 * since the host's screen and the rubber band set the bots' physics. Its score is the race time plus a cost for every
 * hard wall hit, respawn and back-out.
 *
 * The truck slides through every bend, so a line's lap is chaotic in the conditions: one that threads a corner at
 * 144 Hz can scrape it at 120. Scored at a few fixed conditions, a search learns their luck, and its best-scoring line
 * is the luckiest rather than the most robust. So each CMA-ES generation races at conditions of its own, drawn from
 * the range the game runs at and shared by every candidate in it, so they're ranked fairly; and the line the bots
 * race is chosen on a fixed {@link LINE_PANEL} of conditions no generation races at. Every few generations CMA-ES's
 * mean races the panel, and becomes the line only by beating it there. The heuristic grid races half the panel, and
 * its best few and the centreline race the rest, so its pick beats the centreline on the whole panel or isn't taken.
 *
 * The search runs in stages: the centreline at once, then the heuristic grid's pick, then CMA-ES over the whole line
 * from there, for a budget that grows with the line's points, uncapped: longer tracks need more. A search's first
 * stretch is the same in any longer search on the track, so a reference search run for twice the budget passes
 * through exactly the line the game finds. Pure, and the same in every engine (`cma.ts`): {@link LineSearch} hands out
 * candidates and the conditions to race them at and takes their scores, and whoever drives it races them where it
 * likes.
 */

import { rng } from '../../track/generate';
import type { Route } from '../route';
import { Cma, populationSize } from './cma';
import { heuristicLines, HEURISTIC_CANDIDATES } from './heuristic';
import type { LineStage } from './LineService';
import { LINE_LIMIT, lineFor, lineSize } from './RacingLine';
import type { SimTrack } from './sim';
import { HeadlessRace } from './sim';

/** One way a line is raced: the truck's top speed multiplier, the frame rate, and the frame clock's waver. */
export interface LineCondition {
  readonly speed: number;
  readonly hz: number;
  /** Each frame's length wavers by up to this share either way; 0 for a steady clock. */
  readonly jitter: number;
  /** Seeds the waver. */
  readonly seed: number;
}

/**
 * The conditions the bots' line is chosen on. The grid races the first three; the rest are held out for its best few.
 * Their speeds, rates and seeds are ones no CMA-ES generation draws.
 */
export const LINE_PANEL: readonly LineCondition[] = [
  { speed: 0.95, hz: 30, jitter: 0.1, seed: 1 },
  { speed: 1, hz: 60, jitter: 0, seed: 2 },
  { speed: 1.05, hz: 120, jitter: 0.1, seed: 3 },
  { speed: 1.1, hz: 40, jitter: 0.1, seed: 4 },
  { speed: 0.9, hz: 90, jitter: 0.1, seed: 5 },
  { speed: 1, hz: 144, jitter: 0.1, seed: 6 },
];
/** The panel conditions every grid line races. */
const GRID_PANEL = 3;
/** Grid lines besides the centreline that race the rest of the panel. */
const FINALISTS = 6;
/** Candidates the heuristic stage scores: the grid, then its finalists and the centreline again. */
export const HEURISTIC_EVALS = HEURISTIC_CANDIDATES + 1 + FINALISTS;
/** A CMA-ES generation races one condition from each band: frame rates and top speeds, low to high. */
const BANDS: readonly { readonly hz: readonly [number, number]; readonly speed: readonly [number, number] }[] = [
  { hz: [30, 50], speed: [0.9, 1] },
  { hz: [50, 100], speed: [0.95, 1.05] },
  { hz: [100, 165], speed: [1, 1.1] },
];
/** The most a generation's frame clock wavers. */
const JITTER = 0.15;
/** CMA-ES generations between the mean's races of the panel. */
const CHECK_GENERATIONS = 4;

/** Seconds a hard wall hit costs a line's score. */
export const WALL_COST = 2;
/** Seconds a respawn costs a line's score. */
export const RESPAWN_COST = 5;
/** Seconds a back-out costs a line's score. */
export const BACKOUT_COST = 2;
/** From this lap length a line races one lap a condition rather than two: the standing start matters less. */
export const LONG_LAP = 400;
/**
 * CMA-ES candidates per point of the line, and the fewest on any track. At 800, short tracks' lines stopped 3 to 8%
 * off what the search finds with twice the candidates; at 1600 most come within 3% (`scripts/bots/run-suite.ts`).
 */
const BUDGET_PER_POINT = 18;
const MIN_BUDGET = 1600;
/** CMA-ES's first step, metres, the seed of its samples, and the step it resumes with, as a share of the first. */
const SIGMA = 0.8;
const SEED = 7;
const RESUME_SIGMA = 0.5;
/** Steps a scoring takes between checks, about 20 ms of physics. */
const SLICE_STEPS = 2000;

/** How a line raced: the score, and what made it up. */
export interface LineScore {
  /** Race time over every condition plus the costs; Infinity when a race didn't finish. */
  readonly total: number;
  readonly time: number;
  readonly wallHits: number;
  readonly respawns: number;
  readonly backouts: number;
  readonly ultras: number;
  readonly steps: number;
  /** The last lap at the game's own speed at 60 Hz on a steady clock, when raced so: a pace-1 bot's lap. */
  readonly lapSeconds: number;
}

/**
 * Laps a line races in each condition.
 * @param route - The track's route.
 * @returns 2, or 1 from {@link LONG_LAP} metres.
 */
export function scoreLaps(route: Route): number {
  return route.lapLength < LONG_LAP ? 2 : 1;
}

/**
 * Seconds a race may run before it counts as unfinished: a lap at 4 m/s plus 10 s, a lap.
 * @param route - The track's route.
 * @param laps - Laps raced.
 * @returns Seconds.
 */
export function raceLimit(route: Route, laps: number): number {
  return laps * (route.lapLength / 4 + 10);
}

/**
 * The pace whose lone bot races at a top speed multiplier: a bot's top speed is 1 - 0.3 (1 - pace).
 * @param speed - Top speed multiplier.
 * @returns The pace.
 */
export function paceFor(speed: number): number {
  return 1 + (speed - 1) / 0.3;
}

/** CMA-ES candidates from one race of the panel to the next, that race included. */
function checkPeriod(size: number): number {
  return CHECK_GENERATIONS * populationSize(size) + 1;
}

/**
 * CMA-ES's candidates for a track: 18 a point of its line, at least 1600, rounded up to whole stretches between the
 * mean's races of the panel, so a longer search passes through the same checks.
 * @param route - The track's route.
 * @returns Candidates.
 */
export function refineBudget(route: Route): number {
  const size = lineSize(route);
  const period = checkPeriod(size);

  return Math.ceil(Math.max(MIN_BUDGET, BUDGET_PER_POINT * size) / period) * period;
}

/**
 * The whole search's candidates for a track: the heuristic stage's, then CMA-ES's.
 * @param route - The track's route.
 * @param cap - The last stage searched.
 * @returns Candidates.
 */
export function searchBudget(route: Route, cap: 'heuristic' | 'refined' = 'refined'): number {
  return HEURISTIC_EVALS + (cap === 'refined' ? refineBudget(route) : 0);
}

/** Scores a line a slice at a time, so a worker can stop between slices. */
export class LineScoring {
  private readonly _track: SimTrack;
  private readonly _offsets: readonly number[];
  private readonly _conditions: readonly LineCondition[];
  private readonly _laps: number;
  private _condition = 0;
  private _race: HeadlessRace | null = null;
  private _score = { total: 0, time: 0, wallHits: 0, respawns: 0, backouts: 0, ultras: 0, steps: 0, lapSeconds: 0 };
  private _done = false;

  /**
   * @param track - Where it's raced.
   * @param offsets - The line.
   * @param conditions - What it races at.
   */
  constructor(track: SimTrack, offsets: readonly number[], conditions: readonly LineCondition[]) {
    this._track = track;
    this._offsets = offsets;
    this._conditions = conditions;
    this._laps = scoreLaps(track.route);
  }

  /** The score so far; whole once {@link LineScoring.advance} has said it's done. */
  public get score(): LineScore {
    return this._score;
  }

  /**
   * Race on.
   * @param maxSteps - Physics steps to take at most in this slice.
   * @returns Whether the score is whole.
   */
  public advance(maxSteps = SLICE_STEPS): boolean {
    const track = this._track;
    const route = track.route;
    let left = maxSteps;

    while (!this._done && left > 0) {
      const { speed, hz, jitter, seed } = this._conditions[this._condition];

      this._race ??= new HeadlessRace(track, {
        paces: [paceFor(speed)],
        line: lineFor(route, this._offsets),
        laps: this._laps,
        dt: 1 / hz,
        jitter,
        seed,
        maxTime: raceLimit(route, this._laps),
      });

      const before = this._race.steps;
      const over = this._race.advance(left);

      left -= this._race.steps - before;

      if (over) this._finishCondition(this._conditions[this._condition]);
    }

    return this._done;
  }

  private _finishCondition({ speed, hz, jitter }: LineCondition): void {
    const result = this._race!.result();
    const bot = result.bots[0];
    const score = this._score;

    this._race = null;
    score.steps += result.steps;

    if (!result.finished) {
      score.total = Infinity;
      this._done = true;

      return;
    }

    score.time += result.time;
    score.wallHits += bot.wallHits;
    score.respawns += bot.respawns;
    score.backouts += bot.backouts;
    score.ultras += bot.ultras;
    score.total += result.time + WALL_COST * bot.wallHits + RESPAWN_COST * bot.respawns + BACKOUT_COST * bot.backouts;

    if (speed === 1 && hz === 60 && jitter === 0) score.lapSeconds = bot.laps[bot.laps.length - 1];

    this._condition++;
    this._done = this._condition === this._conditions.length;
  }
}

/**
 * A line's score, raced to the end at once.
 * @param track - Where it's raced.
 * @param offsets - The line.
 * @param conditions - What it races at.
 * @returns Its score.
 */
export function scoreLine(
  track: SimTrack,
  offsets: readonly number[],
  conditions: readonly LineCondition[],
): LineScore {
  const scoring = new LineScoring(track, offsets, conditions);

  while (!scoring.advance(1 << 20));

  return scoring.score;
}

/** Where a search left off, to carry on from: its best line and the candidates it had scored. */
export interface SearchResume {
  readonly offsets: readonly number[];
  readonly evals: number;
  readonly total: number;
  readonly lapSeconds: number;
}

/** How a search runs. */
export interface LineSearchOptions {
  /** The last stage to search: `heuristic` stops after the grid. */
  readonly cap?: 'heuristic' | 'refined';
  /** CMA-ES's candidates, for longer reference searches, rounded up as {@link refineBudget}'s are; its by default. */
  readonly refineBudget?: number;
  /** Carry on from a search that was stopped. */
  readonly resume?: SearchResume | null;
  /** Force CMA-ES's form, for comparing them. */
  readonly separable?: boolean;
}

/** The line the bots race: the best on the panel so far, and how it raced there. */
export interface SearchBest {
  readonly offsets: readonly number[];
  readonly total: number;
  readonly lapSeconds: number;
  readonly wallHits: number;
  readonly ultras: number;
}

/** Candidates to race, and the conditions to race every one of them at. */
export interface LineBatch {
  readonly lines: readonly number[][];
  readonly conditions: readonly LineCondition[];
}

/**
 * What the search asks for next: the grid, then its finalists; a cached line's race of the panel on a resume; CMA-ES
 * generations, and the mean's races of the panel between them.
 */
type Phase = 'grid' | 'finals' | 'rescore' | 'cma' | 'check';

/**
 * One track's search, as a state machine: {@link LineSearch.ask} for the next candidates, race them, and
 * {@link LineSearch.tell} their scores in the same order, until `ask` returns null.
 */
export class LineSearch {
  /** Candidates the whole search scores, the heuristic stage's and the panel's included. */
  public readonly budget: number;
  /** Candidates scored so far, those before a resume included. */
  public evals = 0;
  public best: SearchBest;

  private readonly _route: Route;
  private readonly _size: number;
  private readonly _cap: 'heuristic' | 'refined';
  private readonly _separable: boolean | undefined;
  private _stage: LineStage = 'centre';
  private _phase: Phase = 'grid';
  private _cma: Cma | null = null;
  /** The candidates out for scoring now. */
  private _asked: LineBatch | null = null;
  /** Whether it carries on from a stopped search, round whose best CMA-ES takes a smaller step. */
  private readonly _resumed: boolean = false;
  /** The grid's lines and their scores on the first part of the panel, while its finalists race the rest. */
  private _grid: { lines: readonly number[][]; scores: readonly LineScore[]; finalists: number[] } | null = null;
  /** CMA-ES generations drawn, and since the mean last raced the panel. */
  private _generations = 0;
  private _sinceCheck = 0;

  /**
   * @param route - The track's route.
   * @param options - Its stages, budget and where it resumes.
   */
  constructor(route: Route, options: LineSearchOptions = {}) {
    const cap = options.cap ?? 'refined';
    const resume = options.resume ?? null;
    const size = lineSize(route);
    const period = checkPeriod(size);

    this._route = route;
    this._size = size;
    this._cap = cap;
    this._separable = options.separable;
    this.budget =
      HEURISTIC_EVALS +
      (cap === 'refined' ? Math.ceil((options.refineBudget ?? refineBudget(route)) / period) * period : 0);
    this.best = { offsets: new Array<number>(size).fill(0), total: Infinity, lapSeconds: 0, wallHits: 0, ultras: 0 };

    if (resume && resume.evals >= HEURISTIC_EVALS && resume.offsets.length === size) {
      this.evals = Math.min(resume.evals, this.budget);
      this.best = { ...this.best, offsets: resume.offsets.slice(), total: resume.total, lapSeconds: resume.lapSeconds };
      this._stage = this.evals >= this.budget ? cap : 'heuristic';
      // Its cached line races the panel again first: its quantised offsets may race a little differently.
      this._phase = 'rescore';
      this._resumed = true;
    }
  }

  /** How far the search has come. */
  public get stage(): LineStage {
    return this._stage;
  }

  /** Whether it has nothing left to search. */
  public get done(): boolean {
    return this._stage === this._cap && this.evals >= this.budget;
  }

  /**
   * The next candidates to race, and the conditions to race them at.
   * @returns A batch, or null when the search is over.
   */
  public ask(): LineBatch | null {
    if (this._asked) return this._asked;
    if (this.done) return null;

    switch (this._phase) {
      case 'grid':
        this._asked = { lines: heuristicLines(this._route, this._size), conditions: LINE_PANEL.slice(0, GRID_PANEL) };
        break;
      case 'finals': {
        const grid = this._grid!;

        this._asked = { lines: grid.finalists.map((i) => grid.lines[i]), conditions: LINE_PANEL.slice(GRID_PANEL) };
        break;
      }
      case 'rescore':
        this._asked = { lines: [this.best.offsets.slice()], conditions: LINE_PANEL };
        break;
      case 'check':
        this._asked = { lines: [this._cmaOf().mean], conditions: LINE_PANEL };
        break;
      case 'cma': {
        const cma = this._cmaOf();
        // The budget's last candidate is the mean's last race of the panel.
        const left = this.budget - this.evals - 1;

        if (this._sinceCheck === CHECK_GENERATIONS || left <= 0) {
          this._phase = 'check';

          return this.ask();
        }

        this._asked = { lines: cma.ask(Math.min(cma.lambda, left)), conditions: drawConditions(this._generations) };
        break;
      }
    }

    return this._asked;
  }

  /**
   * The scores of the candidates {@link LineSearch.ask} handed out.
   * @param scores - One per candidate, in order.
   * @returns Whether the line the bots race changed.
   */
  public tell(scores: readonly LineScore[]): boolean {
    const asked = this._asked;

    if (!asked || scores.length !== asked.lines.length) throw new Error('Scores for candidates that were not asked');

    this._asked = null;
    this.evals += asked.lines.length;

    let improved = false;

    switch (this._phase) {
      case 'grid': {
        // The centreline goes through, with the grid's best on the first part of the panel.
        const order = scores.map((_, i) => i).sort((a, b) => scores[a].total - scores[b].total || a - b);

        this._grid = {
          lines: asked.lines,
          scores,
          finalists: [0, ...order.filter((i) => i !== 0).slice(0, FINALISTS)],
        };
        this._phase = 'finals';
        break;
      }
      case 'finals': {
        const grid = this._grid!;

        // In order, the centreline first, so it keeps a tie.
        grid.finalists.forEach((i, k) => this._offer(grid.lines[i], combine(grid.scores[i], scores[k])));
        this._grid = null;
        this._stage = 'heuristic';
        this._phase = 'cma';
        improved = this.best.offsets.some((v) => v !== 0);
        break;
      }
      case 'rescore':
        // The cached line's own score now, better or worse: it's the line the bots race.
        this.best = bestOf(asked.lines[0], scores[0]);
        this._phase = 'cma';
        break;
      case 'check':
        this._sinceCheck = 0;
        this._phase = 'cma';
        improved = this._offer(asked.lines[0], scores[0]);
        break;
      case 'cma':
        this._cma!.tell(scores.map((s) => s.total));
        this._generations++;
        this._sinceCheck++;
        break;
    }

    if (this._stage === 'heuristic' && this.evals >= this.budget) this._stage = this._cap;

    return improved;
  }

  private _cmaOf(): Cma {
    return (this._cma ??= new Cma(this.best.offsets, {
      sigma: this._resumed ? SIGMA * RESUME_SIGMA : SIGMA,
      limit: LINE_LIMIT,
      seed: SEED,
      separable: this._separable,
    }));
  }

  /** Make a line the bots' if it beats theirs on the panel. */
  private _offer(offsets: readonly number[], score: LineScore): boolean {
    if (!(score.total < this.best.total)) return false;

    this.best = bestOf(offsets, score);

    return true;
  }
}

function bestOf(offsets: readonly number[], score: LineScore): SearchBest {
  return { offsets, total: score.total, lapSeconds: score.lapSeconds, wallHits: score.wallHits, ultras: score.ultras };
}

/** A generation's conditions: one from each band, with a waver, seeded by the generation. */
function drawConditions(generation: number): LineCondition[] {
  const random = rng(0x5eed + generation * 7919);
  const between = ([lo, hi]: readonly [number, number]) => lo + (hi - lo) * random();

  return BANDS.map((band) => ({
    hz: between(band.hz),
    speed: between(band.speed),
    jitter: JITTER * random(),
    seed: Math.floor(random() * 2 ** 31),
  }));
}

/** One line's scores on two parts of the panel, as one. */
function combine(a: LineScore, b: LineScore): LineScore {
  return {
    total: a.total + b.total,
    time: a.time + b.time,
    wallHits: a.wallHits + b.wallHits,
    respawns: a.respawns + b.respawns,
    backouts: a.backouts + b.backouts,
    ultras: a.ultras + b.ultras,
    steps: a.steps + b.steps,
    lapSeconds: a.lapSeconds || b.lapSeconds,
  };
}
