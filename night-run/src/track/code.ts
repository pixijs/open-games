/**
 * Tracks as data. A track is a closed loop of grid cells, written as one turn letter per cell from the finish cell in
 * race order: `S` straight, `L` left, `R` right. The pieces, their turns, the walls, the route and the share code all
 * follow from that string, and it can't express a branch, a stray cell or a lost finish. Pure: the room, every guest,
 * link import, the editor and the library validate with the same {@link decodeTrack}.
 *
 * Every track is placed the same way: the finish cell at grid (0, 0), racing along +z, with straights before and after
 * it, so the arch, the grid and every staging shot sit in the same place on every track.
 */

/** The code format's version, its first character. */
export const CODE_VERSION = '1';
/**
 * The format's size limit, frozen for version 1, in cells either way round. The editor's board is its own size, so a
 * smaller board later can't invalidate codes already shared.
 */
export const TRACK_MAX_W = 14;
export const TRACK_MAX_H = 9;
/** The smallest loop with three straights in a row at the start: a 5 by 2 ring. */
export const MIN_CELLS = 10;
/** The most cells a track can have: every cell of the largest board. */
export const MAX_CELLS = TRACK_MAX_W * TRACK_MAX_H;
/** The longest code accepted: version 1 needs at most 43 characters; the rest is headroom for a later version. */
export const MAX_CODE_LENGTH = 64;
/** The longest track name shown. */
export const TRACK_NAME_LENGTH = 24;

/** A grid cell, x and z; its world centre is `(g + 0.5) * CELL` on each axis. */
export type Cell = readonly [number, number];
/** One of `S`, `L` and `R` per cell, from the finish cell, in race order. */
export type Turns = string;

/** A track, validated. */
export interface TrackDef {
  /** The share code: {@link CODE_VERSION} and the packed turns; '' for the built-in Night Run. Equal codes are the same track. */
  readonly code: string;
  readonly turns: Turns;
  /** Grid cells in race order: `cells[0]` is the finish cell at [0, 0], `cells[1]` is [0, 1]. */
  readonly cells: readonly Cell[];
  /** Display name, cleaned by {@link cleanTrackName}. */
  readonly name: string;
  /** The built-in Night Run, with its own curated pieces, scenery, lights, cranes, ground and racing line. */
  readonly builtIn: boolean;
}

/** Why a code or a loop isn't a track, the first rule it breaks. */
export type TrackError = 'version' | 'characters' | 'length' | 'open' | 'crossing' | 'start' | 'size';

/** Night Run's turns. */
export const BASE_TURNS = 'SSRSRSSLRSRSSRSS';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SYMBOLS = 'SLR';
/** The 2-bit symbol that ends the turns, padding the last character. */
const END = 3;

/**
 * Characters a name never shows: control characters, and the bidi marks, embeddings, overrides and isolates that would
 * turn the text round them backwards, so a link can't make "Maya shared a track" read as something else.
 */
// oxlint-disable-next-line no-control-regex
export const UNSHOWN_CHARACTERS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A later version's code: its version digit, then base64url, which a newer page reads. */
const LATER_VERSION = /^[2-9][A-Za-z0-9_-]+$/;

/**
 * Walks turns from the finish cell heading +z: `R` turns forward `(fx, fz)` to the driver's right `(-fz, fx)`, `L` to
 * `(fz, -fx)`, as the route measures them. The board's x right and y down map onto world x and z seen from above, so a
 * loop drawn on the board has the handedness it shows.
 */
function walk(turns: Turns): { cells: Cell[]; closed: boolean } {
  const cells: Cell[] = [];
  let x = 0;
  let z = 0;
  let fx = 0;
  let fz = 1;

  for (const turn of turns) {
    cells.push([x, z]);

    if (turn === 'R') [fx, fz] = [-fz, fx];
    else if (turn === 'L') [fx, fz] = [fz, -fx];

    x += fx;
    z += fz;
  }

  return { cells, closed: x === 0 && z === 0 && fx === 0 && fz === 1 };
}

/** Rules 3 to 7 of the validation, on turns already known to be `S`, `L` and `R` only. */
function checkTurns(turns: Turns): { cells: Cell[] } | TrackError {
  const n = turns.length;

  if (n < MIN_CELLS || n > MAX_CELLS) return 'length';

  const { cells, closed } = walk(turns);

  if (!closed) return 'open';

  const seen = new Set<string>();

  for (const [x, z] of cells) {
    const key = `${x},${z}`;

    if (seen.has(key)) return 'crossing';
    seen.add(key);
  }

  if (turns[0] !== 'S' || turns[1] !== 'S' || turns[n - 1] !== 'S') return 'start';

  let minX = 0;
  let maxX = 0;
  let minZ = 0;
  let maxZ = 0;

  for (const [x, z] of cells) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  const w = maxX - minX + 1;
  const d = maxZ - minZ + 1;

  if (Math.max(w, d) > TRACK_MAX_W || Math.min(w, d) > TRACK_MAX_H) return 'size';

  return { cells };
}

