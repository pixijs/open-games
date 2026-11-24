/**
 * "My tracks": the player's tracks in this browser, which one is selected, and the best laps on each. Pure apart from
 * the `Storage` it's handed, so Node can drive it with a stand-in.
 *
 * Every track is its own key, `nightrun:lib:<id>`, written alone with one `setItem` on every commit of that track and
 * removed with one `removeItem`. There is no shared index: the library is whatever `nightrun:lib:*` keys exist. Local
 * storage has no read-modify-write across tabs, so a shared list would let one tab drop a track another tab just saved
 * (the share flow opens a link in a second tab while the first is still open); one key per track can't.
 */

import { cleanTrackName, decodeTrack, isTrackError, TRACK_NAME_LENGTH } from './code';
import type { TrackDef } from './code';
import type { BoardCell, Rot, TrackDoc } from './doc';
import { EMPTY_DOC, isDoc, status, toTrack } from './doc';

/** One saved track, as stored (with `v: 1`). */
export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
  /** Who drew it: the driver name it was saved under. */
  readonly author: string;
  /** Who shared it, for a track that came by link or from a party; '' for your own. */
  readonly from: string;
  /** The editor's document, board cells (`doc.ts`). */
  readonly path: readonly BoardCell[];
  readonly closed: boolean;
  readonly finish: number;
  /** How its author's board turned it: every plan of it is drawn this way round. */
  readonly rot: Rot;
  /** Its share code; null while it's a draft; '' is Night Run everywhere. */
  readonly code: string | null;
  readonly created: number;
  readonly updated: number;
}

/** What saving says. */
export type SaveResult = 'saved' | 'full' | 'memory';

/** The selection's id for the built-in Night Run. */
export const BASE_ID = 'base';
/** The most tracks the library keeps. */
export const LIBRARY_MAX = 200;

const ENTRY_PREFIX = 'nightrun:lib:';
const SELECTED_KEY = 'nightrun:track';
const BEST_PREFIX = 'nightrun:best:';
const ENTRY_VERSION = 1;

/** Word lists for a new track's name, like the drivers'. */
const FIRST = ['Neon', 'Midnight', 'Rain', 'Chrome', 'Static', 'Velvet', 'Ember', 'Glass'] as const;
const SECOND = ['Loop', 'Hook', 'Run', 'Ring', 'Snake', 'Bend', 'Hairpin', 'Sprint'] as const;

/**
 * A generated track name, from two word lists.
 * @param random - A source in [0, 1).
 * @returns For example "Neon Hook".
 */
export function trackName(random: () => number = Math.random): string {
  return `${FIRST[Math.floor(random() * FIRST.length)]} ${SECOND[Math.floor(random() * SECOND.length)]}`;
}

/**
 * The key a best lap is kept under: Night Run's is the one it always had.
 * @param code - The track's code; '' for Night Run.
 * @param laps - The race's laps.
 * @returns The storage key.
 */
export function bestKey(code: string, laps: number): string {
  return code === '' ? `${BEST_PREFIX}${laps}` : `${BEST_PREFIX}${code}:${laps}`;
}

/**
 * An entry's document.
 * @param entry - The entry.
 * @returns What the editor edits.
 */
export function entryDoc(entry: LibraryEntry): TrackDoc {
  return { path: entry.path, closed: entry.closed, finish: entry.finish };
}

/**
 * The track an entry races, or null for a draft.
 * @param entry - The entry.
 * @returns A validated track with the entry's name.
 */
export function entryTrack(entry: LibraryEntry): TrackDef | null {
  if (entry.code === null) return null;

  const def = decodeTrack(entry.code, entry.name);

  return isTrackError(def) ? null : def;
}

/**
 * An entry for a document as it stands now: its code when it's a track, null when it isn't yet.
 * @param base - The entry it updates.
 * @param doc - The document.
 * @param name - Its name.
 * @param rot - How the board turns it; kept from `base` while the document isn't a track.
 * @returns The updated entry.
 */
export function withDoc(base: LibraryEntry, doc: TrackDoc, name: string, rot: Rot): LibraryEntry {
  const def = status(doc) === 'ready' ? toTrack(doc, name) : null;

  return {
    ...base,
    name: cleanTrackName(name) || base.name,
    path: [...doc.path],
    closed: doc.closed,
    finish: doc.finish,
    rot,
    code: def && !isTrackError(def) ? def.code : null,
    updated: Date.now(),
  };
}

/** A fresh id: time and randomness, base 36. */
function newId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0')}`;
}

/** Whether a parsed value is an entry this version reads, its document one the board holds. */
function isEntry(value: unknown): value is LibraryEntry & { v: number } {
  if (!value || typeof value !== 'object') return false;

  const e = value as Record<string, unknown>;

  return (
    e.v === ENTRY_VERSION &&
    typeof e.id === 'string' &&
    typeof e.name === 'string' &&
    isDoc({ path: e.path, closed: e.closed, finish: e.finish }) &&
    (e.code === null || typeof e.code === 'string') &&
    typeof e.created === 'number'
  );
}

/** The library: entries, the selection and best laps, over one `Storage`, or in memory without one. */
export class Library {
  /** Something another tab saved changed the library or the selection. */
  public onChange: (() => void) | null = null;
  private readonly _storage: Storage | null;
  /** Entries this tab couldn't write (storage full or blocked), kept for the page's life. */
  private readonly _memory = new Map<string, LibraryEntry>();
  private _selected: string = BASE_ID;
  private _bests = new Map<string, number>();

  /** @param storage - `localStorage`, or null where the browser blocks it. */
  constructor(storage: Storage | null) {
    this._storage = storage;
    this._selected = this._read(SELECTED_KEY) ?? BASE_ID;

    if (typeof window !== 'undefined') window.addEventListener('storage', this._onStorage);
  }

