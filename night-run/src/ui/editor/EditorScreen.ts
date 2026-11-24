/**
 * The track editor: one board, one path, no tools to pick. What a press does depends on where
 * it lands; the start line places and hops itself; an open road's two ends pulse until the player draws the loop
 * closed, and only a closed loop with a start can be raced or shared; every change is saved as it's made and is one
 * undo step, and the history survives a test drive and a reload.
 *
 * Round the board sit back and the name, six icon tools, Drive alone and Race it, and, while the track can't be raced,
 * one line saying why with its one-press fix when there is one. A press that does nothing says so in a bubble on the
 * board; on a desktop each control names its key when the mouse is over it. The board is one long-lived view: the
 * controls round it rebuild as the track changes, the board only redraws. Keys come through one capture-phase listener
 * that stands aside for text fields and sheets, so typing a name is never a shortcut; the game's own key handlers see
 * each key it used as already handled.
 */

import type { Text } from 'pixi.js';
import { CanvasTextMetrics, Container, Rectangle } from 'pixi.js';

import { TRACK_NAME_LENGTH } from '../../track/code';
import type { BoardCell, DocStatus, Rot, StartFix, TemplateName, TrackDoc } from '../../track/doc';
import {
  BOARD_H,
  BOARD_W,
  cellAt,
  cellX,
  cellY,
  mirror,
  moveFinish,
  nudge,
  placement,
  reroute,
  reverse,
  routeTo,
  sameDoc,
  shuffle,
  startFix,
  status,
  stepCell,
  template,
} from '../../track/doc';
import type { LibraryEntry } from '../../track/library';
import { entryDoc, withDoc } from '../../track/library';
import type { IconName } from '../art/icons';
import { iconSvg } from '../art/icons';
import { leanShift } from '../art/svg';
import { COLORS, RACERS } from '../art/tokens';
import type { NewTrack, Screen } from '../contract';
import type { Button } from '../kit/Button';
import { iconButton } from '../kit/buttons';
import { fitText, makeText } from '../kit/text';
import { MenuScreen } from '../screens/MenuScreen';
import type { BoardInput, BoardPaint } from './BoardView';
import { BoardView } from './BoardView';
import { History } from './History';
import { setActiveEditor } from './hooks';
import type { StrokeCommit, StrokeFeedback } from './Strokes';
import { Strokes } from './Strokes';

type EditorData = Extract<Screen, { id: 'editor' }>;
type Sheet = 'more' | 'rename' | 'shortcuts' | null;

/** Keyboard laying is capped at this many cells a second however fast the key repeats. */
const KEY_CELLS_PER_S = 12;
/** A gamepad's d-pad repeats after this, then this often. */
const PAD_DELAY_MS = 200;
const PAD_EVERY_MS = 80;
/** Controls' PAD bits the editor reads. */
const PAD = { confirm: 1, back: 2, x: 4, y: 8, select: 16, start: 32, up: 64, down: 128, left: 256, right: 512 };
const ARROWS: Readonly<Record<string, number>> = { ArrowRight: 0, ArrowDown: 1, ArrowLeft: 2, ArrowUp: 3 };

/** Why a track can't be raced yet, beside Race it. */
const REASON: Readonly<Record<Exclude<DocStatus, 'ready'>, string>> = {
  empty: 'Draw a loop',
  open: 'Close the loop',
  noStart: 'Needs 3 straight pieces at the start',
};

/** Shortcuts, as the sheet lists them. */
const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['Drag', 'Draw, extend, reshape, move the start'],
  ['Right-drag', 'Erase'],
  ['Shift+click', 'Route from the glowing end'],
  ['Arrows, Space', 'Move the cursor, pen down and up'],
  ['Z, Shift+Z', 'Undo, redo (Ctrl or Cmd too)'],
  ['F, Shift+F', 'Reverse, move the start to the cursor'],
  ['G, M', 'Shuffle, mirror'],
  ['Alt+arrows', 'Move the whole track'],
  ['N, S', 'Rename, share'],
  ['T, R', 'Drive alone, race three bots'],
  ['Backspace, X', 'Erase at the cursor'],
];

/** A box in screen px. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where everything goes in one layout. */
interface Frame {
  readonly board: { readonly x: number; readonly y: number; readonly cell: number; readonly turned: boolean };
  /** Back and the name. */
  readonly head: Rect;
  /** The icon tools, `cols` a row, each `h` tall and `gap` under the last. */
  readonly tools: Rect & { readonly cols: number; readonly gap: number };
  /**
   * The reason a track can't be raced: on a tall phone its row, which a fix shares; elsewhere only its left and width,
   * since it sits just over the fix or Drive alone.
   */
  readonly reason: Rect;
  readonly fix: Rect;
  readonly drive: Rect;
  readonly race: Rect;
}

/** One icon tool: what it's called, its keys for the tooltip, what it does and whether it can now. */
interface Tool {
  readonly icon: IconName;
  readonly label: string;
  readonly keys: readonly string[];
  readonly fn: () => void;
  readonly on: boolean;
  readonly lit?: boolean;
  /** Pressed while it can't: say why. */
  readonly explain?: boolean;
  /** What the tooltip calls it, when not its label. */
  readonly tip?: string;
}

