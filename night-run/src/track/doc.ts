/**
 * The editor's document: one path of board cells, open while it's drawn and closed once it loops, with the start line
 * on one of its cells. Every edit the editor makes is a function here, pure and Node-testable, and every closed path
 * with a start line is a track that {@link toTrack} turns into the same {@link TrackDef} every client validates.
 *
 * The board is the landscape 14 by 9 grid on every device (a tall phone draws it turned). Its x runs right and its y
 * down, which map onto world x and z seen from above, so a loop drawn on the board has the handedness it shows.
 */

import type { Cell, TrackDef, TrackError, Turns } from './code';
import { BASE_TRACK, trackFromTurns, turnsFromLoop } from './code';
import { generateTurns } from './generate';

/** The editor's board, in cells. The format's own limit is `TRACK_MAX_W` by `TRACK_MAX_H` in code.ts. */
export const BOARD_W = 14;
export const BOARD_H = 9;
/** A board cell: `bx + by * BOARD_W`. */
export type BoardCell = number;

/** The document: a path, whether it loops, and where the start line is. */
export interface TrackDoc {
  /** Drawing order while open; race order once closed. */
  readonly path: readonly BoardCell[];
  readonly closed: boolean;
  /** Index into `path` of the start line's cell; -1 while open, or closed with nowhere to start. */
  readonly finish: number;
}

/** What the document is: nothing yet, an open road, a loop with no room for a start, or a track. */
export type DocStatus = 'empty' | 'open' | 'noStart' | 'ready';
/** Why a stroke can't go into a cell. */
export type Refusal = 'cross' | 'edge';
/** A quarter turn, clockwise. */
export type Rot = 0 | 1 | 2 | 3;

/** A reroute that gives a loop with no start a straight of three. */
export interface StartFix {
  readonly from: number;
  readonly to: number;
  readonly cells: readonly BoardCell[];
  /** Whether the longer side goes rather than the shorter, as {@link reroute} takes it. */
  readonly longer: boolean;
}

/** Board steps east, south, west and north, as headings 0 to 3: a right turn adds one. */
const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;
/** What a turn costs the start fix's search, against 1 a cell: straight roads win. */
const TURN_COST = 0.6;
/** Cells the start fix may take getting back to the loop. */
const FIX_REJOIN = 10;

/** An empty board. */
export const EMPTY_DOC: TrackDoc = { path: [], closed: false, finish: -1 };

/** A board cell's column. */
export function cellX(cell: BoardCell): number {
  return cell % BOARD_W;
}

/** A board cell's row. */
export function cellY(cell: BoardCell): number {
  return Math.floor(cell / BOARD_W);
}

/** The board cell at a column and row, or -1 off the board. */
export function cellAt(bx: number, by: number): BoardCell {
  return bx < 0 || by < 0 || bx >= BOARD_W || by >= BOARD_H ? -1 : bx + by * BOARD_W;
}

/** The cell one step from `cell` heading `dir`, or -1 off the board. */
export function stepCell(cell: BoardCell, dir: number): BoardCell {
  return cellAt(cellX(cell) + DX[dir], cellY(cell) + DY[dir]);
}

/** The heading from `a` to its neighbour `b`, or -1 when they aren't side by side. */
export function headingTo(a: BoardCell, b: BoardCell): number {
  const dx = cellX(b) - cellX(a);
  const dy = cellY(b) - cellY(a);

  for (let d = 0; d < 4; d++) if (DX[d] === dx && DY[d] === dy) return d;

  return -1;
}

/** Whether two cells share a side. */
export function adjacent(a: BoardCell, b: BoardCell): boolean {
  return headingTo(a, b) >= 0;
}

/**
 * Whether a value read back from storage is a document this board holds: whole cells on the board, each beside the
 * next and none twice, a loop's last cell beside its first, and its start line on the path or nowhere.
 * @param value - Anything.
 * @returns True for a document every edit can take.
 */
export function isDoc(value: unknown): value is TrackDoc {
  if (!value || typeof value !== 'object') return false;

  const doc = value as Record<string, unknown>;
  const path = doc.path;
  const finish = doc.finish;

  if (!Array.isArray(path) || typeof doc.closed !== 'boolean' || !Number.isInteger(finish)) return false;

  const n = path.length;
  const seen = new Set<number>();

  for (let i = 0; i < n; i++) {
    const cell: unknown = path[i];

    if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) >= BOARD_W * BOARD_H) return false;
    if (seen.has(cell as number) || (i > 0 && !adjacent(path[i - 1] as number, cell as number))) return false;

    seen.add(cell as number);
  }

  if ((finish as number) < -1 || (finish as number) >= Math.max(1, n)) return false;

  return !doc.closed || (n >= 4 && adjacent(path[n - 1] as number, path[0] as number));
}

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

