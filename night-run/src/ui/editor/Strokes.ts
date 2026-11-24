/**
 * The editor's strokes, on board cells: what a press does depends only on where it lands and what it does first. A pointer, a finger and the keyboard's pen all drive the same calls: `down` on the press,
 * `begin` once it has moved far enough to be a drag (the keyboard's pen begins at once), `to` each time it's over
 * another cell, and `up` or `cancel`. Nothing is committed until `up`, which hands back the new document.
 */

import type { BoardCell, Refusal, TrackDoc } from '../../track/doc';
import {
  adjacent,
  backtrack,
  cellAt,
  cellX,
  cellY,
  close,
  erase,
  eraseSpan,
  extend,
  finishSpots,
  reroute,
  rerouteDrop,
  stepCell,
} from '../../track/doc';

/** What a committed stroke did, for its sound and its feedback. */
export type StrokeKind = 'lay' | 'close' | 'reroute' | 'erase' | 'start';

/** A committed stroke. */
export interface StrokeCommit {
  readonly doc: TrackDoc;
  readonly kind: StrokeKind;
}

/** What the board draws for the stroke under way. */
export interface StrokePaint {
  /** The document as the stroke would leave it (a road being laid grows in place). */
  readonly doc: TrackDoc;
  /** New road previewed: from the cell it leaves to the cell it rejoins, each -1 when there's none. */
  readonly ghost: readonly BoardCell[];
  readonly ghostFrom: BoardCell;
  readonly ghostTo: BoardCell;
  /** The ghost isn't back on the road yet: drawn amber. */
  readonly ghostWarn: boolean;
  /** Path indices of `doc` that go, drawn red with hazard dashes. */
  readonly going: ReadonlySet<number>;
  /** Cells an erase touched that stay. */
  readonly kept: ReadonlySet<BoardCell>;
  /** The start line being dragged: the path index it would land on, or -1; and a cell it can't go, or -1. */
  readonly startAt: number;
  readonly startBad: BoardCell;
  /** A cell a release would snap onto, pulsing. */
  readonly magnet: BoardCell;
  /** Road being laid from an end: the other end, which it closes on, or -1. */
  readonly target: BoardCell;
  readonly kind: 'none' | 'lay' | 'reroute' | 'start' | 'erase';
}

/** What the strokes tell the editor as they go. */
export interface StrokeFeedback {
  /** A cell refused: the road there, or the board's edge. */
  refuse(cell: BoardCell, why: Refusal): void;
  /** Cells laid this step; `length` is the road's length after. */
  laid(count: number, length: number): void;
  rubbed(count: number): void;
  /** Grass pressed with road on the board: the ends (or the loop) pulse. */
  pulseEnds(): void;
  /** A tip for a press that did nothing, in a bubble over the cell. */
  hint(text: string, cell: BoardCell): void;
  /** A refusal that isn't a cell: a bubble over the finger, with the error sound. */
  bubble(text: string, cell: BoardCell): void;
  /** The start line tapped: light the loop the way the race runs. */
  showDirection(): void;
}

const EMPTY_SET: ReadonlySet<number> = new Set();
/** A fast flick back toward the head rubs out this far at once; further back, it's crossing the road. */
const RUB_REACH = 3;

/** A cell's 4-connected staircase to another, along the line between their centres, the longer axis first on ties. */
export function staircase(from: BoardCell, to: BoardCell): BoardCell[] {
  const fx = cellX(from);
  const fy = cellY(from);
  const tx = cellX(to);
  const ty = cellY(to);
  const dx = tx - fx;
  const dy = ty - fy;
  const out: BoardCell[] = [];
  let x = fx;
  let y = fy;

  while (x !== tx || y !== ty) {
    const ex = x + Math.sign(tx - x);
    const ey = y + Math.sign(ty - y);

    if (x === tx) y = ey;
    else if (y === ty) x = ex;
    else {
      const offX = Math.abs((ex - fx) * dy - (y - fy) * dx);
      const offY = Math.abs((x - fx) * dy - (ey - fy) * dx);

      if (offX < offY || (offX === offY && Math.abs(dx) >= Math.abs(dy))) x = ex;
      else y = ey;
    }

    out.push(cellAt(x, y));
  }

  return out;
}

