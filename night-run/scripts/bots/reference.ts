/** Reading what `run-reference.ts` wrote. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A checkpoint as stored: the best line among the search's first `evals` candidates, offsets rounded to 0.1 mm. */
export interface StoredCheckpoint {
  readonly evals: number;
  readonly total: number;
  readonly lapSeconds: number;
  readonly wallHits: number;
  readonly ultras: number;
  readonly seconds: number;
  readonly offsets: readonly number[];
}

/** `reference/best-<name>.json`. */
export interface Reference {
  readonly name: string;
  readonly code: string;
  readonly lap: number;
  readonly size: number;
  /** Candidates the game's search scores on this track, and the reference search's. */
  readonly gameBudget: number;
  readonly budget: number;
  readonly evals: number;
  readonly seconds: number;
  readonly threads: number;
  readonly total: number;
  readonly lapSeconds: number;
  /** The reference line, at full precision. */
  readonly offsets: readonly number[];
  readonly checkpoints: readonly StoredCheckpoint[];
  /** The game's lines at the end of the heuristic stage and of its budget, at full precision. */
  readonly heuristic: readonly number[];
  readonly refined: readonly number[];
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A track's reference.
 * @param name - The suite track.
 * @returns It, or null before `run-reference.ts` has made it.
 */
export function readReference(name: string): Reference | null {
  const file = path.join(here, `reference/best-${name}.json`);

  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Reference) : null;
}