/** The editor screen. */
export class EditorScreen extends MenuScreen<EditorData> {
  private _entry: LibraryEntry;
  private _doc: TrackDoc;
  private _name: string;
  private _history: History;
  private readonly _board: BoardView;
  private readonly _strokes: Strokes;
  private _fix: StartFix | null = null;
  private _status: DocStatus = 'empty';
  private _preview: BoardPaint['preview'] = null;
  private _cursor: BoardCell = -1;
  private _boardFocus = false;
  private _pen = false;
  private _erase = false;
  private _sheet: Sheet = null;
  private _draft = '';
  private _activeEnd: 'head' | 'tail' = 'head';
  private _hover: BoardCell = -1;
  private _shift = false;
  /** Whether the track holds nothing the player drew: a new track's starting point, or a Shuffle rolled on one. */
  private _fresh: boolean;
  private _keyAt = 0;
  private _padHeld = 0;
  private _padAt = 0;
  private _reasonNode: Container | null = null;
  private _race: Button | null = null;
  private _closing = false;

  constructor(host: ConstructorParameters<typeof MenuScreen<EditorData>>[0], data: EditorData) {
    super(host, data);
    this._entry = data.entry;
    this._doc = entryDoc(data.entry);
    this._name = data.entry.name;
    this._fresh = data.history === 'fresh';
    this._history = new History(data.entry.id, { doc: this._doc, name: this._name }, data.history === 'restore');
    this._doc = this._history.current.doc;
    this._name = this._history.current.name;
    this._strokes = new Strokes(this._feedback);
    this._board = new BoardView(host.kit.textures, this._input);
    this._recompute();
    window.addEventListener('keydown', this._onKey, { capture: true });
    window.addEventListener('contextmenu', this._onContext, { capture: true });
    setActiveEditor(this);
  }

  /** The document as it stands, for the test hook. */
  public get doc(): TrackDoc {
    return this._doc;
  }

  public get docStatus(): DocStatus {
    return this._status;
  }

  /** The track's code once it's one, else ''. */
  public get code(): string {
    return this._entry.code ?? '';
  }

  public get historyCounts(): { undo: number; redo: number } {
    return this._history.counts;
  }

  public get name(): string {
    return this._name;
  }

  /** Why the track can't be raced, as it shows beside Race it; '' once it can. */
  public get reason(): string {
    return this._status === 'ready' ? '' : REASON[this._status];
  }

  /** What the board shows a harness: the loupe, the last bubble and the refusals so far. */
  public get boardState(): { loupe: boolean; bubble: string; refusals: { cross: number; edge: number } } {
    const b = this._board;

    return { loupe: b.loupeShown, bubble: b.lastBubble, refusals: { ...b.refusals } };
  }

  /** CSS px of a board cell's centre, for harnesses. */
  public cellToClient(bx: number, by: number): { x: number; y: number } {
    const box = this._board.cellCentre(cellAt(bx, by));
    const g = this._board.toGlobal(box);

    return { x: g.x, y: g.y };
  }

  /** The board cell under a CSS px point, or null. */
  public clientToCell(x: number, y: number): { bx: number; by: number } | null {
    const local = this._board.toLocal({ x, y });

    if (!this._board.box.contains(local.x, local.y)) return null;

    const { cell } = this._board.cellAtBox(local.x, local.y);

    return { bx: cellX(cell), by: cellY(cell) };
  }

  /** The game showed the editor again: only another track (or a trail from a drive) changes it. */
  public override update(data: EditorData): void {
    const prev = this.data;

    this.data = data;

    if (prev.entry.id !== data.entry.id) {
      this._entry = data.entry;
      this._doc = entryDoc(data.entry);
      this._name = data.entry.name;
      this._fresh = data.history === 'fresh';
      this._history = new History(data.entry.id, { doc: this._doc, name: this._name }, data.history === 'restore');
      this._recompute();
      this.rebuild();
    } else if (prev.trail !== data.trail) {
      this._board.setTrail(data.trail);
    }
  }

  /** A turned phone lays the board out afresh: a stroke under way goes, since its cells were the old layout's. */
  public override relayout(): void {
    if (this._strokes.active || this._board.pressing) this._cancelStroke();

    this._board.dropFingers();
    this.rebuild();
  }

  public override destroy(): void {
    window.removeEventListener('keydown', this._onKey, { capture: true });
    window.removeEventListener('contextmenu', this._onContext, { capture: true });
    setActiveEditor(null);
    super.destroy();
  }

  public override exit(): Promise<void> {
    this._board.eventMode = 'none';

    return super.exit();
  }

  /** Esc or B: a stroke goes, then a sheet closes, then the editor goes back to the library. */
  public override back(): boolean {
    if (this._strokes.active) {
      this._cancelStroke();

      return true;
    }

    if (this._sheet) {
      this._closeSheet(false);

      return true;
    }

    if (this._closing) return true;

    this._closing = true;
    this.host.kit.sound.play('back');
    this.host.actions.closeEditor();

    return true;
  }

  /** Printable keys reach the editor through its own listener; the shell's never fires a shortcut twice. */
  public override key(): boolean {
    return false;
  }

  /** The gamepad: the d-pad moves the cursor with repeat, A pen, B back, X undo, Y redo, Start races, Back drives. */
  public pad(held: number, pressed: number): boolean {
    if (this._sheet) return false;

    const now = performance.now();
    const dirs = [PAD.right, PAD.down, PAD.left, PAD.up];
    const dirBits = held & (PAD.up | PAD.down | PAD.left | PAD.right);

    if (dirBits !== (this._padHeld & (PAD.up | PAD.down | PAD.left | PAD.right))) this._padAt = now + PAD_DELAY_MS;

    this._padHeld = held;

    for (let d = 0; d < 4; d++) {
      if (pressed & dirs[d]) this._arrow(d, false);
      else if (held & dirs[d] && now >= this._padAt) {
        this._padAt = now + PAD_EVERY_MS;
        this._arrow(d, false);
      }
    }

    if (pressed & PAD.confirm) {
      if (this._boardFocus || this._cursor >= 0) this._togglePen();
      else this.focus.navigate('confirm');
    }

    if (pressed & PAD.back) this.back();
    if (pressed & PAD.x) this._undo();
    if (pressed & PAD.y) this._redo();
    if (pressed & PAD.start) this._raceIt(true);
    if (pressed & PAD.select) this._raceIt(false);

    return true;
  }

