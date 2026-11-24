/**
 * Random tracks, for the editor's Shuffle and for checks over many layouts. Pure, and frozen once written: the bots,
 * the scenery and the editor all test against what it makes.
 */

import type { Turns } from './code';
import { isTrackError, trackFromTurns, turnsFromLoop } from './code';

/** Blocks of 2 by 2 cells across and down: 14 by 8 cells, inside the format's 14 by 9. */
const BLOCKS_W = 7;
const BLOCKS_H = 4;
const MIN_BLOCKS = 3;
const MAX_BLOCKS = 12;
/** Steps the ring walk may take before the blob is given up on. */
const WALK_BUDGET = 200_000;
/** Seeds tried, 1000 apart, before falling back to the oval. */
const TRIES = 50;
const SEED_STRIDE = 1000;
const OVAL: Turns = 'SSRRSSSRRS';
const SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * A seeded random source: mulberry32.
 * @param seed - Any 32-bit integer.
 * @returns A function giving the next number in [0, 1) each call.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (x: number, z: number): string => `${x},${z}`;

/** Whether a blob of cells is one piece with no holes and no two cells meeting only at a corner. */
function isSimple(blob: ReadonlySet<string>): boolean {
  const cells = [...blob].map((k) => k.split(',').map(Number));
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const [x, z] of cells) {
    for (const [dx, dz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      if (blob.has(key(x + dx, z + dz)) && !blob.has(key(x + dx, z)) && !blob.has(key(x, z + dz))) return false;
    }

    minX = Math.min(minX, x - 1);
    maxX = Math.max(maxX, x + 1);
    minZ = Math.min(minZ, z - 1);
    maxZ = Math.max(maxZ, z + 1);
  }

  // Flood the outside from a corner of the padded box: with no hole, outside and blob fill the box between them.
  const outside = new Set<string>();
  const stack: [number, number][] = [[minX, minZ]];

  while (stack.length > 0) {
    const [x, z] = stack.pop()!;
    const k = key(x, z);

    if (x < minX || x > maxX || z < minZ || z > maxZ || outside.has(k) || blob.has(k)) continue;

    outside.add(k);
    stack.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]);
  }

  return outside.size + blob.size === (maxX - minX + 1) * (maxZ - minZ + 1);
}

/** The ring of cells round the edge of a random blob of blocks, walked as one loop, or null when it isn't one. */
function ringLoop(rand: () => number, blocks: number): [number, number][] | null {
  const sx = Math.floor(rand() * BLOCKS_W);
  const sz = Math.floor(rand() * BLOCKS_H);
  const blob = new Set([key(sx, sz)]);
  const list: [number, number][] = [[sx, sz]];

  for (let guard = 0; list.length < blocks && guard < 5000; guard++) {
    const [bx, bz] = list[Math.floor(rand() * list.length)];
    const [dx, dz] = SIDES[Math.floor(rand() * 4)];
    const nx = bx + dx;
    const nz = bz + dz;

    if (nx < 0 || nz < 0 || nx >= BLOCKS_W || nz >= BLOCKS_H || blob.has(key(nx, nz))) continue;

    blob.add(key(nx, nz));

    if (!isSimple(blob)) {
      blob.delete(key(nx, nz));
      continue;
    }

    list.push([nx, nz]);
  }

  const fine = new Set<string>();

  for (const [bx, bz] of list) {
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) fine.add(key(bx * 2 + dx, bz * 2 + dz));
  }

  const ring = new Set<string>();

  for (const k of fine) {
    const [x, z] = k.split(',').map(Number);
    let edge = false;

    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!fine.has(key(x + dx, z + dz))) edge = true;

    if (edge) ring.add(k);
  }

  const first = [...ring][0].split(',').map(Number) as [number, number];
  const cells: [number, number][] = [first];
  const used = new Set([key(...first)]);
  let budget = WALK_BUDGET;

  const extend = (): boolean => {
    if (budget-- < 0) return false;

    const [x, z] = cells[cells.length - 1];

    if (cells.length === ring.size) return Math.abs(x - first[0]) + Math.abs(z - first[1]) === 1;

    for (const [dx, dz] of SIDES) {
      const k = key(x + dx, z + dz);

      if (!ring.has(k) || used.has(k)) continue;

      used.add(k);
      cells.push([x + dx, z + dz]);

      if (extend()) return true;

      cells.pop();
      used.delete(k);
    }

    return false;
  };

  return extend() ? cells : null;
}

/** One try: a blob's ring, a random way round, the finish in the middle of its longest straight run of three or more. */
function attempt(seed: number): Turns | null {
  const rand = rng(seed);
  const blocks = MIN_BLOCKS + Math.floor(rand() * (MAX_BLOCKS - MIN_BLOCKS + 1));
  const cells = ringLoop(rand, blocks);

  if (!cells || cells.length < 10) return null;
  if (rand() < 0.5) cells.reverse();

  const turns = turnsFromLoop(cells, 0);
  const n = turns.length;
  let best: { at: number; length: number } | null = null;

  for (let i = 0; i < n; i++) {
    if (turns[i] !== 'S' || turns[(i - 1 + n) % n] === 'S') continue;

    let length = 0;

    while (length < n && turns[(i + length) % n] === 'S') length++;

    if (!best || length > best.length) best = { at: i, length };
  }

  if (!best || best.length < 3) return null;

  const finish = (best.at + Math.floor((best.length - 1) / 2)) % n;
  const placed = turns.slice(finish) + turns.slice(0, finish);

  return isTrackError(trackFromTurns(placed)) ? null : placed;
}

/**
 * A random valid track: the ring round a random blob of 2 by 2 blocks, 3 to 12 of them on a 7 by 4 grid of blocks, walked
 * one way or the other, its finish in the middle of its longest straight run. A seed that makes no valid loop moves on
 * 1000 at a time; after 50 misses it's the oval.
 * @param seed - Any integer; the same seed gives the same track.
 * @returns Turns that {@link trackFromTurns} accepts.
 */
export function generateTurns(seed: number): Turns {
  for (let i = 0; i < TRIES; i++) {
    const turns = attempt(seed + i * SEED_STRIDE);

    if (turns) return turns;
  }

  return OVAL;
}
