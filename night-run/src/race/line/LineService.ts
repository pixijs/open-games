/**
 * Where the bots' racing lines come from. Night Run's ships with the game. A custom track races its centreline at
 * once, which every bot can lap, while Web Workers search for a better line: the best of a heuristic grid within a
 * second or two, then CMA-ES over the whole line, scored by racing each candidate in a headless race (`search.ts`).
 * Only the device that drives the bots searches: the host, or the player in a quick race. A guest's page is told it
 * isn't ({@link LineService.setSearching}), so it starts no worker and races nothing; it shows the cached line or the
 * centreline.
 *
 * One track searches at a time: the one {@link LineService.get} asked for last, then the ones
 * {@link LineService.prefetch} queued. The search stops taking candidates from a race's countdown to its results, and
 * while the page is hidden, so a line never changes under a race; each bot takes the course's line when the race
 * starts. Lines are cached in localStorage by track code, with how far their search came, so a reload or a later
 * visit carries on where it stopped.
 */

import type { TrackDef } from '../../track/code';
import { Route } from '../route';
import type { PoolJob } from './pool';
import { LinePool } from './pool';
import type { RacingLine } from './RacingLine';
import { baseLine, centreLine, decodeLine, encodeLine, lineFor } from './RacingLine';
import type { SearchBest } from './search';
import { searchBudget } from './search';

/** How far a track's line has come: shipped with the game, the centreline, the search's first pick, or its finished line. */
export type LineStage = 'shipped' | 'centre' | 'heuristic' | 'refined';

/** A track's line, as the search last left it. */
export interface LineStatus {
  readonly code: string;
  readonly stage: LineStage;
  /** Candidates scored so far, and the search's budget, the heuristic grid's included. */
  readonly evals: number;
  readonly budget: number;
  /** A pace-1 bot's lap on the line at 60 Hz, in seconds, as the search timed it; 0 until it has. */
  readonly lapSeconds: number;
  /** Whether a search is running for this track now. */
  readonly working: boolean;
  /** Workers searching. */
  readonly workers: number;
}

/** The highest stage `?botline=` lets the host use: `off` and `centre` start no worker. */
type LineCap = 'off' | 'centre' | 'heuristic' | 'refined';

/** A track's line on this page. */
interface LineTrack {
  readonly def: TrackDef;
  readonly route: Route;
  line: RacingLine;
  stage: LineStage;
  evals: number;
  budget: number;
  total: number;
  lapSeconds: number;
  /** When it was last raced or picked, ms since the epoch. */
  used: number;
  /** Whether it's kept between visits: a track the player committed to, not an editor's passing one. */
  persist: boolean;
}

/** A line as the cache keeps it. */
interface CachedLine {
  /** `encodeLine`'s text, 2 characters a point: at most 719 on the largest track. */
  line: string;
  stage: LineStage;
  evals: number;
  budget: number;
  total: number;
  lapSeconds: number;
  used: number;
  pinned: boolean;
}

interface LineCache {
  v: number;
  lines: Record<string, CachedLine>;
}

const STORAGE_KEY = 'nightrun:lines';
/** Bump whenever the physics, the bot's controller or the search's objective changes: old lines no longer fit. */
const LINE_VERSION = 2;
/** A pace-1 bot's average speed on a line nobody has timed yet, metres a second. */
const UNTIMED_SPEED = 15;
/** Unpinned lines unused this long are dropped, and the least recently used past this many. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_UNPINNED = 40;
/** Tracks kept in memory only, as the editor's passing ones are. */
const MAX_PASSING = 8;
/** The cache is written at most this often while a search runs, and at once when a stage ends. */
const SAVE_EVERY_MS = 1000;
const STAGES: readonly LineStage[] = ['centre', 'heuristic', 'refined'];

/** The bots' lines, by track code. */
export class LineService {
  /** A track's line got better, or its search reached a new stage; the game puts the line on the course. */
  public onImproved: ((code: string, line: RacingLine, status: LineStatus) => void) | null = null;