  protected override build(): void {
    const f = this._frame();

    this._reasonNode = null;
    this._race = null;
    this.begin(true);
    this.dim(1);
    this.begin(true);
    this._board.layout(f.board.x, f.board.y, f.board.cell, f.board.turned, this.L.density, this.L.textResolution, {
      w: this.W,
      h: this.H,
    });
    this.target.addChild(this._board);
    this.begin();
    this._nameRow(f.head);
    this.begin();
    this._tools(f.tools);
    this.begin();
    this._raceRow(f);
    if (this._sheet) this._buildSheet();

    this._render();
  }

  /** A tall phone's toasts sit over the board's top edge, clear of the controls under it. */
  public override toastBottom(): number | null {
    return this.k === 'p' ? this._board.box.y + 62 : null;
  }

  /** Keys or a pad took over: the board has the focus, its cursor showing; a pointer hides the cursor again. */
  public override inputChanged(): void {
    if (this.host.kit.keys && !this._sheet) {
      if (!this._boardFocus && !this.focus.current) this._enterBoard();

      return;
    }

    super.inputChanged();

    if (!this.host.kit.keys && this._boardFocus) {
      this._boardFocus = false;
      this._render();
    }
  }

  public override async enter(delay = 0): Promise<void> {
    await super.enter(delay);
    if (!this.destroyed && this.host.kit.keys) this._enterBoard();
  }

  protected override entered(): void {
    this.host.actions.editing?.(true);
    this._board.setTrail(this.data.trail);
  }

  // -- The board's input and the strokes --

  private readonly _feedback: StrokeFeedback = {
    refuse: (cell, why) => {
      this.host.kit.sound.play('error');
      this._board.refuse(cell, why, why === 'edge' ? 'Edge of the board.' : "Roads can't cross.");
    },
    laid: (count, length) => {
      for (let i = 0; i < Math.min(count, 3); i++) this.host.kit.sound.play('tick', 1 + Math.min(40, length) * 0.02);
      if (this.host.kit.touch && typeof navigator.vibrate === 'function') navigator.vibrate(4);
      this._render();
    },
    rubbed: () => {
      this.host.kit.sound.play('tick', 0.8);
      this._render();
    },
    pulseEnds: () => this._board.pulseEnds(),
    hint: (text, cell) => this._board.bubble(text, cell, 'info'),
    bubble: (text, cell) => {
      this.host.kit.sound.play('error');
      this._board.bubble(text, cell);
    },
    showDirection: () => {
      this._board.runLight();
      this._board.bubble('The race runs this way. Reverse flips it.', this._doc.path[this._doc.finish], 'info');
    },
  };

  private readonly _input: BoardInput = {
    press: (cell, o) => {
      if (this._sheet) return;

      this._shift = o.shift;

      // Shift+click on grass with an open road: route there from the glowing end.
      if (o.shift && !o.touch && this._routeTo(cell, true)) return;

      const erase = o.erase || this._erase;

      if (this._doc.path.length > 0 && !this._doc.closed) {
        const n = this._doc.path.length;

        if (cell === this._doc.path[0] && n > 1) this._activeEnd = 'tail';
        else if (cell === this._doc.path[n - 1]) this._activeEnd = 'head';
      }

      this._strokes.down(this._doc, cell, erase);
      if (!o.touch) this._cursor = -1;
      this._render();
    },
    drag: () => {
      this._strokes.begin();
      this._render();
    },
    move: (cell, off) => {
      this._strokes.to(cell, off);
      this._render();
    },
    release: () => this._release(),
    cancel: () => this._cancelStroke(),
    fingers: (count) => (count === 2 ? this._undo() : this._redo()),
    hover: (cell, shift) => {
      this._hover = cell;
      this._shift = shift;
      this._updateHover();
    },
  };

  private _release(): void {
    const commit = this._strokes.up();
    const wasErase = this._erase;

    if (commit) this._commitStroke(commit);
    if (wasErase && (commit || !this._strokes.active)) {
      this._erase = false;
      this.rebuild();
    }

    this._render();
  }

  private _cancelStroke(): void {
    this._strokes.cancel();
    this._board.cancelPointer();
    this._pen = false;
    this._render();
  }

  private _commitStroke(commit: StrokeCommit): void {
    const sound = this.host.kit.sound;

    if (commit.kind === 'reroute') sound.play('clack');
    else if (commit.kind === 'erase') sound.play('thock');
    else if (commit.kind === 'start') sound.play('pluck');

    this._commit(commit.doc, this._name, commit.kind === 'reroute');
    if (commit.kind === 'start') this._board.punchStart();
  }

  /**
   * A committed change: one undo step, saved at once.
   * @param doc - The new document.
   * @param name - A new name, for a rename.
   * @param reshaped - A reroute: the start line may have hopped.
   */
  private _commit(doc: TrackDoc, name = this._name, reshaped = false): void {
    const before = this._doc;
    const wasClosed = before.closed;
    const finishCell = before.finish >= 0 ? before.path[before.finish] : -1;

    if (sameDoc(doc, before) && name === this._name) return;

    this._fresh = false;
    this._doc = doc;
    this._name = name;
    this._board.setTrail(null);
    this._history.push({ doc, name });
    this._save();
    this._recompute();

    const sound = this.host.kit.sound;

    if (!wasClosed && doc.closed) {
      sound.play('confirm');
      sound.play('neonBuzz');
      this.motion.delay(0.05, () => {
        this._board.runLight(COLORS.cyan);
        this._board.punchStart();
      });
      // The loop is a track: Race it lights up and catches the light.
      if (this._status === 'ready') this.motion.delay(0.35, () => this._race?.sweep());
    }

    // A reshape took the start line's cell, or its straights: it hopped.
    if (
      reshaped &&
      wasClosed &&
      doc.closed &&
      finishCell >= 0 &&
      doc.finish >= 0 &&
      doc.path[doc.finish] !== finishCell
    ) {
      sound.play('pluck');
      this.motion.delay(0.05, () => this._board.punchStart());
      this.host.toast({ kind: 'notice', text: 'Start line moved.' });
    }

    this.rebuild();
  }