/** Night Run, as every track is described. */
export const BASE_TRACK: TrackDef = {
  code: '',
  turns: BASE_TURNS,
  cells: walk(BASE_TURNS).cells,
  name: 'Night Run',
  builtIn: true,
};

/**
 * Whether a decode or a build failed.
 * @param value - What {@link decodeTrack} or {@link trackFromTurns} returned.
 * @returns True for a {@link TrackError}.
 */
export function isTrackError(value: TrackDef | TrackError): value is TrackError {
  return typeof value === 'string';
}

/**
 * A track name as shown: control and bidi characters out, runs of spaces collapsed, trimmed, at most
 * {@link TRACK_NAME_LENGTH} characters.
 * @param raw - Anything; a non-string is an empty name.
 * @returns The clean name, possibly empty.
 */
export function cleanTrackName(raw: unknown): string {
  if (typeof raw !== 'string') return '';

  return raw.replace(UNSHOWN_CHARACTERS, '').replace(/\s+/g, ' ').trim().slice(0, TRACK_NAME_LENGTH).trim();
}

/**
 * Packs turns into a share code: {@link CODE_VERSION}, then one base64url character per three turns, the last padded
 * with end symbols.
 * @param turns - `S`, `L` and `R` only.
 * @returns The code.
 */
export function encodeTurns(turns: Turns): string {
  let code = CODE_VERSION;

  for (let i = 0; i < turns.length; i += 3) {
    let value = 0;

    for (let k = 0; k < 3; k++) {
      const symbol = i + k < turns.length ? SYMBOLS.indexOf(turns[i + k]) : END;

      value |= symbol << (k * 2);
    }

    code += B64URL[value];
  }

  return code;
}

/**
 * A track from turns, validated by rules 3 to 7 of {@link decodeTrack}. Night Run's own turns give Night Run.
 * @param turns - One letter per cell from the finish cell.
 * @param name - Its name, cleaned.
 * @returns The track, or the first rule it breaks.
 */
export function trackFromTurns(turns: Turns, name?: string): TrackDef | TrackError {
  if (!/^[SLR]*$/.test(turns)) return 'characters';
  if (turns === BASE_TURNS) return BASE_TRACK;

  const checked = checkTurns(turns);

  if (typeof checked === 'string') return checked;

  return { code: encodeTurns(turns), turns, cells: checked.cells, name: cleanTrackName(name), builtIn: false };
}

/**
 * The one validator. Rules, first failure wins: at most {@link MAX_CODE_LENGTH} characters and base64url after a
 * leading {@link CODE_VERSION}, with end symbols only at the tail of the last character (`characters`; a code that
 * leads with a later version's digit and is otherwise base64url is `version`);
 * {@link MIN_CELLS} to {@link MAX_CELLS} turns (`length`); the walk comes back to the finish heading +z (`open`);
 * no cell twice (`crossing`); the finish cell and the cells either side of it straight (`start`); the cells fit
 * {@link TRACK_MAX_W} by {@link TRACK_MAX_H} either way round (`size`). '' and Night Run's own code are Night Run.
 * @param code - A share code.
 * @param name - The track's name, cleaned.
 * @returns The track, or the first rule it breaks.
 */
export function decodeTrack(code: string, name?: string): TrackDef | TrackError {
  if (code === '') return BASE_TRACK;
  if (code.length > MAX_CODE_LENGTH) return 'characters';
  if (code[0] !== CODE_VERSION) return LATER_VERSION.test(code) ? 'version' : 'characters';

  let turns = '';

  for (let i = 1; i < code.length; i++) {
    const value = B64URL.indexOf(code[i]);

    if (value < 0) return 'characters';

    for (let k = 0; k < 3; k++) {
      const symbol = (value >> (k * 2)) & 3;

      if (symbol !== END) {
        turns += SYMBOLS[symbol];
        continue;
      }

      // Only the last character pads, it pads to its end, and it carries a turn: one code per track.
      if (i !== code.length - 1 || k === 0 || ((value >> (k * 2)) & 0b111111) !== (1 << ((3 - k) * 2)) - 1) {
        return 'characters';
      }

      break;
    }
  }

  return trackFromTurns(turns, name);
}

/**
 * A room's track field as received: a missing or non-string value, as an older host's state has, is Night Run.
 * @param value - `RaceState.track`, or anything.
 * @returns A code to decode.
 */
export function roomTrackCode(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The turns of any closed loop of neighbouring cells, starting at `start`, in the loop's order: each cell's turn from
 * the way it's entered to the way it's left.
 * @param cells - The loop, each cell beside the next and the last beside the first.
 * @param start - Index of the cell to start from, the finish cell.
 * @returns One letter per cell.
 */
export function turnsFromLoop(cells: readonly Cell[], start: number): Turns {
  const n = cells.length;
  let turns = '';

  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const [px, pz] = cells[(i - 1 + n) % n];
    const [gx, gz] = cells[i];
    const [nx, nz] = cells[(i + 1) % n];
    // A right turn takes forward toward the driver's right, which makes the cross product positive.
    const cross = (gx - px) * (nz - gz) - (gz - pz) * (nx - gx);

    turns += cross === 0 ? 'S' : cross > 0 ? 'R' : 'L';
  }

  return turns;
}