  private readonly _storage: Storage | null;
  private readonly _cap: LineCap;
  private readonly _poolSize: number;
  private readonly _tracks = new Map<string, LineTrack>();
  /** Codes queued behind the one searching, oldest first. */
  private readonly _queue: string[] = [];
  /** The code `get` asked for last. */
  private _focus: string | null = null;
  private _searching: string | null = null;
  private _pool: LinePool | null = null;
  private _failed = false;
  private _racing = false;
  /** Whether this page may search: not while it's a guest in someone else's room. */
  private _maySearch = true;
  private _hidden = false;
  private _pins: ReadonlySet<string> | null = null;
  /** `performance.now()` when each code was first asked for, for harnesses timing the search. */
  private readonly _askedAt = new Map<string, number>();
  /** The search's count when each line object was made, for the test hooks' `botLines`. */
  private readonly _evalsOf = new WeakMap<RacingLine, number>();
  private _savedAt = 0;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The stored cache as last read for {@link LineService.status}, and when: a page of cards asks for many tracks. */
  private _peeked: LineCache | null = null;
  private _peekedAt = 0;

  /**
   * @param storage - Where found lines are cached between visits.
   * @param params - The page's URL switches: `botline` caps the stage used, `lineWorkers` sets the workers.
   */
  constructor(storage: Storage | null, params: URLSearchParams) {
    const cap = params.get('botline');
    const asked = Number.parseInt(params.get('lineWorkers') ?? '', 10);

    this._storage = storage;
    this._cap = cap === 'off' || cap === 'centre' || cap === 'heuristic' ? cap : 'refined';
    this._poolSize = asked >= 1 ? Math.min(4, asked) : defaultWorkers();

    if (typeof document !== 'undefined') {
      this._hidden = document.hidden;
      document.addEventListener('visibilitychange', this._onVisibility);
      window.addEventListener('pagehide', this._flush);
    }
  }

  /** Workers this page has made: none until a custom track needs a search. */
  public get workers(): number {
    return this._pool?.size ?? 0;
  }

  /** When each candidate scored on this page finished, ms since the epoch, for harnesses. */
  public get scoredAt(): readonly number[] {
    return this._pool?.scoredAt ?? [];
  }

  /** Each pause of the search on this page, from and to in ms since the epoch, and the count taken in by then. */
  public get pauses(): readonly { readonly from: number; readonly to: number | null; readonly scored: number }[] {
    return this._pool?.pauses ?? [];
  }

  /**
   * A track's line to race now, the best there is at once, and its search put first.
   * @param def - The track.
   * @param route - Its route.
   * @returns Night Run's shipped line, or the track's best so far.
   */
  public get(def: TrackDef, route: Route): RacingLine {
    if (def.builtIn) return baseLine();

    const track = this._track(def, route, true);

    track.used = Date.now();
    this._focus = def.code;
    this._save(true);
    this._schedule();

    return track.line;
  }

  /**
   * Queue a track's search behind the current one, as when it's picked, opened or left unchanged in the editor.
   * @param def - The track.
   * @param opts - `persist: false` keeps it in memory only, for an editor's track that may change again.
   * @param opts.persist - Whether its line is cached between visits.
   */
  public prefetch(def: TrackDef, opts: { persist?: boolean } = {}): void {
    if (def.builtIn) return;

    const track = this._track(def, null, opts.persist ?? true);

    if (!this._queue.includes(def.code)) this._queue.push(def.code);
    if (track.persist) this._save(true);

    this._schedule();
  }

  /**
   * The codes in the library, whose cached lines are never evicted.
   * @param codes - Every code in the library, after each change.
   */
  public pin(codes: readonly string[]): void {
    this._pins = new Set(codes);
    // Soon rather than now: the editor's every change makes a new code, and only the cache's eviction reads pins.
    this._save();
  }