  /** Keeps the library's copy in step with the document. */
  private _save(): void {
    const place = placement(this._doc);
    const rot: Rot = this._doc.closed && this._doc.finish >= 0 ? place.rot : this._entry.rot;

    this._entry = withDoc(this._entry, this._doc, this._name, rot);
    this.host.actions.saveTrack(this._entry);
  }

  /** The status and the start fix, after any change. */
  private _recompute(): void {
    this._status = status(this._doc);
    this._fix = this._status === 'noStart' ? startFix(this._doc) : null;
  }

  private _render(): void {
    const stroke = this._strokes.paint();

    this._board.render({
      doc: this._doc,
      stroke,
      preview: this._preview,
      cursor: this._boardFocus || this._pen ? this._cursor : -1,
      amber: this._status === 'noStart' ? longestStraight(this._doc) : [],
      ready: this._status === 'ready' && !stroke,
    });
  }

  // -- Actions --

  private _undo(): void {
    if (this._strokes.active) this._cancelStroke();

    const before = this._doc;
    const snap = this._history.undo();

    if (!snap) return;

    this._restore(snap.doc, snap.name, before);
    this.host.kit.sound.play('back');
  }

  private _redo(): void {
    if (this._strokes.active) this._cancelStroke();

    const before = this._doc;
    const snap = this._history.redo();

    if (!snap) return;

    this._restore(snap.doc, snap.name, before);
    this.host.kit.sound.play('confirm');
  }

  private _restore(doc: TrackDoc, name: string, before: TrackDoc): void {
    this._doc = doc;
    this._name = name;
    this._fresh = false;
    this._save();
    this._recompute();

    const a = new Set(before.path);
    const b = new Set(doc.path);
    const changed = [...doc.path.filter((c) => !a.has(c)), ...before.path.filter((c) => !b.has(c))];

    this.rebuild();
    this._board.flash(changed.length > 0 ? changed : doc.path);
  }

  private _reverse(): void {
    if (this._doc.path.length === 0) return;

    this.host.kit.sound.play('whooshUp');
    this._commit(reverse(this._doc));
    this.motion.delay(0.05, () => this._board.runLight());
  }

  private _mirror(): void {
    if (this._doc.path.length > 0) this._commit(mirror(this._doc));
  }

  private _nudge(dx: number, dy: number): void {
    const next = nudge(this._doc, dx, dy);

    if (next) this._commit(next);
    else {
      this.host.kit.sound.play('error');
      this._board.refuse(-1, 'edge', 'Edge of the board.');
    }
  }

  private _shuffle(): void {
    this._sheet = null;
    this.host.kit.sound.play('whooshUp');
    this.host.kit.sound.play('clack');

    if (this._keeps()) {
      this._startNew('shuffle');

      return;
    }

    this._commit(shuffle(Math.floor(Math.random() * 2 ** 31)));
    this._fresh = true;
  }

  private _startOver(name: TemplateName): void {
    this._sheet = null;

    if (this._keeps()) {
      this._startNew(name);

      return;
    }

    this._commit(template(name));
    this._fresh = true;
    // Starting over onto the same track changes nothing, but the sheet still goes.
    this.rebuild();
  }

  /**
   * Whether starting over or a Shuffle makes a new track rather than replacing this one: it has road the player drew,
   * which undo alone would keep only as long as the tab.
   */
  private _keeps(): boolean {
    return !this._fresh && this._doc.path.length > 0;
  }

  /** A new track in the library from a starting point; this one stays as it is. */
  private _startNew(start: NewTrack): void {
    const kept = this._entry;

    this.host.actions.newTrack(start);

    if (!this.destroyed && this._entry.id !== kept.id) {
      this.host.toast({ kind: 'notice', text: `New track started. ${kept.name} is still in My tracks.` });
    }
  }

  private _applyFix(): void {
    const fix = this._fix;

    if (!fix) return;

    this._preview = null;
    this.host.kit.sound.play('clack');
    this._commit(reroute(this._doc, fix.from, fix.cells, fix.to, fix.longer), this._name, true);
  }

  /** Race it (with three bots) or drive it alone, once the track is one. */
  private _raceIt(bots: boolean): void {
    if (this._strokes.active) this._cancelStroke();
    if (this._status !== 'ready') {
      this._notReady();

      return;
    }

    this.host.kit.sound.play('launch');
    this.host.actions.raceTrack(this._entry.id, bots);
  }

  /** Something only a finished track can do was pressed: the reason shakes, and an open road's ends pulse. */
  private _notReady(): void {
    const reason = this._reasonNode;

    this.host.kit.sound.play('error');
    if (reason && !reason.destroyed) this.motion.shake(reason, 6, 0.3);
    if (this._status === 'open') this._board.pulseEnds();
  }

