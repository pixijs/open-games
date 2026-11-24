/** What the page and the line workers say to each other. Types only. */

import type { LineStage } from './LineService';
import type { LineCondition, LineScore, SearchBest, SearchResume } from './search';

/** The page to a worker. */
export type ToLineWorker =
  /** Race one candidate at some conditions and send its score back. */
  | {
      kind: 'score';
      job: number;
      task: number;
      code: string;
      offsets: readonly number[];
      conditions: readonly LineCondition[];
    }
  /** Worker 0 only: run a track's search, handing out each batch of candidates for the pool to race. */
  | { kind: 'search'; job: number; code: string; cap: 'heuristic' | 'refined'; resume: SearchResume | null }
  /** Worker 0 only: the scores of the batch it handed out last. */
  | { kind: 'scores'; job: number; scores: readonly LineScore[] }
  /** Forget a job: its search, and any candidate of it being raced. */
  | { kind: 'drop'; job: number }
  /** Stop racing between slices until told to resume, or carry on. */
  | { kind: 'pause' }
  | { kind: 'resume' };

/** A worker to the page. */
export type FromLineWorker =
  /** A candidate's score, or null for one dropped; `at` is when it finished, in ms since the epoch. */
  | { kind: 'scored'; job: number; task: number; score: LineScore | null; at: number }
  /** The search's next candidates, and the conditions to race them all at. */
  | { kind: 'batch'; job: number; lines: readonly (readonly number[])[]; conditions: readonly LineCondition[] }
  /** The search after a batch: its stage, count and best line, and whether that line is new. */
  | {
      kind: 'progress';
      job: number;
      stage: LineStage;
      evals: number;
      budget: number;
      best: SearchBest;
      improved: boolean;
    }
  /** The search has nothing left to do. */
  | { kind: 'done'; job: number }
  | { kind: 'failed'; message: string };