/** The turn at index `i` of a closed path, from the way it's entered to the way it's left. */
function turnAt(path: readonly BoardCell[], i: number): 'S' | 'L' | 'R' {
  const n = path.length;
  const din = headingTo(path[wrap(i - 1, n)], path[i]);
  const dout = headingTo(path[i], path[wrap(i + 1, n)]);

  if (din === dout) return 'S';

  return dout === (din + 1) % 4 ? 'R' : 'L';
}

/** Every turn of a closed path, from index 0. */
function loopTurns(path: readonly BoardCell[]): string {
  let turns = '';

  for (let i = 0; i < path.length; i++) turns += turnAt(path, i);

  return turns;
}

/** Maximal runs of straights round a loop, as start index and length (a run may wrap past index 0). */
function straightRuns(turns: string): { start: number; length: number }[] {
  const n = turns.length;
  const runs: { start: number; length: number }[] = [];

  for (let i = 0; i < n; i++) {
    if (turns[i] !== 'S' || turns[wrap(i - 1, n)] === 'S') continue;

    let length = 0;

    while (length < n && turns[(i + length) % n] === 'S') length++;

    runs.push({ start: i, length });
  }

  return runs;
}

/** The start line's cell when a loop closes: the middle of its longest straight of three or more, leaning back. */
function placeFinish(path: readonly BoardCell[]): number {
  const n = path.length;
  let best: { start: number; length: number; near: number } | null = null;

  for (const run of straightRuns(loopTurns(path))) {
    if (run.length < 3) continue;

    let near = n;

    for (let k = 0; k < run.length; k++) {
      const i = (run.start + k) % n;

      near = Math.min(near, i, n - i);
    }

    if (!best || run.length > best.length || (run.length === best.length && near < best.near)) {
      best = { ...run, near };
    }
  }

  return best ? (best.start + Math.floor((best.length - 1) / 2)) % n : -1;
}

/**
 * Where the start line can go: the cells with a straight before, on and after them.
 * @param doc - The document.
 * @returns Path indices, in race order; none while open.
 */
export function finishSpots(doc: TrackDoc): readonly number[] {
  if (!doc.closed) return [];

  const turns = loopTurns(doc.path);
  const n = turns.length;
  const spots: number[] = [];

  for (let i = 0; i < n; i++) {
    if (turns[i] === 'S' && turns[wrap(i - 1, n)] === 'S' && turns[(i + 1) % n] === 'S') spots.push(i);
  }

  return spots;
}

/**
 * What the document is.
 * @param doc - The document.
 * @returns `ready` exactly when every client accepts it as a track.
 */
export function status(doc: TrackDoc): DocStatus {
  if (doc.path.length === 0) return 'empty';
  if (!doc.closed) return 'open';
  if (doc.finish < 0) return 'noStart';

  return typeof toTrack(doc, '') === 'string' ? 'noStart' : 'ready';
}

/**
 * Lays cells onto one end of an open road, stopping at the first that isn't a free neighbour of that end.
 * @param doc - An empty or open document.
 * @param end - The head (the path's last cell) or the tail (its first).
 * @param cells - The cells, in the order they're laid.
 * @returns The longer road.
 */
export function extend(doc: TrackDoc, end: 'head' | 'tail', cells: readonly BoardCell[]): TrackDoc {
  if (doc.closed) return doc;

  const path = end === 'head' ? [...doc.path] : [...doc.path].reverse();
  const used = new Set(path);

  for (const cell of cells) {
    if (cell < 0 || cell >= BOARD_W * BOARD_H || used.has(cell)) break;
    if (path.length > 0 && !adjacent(path[path.length - 1], cell)) break;

    path.push(cell);
    used.add(cell);
  }

  return { path: end === 'head' ? path : path.reverse(), closed: false, finish: -1 };
}

/**
 * Rubs road out from one end.
 * @param doc - An open document.
 * @param end - Which end.
 * @param count - Cells to take off.
 * @returns The shorter road.
 */