type Mode =
  | { kind: 'idle' }
  /** Pressed, not yet a drag. */
  | { kind: 'pressed'; target: 'empty' | 'head' | 'tail' | 'road' | 'start' | 'grass'; erase: boolean }
  /** On the road, waiting to see whether it leaves it. */
  | { kind: 'armed'; start: boolean; from: number }
  | { kind: 'dead' }
  | { kind: 'lay'; end: 'head' | 'tail'; doc: TrackDoc; laid: number; closed: boolean }
  | { kind: 'reroute'; from: number; ghost: BoardCell[]; to: number }
  | { kind: 'start'; at: number; bad: BoardCell }
  | { kind: 'erase'; touched: number[] };

/** One stroke at a time, from press to release. */
export class Strokes {
  private readonly _feedback: StrokeFeedback;
  private _base: TrackDoc = { path: [], closed: false, finish: -1 };
  private _index = new Map<BoardCell, number>();
  private _mode: Mode = { kind: 'idle' };
  private _press: BoardCell = -1;
  /** The cell the pointer was last over. */
  private _at: BoardCell = -1;
  private _paint: StrokePaint | null = null;

  constructor(feedback: StrokeFeedback) {
    this._feedback = feedback;
  }

  /** A stroke is under way, pressed or dragging. */
  public get active(): boolean {
    return this._mode.kind !== 'idle';
  }

  /** The stroke has turned into a drag: a tap can no longer come of it. */
  public get dragging(): boolean {
    const kind = this._mode.kind;

    return kind !== 'idle' && kind !== 'pressed';
  }

  /** Which end of an open road the stroke is laying from, if any. */
  public get end(): 'head' | 'tail' | null {
    return this._mode.kind === 'lay' ? this._mode.end : null;
  }

  /**
   * A press.
   * @param doc - The document as committed.
   * @param cell - The cell pressed.
   * @param erase - Right button, or the Erase button lit.
   */
  public down(doc: TrackDoc, cell: BoardCell, erase: boolean): void {
    this._base = doc;
    this._index = new Map(doc.path.map((c, i) => [c, i]));
    this._press = cell;
    this._at = cell;
    this._paint = null;

    const i = this._index.get(cell);
    const n = doc.path.length;
    let target: Extract<Mode, { kind: 'pressed' }>['target'];

    if (n === 0) target = 'empty';
    else if (i === undefined) target = 'grass';
    else if (!doc.closed && i === n - 1) target = 'head';
    else if (!doc.closed && i === 0) target = 'tail';
    else if (doc.closed && i === doc.finish) target = 'start';
    else target = 'road';

    this._mode = { kind: 'pressed', target, erase };
  }

  /** The press moved far enough to be a drag: it becomes the gesture its landing spot suggests. */
  public begin(): void {
    const mode = this._mode;

    if (mode.kind !== 'pressed') return;

    const doc = this._base;
    const press = this._press;

    if (mode.erase) {
      this._mode = { kind: 'erase', touched: [this._index.get(press) ?? -1] };
    } else if (mode.target === 'empty') {
      this._mode = { kind: 'lay', end: 'head', doc: extend(doc, 'head', [press]), laid: 1, closed: false };
      this._feedback.laid(1, 1);
    } else if (mode.target === 'head' || mode.target === 'tail') {
      this._mode = { kind: 'lay', end: mode.target, doc, laid: 0, closed: false };
    } else if (mode.target === 'road' || mode.target === 'start') {
      this._mode = { kind: 'armed', start: mode.target === 'start', from: this._index.get(press)! };
    } else {
      this._feedback.pulseEnds();
      this._feedback.hint(doc.closed ? 'Drag from the road to reshape it.' : 'Start from a glowing end.', press);
      this._mode = { kind: 'dead' };
    }

    this._paint = null;
  }