  /**
   * How far a track's line has come.
   * @param code - The track's code.
   * @returns Its status.
   */
  public status(code: string): LineStatus {
    if (code === '') return { code, stage: 'shipped', evals: 0, budget: 0, lapSeconds: 0, working: false, workers: 0 };

    const track = this._tracks.get(code);
    const cached = track ? null : this._peek().lines[code];
    const working = code === this._searching && (this._pool?.working ?? false);

    return {
      code,
      stage: track?.stage ?? cached?.stage ?? 'centre',
      evals: track?.evals ?? cached?.evals ?? 0,
      budget: track?.budget ?? cached?.budget ?? 0,
      lapSeconds: track?.lapSeconds ?? cached?.lapSeconds ?? 0,
      working,
      workers: working ? this._pool!.size : 0,
    };
  }

  /**
   * A track's line's points as the bots race them now, for harnesses.
   * @param code - The track's code.
   * @returns The offsets; none for a track this page hasn't seen.
   */
  public offsets(code: string): readonly number[] {
    return code === '' ? baseLine().offsets : (this._tracks.get(code)?.line.offsets ?? []);
  }

  /**
   * When a track was first asked for on this page, for harnesses timing its search.
   * @param code - The track's code.
   * @returns `performance.now()` then, or NaN.
   */
  public askedAt(code: string): number {
    return this._askedAt.get(code) ?? NaN;
  }

  /**
   * How many candidates the search had scored when a line was found, for harnesses that tell lines apart.
   * @param line - A line this service handed out.
   * @returns The count, or -1 for a line it didn't.
   */
  public evalsOf(line: RacingLine | null): number {
    return line ? (this._evalsOf.get(line) ?? -1) : -1;
  }

  /**
   * A pace-1 bot's lap: the search's own 60 Hz figure once it has one, on this page or cached by an earlier one, else
   * the lap at a nominal speed.
   * @param def - The track.
   * @param route - Its route.
   * @returns Seconds.
   */
  public lapSeconds(def: TrackDef, route: Route): number {
    const timed = def.builtIn ? 0 : this.status(def.code).lapSeconds;

    return timed > 0 ? timed : route.lapLength / UNTIMED_SPEED;
  }

  /**
   * Whether a race is on, from its countdown to its results: the search stops taking candidates until it ends, so the
   * line never changes under a race.
   * @param racing - Whether one is.
   */
  public setRacing(racing: boolean): void {
    this._racing = racing;
    this._applyPause();
  }

  /**
   * Whether this page searches: false while it's a guest or a spectator in another player's room, whose host drives
   * the bots. A search under way stops, keeping its progress, and carries on once the page may search again.
   * @param searching - Whether it may.
   */
  public setSearching(searching: boolean): void {
    if (searching === this._maySearch) return;

    this._maySearch = searching;

    if (searching) {
      this._schedule();

      return;
    }

    if (this._unfinished(this._searching)) this._queue.unshift(this._searching);

    this._searching = null;
    this._pool?.stop();
    this._flush();
  }