export function backtrack(doc: TrackDoc, end: 'head' | 'tail', count: number): TrackDoc {
  if (doc.closed || count <= 0) return doc;

  const keep = Math.max(0, doc.path.length - count);
  const path = end === 'head' ? doc.path.slice(0, keep) : doc.path.slice(doc.path.length - keep);

  return { path, closed: false, finish: -1 };
}

/**
 * Closes an open road whose ends meet, the drawing order becoming the race's, and places the start line.
 * @param doc - An open road of at least four cells with its head beside its tail.
 * @returns The loop, or the same document when its ends don't meet.
 */
export function close(doc: TrackDoc): TrackDoc {
  const path = doc.path;

  if (doc.closed || path.length < 4 || !adjacent(path[0], path[path.length - 1])) return doc;

  return { path, closed: true, finish: placeFinish(path) };
}

/**
 * Whether the start line can stay on its cell after an edit, or where it hops: the nearest place it can go along the
 * old route, ahead first, else wherever a new loop would put it.
 */
function hopFinish(old: TrackDoc, path: readonly BoardCell[]): number {
  const doc: TrackDoc = { path, closed: true, finish: -1 };
  const spots = new Set(finishSpots(doc));

  if (spots.size === 0) return -1;

  const index = new Map(path.map((cell, i) => [cell, i]));
  const n = old.path.length;

  if (old.finish >= 0) {
    for (let d = 0; d < n; d++) {
      for (const k of d === 0 ? [0] : [d, -d]) {
        const i = index.get(old.path[wrap(old.finish + k, n)]);

        if (i !== undefined && spots.has(i)) return i;
      }
    }
  }

  return placeFinish(path);
}

/** The path indices strictly between `a` and `b` going forward round a loop (or along an open road). */
function between(n: number, a: number, b: number, closed: boolean): number[] {
  const out: number[] = [];

  if (closed) {
    for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) out.push(i);
  } else {
    for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) out.push(i);
  }

  return out;
}

/** On a loop, the road ahead of `from` up to `to` and the road behind it, and which of them a reroute drops. */
function sides(doc: TrackDoc, from: number, to: number, longer: boolean): { drop: number[]; ahead: boolean } {
  const n = doc.path.length;
  const ahead = between(n, from, to, true);
  const behind = between(n, to, from, true);
  const dropAhead = ahead.length <= behind.length !== longer;

  return { drop: dropAhead ? ahead : behind, ahead: dropAhead };
}

/**
 * The road a reroute between two road cells replaces, as it previews.
 * @param doc - The document.
 * @param from - Path index the new road leaves from.
 * @param to - Path index it comes back to.
 * @param longer - On a loop the shorter side goes; true drops the longer one, as the start fix may need.
 * @returns Path indices that go.
 */
export function rerouteDrop(doc: TrackDoc, from: number, to: number, longer = false): readonly number[] {
  const n = doc.path.length;

  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return [];
  if (!doc.closed) return between(n, from, to, false);

  return sides(doc, from, to, longer).drop;
}

/**
 * Replaces the road between two road cells with new cells.
 * @param doc - The document.
 * @param from - Path index the new road leaves from.
 * @param cells - The new cells, free ones, from beside `from` to beside `to`.
 * @param to - Path index it comes back to.
 * @param longer - As {@link rerouteDrop}.
 * @returns The reshaped document; on a loop the race keeps its direction and the start line hops if it has to.
 */
export function reroute(
  doc: TrackDoc,
  from: number,
  cells: readonly BoardCell[],
  to: number,
  longer = false,
): TrackDoc {
  const path = doc.path;
  const n = path.length;

  if (from === to || cells.length === 0) return doc;

  if (!doc.closed) {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const run = from < to ? cells : [...cells].reverse();

    return { path: [...path.slice(0, a + 1), ...run, ...path.slice(b)], closed: false, finish: -1 };
  }

  const next: BoardCell[] = [];

  if (sides(doc, from, to, longer).ahead) {
    // from, the new cells, to, then the rest of the loop back round to from.
    next.push(path[from], ...cells);
    for (let i = to; i !== from; i = (i + 1) % n) next.push(path[i]);
  } else {
    // from, the kept road ahead to `to`, then the new cells backwards to from.
    for (let i = from; i !== to; i = (i + 1) % n) next.push(path[i]);
    next.push(path[to], ...[...cells].reverse());
  }

  return { path: next, closed: true, finish: hopFinish(doc, next) };
}