  private _share(): void {
    if (this._status !== 'ready') {
      this._notReady();

      return;
    }

    const share = this.host.actions.shareTrack;

    if (!share) return;

    share
      .call(this.host.actions, this._entry.id)
      .then((how) =>
        this.host.toast(
          how === 'shared' ? { kind: 'shared' } : { kind: 'notice', text: 'Track link copied. Paste it to a friend.' },
        ),
      )
      .catch(() => this.host.toast({ kind: 'notice', text: "Couldn't copy the link." }));
  }

  /** The cells Shift+click would lay from the active end to a grass cell: a straight, or an L either way round. */
  private _route(cell: BoardCell): { end: 'head' | 'tail'; cells: readonly BoardCell[] } | null {
    const doc = this._doc;

    if (cell < 0 || doc.closed || doc.path.length === 0 || doc.path.includes(cell)) return null;

    const end = doc.path.length === 1 ? 'head' : this._activeEnd;
    const cells = routeTo(doc, end, cell, 'x') ?? routeTo(doc, end, cell, 'y');

    return cells ? { end, cells } : null;
  }

  /** Shift+click: route from the active end to a grass cell. */
  private _routeTo(cell: BoardCell, commit: boolean): boolean {
    const route = this._route(cell);

    if (!route) return false;

    if (commit) {
      const path =
        route.end === 'head' ? [...this._doc.path, ...route.cells] : [...[...route.cells].reverse(), ...this._doc.path];

      this._preview = null;
      this._commit({ path, closed: false, finish: -1 });
    }

    return true;
  }

  /** Holding Shift over grass shows where Shift+click would route. */
  private _updateHover(): void {
    const route = this._shift ? this._route(this._hover) : null;
    const doc = this._doc;
    const preview: BoardPaint['preview'] = route
      ? {
          cells: route.cells,
          from: route.end === 'head' ? doc.path[doc.path.length - 1] : doc.path[0],
          to: -1,
          going: new Set(),
        }
      : null;

    if (preview || this._preview?.to === -1) {
      this._preview = preview;
      this._render();
    }
  }

  // -- Keys --

  private readonly _onContext = (e: Event): void => {
    if (!this.destroyed) e.preventDefault();
  };

  private readonly _onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;

    if (
      this.destroyed ||
      this._closing ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable
    ) {
      return;
    }

