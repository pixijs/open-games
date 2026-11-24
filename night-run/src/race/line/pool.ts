/**
 * The page's line workers. Worker 0 runs the search; each batch of candidates it hands out is raced across every
 * worker, one candidate a message, so an idle worker always takes the next, and the batch's scores go back to worker
 * 0 together. While paused, no candidate is handed out and every message that comes in is held until the pause ends,
 * so nothing a worker finished just after the pause began reaches the game during a race.
 */

import type { LineStage } from './LineService';
import type { FromLineWorker, ToLineWorker } from './messages';
import type { LineCondition, LineScore, SearchBest, SearchResume } from './search';

/** A search to run. */
export interface PoolJob {
  readonly code: string;
  readonly cap: 'heuristic' | 'refined';
  readonly resume: SearchResume | null;
}

/** What a search tells its owner. */
export interface PoolHandlers {
  progress(stage: LineStage, evals: number, budget: number, best: SearchBest, improved: boolean): void;
  done(): void;
}

/** The page's pool of line workers. */
export class LinePool {
  /** Workers in the pool. */
  public readonly size: number;
  /** Candidates scored and taken in on this page, and when each finished, in ms since the epoch, for harnesses. */
  public readonly scoredAt: number[] = [];
  /**
   * Each pause on this page, from and to in ms since the epoch (to is null while it lasts), and how many candidates had
   * been taken in when it began, for harnesses.
   */
  public readonly pauses: { from: number; to: number | null; scored: number }[] = [];
  /** A worker failed; the pool does nothing more. */
  public onFailed: ((message: string) => void) | null = null;

  private readonly _workers: Worker[] = [];
  private readonly _busy: boolean[] = [];
  private _job = 0;
  private _current: { job: number; code: string; handlers: PoolHandlers } | null = null;
  /** The batch being raced: candidates not handed out yet, the conditions they race at, and the scores so far. */
  private _waiting: { task: number; offsets: readonly number[] }[] = [];
  private _conditions: readonly LineCondition[] = [];
  private _scores: (LineScore | null)[] = [];
  private _left = 0;
  private _paused = false;
  private _held: [number, FromLineWorker][] = [];
  private _failed = false;

  /**
   * @param size - Workers, made now.
   * @param create - Makes a worker.
   */
  constructor(size: number, create: () => Worker) {
    this.size = size;

    for (let i = 0; i < size; i++) {
      const worker = create();

      worker.onmessage = (event: MessageEvent<FromLineWorker>) => this._receive(i, event.data);
      worker.onerror = (event) => this._fail(event.message || 'Line worker failed to load');
      this._workers.push(worker);
      this._busy.push(false);
    }
  }

  /** Whether a search is under way and not paused. */
  public get working(): boolean {
    return this._current !== null && !this._paused && !this._failed;
  }

  /**
   * Search a track, stopping whatever was searching.
   * @param job - The track and where its search starts.
   * @param handlers - Told of its progress.
   */
  public start(job: PoolJob, handlers: PoolHandlers): void {
    this.stop();

    if (this._failed) return;

    const id = ++this._job;

    this._current = { job: id, code: job.code, handlers };
    this._post(0, { kind: 'search', job: id, code: job.code, cap: job.cap, resume: job.resume });
  }

  /** Stop the search under way; its progress so far is its owner's. */
  public stop(): void {
    if (!this._current) return;

    const job = this._current.job;

    this._current = null;
    this._waiting = [];
    this._left = 0;

    for (let i = 0; i < this._workers.length; i++) this._post(i, { kind: 'drop', job });
  }

  /**
   * Hold the search, or let it go on.
   * @param paused - Whether to hold it.
   */
  public setPaused(paused: boolean): void {
    if (paused === this._paused) return;

    this._paused = paused;

    for (let i = 0; i < this._workers.length; i++) this._post(i, { kind: paused ? 'pause' : 'resume' });

    const now = performance.timeOrigin + performance.now();

    if (paused) {
      this.pauses.push({ from: now, to: null, scored: this.scoredAt.length });

      return;
    }

    const last = this.pauses.at(-1);

    if (last) last.to = now;

    const held = this._held;

    this._held = [];
    held.forEach(([worker, message]) => this._receive(worker, message));
    this._dispatch();
  }

  public destroy(): void {
    this._current = null;
    this._workers.forEach((worker) => worker.terminate());
    this._workers.length = 0;
    this.onFailed = null;
  }

  private _receive(worker: number, message: FromLineWorker): void {
    if (this._paused) {
      this._held.push([worker, message]);

      return;
    }

    const current = this._current;
    const mine = current !== null && 'job' in message && message.job === current.job;

    switch (message.kind) {
      case 'scored':
        this._busy[worker] = false;

        if (mine && message.score) {
          this._scores[message.task] = message.score;
          this.scoredAt.push(message.at);

          if (--this._left === 0) {
            this._post(0, { kind: 'scores', job: current.job, scores: this._scores as LineScore[] });
          }
        }

        this._dispatch();
        break;
      case 'batch':
        if (!mine) break;

        this._waiting = message.lines.map((offsets, task) => ({ task, offsets }));
        this._conditions = message.conditions;
        this._scores = message.lines.map(() => null);
        this._left = message.lines.length;
        this._dispatch();
        break;
      case 'progress':
        if (mine)
          current.handlers.progress(message.stage, message.evals, message.budget, message.best, message.improved);
        break;
      case 'done':
        if (!mine) break;

        this._current = null;
        current.handlers.done();
        break;
      case 'failed':
        this._fail(message.message);
        break;
    }
  }

  /** Hand the batch's next candidates to every idle worker. */
  private _dispatch(): void {
    const current = this._current;

    if (!current || this._paused) return;

    for (let i = 0; i < this._workers.length && this._waiting.length > 0; i++) {
      if (this._busy[i]) continue;

      const { task, offsets } = this._waiting.shift()!;

      this._busy[i] = true;
      this._post(i, {
        kind: 'score',
        job: current.job,
        task,
        code: current.code,
        offsets,
        conditions: this._conditions,
      });
    }
  }

  private _post(worker: number, message: ToLineWorker): void {
    this._workers[worker]?.postMessage(message);
  }

  private _fail(message: string): void {
    if (this._failed) return;

    this._failed = true;
    this._current = null;
    this.onFailed?.(message);
  }
}