/**
 * The road an erase stroke removes: on a loop, the first span of neighbouring road it touched; on an open road,
 * a span that reaches an end.
 * @param doc - The document.
 * @param touched - The path index of each cell the stroke entered, in order; -1 for a cell off the road.
 * @returns Path indices that go, or 'middle' for an open road touched only away from its ends.
 */
export function eraseSpan(doc: TrackDoc, touched: readonly number[]): readonly number[] | 'middle' {
  const n = doc.path.length;
  const first = touched.findIndex((i) => i >= 0);

  if (first < 0 || n === 0) return [];

  const span = new Set<number>([touched[first]]);
  let lo = touched[first];
  let hi = touched[first];

  for (let k = first + 1; k < touched.length; k++) {
    const i = touched[k];

    if (i < 0) break;
    if (span.has(i)) continue;

    const next = doc.closed ? (hi + 1) % n : hi + 1;
    const prev = doc.closed ? wrap(lo - 1, n) : lo - 1;

    if (i === next) hi = i;
    else if (i === prev) lo = i;
    else break;

    span.add(i);
  }

  if (doc.closed) return [...span].sort((a, b) => a - b);
  if (lo === 0) return Array.from({ length: hi + 1 }, (_, i) => i);
  if (hi === n - 1) return Array.from({ length: n - lo }, (_, i) => lo + i);

  return 'middle';
}

/**
 * Takes road out. A loop opens where the road went, its race order becoming the open road's drawing order.
 * @param doc - The document.
 * @param span - Indices from {@link eraseSpan}.
 * @returns The document without them; always open.
 */
export function erase(doc: TrackDoc, span: readonly number[]): TrackDoc {
  if (span.length === 0) return doc;

  const n = doc.path.length;
  const gone = new Set(span);

  if (gone.size >= n) return EMPTY_DOC;
  if (!doc.closed) return { path: doc.path.filter((_, i) => !gone.has(i)), closed: false, finish: -1 };

  // The loop opens after the span: the first kept cell past it is the new tail.
  let start = 0;

  while (!gone.has(start)) start++;
  while (gone.has(start)) start = (start + 1) % n;

  const path: BoardCell[] = [];

  for (let k = 0, i = start; k < n; k++, i = (i + 1) % n) {
    if (gone.has(i)) break;
    path.push(doc.path[i]);
  }

  return { path, closed: false, finish: -1 };
}

/**
 * Moves the start line, where it can go.
 * @param doc - A loop.
 * @param index - Path index for it.
 * @returns The document with the start there, or unchanged.
 */
export function moveFinish(doc: TrackDoc, index: number): TrackDoc {
  if (!finishSpots(doc).includes(index)) return doc;

  return { ...doc, finish: index };
}

/**
 * Races the loop the other way round (or swaps an open road's ends). The start line keeps its cell.
 * @param doc - The document.
 * @returns The document reversed.
 */
export function reverse(doc: TrackDoc): TrackDoc {
  const n = doc.path.length;
  const path = [...doc.path].reverse();

  return { path, closed: doc.closed, finish: doc.finish < 0 ? -1 : n - 1 - doc.finish };
}

/** A binary min-heap of indices into a cost table. */
class Heap {
  private readonly _items: number[] = [];
  private readonly _cost: number[] = [];

  public get size(): number {
    return this._items.length;
  }

  public push(item: number, cost: number): void {
    const items = this._items;
    const costs = this._cost;
    let i = items.length;

    items.push(item);
    costs.push(cost);

    while (i > 0) {
      const p = (i - 1) >> 1;

      if (costs[p] <= cost) break;

      items[i] = items[p];
      costs[i] = costs[p];
      i = p;
    }

    items[i] = item;
    costs[i] = cost;
  }

  public pop(): number {
    const items = this._items;
    const costs = this._cost;
    const top = items[0];
    const item = items.pop()!;
    const cost = costs.pop()!;
    const n = items.length;

    if (n > 0) {
      let i = 0;

      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        let mc = cost;

        if (l < n && costs[l] < mc) {
          m = l;
          mc = costs[l];
        }

        if (r < n && costs[r] < mc) m = r;
        if (m === i) break;

        items[i] = items[m];
        costs[i] = costs[m];
        i = m;
      }

      items[i] = item;
      costs[i] = cost;
    }

    return top;
  }
}