    if (this._sheet) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeSheet(false);
      }

      return;
    }

    if (this._handleKey(e)) e.preventDefault();
  };

  /** One key; returns whether the editor used it. */
  private _handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const code = e.code;
    const arrow = ARROWS[e.key];

    if (arrow !== undefined) {
      if (e.altKey) {
        const [dx, dy] = [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ][this._boardDir(arrow)];

        this._nudge(dx, dy);
      } else {
        this._arrow(arrow, e.repeat);
      }

      return true;
    }

    if (mod && code === 'KeyZ') {
      if (e.shiftKey) this._redo();
      else this._undo();

      return true;
    }

    if (mod && code === 'KeyY') {
      this._redo();

      return true;
    }

    if (mod && code === 'KeyS') {
      this.host.toast({ kind: 'notice', text: 'Saved. Every change is.' });

      return true;
    }

    if (mod || e.altKey) return false;

    switch (e.key) {
      case 'Escape':
        this.back();

        return true;
      case 'Enter':
      case ' ':
        if (e.repeat) return true;
        if (this._boardFocus) this._togglePen();
        else if (!this.focus.navigate('confirm')) this._enterBoard();

        return true;
      case 'Backspace':
      case 'Delete':
        this._eraseAtCursor();

        return true;
      case '?':
        this._openSheet('shortcuts');

        return true;
      default:
        break;
    }

    if (e.repeat) return code.startsWith('Key');

    switch (code) {
      case 'KeyZ':
        if (e.shiftKey) this._redo();
        else this._undo();

        return true;
      case 'KeyX':
        this._eraseAtCursor();

        return true;
      case 'KeyF':
        if (e.shiftKey) this._moveStartToCursor();
        else this._reverse();

        return true;
      case 'KeyG':
        this._shuffle();

        return true;
      case 'KeyM':
        this._mirror();

        return true;
      case 'KeyN':
        this._openSheet('rename');

        return true;
      case 'KeyS':
        this._share();

        return true;
      case 'KeyT':
        this._raceIt(false);

        return true;
      case 'KeyR':
        this._raceIt(true);

        return true;
      default:
        return false;
    }
  }

  /** A board direction (0 right, 1 down, 2 left, 3 up, as the board's own axes) for a direction on screen. */
  private _boardDir(screen: number): number {
    // On a tall phone the board is turned clockwise: screen right is board up, screen down is board right.
    return this.k === 'p' ? (screen + 3) % 4 : screen;
  }

  /** An arrow on screen: the cursor moves, the pen lays as it goes; past the board's edge, focus goes to the buttons. */
  private _arrow(screen: number, repeat: boolean): void {
    const now = performance.now();

    if (repeat && now - this._keyAt < 1000 / KEY_CELLS_PER_S) return;

    this._keyAt = now;

    if (!this._boardFocus) {
      const before = this.focus.current;

      if (before) this.focus.navigate((['right', 'down', 'left', 'up'] as const)[screen]);

      // Nothing further that way among the buttons: back onto the board, at its nearest edge.
      if (!before || (this.focus.current === before && screen === this._towardBoard())) this._enterBoard();

      return;
    }

    const dir = this._boardDir(screen);
    const cur = this._cursor >= 0 ? this._cursor : this._startCursor();
    const next = stepCell(cur, dir);

    if (next < 0) {
      if (this._pen) {
        this._strokes.to(cur, true);
        this._render();

        return;
      }

      if (screen === (this._towardBoard() + 2) % 4) {
        this._boardFocus = false;
        this.focus.focus();
        this._render();
      }

      return;
    }

    this._cursor = next;

    if (this._pen) this._strokes.to(next);

    this._render();
  }

  /** The screen direction from the controls to the board: they're right of it, and under it on a tall phone. */
  private _towardBoard(): number {
    return this.k === 'p' ? 3 : 2;
  }

  private _startCursor(): BoardCell {
    const doc = this._doc;

    if (doc.path.length > 0) return doc.closed ? doc.path[Math.max(0, doc.finish)] : doc.path[doc.path.length - 1];

    return cellAt(Math.floor(BOARD_W / 2), Math.floor(BOARD_H / 2));
  }

  private _enterBoard(): void {
    this.focus.blur();
    this._boardFocus = true;
    if (this._cursor < 0) this._cursor = this._startCursor();
    this._render();
  }

  private _togglePen(): void {
    if (this._cursor < 0) this._cursor = this._startCursor();

    if (!this._pen) {
      this._pen = true;
      this._strokes.down(this._doc, this._cursor, false);
      this._strokes.begin();
    } else {
      this._pen = false;
      this._release();
    }

    this._render();
  }

  private _eraseAtCursor(): void {
    const i = this._doc.path.indexOf(this._cursor);

    if (i < 0) return;

    this._strokes.down(this._doc, this._cursor, true);
    this._release();
  }

  private _moveStartToCursor(): void {
    const i = this._doc.path.indexOf(this._cursor);
    const next = i >= 0 ? moveFinish(this._doc, i) : this._doc;

    if (next === this._doc) {
      this.host.kit.sound.play('error');
      this._board.bubble('The start needs a straight before and after it.', this._cursor);

      return;
    }

    this.host.kit.sound.play('pluck');
    this._commit(next);
    this._board.punchStart();
  }

  private _toggleErase(): void {
    this._erase = !this._erase;
    this.host.kit.sound.play(this._erase ? 'arm' : 'back');
    this.rebuild();
  }

  // -- Layout --

  /**
   * Where everything goes. On a desktop and a phone on its side the board takes the left and a narrow rail on its right
   * holds the controls; a tall phone turns the board and stacks the controls under it.
   */
  private _frame(): Frame {
    const { k, W, H, S } = this;

    if (k === 'p') {
      const w = W - S.l - S.r;
      const race = { x: S.l + 176, y: H - S.b - 52, w: w - 176, h: 52 };
      const reason = { x: S.l, y: race.y - 52, w, h: 44 };
      const tools = { x: S.l, y: reason.y - 52, w, h: 44, cols: 6, gap: 0 };
      const top = S.t + 48;
      const room = tools.y - 6 - top;
      const cell = Math.floor(Math.min(w / BOARD_H, room / BOARD_W));

      return {
        board: { x: (W - cell * BOARD_H) / 2, y: top + (room - cell * BOARD_W) / 2, cell, turned: true },
        head: { x: S.l, y: S.t, w, h: 44 },
        tools,
        reason: { ...reason, w: w - 214 },
        fix: { x: S.l + w - 204, y: reason.y, w: 204, h: 44 },
        drive: { x: S.l, y: race.y, w: 166, h: 56 },
        race,
      };
    }

    if (k === 'l') {
      const rail = 210;
      const cell = Math.floor(Math.min((H - S.t - S.b) / BOARD_H, (W - S.l - S.r - rail - 20) / BOARD_W));
      const x = S.l + cell * BOARD_W + 20;
      const w = W - S.r - x;
      const race = { x, y: H - S.b - 50, w, h: 50 };
      const drive = { x, y: race.y - 52, w, h: 44 };
      const fix = { x, y: drive.y - 52, w, h: 44 };
      const tools = { x, y: S.t + 52, w, h: 44, cols: 3, gap: 8 };

      return {
        board: { x: S.l, y: S.t + (H - S.t - S.b - cell * BOARD_H) / 2, cell, turned: false },
        head: { x, y: S.t, w, h: 44 },
        tools,
        reason: { x, y: 0, w, h: 0 },
        fix,
        drive,
        race,
      };
    }

    // The board takes all the height, and the rail on its right (back and the name too, as on a phone on its side)
    // whatever width is left past the narrowest that holds a short name on one line and the fix with its flag, about
    // a phone on its side's rail.
    const gap = 20;
    const cell = Math.floor(Math.min((H - S.t - S.b) / BOARD_H, (W - S.l - S.r - gap - 220) / BOARD_W));
    const bw = cell * BOARD_W;
    const bh = cell * BOARD_H;
    const y0 = S.t + (H - S.t - S.b - bh) / 2;
    const x = S.l + bw + gap;
    const rail = W - S.r - x;
    const race = { x, y: y0 + bh - 64, w: rail, h: 64 };
    const drive = { x, y: race.y - 64, w: rail, h: 52 };
    const fix = { x, y: drive.y - 58, w: rail, h: 44 };
    const tools = { x, y: y0 + 64, w: rail, h: 46, cols: 3, gap: 12 };

    return {
      board: { x: S.l, y: y0, cell, turned: false },
      head: { x, y: y0, w: rail, h: 44 },
      tools,
      reason: { x, y: 0, w: rail, h: 0 },
      fix,
      drive,
      race,
    };
  }

  /** Back, and the name: tap it (or its pencil) to rename. */
  private _nameRow(r: Rect): void {
    const rename = (): void => this._openSheet('rename');
    const back = this.iconBtn('back', r.x, r.y, r.h, 'secondary', () => void this.back());
    const nx = r.x + r.h + leanShift(r.h, 12) + 14;
    const room = r.x + r.w - nx - 26;
    const size = this.k === 'd' ? 26 : 22;
    const name = this._nameText(nx, r.y + r.h / 2, room, size);
    const pencil = this.put(
      iconSvg('edit', { size: 18, color: COLORS.mist, accent: COLORS.cyan }),
      nx + name.width + 8,
      r.y + (r.h - 18) / 2,
    );
    const hit = new Container();

    hit.hitArea = new Rectangle(nx - 6, r.y, pencil.f.x + pencil.f.w - nx + 14, r.h);
    hit.eventMode = 'static';
    hit.cursor = 'text';
    hit.label = 'rename';
    hit.on('pointertap', rename);
    this.target.addChild(hit);
    this.explain(back, 'My tracks', ['Esc']);
    this.explain(hit, 'Rename', ['N']);
  }

  /**
   * The name, centred on `cy`: one line at its size when it fits; in a rail beside the board, which is narrow, two
   * smaller lines; else cut.
   */
  private _nameText(x: number, cy: number, room: number, size: number): Text {
    const res = this.L.textResolution;
    const one = makeText(this._name, x, 0, { f: 'b', s: size, w: 900 }, res);

    if (one.width > room && this.k !== 'p') {
      for (const s of this.k === 'd' ? [22, 19, 16] : [18, 16]) {
        const two = makeText(this._name, x, 0, { f: 'b', s, w: 900, wrap: room, lh: 1.05 }, res);

        if (CanvasTextMetrics.measureText(this._name, two.style).lines.length <= 2) {
          one.destroy();
          two.y = cy - two.height / 2;

          return this.target.addChild(two);
        }

        two.destroy();
      }
    }

    fitText(one, room);
    one.y = cy - Number(one.style.fontSize) / 2;

    return this.target.addChild(one);
  }

  /** The icon tools: Undo, Redo, Erase, Reverse, Share, More. */
  private _tools(r: Frame['tools']): void {
    const counts = this._history.counts;
    const n = this._doc.path.length;
    const ready = this._status === 'ready';
    const tools: Tool[] = [
      { icon: 'undo', label: 'Undo', keys: ['Z'], fn: () => this._undo(), on: counts.undo > 0 },
      { icon: 'redo', label: 'Redo', keys: ['Shift', 'Z'], fn: () => this._redo(), on: counts.redo > 0 },
      {
        icon: 'erase',
        label: 'Erase',
        keys: ['Right-drag'],
        fn: () => this._toggleErase(),
        on: n > 0,
        lit: this._erase,
      },
      { icon: 'reverse', label: 'Reverse', keys: ['F'], fn: () => this._reverse(), on: n > 0 },
      { icon: 'share', label: 'Share', keys: ['S'], fn: () => this._share(), on: ready, explain: true },
      {
        icon: 'more',
        label: 'More',
        keys: [],
        fn: () => this._openSheet('more'),
        on: true,
        tip: 'Start over, Shuffle',
      },
    ];
    const bw = r.h + leanShift(r.h, 12);
    const gx = (r.w - r.cols * bw) / (r.cols - 1);

    tools.forEach((t, i) => {
      const col = i % r.cols;
      const row = Math.floor(i / r.cols);
      const b = this.add(
        iconButton(this.host.kit, t.icon, r.h, t.lit ? 'caution' : 'secondary', t.fn).placeFace(
          r.x + col * (bw + gx),
          r.y + row * (r.h + r.gap),
        ),
      );

      b.label = t.label;
      b.setDisabled(!t.on);
      if (t.explain) b.on('pointertap', () => b.disabled && this._notReady());
      this.explain(b, t.tip ?? t.label, t.keys);
    });
  }

  /** Drive alone and Race it, with the reason the track can't be raced yet and its fix over them. */
  private _raceRow(f: Frame): void {
    const ready = this._status === 'ready';
    const drive = this.button('Drive alone', f.drive.x, f.drive.y, f.drive.w, f.drive.h, 'secondary', 'driver', () =>
      this._raceIt(false),
    );
    const race = this.button(
      'Race it',
      f.race.x,
      f.race.y,
      f.race.w,
      f.race.h,
      'go',
      'play',
      () => this._raceIt(true),
      true,
    );

    for (const b of [drive, race]) {
      b.setDisabled(!ready);
      // Disabled, it still says what the track needs.
      b.on('pointertap', () => b.disabled && this._notReady());
    }

    this._race = race;
    this.explain(drive, 'Drive alone', ['T']);
    this.explain(race, 'Race three bots', ['R']);

    if (ready) return;

    const fix = this._fix;

    if (fix) {
      const b = this.button('Make a start straight', f.fix.x, f.fix.y, f.fix.w, f.fix.h, 'caution', 'flag', () =>
        this._applyFix(),
      );

      b.on('pointerover', () => this._showFix(true));
      b.on('pointerout', () => this._showFix(false));
    }

    this._reason(f, !!fix);
  }

  /**
   * The reason, amber with a warning sign. On a tall phone it shares a row with the fix, centred in it; elsewhere it
   * sits over the fix (or over Drive alone when there's none), its last line just above.
   */
  private _reason(f: Frame, fixed: boolean): void {
    const phone = this.k !== 'd';
    const s = this.k === 'l' ? 12 : phone ? 13 : 16;
    const icon = phone ? 18 : 20;
    const r = f.reason;
    const wrap = (this.k === 'p' && !fixed ? f.head.w : r.w) - icon - 8;
    const node = new Container();
    const text = makeText(
      REASON[this._status as Exclude<DocStatus, 'ready'>],
      icon + 8,
      0,
      { s, w: 700, c: COLORS.amber, wrap, lh: 1.2 },
      this.L.textResolution,
    );
    const sign = this.put(iconSvg('warning', { size: icon, color: COLORS.amber, accent: COLORS.ink900 }), 0, 0);
    const h = Math.max(icon, text.height);

    sign.sprite.position.y += (Math.min(text.height, s * 1.2) - icon) / 2;
    node.addChild(sign.sprite, text);

    if (this.k === 'p') node.position.set(r.x, r.y + (r.h - h) / 2);
    else node.position.set(r.x, (fixed ? f.fix.y : f.drive.y) - (this.k === 'l' ? 10 : 14) - h);

    this.target.addChild(node);
    this._reasonNode = node;
  }

  /** The fix's new road previewed under the mouse. */
  private _showFix(on: boolean): void {
    const fix = this._fix;

    if (on && fix) {
      const keep = new Set(reroute(this._doc, fix.from, fix.cells, fix.to, fix.longer).path);

      this._preview = {
        cells: fix.cells,
        from: this._doc.path[fix.from],
        to: this._doc.path[fix.to],
        going: new Set(this._doc.path.map((c, i) => (keep.has(c) ? -1 : i)).filter((i) => i >= 0)),
      };
    } else {
      this._preview = null;
    }

    this._render();
  }

  // -- Sheets --

  private _openSheet(sheet: Exclude<Sheet, null>): void {
    if (this._strokes.active) this._cancelStroke();

    this._sheet = sheet;
    this._draft = this._name;
    this.host.kit.sound.play('whooshUp');
    this.rebuild();
  }

  /** Closes the sheet; a rename is kept unless the sheet was backed out of. */
  private _closeSheet(keep = true): void {
    const sheet = this._sheet;

    if (!sheet) return;

    if (sheet === 'rename' && keep) {
      const name = this._draft.trim();

      if (name && name !== this._name) this._commit(this._doc, name.slice(0, TRACK_NAME_LENGTH));
    }

    this._sheet = null;
    this.host.kit.sound.play('back');
    this.rebuild();
  }

  private _buildSheet(): void {
    const { k, W, H } = this;

    this.begin(true);
    this.dim(0.72);
    this.begin();

    if (this._sheet === 'rename') {
      const w = k === 'p' ? W - 40 : 460;
      const h = 250;
      const x = (W - w) / 2;
      const y = k === 'p' ? this.S.t + 80 : (H - h) / 2;
      const p = this.panel(x, y, w, h, { accent: COLORS.cyan });

      this.title('Track name', p.c.x + 24, p.c.y + 24, k === 'd' ? 34 : 28);

      const field = this.nameField(
        p.c.x + 24,
        p.c.y + 84,
        w - 48,
        56,
        this._draft,
        RACERS[this.host.memory.car],
        (v) => void (this._draft = v),
        () => this._closeSheet(),
        true,
        TRACK_NAME_LENGTH,
        'flag',
      );

      this.button('Done', p.c.x + 24, p.c.y + h - 74, w - 48, 52, 'primary', 'check', () => this._closeSheet());
      field.focus();

      return;
    }

    if (this._sheet === 'shortcuts') {
      const w = Math.min(W - 40, 620);
      const rows = SHORTCUTS.length;
      // A tall phone's sheet is too narrow for two columns: each description goes under its keys.
      const stack = k === 'p';
      const lh = k === 'l' ? 19 : stack ? 44 : 24;
      const top = k === 'l' ? 58 : 72;
      const h = Math.min(H - 30, top + rows * lh + 80);
      const x = (W - w) / 2;
      const y = (H - h) / 2;
      const p = this.panel(x, y, w, h, { accent: COLORS.cyan });
      const s = k === 'l' ? 12 : 14;

      this.title('Shortcuts', p.c.x + 24, p.c.y + 20, k === 'l' ? 24 : 30);
      SHORTCUTS.forEach(([keys, what], i) => {
        const ry = p.c.y + top + i * lh;

        this.text(keys, p.c.x + 24, ry, { s, w: 700, c: COLORS.cyan });
        if (stack) this.text(what, p.c.x + 24, ry + 19, { s, c: COLORS.white });
        else this.text(what, p.c.x + 24 + Math.min(200, w * 0.36), ry, { s, c: COLORS.white });
      });
      this.button(
        'Close',
        p.c.x + w - 160,
        p.c.y + h - 64,
        136,
        44,
        'secondary',
        'close',
        () => this._closeSheet(),
        true,
      );

      return;
    }

    this._moreSheet();
  }

  /** More: start over from a plan or a Shuffle (each one undo step, or a new track), and the shortcuts. */
  private _moreSheet(): void {
    this.startsSheet({
      title: 'Start over',
      note: this._keeps() ? `A new track. ${this._name} stays in My tracks.` : 'Undo brings this track back.',
      pick: (start) => (start === 'shuffle' ? this._shuffle() : this._startOver(start)),
      close: () => this._closeSheet(),
      extra: this.host.kit.touch
        ? undefined
        : { label: 'Shortcuts', icon: 'keys', onPress: () => this._openSheet('shortcuts') },
      focus: 1,
    });
  }
}

/** A loop's longest run of straights, as path indices, for the amber outline of a loop with no start. */
function longestStraight(doc: TrackDoc): number[] {
  const n = doc.path.length;
  let best: number[] = [];

  for (let i = 0; i < n; i++) {
    const run: number[] = [];

    for (let k = 0; k < n; k++) {
      const j = (i + k) % n;
      const a = doc.path[(j - 1 + n) % n];
      const b = doc.path[j];
      const c = doc.path[(j + 1) % n];

      if (cellX(a) - cellX(b) !== cellX(b) - cellX(c) || cellY(a) - cellY(b) !== cellY(b) - cellY(c)) break;

      run.push(j);
    }

    if (run.length > best.length) best = run;
  }

  return best;
}
