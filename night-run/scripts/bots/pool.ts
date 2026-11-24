/**
 * Node `worker_threads` for the bot scripts: one queue of races, shared by however many searches and checks run at
 * once, so the threads stay busy. Half the machine's cores by default, so the scripts leave room for everything else.
 */

import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type { LineCondition, LineScore } from '../../src/race/line/search';
import type { SimOptions, SimResult } from '../../src/race/line/sim';

/** A headless race for a worker: the sim's options, with the line as offsets. */
export type RaceTask = Omit<SimOptions, 'line'> & { readonly offsets: readonly number[] };

/** What a worker does. */
export type PoolTask =
  | {
      readonly kind: 'score';
      readonly code: string;
      readonly offsets: readonly number[];
      readonly conditions: readonly LineCondition[];
    }
  | { readonly kind: 'race'; readonly code: string; readonly race: RaceTask };

interface Pending {
  readonly id: number;
  readonly task: PoolTask;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The thread count from `--workers N`, else half the cores.
 * @param argv - The script's arguments.
 * @returns Threads.
 */
export function workerCount(argv: readonly string[]): number {
  const at = argv.indexOf('--workers');
  const asked = at >= 0 ? Number(argv[at + 1]) : NaN;

  return Number.isInteger(asked) && asked > 0 ? asked : Math.max(1, Math.floor(availableParallelism() / 2));
}

/** A pool of workers racing headless. */
export class RacePool {
  public readonly size: number;

  private readonly _workers: Worker[] = [];
  private readonly _idle: Worker[] = [];
  private readonly _queue: Pending[] = [];
  private readonly _running = new Map<Worker, Pending>();
  private _nextId = 0;

  /** @param size - Threads. */
  constructor(size: number) {
    this.size = size;

    // Each thread loads the TypeScript modules through tsx, as the script itself was.
    const source = `import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(
      new URL('./worker.ts', import.meta.url).href,
    )}, ${JSON.stringify(import.meta.url)}))`;

    for (let i = 0; i < size; i++) {
      const worker = new Worker(source, { eval: true });

      worker.on('message', ({ result }: { id: number; result: unknown }) => {
        const pending = this._running.get(worker)!;

        this._running.delete(worker);
        this._idle.push(worker);
        pending.resolve(result);
        this._pump();
      });
      worker.on('error', (error) => {
        this._running.get(worker)?.reject(error);
      });
      this._workers.push(worker);
      this._idle.push(worker);
    }
  }

  /**
   * A line's score, as the game's search scores it.
   * @param code - The track's code.
   * @param offsets - The line.
   * @param conditions - What it races at.
   * @returns Its score.
   */
  public score(code: string, offsets: readonly number[], conditions: readonly LineCondition[]): Promise<LineScore> {
    return this._run({ kind: 'score', code, offsets, conditions }) as Promise<LineScore>;
  }

  /**
   * A headless race.
   * @param code - The track's code.
   * @param race - The race.
   * @returns What it came to.
   */
  public race(code: string, race: RaceTask): Promise<SimResult> {
    return this._run({ kind: 'race', code, race }) as Promise<SimResult>;
  }

  public async close(): Promise<void> {
    await Promise.all(this._workers.map((worker) => worker.terminate()));
  }

  private _run(task: PoolTask): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this._queue.push({ id: this._nextId++, task, resolve, reject });
      this._pump();
    });
  }

  private _pump(): void {
    while (this._idle.length > 0 && this._queue.length > 0) {
      const worker = this._idle.pop()!;
      const pending = this._queue.shift()!;

      this._running.set(worker, pending);
      worker.postMessage({ id: pending.id, task: pending.task });
    }
  }
}