/** Where a search for new road starts: the cell it leaves from, the way it was entered, and the straight behind it. */
interface SearchStart {
  readonly cell: BoardCell;
  readonly dir: number;
  /** Straights in a row ending at the cell before `cell`, up to 3. */
  readonly run: number;
  /** Whether a straight of three is already in the loop. */
  readonly has3: boolean;
  /** Loop cells so far, up to 10. */
  readonly count: number;
}

/** What one search looks for. */
interface SearchGoal {
  /** A cell new road may go through. */
  free(cell: BoardCell): boolean;
  /** A road cell the new road may end beside. */
  goal(cell: BoardCell): boolean;
  /** Whether arriving at `goal` heading `dir`, with this straight and count, may be a loop worth checking. */
  accept(goal: BoardCell, dir: number, run: number, has3: boolean, count: number): boolean;
  /** The exact check on a candidate: the new cells in order and the cell they rejoin at. */
  check(cells: readonly BoardCell[], goal: BoardCell): boolean;
  /** New cells allowed. */
  readonly maxCells: number;
}

const STATES = BOARD_W * BOARD_H * 4 * 4 * 2 * 11;
/** The search's tables, kept between searches: the editor runs one on every edit of a loop with no start. */
const _cost = new Float64Array(STATES);
const _parent = new Int32Array(STATES);
const _done = new Uint8Array(STATES);
const _onPath = new Uint8Array(BOARD_W * BOARD_H);

/**
 * A cheapest-first search over (cell, heading, straight run, has a straight of three, loop cells up to 10), cost 1 a
 * cell and {@link TURN_COST} a turn, that never crosses its own new cells. Candidates leave in cost order and the first
 * that passes the exact check wins.
 * @returns The new cells, and the road cell they rejoin at, or null.
 */
function search(start: SearchStart, goal: SearchGoal): { cells: BoardCell[]; goal: BoardCell } | null {
  const cost = _cost.fill(Infinity);
  const parent = _parent.fill(-1);
  const done = _done.fill(0);
  const onPath = _onPath;
  const heap = new Heap();
  // Goal candidates share the heap: a negative item -(state + 1) * 4 - dir arrives at that state's goal heading dir.
  const key = (cell: number, dir: number, run: number, has3: number, count: number): number =>
    (((cell * 4 + dir) * 4 + run) * 2 + has3) * 11 + count;
  const cellOf = (state: number): number => Math.floor(state / (4 * 4 * 2 * 11));
  const root = key(start.cell, start.dir, Math.min(3, start.run), start.has3 ? 1 : 0, Math.min(10, start.count));

  cost[root] = 0;
  heap.push(root, 0);

  const trail = (state: number): BoardCell[] => {
    const cells: BoardCell[] = [];

    for (let s = state; s !== root; s = parent[s]) cells.push(cellOf(s));

    return cells.reverse();
  };

  while (heap.size > 0) {
    const item = heap.pop();

    if (item < 0) {
      const code = -item - 1;
      const state = Math.floor(code / 4);
      const dir = code % 4;
      const cells = trail(state);
      const at = stepCell(cellOf(state), dir);

      if (goal.check(cells, at)) return { cells, goal: at };
      continue;
    }

    if (done[item]) continue;
    done[item] = 1;

    let rest = item;
    const count = rest % 11;
    rest = Math.floor(rest / 11);
    const has3 = rest % 2;
    rest = Math.floor(rest / 2);
    const run = rest % 4;
    rest = Math.floor(rest / 4);
    const dir = rest % 4;
    const cell = Math.floor(rest / 4);
    const cells = item === root ? [] : trail(item);

    onPath.fill(0);
    for (const c of cells) onPath[c] = 1;

    for (let d = 0; d < 4; d++) {
      if (d === (dir + 2) % 4) continue;

      const next = stepCell(cell, d);

      if (next < 0) continue;

      const straight = d === dir;
      const step = 1 + (straight ? 0 : TURN_COST);
      const nrun = straight ? Math.min(3, run + 1) : 0;
      const nhas3 = has3 || (straight && run + 1 >= 3) ? 1 : 0;

      if (item !== root && goal.goal(next)) {
        if (goal.accept(next, d, nrun, nhas3 === 1, count)) heap.push(-(item * 4 + d) - 1, cost[item] + step);
        continue;
      }

      if (onPath[next] || !goal.free(next) || cells.length >= goal.maxCells) continue;

      const ns = key(next, d, nrun, nhas3, Math.min(10, count + 1));
      const nc = cost[item] + step;

      if (nc < cost[ns]) {
        cost[ns] = nc;
        parent[ns] = item;
        heap.push(ns, nc);
      }
    }
  }

  return null;
}

