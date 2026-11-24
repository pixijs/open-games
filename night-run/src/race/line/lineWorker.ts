/**
 * A line worker: races candidate lines in the headless race, a slice at a time so a pause lands within a slice, and
 * in worker 0, runs the search that hands the candidates out. No pixi: the game's physics, bot and race rules only.
 */

import { decodeTrack, isTrackError } from '../../track/code';
import type { FromLineWorker, ToLineWorker } from './messages';
import type { LineCondition } from './search';
import { LineScoring, LineSearch } from './search';
import type { SimTrack } from './sim';
import { simTrack } from './sim';

/** The worker's side of the page's messages. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ToLineWorker>) => void) | null;
  postMessage(message: FromLineWorker): void;
}

/** Tracks kept ready to race; a search races one track at a time. */
const KEEP_TRACKS = 4;

const scope = self as unknown as WorkerScope;
const tracks = new Map<string, SimTrack>();
const tasks: {
  job: number;
  task: number;
  code: string;
  offsets: readonly number[];
  conditions: readonly LineCondition[];
}[] = [];
const dropped = new Set<number>();
let search: { job: number; search: LineSearch } | null = null;
let paused = false;
let working = false;
let resumes: (() => void)[] = [];

// A message to itself lets the page's messages in between slices, without a timer's clamped delay.
const channel = new MessageChannel();
let wake: (() => void) | null = null;

channel.port1.onmessage = () => {
  const resolve = wake;

  wake = null;
  resolve?.();
};

/** Let waiting messages in, then wait out any pause. */
async function breathe(): Promise<void> {
  await new Promise<void>((resolve) => {
    wake = resolve;
    channel.port2.postMessage(0);
  });

  while (paused) await new Promise<void>((resolve) => resumes.push(resolve));
}

function trackOf(code: string): SimTrack {
  let track = tracks.get(code);

  if (!track) {
    const def = decodeTrack(code);

    if (isTrackError(def)) throw new Error(`Line worker given a bad track: ${def}`);

    track = simTrack(def);
    tracks.set(code, track);

    if (tracks.size > KEEP_TRACKS) tracks.delete(tracks.keys().next().value!);
  }

  return track;
}

async function work(): Promise<void> {
  if (working) return;

  working = true;

  try {
    await scoreTasks();
  } catch (error) {
    scope.postMessage({ kind: 'failed', message: String(error) });
  }

  working = false;
}

async function scoreTasks(): Promise<void> {
  while (tasks.length > 0) {
    const task = tasks[0];
    const scoring = new LineScoring(trackOf(task.code), task.offsets, task.conditions);

    while (!dropped.has(task.job) && !scoring.advance()) await breathe();

    // A pause that came in during the last slice holds the score back, so none lands during a race.
    await breathe();
    tasks.shift();
    scope.postMessage({
      kind: 'scored',
      job: task.job,
      task: task.task,
      score: dropped.has(task.job) ? null : scoring.score,
      at: performance.timeOrigin + performance.now(),
    });
  }
}

function next(job: number, current: LineSearch): void {
  const batch = current.ask();

  if (batch) scope.postMessage({ kind: 'batch', job, lines: batch.lines, conditions: batch.conditions });
  else scope.postMessage({ kind: 'done', job });
}

scope.onmessage = ({ data }) => {
  try {
    switch (data.kind) {
      case 'score':
        tasks.push(data);
        void work();
        break;
      case 'search':
        search = {
          job: data.job,
          search: new LineSearch(trackOf(data.code).route, { cap: data.cap, resume: data.resume }),
        };
        next(data.job, search.search);
        break;
      case 'scores': {
        if (search?.job !== data.job) break;

        const current = search.search;
        const before = current.stage;
        const improved = current.tell(data.scores);

        scope.postMessage({
          kind: 'progress',
          job: data.job,
          stage: current.stage,
          evals: current.evals,
          budget: current.budget,
          best: current.best,
          improved: improved || current.stage !== before,
        });
        next(data.job, current);
        break;
      }
      case 'drop':
        dropped.add(data.job);
        if (search?.job === data.job) search = null;
        break;
      case 'pause':
        paused = true;
        break;
      case 'resume': {
        paused = false;

        const waiting = resumes;

        resumes = [];
        waiting.forEach((resolve) => resolve());
        break;
      }
    }
  } catch (error) {
    scope.postMessage({ kind: 'failed', message: String(error) });
  }
};