  /**
   * The pointer is over another cell.
   * @param cell - The cell, clamped onto the board.
   * @param off - The pointer itself is off the board's edge.
   */
  public to(cell: BoardCell, off = false): void {
    if (cell < 0 || cell === this._at) {
      if (off) this._edge(cell);

      return;
    }

    if (this._mode.kind === 'pressed') this.begin();

    const mode = this._mode;

    switch (mode.kind) {
      case 'lay':
        this._lay(mode, cell);
        break;
      case 'armed':
        this._armed(mode, cell);
        break;
      case 'reroute':
        this._reroute(mode, cell);
        break;
      case 'start':
        this._start(mode, cell);
        break;
      case 'erase':
        for (const c of staircase(this._at, cell)) mode.touched.push(this._index.get(c) ?? -1);
        this._at = cell;
        break;
      default:
        this._at = cell;
    }

    if (off) this._edge(this._at);
    this._paint = null;
  }

  /**
   * The release.
   * @returns The new document, or null when nothing changes.
   */
  public up(): StrokeCommit | null {
    const mode = this._mode;
    const doc = this._base;

    this._mode = { kind: 'idle' };
    this._paint = null;

    switch (mode.kind) {
      case 'pressed':
        return this._tap(mode);
      case 'lay': {
        let next = mode.doc;
        const n = next.path.length;
        const head = mode.end === 'head' ? next.path[n - 1] : next.path[0];
        const other = mode.end === 'head' ? next.path[0] : next.path[n - 1];

        // One cell short of the other end closes it, the race running the way the stroke went.
        if (!mode.closed && n >= 4 && adjacent(head, other)) next = closeFrom(next, mode.end);
        if (next === doc) return null;

        return { doc: next, kind: next.closed ? 'close' : 'lay' };
      }
      case 'reroute': {
        let to = mode.to;

        if (to < 0) to = this._magnet(mode);
        if (to < 0 || mode.ghost.length === 0) return null;

        return { doc: reroute(doc, mode.from, mode.ghost, to), kind: 'reroute' };
      }
      case 'start': {
        if (this._at === doc.path[doc.finish]) {
          this._feedback.showDirection();

          return null;
        }

        const i = this._index.get(this._at);

        if (i === undefined || !finishSpots(doc).includes(i)) {
          this._feedback.bubble('The start needs a straight before and after it.', this._at);

          return null;
        }

        return { doc: { ...doc, finish: i }, kind: 'start' };
      }
      case 'armed':
        if (mode.start && this._at === this._press) this._feedback.showDirection();

        return null;
      case 'erase': {
        const span = eraseSpan(doc, mode.touched);

        if (span === 'middle') {
          this._feedback.bubble('Erase from an end, or reshape it.', this._at);

          return null;
        }

        if (span.length === 0) return null;

        return { doc: erase(doc, span), kind: 'erase' };
      }
      default:
        return null;
    }
  }

  /** Esc, a right-click, or a second finger: the stroke goes, nothing committed. */
  public cancel(): void {
    this._mode = { kind: 'idle' };
    this._paint = null;
  }

  /** What the board draws for the stroke, or null when there's none. */
  public paint(): StrokePaint | null {
    const mode = this._mode;

    if (mode.kind === 'idle' || mode.kind === 'pressed' || mode.kind === 'dead' || mode.kind === 'armed') return null;

    if (this._paint) return this._paint;

    const doc = this._base;

    switch (mode.kind) {
      case 'lay': {
        const path = mode.doc.path;
        const far = mode.end === 'head' ? path[0] : path[path.length - 1];

        this._paint = this._paintOf({ kind: 'lay', doc: mode.doc, target: mode.closed || path.length < 2 ? -1 : far });
        break;
      }
      case 'reroute': {
        const going = mode.to >= 0 ? new Set(rerouteDrop(doc, mode.from, mode.to)) : EMPTY_SET;
        const magnet = mode.to < 0 ? this._magnet(mode) : -1;

        this._paint = this._paintOf({
          kind: 'reroute',
          ghost: mode.ghost,
          ghostFrom: doc.path[mode.from],
          ghostTo: mode.to >= 0 ? doc.path[mode.to] : -1,
          ghostWarn: mode.to < 0,
          going,
          magnet: magnet >= 0 ? doc.path[magnet] : -1,
        });
        break;
      }
      case 'start':
        this._paint = this._paintOf({ kind: 'start', startAt: mode.at, startBad: mode.bad });
        break;
      case 'erase': {
        const span = eraseSpan(doc, mode.touched);
        const going = span === 'middle' ? EMPTY_SET : new Set(span);
        const kept = new Set<BoardCell>();

        for (const i of mode.touched) if (i >= 0 && !going.has(i)) kept.add(doc.path[i]);

        this._paint = this._paintOf({ kind: 'erase', going, kept });
        break;
      }
    }

    return this._paint;
  }