  /** Whether there's storage to save to at all; without it, tracks last as long as the page. */
  public get stored(): boolean {
    return this._storage !== null;
  }

  /** The selected entry's id, or {@link BASE_ID}. */
  public get selected(): string {
    if (this._selected !== BASE_ID && !this.get(this._selected)) return BASE_ID;

    return this._selected;
  }

  /**
   * Every entry, newest first.
   * @returns The entries.
   */
  public list(): LibraryEntry[] {
    const byId = new Map<string, LibraryEntry>();
    const storage = this._storage;

    if (storage) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);

          if (!key?.startsWith(ENTRY_PREFIX)) continue;

          const entry = this._parse(storage.getItem(key));

          if (entry) byId.set(entry.id, entry);
        }
      } catch {
        // Storage that throws on reading lists what this tab holds.
      }
    }

    for (const [id, entry] of this._memory) byId.set(id, entry);

    return [...byId.values()].sort((a, b) => b.created - a.created);
  }

  /**
   * One entry.
   * @param id - Its id.
   * @returns The entry, or null.
   */
  public get(id: string): LibraryEntry | null {
    return this._memory.get(id) ?? this._parse(this._read(ENTRY_PREFIX + id));
  }

  /**
   * The entry racing a code, the newest when there are several.
   * @param code - A track code.
   * @returns The entry, or null.
   */
  public byCode(code: string): LibraryEntry | null {
    return this.list().find((entry) => entry.code === code) ?? null;
  }

  /**
   * A new entry, not saved yet.
   * @param doc - Its document.
   * @param fields - Name, author, who shared it and its turn.
   * @returns The entry.
   */
  public create(doc: TrackDoc, fields: { name: string; author: string; from?: string; rot?: Rot }): LibraryEntry {
    const now = Date.now();
    const base: LibraryEntry = {
      id: newId(),
      name: cleanTrackName(fields.name).slice(0, TRACK_NAME_LENGTH) || trackName(),
      author: fields.author,
      from: fields.from ?? '',
      path: [],
      closed: false,
      finish: -1,
      rot: fields.rot ?? 0,
      code: null,
      created: now,
      updated: now,
    };

    return withDoc(base, doc ?? EMPTY_DOC, base.name, fields.rot ?? 0);
  }

  /**
   * Saves one entry under its own key.
   * @param entry - The entry.
   * @returns `saved`; `full` for a new entry past {@link LIBRARY_MAX}; `memory` when storage refused it and it's kept
   * for this page only.
   */
  public save(entry: LibraryEntry): SaveResult {
    const known = this.get(entry.id) !== null;

    if (!known && this.list().length >= LIBRARY_MAX) return 'full';

    if (this._write(ENTRY_PREFIX + entry.id, JSON.stringify({ v: ENTRY_VERSION, ...entry }))) {
      this._memory.delete(entry.id);

      return 'saved';
    }

    this._memory.set(entry.id, entry);

    return 'memory';
  }

  /**
   * Deletes one entry; the selection falls back to Night Run when it was this one.
   * @param id - Its id.
   */
  public remove(id: string): void {
    this._memory.delete(id);

    try {
      this._storage?.removeItem(ENTRY_PREFIX + id);
    } catch {
      // Blocked storage has nothing to remove.
    }

    if (this._selected === id) this.select(BASE_ID);
  }

  /**
   * Selects a track: what Quick race races and the title shows.
   * @param id - An entry's id, or {@link BASE_ID}.
   */
  public select(id: string): void {
    this._selected = id;
    this._write(SELECTED_KEY, id);
  }

  /**
   * A best lap.
   * @param code - The track's code.
   * @param laps - The race's laps.
   * @returns Milliseconds, or 0 with none.
   */
  public best(code: string, laps: number): number {
    const key = bestKey(code, laps);
    const value = Number(this._read(key) ?? this._bests.get(key) ?? 0);

    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * Keeps a race time when it beats the best.
   * @param code - The track's code.
   * @param laps - The race's laps.
   * @param ms - The time.
   * @returns Whether it was a best.
   */
  public offerBest(code: string, laps: number, ms: number): boolean {
    const best = this.best(code, laps);

    if (ms <= 0 || (best > 0 && ms >= best)) return false;

    const key = bestKey(code, laps);

    this._bests.set(key, ms);
    this._write(key, String(ms));

    return true;
  }

  public destroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('storage', this._onStorage);
    this.onChange = null;
  }

  private _parse(raw: string | null): LibraryEntry | null {
    if (!raw) return null;

    try {
      const value: unknown = JSON.parse(raw);

      if (!isEntry(value)) return null;

      const { v: _v, ...entry } = value;
      const rot = ([0, 1, 2, 3] as const).includes(entry.rot) ? entry.rot : 0;

      return {
        ...entry,
        rot,
        author: typeof entry.author === 'string' ? entry.author : '',
        from: typeof entry.from === 'string' ? entry.from : '',
        updated: typeof entry.updated === 'number' ? entry.updated : entry.created,
      };
    } catch {
      return null;
    }
  }

  private _read(key: string): string | null {
    try {
      return this._storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private _write(key: string, value: string): boolean {
    if (!this._storage) return false;

    try {
      this._storage.setItem(key, value);

      return true;
    } catch {
      return false;
    }
  }

  private readonly _onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key.startsWith(ENTRY_PREFIX) || e.key === SELECTED_KEY) {
      if (e.key === SELECTED_KEY) this._selected = e.newValue ?? BASE_ID;
      this.onChange?.();
    }
  };
}