  public destroy(): void {
    this.onImproved = null;
    this._flush();
    this._pool?.destroy();
    this._pool = null;

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
      window.removeEventListener('pagehide', this._flush);
    }
  }

  /** The page's line for a track, made from the cache or the centreline the first time it's asked for. */
  private _track(def: TrackDef, route: Route | null, persist: boolean): LineTrack {
    let track = this._tracks.get(def.code);

    if (track) {
      track.persist ||= persist;

      return track;
    }

    this._askedAt.set(def.code, performance.now());

    const trackRoute = route ?? new Route(def.cells);
    const searched = this._cap === 'heuristic' || this._cap === 'refined';
    const budget = searched ? searchBudget(trackRoute, this._cap === 'heuristic' ? 'heuristic' : 'refined') : 0;
    // A capped page searches afresh and keeps nothing, so a check of one stage never meets another's line.
    const cached = this._cap === 'refined' ? this._read().lines[def.code] : undefined;
    const decoded = cached ? decodeLine(cached.line, trackRoute) : null;

    track =
      cached && decoded
        ? {
            def,
            route: trackRoute,
            line: decoded,
            stage: cached.stage,
            evals: cached.evals,
            budget,
            total: cached.total,
            lapSeconds: cached.lapSeconds,
            used: cached.used,
            persist,
          }
        : {
            def,
            route: trackRoute,
            line: centreLine(trackRoute),
            stage: 'centre',
            evals: 0,
            budget,
            total: Infinity,
            lapSeconds: 0,
            used: Date.now(),
            persist,
          };

    this._evalsOf.set(track.line, track.evals);
    this._tracks.set(def.code, track);
    this._forgetPassing();

    return track;
  }

  /** Keep at most {@link MAX_PASSING} tracks the cache won't keep, dropping the oldest that isn't busy. */
  private _forgetPassing(): void {
    const passing = [...this._tracks.values()].filter((t) => !t.persist && t.def.code !== this._searching);

    for (let i = 0; i < passing.length - MAX_PASSING; i++) {
      const code = passing[i].def.code;

      const queued = this._queue.indexOf(code);

      this._tracks.delete(code);
      if (queued >= 0) this._queue.splice(queued, 1);
    }
  }

  /** Whether a track's search has more to do. */
  private _unfinished(code: string | null): code is string {
    const track = code === null ? undefined : this._tracks.get(code);

    return !!track && track.budget > 0 && track.evals < track.budget;
  }

  /** Search the focused track, else the next queued one; start the workers the first time one is needed. */
  private _schedule(): void {
    if (this._failed || this._cap === 'off' || this._cap === 'centre' || !this._maySearch) return;
    if (this._racing || this._hidden) return;

    for (let i = this._queue.length - 1; i >= 0; i--) {
      if (!this._unfinished(this._queue[i]) || this._queue[i] === this._focus) this._queue.splice(i, 1);
    }

    const next = this._unfinished(this._focus) ? this._focus : (this._queue[0] ?? null);

    if (next === this._searching) return;

    // The track it was on keeps its progress, and goes on next once the new one's done.
    if (this._searching !== null && this._unfinished(this._searching)) this._queue.unshift(this._searching);

    this._searching = next;

    if (next === null) {
      this._pool?.stop();

      return;
    }

    const track = this._tracks.get(next)!;
    const pool = (this._pool ??= this._makePool());
    const job: PoolJob = {
      code: next,
      cap: this._cap === 'heuristic' ? 'heuristic' : 'refined',
      resume:
        track.stage === 'centre'
          ? null
          : { offsets: track.line.offsets, evals: track.evals, total: track.total, lapSeconds: track.lapSeconds },
    };

    pool.start(job, {
      progress: (stage, evals, budget, best, improved) => this._progress(track, stage, evals, budget, best, improved),
      done: () => {
        if (this._searching === next) this._searching = null;

        this._save(true);
        this._schedule();
      },
    });
  }

  private _makePool(): LinePool {
    const pool = new LinePool(
      this._poolSize,
      () => new Worker(new URL('./lineWorker.ts', import.meta.url), { type: 'module', name: 'night-run-lines' }),
    );

    pool.onFailed = (message) => {
      console.warn(`The bots' line search stopped: ${message}`);
      this._failed = true;
      this._searching = null;
    };
    pool.setPaused(this._racing || this._hidden);

    return pool;
  }

  private _progress(
    track: LineTrack,
    stage: LineStage,
    evals: number,
    budget: number,
    best: SearchBest,
    improved: boolean,
  ): void {
    const stageEnded = STAGES.indexOf(stage) > STAGES.indexOf(track.stage);

    track.stage = stage;
    track.evals = evals;
    track.budget = budget;
    track.total = best.total;
    track.lapSeconds = best.lapSeconds;

    if (improved) {
      track.line = lineFor(track.route, best.offsets);
      this._evalsOf.set(track.line, evals);
      this.onImproved?.(track.def.code, track.line, this.status(track.def.code));
    }

    this._save(stageEnded);
  }

  private _applyPause(): void {
    this._pool?.setPaused(this._racing || this._hidden);

    if (this._racing || this._hidden) this._flush();
    else this._schedule();
  }

  private readonly _onVisibility = (): void => {
    this._hidden = document.hidden;
    this._applyPause();
  };

  /**
   * The cache as stored now, keeping only well-formed entries; empty when there's none, it's another version's, or
   * storage is unreadable. Whatever it drops is searched for again and written over at the next save.
   */
  private _read(): LineCache {
    const lines: Record<string, CachedLine> = {};

    try {
      const parsed = JSON.parse(this._storage?.getItem(STORAGE_KEY) ?? 'null') as { v?: unknown; lines?: unknown };

      if (parsed?.v === LINE_VERSION && isRecord(parsed.lines)) {
        for (const [code, entry] of Object.entries(parsed.lines)) if (isCachedLine(entry)) lines[code] = entry;
      }
    } catch {
      // A corrupt cache is an empty one: every line can be searched for again.
    }

    return { v: LINE_VERSION, lines };
  }

  /** The stored cache, read again at most once a second. */
  private _peek(): LineCache {
    const now = performance.now();

    if (!this._peeked || now - this._peekedAt >= SAVE_EVERY_MS) {
      this._peeked = this._read();
      this._peekedAt = now;
    }

    return this._peeked;
  }

  /** Write the cache soon, or now. */
  private _save(now = false): void {
    if (now || Date.now() - this._savedAt >= SAVE_EVERY_MS) {
      this._flush();
    } else {
      this._saveTimer ??= setTimeout(this._flush, SAVE_EVERY_MS - (Date.now() - this._savedAt));
    }
  }

  /**
   * Merge this page's kept lines into the stored cache, which another tab may have written since, keeping whichever
   * search went further, then drop stale and surplus unpinned lines.
   */
  private readonly _flush = (): void => {
    if (this._saveTimer !== null) clearTimeout(this._saveTimer);

    this._saveTimer = null;
    this._savedAt = Date.now();
    this._peeked = null;

    if (!this._storage || this._cap !== 'refined') return;

    const cache = this._read();
    const lines = cache.lines;
    const now = Date.now();

    for (const track of this._tracks.values()) {
      const stored = lines[track.def.code];

      if (!track.persist || track.stage === 'centre' || (stored && stored.evals > track.evals)) {
        if (stored) stored.used = Math.max(stored.used, track.persist ? track.used : 0);

        continue;
      }

      lines[track.def.code] = {
        line: encodeLine(track.line),
        stage: track.stage,
        evals: track.evals,
        budget: track.budget,
        total: track.total,
        lapSeconds: track.lapSeconds,
        used: track.used,
        pinned: false,
      };
    }

    const unpinned: [string, CachedLine][] = [];

    for (const [code, entry] of Object.entries(lines)) {
      if (this._pins) entry.pinned = this._pins.has(code);
      if (entry.pinned) continue;

      if (now - entry.used > STALE_MS) delete lines[code];
      else unpinned.push([code, entry]);
    }

    unpinned.sort((a, b) => b[1].used - a[1].used);

    for (const [code] of unpinned.slice(MAX_UNPINNED)) delete lines[code];

    try {
      this._storage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // Out of room, or a private window: the lines live on in memory for this visit.
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a stored entry has every field the service reads, of the right kind. */
function isCachedLine(entry: unknown): entry is CachedLine {
  if (!isRecord(entry)) return false;

  const finite = (key: string) => typeof entry[key] === 'number' && Number.isFinite(entry[key]);

  return (
    typeof entry.line === 'string' &&
    STAGES.includes(entry.stage as LineStage) &&
    finite('evals') &&
    finite('budget') &&
    finite('total') &&
    finite('lapSeconds') &&
    finite('used') &&
    typeof entry.pinned === 'boolean'
  );
}

/** Up to 4 workers on a desktop with cores to spare, else 1. */
function defaultWorkers(): number {
  if (typeof navigator === 'undefined') return 1;

  const cores = navigator.hardwareConcurrency ?? 1;
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  return cores >= 6 && !touch ? Math.min(4, cores - 2) : 1;
}
