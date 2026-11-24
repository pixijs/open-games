/**
 * The editor's undo: one snapshot of the document and the name per committed action, 200 deep, kept per track for the
 * page's life, so a test drive comes back to the same history, and in session storage (`nightrun:undo:<id>`) too, so a
 * reload does where the browser lets the page keep it.
 */

import { TRACK_NAME_LENGTH } from '../../track/code';
import type { TrackDoc } from '../../track/doc';
import { isDoc, sameDoc } from '../../track/doc';

/** One state the editor can go back to. */
export interface Snapshot {
  readonly doc: TrackDoc;
  readonly name: string;
}

/** Actions undo keeps. */
const DEPTH = 200;
const KEY = 'nightrun:undo:';
/** The stored history's shape; another version's is left alone. */
const VERSION = 1;

/** A track's history as it's kept. */
interface Kept {
  readonly at: number;
  readonly stack: readonly Snapshot[];
}

/** Every track's history this page has made, by entry id: it outlives the editor's screen. */
const kept = new Map<string, Kept>();

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isSnapshot(value: unknown): value is Snapshot {
  const s = value as Snapshot | null;

  return !!s && typeof s.name === 'string' && s.name.length <= TRACK_NAME_LENGTH && isDoc(s.doc);
}

/** A stored history, or null for one this version doesn't read or whose every snapshot isn't a document. */
function parse(raw: string | null): Kept | null {
  if (!raw) return null;

  const value = JSON.parse(raw) as { v?: unknown; at?: unknown; stack?: unknown };

  if (value.v !== VERSION || !Array.isArray(value.stack) || !value.stack.every(isSnapshot)) return null;
  if (!Number.isInteger(value.at)) return null;

  return { at: value.at as number, stack: value.stack as Snapshot[] };
}

/** A track's undo and redo. */
export class History {
  private readonly _id: string;
  private _stack: Snapshot[];
  private _at: number;

  /**
   * @param id - The library entry's id.
   * @param current - The track as it is now.
   * @param restore - Pick up the history kept for this track, when it ends where the track is now.
   */
  constructor(id: string, current: Snapshot, restore: boolean) {
    this._id = id;
    this._stack = [current];
    this._at = 0;

    if (restore) this._restore(current);
  }

  /** Steps that can be undone and redone. */
  public get counts(): { undo: number; redo: number } {
    return { undo: this._at, redo: this._stack.length - 1 - this._at };
  }

  /** Where the history stands. */
  public get current(): Snapshot {
    return this._stack[this._at];
  }

  /**
   * A committed action: what comes after it in redo is gone.
   * @param snap - The state after it.
   */
  public push(snap: Snapshot): void {
    this._stack.length = this._at + 1;
    this._stack.push(snap);

    if (this._stack.length > DEPTH + 1) this._stack.shift();

    this._at = this._stack.length - 1;
    this._save();
  }

  /** One step back, or null at the start. */
  public undo(): Snapshot | null {
    if (this._at === 0) return null;

    this._at--;
    this._save();

    return this._stack[this._at];
  }

  /** One step forward again, or null at the end. */
  public redo(): Snapshot | null {
    if (this._at >= this._stack.length - 1) return null;

    this._at++;
    this._save();

    return this._stack[this._at];
  }

  private _restore(current: Snapshot): void {
    let found = kept.get(this._id) ?? null;

    try {
      found ??= parse(session()?.getItem(KEY + this._id) ?? null);
    } catch {
      // A history that doesn't read starts afresh.
    }

    // Only a history that ends where the track is now: another tab may have changed it since.
    if (!found || found.at < 0 || found.at >= found.stack.length || !sameDoc(found.stack[found.at].doc, current.doc)) {
      return;
    }

    this._stack = [...found.stack];
    this._at = found.at;
  }

  private _save(): void {
    kept.set(this._id, { at: this._at, stack: [...this._stack] });

    try {
      session()?.setItem(KEY + this._id, JSON.stringify({ v: VERSION, at: this._at, stack: this._stack }));
    } catch {
      // Full or blocked: the page's own copy keeps it until the page closes.
    }
  }
}