  /** A press that never became a drag. */
  private _tap(mode: Extract<Mode, { kind: 'pressed' }>): StrokeCommit | null {
    const doc = this._base;
    const press = this._press;

    if (mode.erase) {
      const i = this._index.get(press);
      const span = i === undefined ? [] : eraseSpan(doc, [i]);

      if (span === 'middle') {
        this._feedback.bubble('Erase from an end, or reshape it.', press);

        return null;
      }

      return span.length > 0 ? { doc: erase(doc, span), kind: 'erase' } : null;
    }

    switch (mode.target) {
      case 'empty':
        this._feedback.laid(1, 1);

        return { doc: extend(doc, 'head', [press]), kind: 'lay' };
      case 'start':
        this._feedback.showDirection();

        return null;
      case 'grass':
        this._feedback.pulseEnds();
        this._feedback.hint(doc.closed ? 'Drag from the road to reshape it.' : 'Start from a glowing end.', press);

        return null;
      case 'road':
        this._feedback.hint('Drag out onto the grass and back to reshape it.', press);

        return null;
      default:
        return null;
    }
  }

  /** Laying from an end: each cell on the way is laid, rubbed out, closes the loop, or is refused. */
  private _lay(mode: Extract<Mode, { kind: 'lay' }>, cell: BoardCell): void {
    if (mode.closed) {
      this._at = cell;

      return;
    }

    let laid = 0;
    let rubbed = 0;
    const path = (): readonly BoardCell[] => mode.doc.path;
    const headOf = (): BoardCell => (mode.end === 'head' ? path()[path().length - 1] : path()[0]);
    // How far back from the laying end a cell is, along the road: 1 is the cell just before it.
    const behind = (c: BoardCell): number => {
      const p = path();
      const i = p.indexOf(c);

      if (i < 0) return -1;

      return mode.end === 'head' ? p.length - 1 - i : i;
    };

    const n = path().length;

    // Onto the far end of a road that has come round beside it: that closes it, however small, rather than rubbing a
    // four-piece road back to one.
    if (n >= 4 && cell === (mode.end === 'head' ? path()[0] : path()[n - 1]) && adjacent(headOf(), cell)) {
      mode.doc = closeFrom(mode.doc, mode.end);
      mode.closed = true;
      this._at = cell;

      return;
    }

    // A fast flick back along the road rubs out to where the pointer is.
    const back = behind(cell);

    if (back >= 1 && back <= RUB_REACH && path().length - back >= 1) {
      mode.doc = backtrack(mode.doc, mode.end, back);
      this._at = cell;
      this._feedback.rubbed(back);

      return;
    }

    for (const c of staircase(headOf(), cell)) {
      const p = path();
      const n = p.length;
      const b = behind(c);
      const other = mode.end === 'head' ? p[0] : p[n - 1];

      if (b === 1 && n > 1) {
        mode.doc = backtrack(mode.doc, mode.end, 1);
        rubbed++;
      } else if (c === other && n >= 4) {
        mode.doc = closeFrom(mode.doc, mode.end);
        mode.closed = true;
        this._at = c;
        break;
      } else if (b >= 0) {
        this._feedback.refuse(c, 'cross');
        break;
      } else {
        mode.doc = extend(mode.doc, mode.end, [c]);
        laid++;
      }

      this._at = c;
    }

    if (laid > 0) {
      mode.laid += laid;
      this._feedback.laid(laid, path().length);
    }

    if (rubbed > 0) this._feedback.rubbed(rubbed);
  }