/**
 * The one-tap fix for a loop with no start: for each straight, longest first, and each of its ends, a reroute
 * that carries the straight on to three cells and comes back to the loop within ten.
 * @param doc - A closed loop with no start.
 * @returns A reroute that gives a track, or null.
 */
export function startFix(doc: TrackDoc): StartFix | null {
  const path = doc.path;
  const n = path.length;

  if (!doc.closed || n < 4) return null;

  const turns = loopTurns(path);
  let runs = straightRuns(turns).sort((a, b) => b.length - a.length);

  // A loop of nothing but corners starts its straight from any cell.
  if (runs.length === 0) runs = path.map((_, i) => ({ start: i, length: 0 }));

  const index = new Map(path.map((cell, i) => [cell, i]));

  for (const run of runs) {
    for (const forward of [true, false]) {
      // The corner past this end of the straight carries it on.
      const from = forward ? (run.start + run.length) % n : wrap(run.start - 1, n);
      const dir = forward
        ? headingTo(path[wrap(from - 1, n)], path[from])
        : headingTo(path[(from + 1) % n], path[from]);

      for (let extra = 0; extra < 3; extra++) {
        const straight: BoardCell[] = [];
        let at = path[from];
        let blocked = false;

        for (let k = 0; k < 3 - Math.min(2, run.length) + extra; k++) {
          at = stepCell(at, dir);

          if (at < 0 || index.has(at) || straight.includes(at)) {
            blocked = true;
            break;
          }

          straight.push(at);
        }

        if (blocked || straight.length === 0) continue;

        const fix = (rest: readonly BoardCell[], goal: BoardCell): StartFix | null => {
          const to = index.get(goal)!;
          const cells = [...straight, ...rest];

          if (to === from) return null;

          for (const longer of [false, true]) {
            const next = reroute(doc, from, cells, to, longer);

            if (status(next) === 'ready') return { from, to, cells, longer };
          }

          return null;
        };
        const last = straight[straight.length - 1];
        // The straight may already end beside the loop; else the search brings it back.
        let result: StartFix | null = null;

        for (let d = 0; d < 4 && !result; d++) {
          const goal = stepCell(last, d);

          if (goal >= 0 && index.has(goal) && goal !== path[from]) result = fix([], goal);
        }

        const found = result
          ? null
          : search(
              { cell: last, dir, run: 3, has3: true, count: 10 },
              {
                free: (cell) => !index.has(cell) && !straight.includes(cell),
                goal: (cell) => index.has(cell) && cell !== path[from],
                accept: () => true,
                check: (rest, goal) => fix(rest, goal) !== null,
                maxCells: FIX_REJOIN,
              },
            );

        if (found) result = fix(found.cells, found.goal);
        if (result) return result;
      }
    }
  }

  return null;
}

/**
 * Shift+click on grass: one straight, or an L, from an open road's end to a free cell.
 * @param doc - An open road.
 * @param end - The end it leaves from.
 * @param cell - The cell to reach.
 * @param legFirst - Which leg of an L goes first.
 * @returns The cells to lay, ending on `cell`, or null when the way is blocked.
 */
export function routeTo(
  doc: TrackDoc,
  end: 'head' | 'tail',
  cell: BoardCell,
  legFirst: 'x' | 'y',
): readonly BoardCell[] | null {
  const path = doc.path;

  if (doc.closed || path.length === 0) return null;

  const from = end === 'head' ? path[path.length - 1] : path[0];
  const used = new Set(path);
  const out: BoardCell[] = [];
  let x = cellX(from);
  let y = cellY(from);
  const tx = cellX(cell);
  const ty = cellY(cell);

  if (x === tx && y === ty) return null;

  for (const axis of legFirst === 'x' ? ['x', 'y'] : ['y', 'x']) {
    while (axis === 'x' ? x !== tx : y !== ty) {
      if (axis === 'x') x += Math.sign(tx - x);
      else y += Math.sign(ty - y);

      const next = cellAt(x, y);

      if (next < 0 || used.has(next)) return null;

      out.push(next);
    }
  }

  return out;
}

/** Every cell of the path, moved by `map`; null when one leaves the board. */
function mapCells(doc: TrackDoc, map: (bx: number, by: number) => [number, number]): TrackDoc | null {
  const path: BoardCell[] = [];

  for (const cell of doc.path) {
    const [bx, by] = map(cellX(cell), cellY(cell));
    const next = cellAt(bx, by);

    if (next < 0) return null;

    path.push(next);
  }

  return { ...doc, path };
}

/** The path's bounding box in board cells. */
function box(path: readonly BoardCell[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = BOARD_W;
  let maxX = -1;
  let minY = BOARD_H;
  let maxY = -1;

  for (const cell of path) {
    minX = Math.min(minX, cellX(cell));
    maxX = Math.max(maxX, cellX(cell));
    minY = Math.min(minY, cellY(cell));
    maxY = Math.max(maxY, cellY(cell));
  }

  return { minX, maxX, minY, maxY };
}

/**
 * Mirrors the track left to right where it stands: its left-handers become right-handers.
 * @param doc - The document.
 * @returns The mirror image.
 */
export function mirror(doc: TrackDoc): TrackDoc {
  if (doc.path.length === 0) return doc;

  const { minX, maxX } = box(doc.path);

  return mapCells(doc, (bx, by) => [minX + maxX - bx, by]) ?? doc;
}

/**
 * Moves the whole track.
 * @param doc - The document.
 * @param dx - Cells right.
 * @param dy - Cells down.
 * @returns The moved document, or null when it would leave the board.
 */
export function nudge(doc: TrackDoc, dx: number, dy: number): TrackDoc | null {
  if (doc.path.length === 0) return null;

  return mapCells(doc, (bx, by) => [bx + dx, by + dy]);
}

/**
 * The track the document makes.
 * @param doc - The document.
 * @param name - Its name.
 * @returns The track, or why it isn't one: `open` while open, `start` with no start line.
 */
export function toTrack(doc: TrackDoc, name: string): TrackDef | TrackError {
  if (!doc.closed) return 'open';
  if (doc.finish < 0) return 'start';

  const cells: Cell[] = doc.path.map((cell) => [cellX(cell), cellY(cell)]);

  return trackFromTurns(turnsFromLoop(cells, doc.finish), name);
}

/** A canonical cell turned `rot` quarter turns clockwise. */
function turn(x: number, z: number, rot: Rot): [number, number] {
  switch (rot) {
    case 0:
      return [x, z];
    case 1:
      return [-z, x];
    case 2:
      return [-x, -z];
    case 3:
      return [z, -x];
  }
}

/**
 * How a loop sits on the board: the quarter turns clockwise from canonical (where the race leaves the start line
 * heading down the board), and the start line's cell.
 * @param doc - The document.
 * @returns Board = canonical turned by `rot`, plus (`dx`, `dz`); zeros while it isn't a loop with a start.
 */
export function placement(doc: TrackDoc): { rot: Rot; dx: number; dz: number } {
  const n = doc.path.length;

  if (!doc.closed || doc.finish < 0) return { rot: 0, dx: 0, dz: 0 };

  const cell = doc.path[doc.finish];
  const dir = headingTo(cell, doc.path[(doc.finish + 1) % n]);

  return { rot: ((dir + 3) % 4) as Rot, dx: cellX(cell), dz: cellY(cell) };
}

/**
 * A point in canonical grid coordinates (cell centres on whole numbers) as board coordinates under a placement.
 * @param x - Canonical x, in cells.
 * @param z - Canonical z, in cells.
 * @param place - From {@link placement}.
 * @returns Board x and y, in cells.
 */
export function toBoard(x: number, z: number, place: { rot: Rot; dx: number; dz: number }): [number, number] {
  const [bx, by] = turn(x, z, place.rot);

  return [bx + place.dx, by + place.dz];
}

/** Which way a track goes on the board when nothing says: the start heading right, then left, down, up. */
const ROT_PREFERENCE: readonly Rot[] = [3, 1, 0, 2];

/**
 * A track laid on the board, centred.
 * @param def - The track.
 * @param rot - Its author's turn, when known and it fits; else the first of right, left, down and up that fits.
 * @returns A closed document with the start line on its first cell.
 */
export function fromTrack(def: TrackDef, rot?: Rot): TrackDoc {
  for (const r of rot === undefined ? ROT_PREFERENCE : [rot, ...ROT_PREFERENCE]) {
    const turned = def.cells.map(([x, z]) => turn(x, z, r));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const [x, y] of turned) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;

    if (w > BOARD_W || h > BOARD_H) continue;

    const ox = Math.floor((BOARD_W - w) / 2) - minX;
    const oy = Math.floor((BOARD_H - h) / 2) - minY;

    return { path: turned.map(([x, y]) => cellAt(x + ox, y + oy)), closed: true, finish: 0 };
  }

  return EMPTY_DOC;
}