  /** On the road: a step onto grass starts a reroute from the last road cell; along the road, it waits. */
  private _armed(mode: Extract<Mode, { kind: 'armed' }>, cell: BoardCell): void {
    for (const c of staircase(this._at, cell)) {
      const i = this._index.get(c);

      if (i === undefined) {
        const reroute: Extract<Mode, { kind: 'reroute' }> = { kind: 'reroute', from: mode.from, ghost: [], to: -1 };

        this._mode = reroute;
        this._reroute(reroute, cell);

        return;
      }

      if (mode.start) {
        const start: Extract<Mode, { kind: 'start' }> = { kind: 'start', at: this._base.finish, bad: -1 };

        this._mode = start;
        this._start(start, cell);

        return;
      }

      mode.from = i;
      this._at = c;
    }

    this._feedback.hint('Drag out onto the grass and back to reshape it.', this._at);
  }

  /** A reroute's ghost: free cells from the road, until it comes back onto another road cell. */
  private _reroute(mode: Extract<Mode, { kind: 'reroute' }>, cell: BoardCell): void {
    const doc = this._base;
    const fromCell = doc.path[mode.from];
    const headOf = (): BoardCell => (mode.ghost.length > 0 ? mode.ghost[mode.ghost.length - 1] : fromCell);
    // Back along the ghost: 1 is the cell before its head (the road cell it left, for the first).
    const behind = (c: BoardCell): number => {
      if (c === fromCell) return mode.ghost.length;

      const i = mode.ghost.indexOf(c);

      return i < 0 ? -1 : mode.ghost.length - 1 - i;
    };

    mode.to = -1;

    const back = behind(cell);

    if (back >= 1 && back <= RUB_REACH) {
      mode.ghost.length -= back;
      this._at = cell;
      this._feedback.rubbed(back);

      return;
    }

    let laid = 0;

    for (const c of staircase(headOf(), cell)) {
      const b = behind(c);
      const road = this._index.get(c);

      if (b === 1) {
        mode.ghost.pop();
        this._feedback.rubbed(1);
      } else if (b >= 0) {
        this._feedback.refuse(c, 'cross');
        break;
      } else if (road !== undefined) {
        if (mode.ghost.length > 0) {
          mode.to = road;
          this._at = c;
        }
        break;
      } else {
        mode.ghost.push(c);
        laid++;
      }

      this._at = c;
    }

    if (laid > 0) this._feedback.laid(laid, mode.ghost.length);
  }

  /** The start line dragged along the road: it lands only where three straights meet. */
  private _start(mode: Extract<Mode, { kind: 'start' }>, cell: BoardCell): void {
    const i = this._index.get(cell);

    this._at = cell;

    if (i === undefined) {
      mode.bad = -1;

      return;
    }

    if (finishSpots(this._base).includes(i)) {
      mode.at = i;
      mode.bad = -1;
    } else {
      mode.bad = cell;
    }
  }

  /** A reroute released one cell short of the road: the road cell beside its head it snaps onto, or -1. */
  private _magnet(mode: Extract<Mode, { kind: 'reroute' }>): number {
    const head = mode.ghost[mode.ghost.length - 1];

    if (head === undefined) return -1;

    for (let d = 0; d < 4; d++) {
      const c = stepCell(head, d);
      const i = c < 0 ? undefined : this._index.get(c);

      if (i !== undefined && i !== mode.from) return i;
    }

    return -1;
  }

  private _edge(cell: BoardCell): void {
    const kind = this._mode.kind;

    if (kind === 'lay' || kind === 'reroute') this._feedback.refuse(cell, 'edge');
  }

  private _paintOf(over: Partial<StrokePaint>): StrokePaint {
    return {
      doc: this._base,
      ghost: [],
      ghostFrom: -1,
      ghostTo: -1,
      ghostWarn: false,
      going: EMPTY_SET,
      kept: EMPTY_SET,
      startAt: -1,
      startBad: -1,
      magnet: -1,
      target: -1,
      kind: 'none',
      ...over,
    };
  }
}

/** Closes a road laid from one end: the race runs the way that end was laid. */
function closeFrom(doc: TrackDoc, end: 'head' | 'tail'): TrackDoc {
  return close(end === 'head' ? doc : { ...doc, path: [...doc.path].reverse() });
}