/** How a track feels to drive, in a word, from its turns. */
export interface Feel {
  readonly word: 'Flowing' | 'Twisty' | 'Wild';
  readonly level: 1 | 2 | 3;
  readonly corners: number;
  /** Two corners the same way in a row. */
  readonly hairpins: number;
  /** Two corners opposite ways in a row. */
  readonly esses: number;
}

/**
 * The feel word: twist = (corners + hairpins + half the S-bends) / pieces; under 0.35 Flowing, under 0.55 Twisty, else
 * Wild. Night Run is 0.41, Twisty.
 * @param turns - A loop's turns.
 * @returns The word, its level and the counts behind it.
 */
export function feel(turns: Turns): Feel {
  const n = turns.length;
  let corners = 0;
  let hairpins = 0;
  let esses = 0;

  for (let i = 0; i < n; i++) {
    const a = turns[i];
    const b = turns[(i + 1) % n];

    if (a === 'S') continue;

    corners++;

    if (b === a) hairpins++;
    else if (b !== 'S') esses++;
  }

  const twist = n > 0 ? (corners + hairpins + esses * 0.5) / n : 0;
  const level = twist < 0.35 ? 1 : twist < 0.55 ? 2 : 3;

  return { word: (['Flowing', 'Twisty', 'Wild'] as const)[level - 1], level, corners, hairpins, esses };
}

/** A ring of cells round a box, clockwise from its top-left corner. */
function ring(x0: number, y0: number, w: number, h: number): BoardCell[] {
  const cells: BoardCell[] = [];

  for (let x = x0; x < x0 + w; x++) cells.push(cellAt(x, y0));
  for (let y = y0 + 1; y < y0 + h; y++) cells.push(cellAt(x0 + w - 1, y));
  for (let x = x0 + w - 2; x >= x0; x--) cells.push(cellAt(x, y0 + h - 1));
  for (let y = y0 + h - 2; y > y0; y--) cells.push(cellAt(x0, y));

  return cells;
}

/** The starting points for a new track: names the editor's Start over sheet shows. */
export type TemplateName = 'nightrun' | 'oval' | 'ring' | 'blank';

/**
 * A starting point: Night Run to remix, an 8 by 4 oval, the whole board's edge, or nothing.
 * @param name - Which.
 * @returns Its document.
 */
export function template(name: TemplateName): TrackDoc {
  switch (name) {
    case 'nightrun':
      return fromTrack(BASE_TRACK, 0);
    case 'oval':
      return close({ path: ring(3, 2, 8, 4), closed: false, finish: -1 });
    case 'ring':
      return close({ path: ring(0, 0, BOARD_W, BOARD_H), closed: false, finish: -1 });
    case 'blank':
      return EMPTY_DOC;
  }
}

/**
 * A random track, laid on the board.
 * @param seed - Any integer; the same seed gives the same track.
 * @returns A ready document.
 */
export function shuffle(seed: number): TrackDoc {
  const def = trackFromTurns(generateTurns(seed));

  return typeof def === 'string' ? template('oval') : fromTrack(def);
}

/** Whether two documents are the same. */
export function sameDoc(a: TrackDoc, b: TrackDoc): boolean {
  return (
    a.closed === b.closed &&
    a.finish === b.finish &&
    a.path.length === b.path.length &&
    a.path.every((cell, i) => cell === b.path[i])
  );
}

/** Straight and corner lengths of the centreline, as the route measures them. */
const STRAIGHT_M = 7.4925;
const CORNER_M = (Math.PI / 2) * (7.4925 / 2);

/**
 * A loop's pieces and its exact length.
 * @param turns - Its turns.
 * @returns Pieces, metres (straights x 7.4925 + corners x 5.8846) and corners.
 */
export function measure(turns: Turns): { pieces: number; metres: number; corners: number } {
  let corners = 0;

  for (const t of turns) if (t !== 'S') corners++;

  return {
    pieces: turns.length,
    metres: (turns.length - corners) * STRAIGHT_M + corners * CORNER_M,
    corners,
  };
}
