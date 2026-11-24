import type { Container } from 'pixi.js';

import type { IconName } from '../art/icons';
import { iconSvg } from '../art/icons';
import type { SvgArt } from '../art/svg';
import { chamferRect, leanShift } from '../art/svg';
import { COLORS } from '../art/tokens';
import { dashedCardSvg, planSvg, trackTileSvg } from '../art/trackArt';
import type { Screen, TrackCard } from '../contract';
import { Button } from '../kit/Button';
import { iconButton } from '../kit/buttons';
import { makeText } from '../kit/text';
import { TextField } from '../kit/TextField';
import type { TrackBoard } from './MenuScreen';
import { MenuScreen, planPoints } from './MenuScreen';

type TracksData = Extract<Screen, { id: 'tracks' }>;
type Slot = TrackCard | 'new';

/** How long Delete stays armed, as the lobby's Remove does. */
const ARM_MS = 3000;
/**
 * Tiles a page, columns by rows, beside the shown track's board (over it on a tall phone). A landscape box too narrow
 * for three columns of {@link TILE_L} shows two.
 */
const GRID = { d: [3, 3], p: [2, 2], l: [3, 2] } as const;
/** A tall phone's tile height. */
const TILE_P = 170;
/**
 * The narrowest a landscape board gets: its name, best time and Edit beside the three tools still fit. A narrower box
 * (a 16:9 phone, a notch) narrows the grid instead.
 */
const BOARD_L = 320;
/** The narrowest landscape tile: a name and its Draft tag still fit along its foot. */
const TILE_L = 130;
/** Between tiles: desktop, and both phone layouts. */
const GAP = { d: 16, p: 12, l: 12 } as const;
/** A mouse wheel turns at most one page this often. */
const WHEEL_MS = 300;

/** A box in screen px. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * My tracks, as a track select: a grid of tiles, each the track's plan in neon on a slate with its name, New track
 * first, then Night Run, then yours newest first, a page at a time; and beside them (under them on a tall phone) the
 * pit board of the track shown, with its length, lap and your best, and what it can do: race it, edit it, share,
 * duplicate or delete it (Delete arms for 3 s and asks again). Tapping a tile shows it and selects it when it can be
 * raced (Quick race and the title follow the selection); coming back from the editor shows the track just edited.
 * Paste (a link or a bare code) is in the header. Over the lobby, the host's picker: the same tiles and board, with
 * Pick, which makes the shown track the party's.
 */
export class TracksScreen extends MenuScreen<TracksData> {
  private _page: number;
  private _focusId: string;
  private _armedUntil = 0;
  private _sheet: 'new' | 'paste' | null = null;
  private _paste = '';
  private _tiles = new Map<string, Button>();
  private _wheelAt = 0;

  constructor(host: ConstructorParameters<typeof MenuScreen<TracksData>>[0], data: TracksData) {
    super(host, data);
    this._focusId =
      data.cards.find((c) => c.id === data.focus)?.id ??
      data.cards.find((c) => c.selected)?.id ??
      data.cards[0]?.id ??
      '';
    this._page = this._pageOf(this._focusId);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    document.addEventListener('paste', this._onPaste);
  }

  private get _pick(): boolean {
    return this.data.mode === 'pick';
  }

  /** New track first in the library; the picker has only tracks. */
  private get _slots(): Slot[] {
    return this._pick ? [...this.data.cards] : ['new', ...this.data.cards];
  }

  private get _grid(): readonly [number, number] {
    const [cols, rows] = GRID[this.k];

    if (this.k !== 'l') return [cols, rows];

    return [Math.min(cols, Math.floor((this._gridW + GAP.l) / (TILE_L + GAP.l))), rows];
  }

  /** A landscape grid's width: 450, less on a narrower box so the board keeps {@link BOARD_L}. */
  private get _gridW(): number {
    const { W, S } = this;

    return Math.min(450, W - S.l - S.r - 20 - BOARD_L);
  }

  private get _perPage(): number {
    const [cols, rows] = this._grid;

    return cols * rows;
  }

  private get _pages(): number {
    return Math.max(1, Math.ceil(this._slots.length / this._perPage));
  }

  /** The page a track's tile is on, at this layout's grid. */
  private _pageOf(id: string): number {
    return Math.max(0, Math.floor(this._slots.findIndex((s) => s !== 'new' && s.id === id) / this._perPage));
  }

  public override update(data: TracksData): void {
    const was = this._focusId;

    this.data = data;

    if (!data.cards.some((c) => c.id === this._focusId)) this._focusId = data.cards.find((c) => c.selected)?.id ?? '';
    if (this._focusId !== was) this._page = this._pageOf(this._focusId);

    this._page = Math.min(this._page, this._pages - 1);
    this.rebuild();
  }

  /** Another grid: the page goes to the picked track's tile. */
  public override relayout(): void {
    this._page = this._pageOf(this._focusId);
    this.rebuild();
  }

  /** A tall phone's toasts sit under the header, over the tiles, clear of the board and its Race it. */
  public override toastBottom(): number | null {
    return this.k === 'p' ? this.S.t + 106 : null;
  }

  public override destroy(): void {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('paste', this._onPaste);
    super.destroy();
  }

  public override back(): boolean {
    if (this._sheet) {
      this._sheet = null;
      this.host.kit.sound.play('back');
      this.rebuild();

      return true;
    }

    this.host.kit.sound.play('back');
    this.host.actions.closeTracks();

    return true;
  }

  public override key(key: string): boolean {
    if (this._sheet) return false;

    const k = key.toLowerCase();
    const card = this._focused();

    if (k === 'n' && !this._pick) {
      this._openNew();

      return true;
    }

    if (k === 'e' && card && !this._pick) {
      this.host.actions.editTrack(card.id);

      return true;
    }

    return false;
  }

  protected override build(): void {
    const { k, W, H, S } = this;
    const pick = this._pick;
    const pages = this._pages;

    this._tiles.clear();
    this.begin(true);
    if (k === 'p') this.dim(0.82);
    else this.scrim('left', 0.96, 1);
    this.dim(0.5);

    this.begin();
    this.iconBtn('back', S.l, S.t, 44, 'secondary', () => void this.back());
    this.title(pick ? 'Pick a track' : 'My tracks', S.l + 44 + leanShift(44, 12) + 16, S.t + 2, k === 'd' ? 40 : 30);

    if (!pick) {
      const pw = k === 'p' ? 104 : 120;
      const paste = this.button('Paste', W - S.r - pw, S.t, pw, 44, 'secondary', 'paste', () => this._pasteClipboard());

      this.explain(paste, 'Paste a track link or code', ['Ctrl', 'V']);
    }

    const [cols, rows] = this._grid;
    const top = S.t + (k === 'd' ? 68 : 56);
    const gap = GAP[k];
    // A tall phone with one page shows only the rows it fills, and the board comes up under them.
    const shown = k === 'p' && pages === 1 ? Math.min(rows, Math.ceil(this._slots.length / cols)) : rows;
    let grid: Rect;
    let board: Rect;
    let pager: Rect;

    if (k === 'd') {
      grid = { x: S.l, y: top, w: 690, h: H - S.b - top - 56 };
      pager = { x: S.l + 690 - 180, y: grid.y + grid.h + 12, w: 180, h: 44 };
      board = { x: S.l + 690 + 24, y: top, w: W - S.r - S.l - 690 - 24, h: H - S.b - top };
    } else if (k === 'p') {
      const gh = shown * TILE_P + (shown - 1) * gap;
      const by = pages > 1 ? top + gh + 60 : top + gh + 16;

      grid = { x: S.l, y: top, w: W - S.l - S.r, h: gh };
      pager = { x: (W - 180) / 2, y: grid.y + gh + 8, w: 180, h: 44 };
      board = { x: S.l, y: by, w: grid.w, h: H - S.b - by };
    } else {
      grid = { x: S.l, y: top, w: this._gridW, h: H - S.b - top };
      // The pager sits in the header, left of Paste.
      pager = { x: W - S.r - (pick ? 0 : 136) - 180, y: S.t, w: 180, h: 44 };
      board = { x: S.l + grid.w + 20, y: top, w: W - S.r - S.l - grid.w - 20, h: H - S.b - top };
    }

    const cw = (grid.w - gap * (cols - 1)) / cols;
    const ch = (grid.h - gap * (shown - 1)) / shown;
    const slots = this._slots;
    const start = this._page * this._perPage;

    this.begin();
    for (let i = 0; i < this._perPage && start + i < slots.length; i++) {
      const slot = slots[start + i];
      const x = grid.x + (i % cols) * (cw + gap);
      const y = grid.y + Math.floor(i / cols) * (ch + gap);

      if (slot === 'new') this._newTile(x, y, cw, ch);
      else this._tile(slot, x, y, cw, ch);
    }

    if (pages > 1) this._pager(pager, pages);

    const card = this._focused();

    if (card) {
      this.begin();
      this._board(card, board);
    }

    if (this._sheet) this._buildSheet();
  }

  /** One track's tile: its plan, its name along the bottom, and Draft on one not yet a track. */
  private _tile(card: TrackCard, x: number, y: number, w: number, h: number): void {
    const kit = this.host.kit;
    const lit = card.id === this._focusId;
    const strip = this.k === 'd' ? 38 : 34;
    const b = new Button(kit, {
      art: (state) => trackTileSvg(w, h, strip, state, lit),
      outline: chamferRect(16, 16, w, h, [12, 3.6, 12, 3.6]),
      name: card.name,
      glint: false,
      lift: 0,
      onPress: () => this._press(card),
    });

    b.placeFace(x, y);
    this.add(b, lit);
    this._tiles.set(card.id, b);
    if (this._pick && !card.ready) {
      b.setDisabled(true);
      b.alpha = 0.5;
    }

    const res = this.L.textResolution;
    const pad = 16;
    const planH = h - strip - 14;
    const plan = this._artChild(
      b,
      planSvg(planPoints(card, this.k === 'p'), card.ready, w - 24, planH),
      pad + 12,
      pad + 7,
    );
    const draft = !card.ready
      ? makeText('Draft', pad + w - 12, pad + h - strip / 2 - 6, { s: 12, w: 700, c: COLORS.amber, a: 'r' }, res)
      : null;
    const name = makeText(
      card.name || 'Untitled',
      pad + 12,
      pad + h - strip / 2 - (this.k === 'd' ? 9 : 8),
      { f: 'b', s: this.k === 'd' ? 18 : 16, w: 900, max: w - 24 - (draft ? draft.width + 8 : 0) },
      res,
    );

    plan.alpha = card.ready ? 1 : 0.85;
    b.addChild(name);
    if (draft) b.addChild(draft);
  }

  /**
   * New track: a dashed tile with a plus over its label, the pair centred, first in the grid. Draw your first track
   * takes two lines so it fits a phone's narrow tile whole.
   */
  private _newTile(x: number, y: number, w: number, h: number): void {
    const first = !this.data.cards.some((c) => !c.builtIn);
    const size = this.k === 'd' ? 40 : 34;
    const s = this.k === 'd' ? 18 : 15;
    const lh = 1.15;
    const lines = first ? ['Draw your', 'first track'] : ['New track'];
    const gap = 14;
    const top = (h - size - gap - lines.length * s * lh) / 2;
    const b = new Button(this.host.kit, {
      art: () => dashedCardSvg(w, h),
      outline: chamferRect(4, 4, w - 8, h - 8, 12),
      name: lines.join(' '),
      glint: false,
      onPress: () => this._openNew(),
    });

    b.placeFace(x, y);
    this.add(b, !this._focusId);
    this._artChild(b, iconSvg('plus', { size, color: COLORS.cyan, accent: COLORS.cyan }), (w - size) / 2, top);
    // The tile's own text, not a button label: a label goes back to the middle of the plate on hover, over the plus.
    b.addChild(
      makeText(
        lines.join('\n'),
        w / 2,
        top + size + gap,
        { s, w: 700, i: true, c: COLORS.cyan, a: 'c', lh },
        this.L.textResolution,
      ),
    );
    this.explain(b, 'New track', ['N']);
  }

  /** Page turns, and which page this is. */
  private _pager(r: Rect, pages: number): void {
    this.begin();

    const prev = this.iconBtn('back', r.x, r.y, r.h, 'secondary', () => this._turn(-1));
    const next = this.iconBtn('forward', r.x + r.w - r.h - leanShift(r.h, 12), r.y, r.h, 'secondary', () =>
      this._turn(1),
    );

    prev.label = 'Previous page';
    next.label = 'Next page';
    prev.setDisabled(this._page === 0);
    next.setDisabled(this._page >= pages - 1);
    this.inbox(
      `${this._page + 1} / ${pages}`,
      { x: r.x + r.h, y: r.y, w: r.w - r.h * 2, h: r.h },
      { f: 'b', s: 20, w: 800 },
    );
  }

  /**
   * The shown track's pit board: its plan, name and where it's from, its length, lap and your best, then Race it, and
   * Edit with Share, Duplicate and Delete under it; over the lobby, Pick.
   */
  private _board(card: TrackCard, r: Rect): void {
    const { k } = this;
    const raceH = k === 'd' ? 60 : k === 'p' ? 52 : 48;
    const toolH = k === 'd' ? 48 : 44;

    this.trackBoard(card, r, {
      ...this._sub(card),
      actionsH: this._pick ? raceH : raceH + 10 + toolH,
      actions: (x, y, w) =>
        this._pick ? this._pickButton(card, x, y, w, raceH) : this._actions(card, x, y, w, raceH, toolH),
    });
  }

  /** Under the name: who it's from, or that it's the original, or how it feels; a draft says what it needs. */
  private _sub(card: TrackCard): Pick<TrackBoard, 'sub' | 'subColor'> {
    if (this._armedUntil > performance.now()) return { sub: 'Press again to delete it.', subColor: COLORS.danger };
    if (!card.ready) return { sub: 'Draft: close its loop to race it.', subColor: COLORS.amber };
    if (card.builtIn) return { sub: 'The original circuit' };
    if (card.from) return { sub: `Shared by ${card.from}` };

    return { sub: `${card.feel}, ${card.corners} ${card.corners === 1 ? 'corner' : 'corners'}` };
  }

  /** Over the lobby: Pick makes the shown track the party's. */
  private _pickButton(card: TrackCard, x: number, y: number, w: number, h: number): void {
    const pick = this.button('Pick', x, y, w, h, 'go', 'check', () => this.host.actions.selectTrack(card.id), true);

    pick.setDisabled(!card.ready);
    this.explain(pick, 'Race this track in the party');
  }

  /** Race it across the board, then Edit, and Share, Duplicate and Delete for your own tracks. */
  private _actions(card: TrackCard, x: number, y: number, w: number, raceH: number, toolH: number): void {
    const a = this.host.actions;
    const armed = this._armedUntil > performance.now();
    const race = this.button('Race it', x, y, w, raceH, 'go', 'play', () => a.raceTrack(card.id, true), true);

    race.setDisabled(!card.ready);
    this.explain(race, 'Race three bots on it');

    const ty = y + raceH + 10;
    const bw = toolH + leanShift(toolH, 12);
    // Night Run has no tools, so its Edit a copy takes the row, as TrackLink's buttons fill theirs.
    const edit = this.button(
      card.builtIn ? 'Edit a copy' : 'Edit',
      x,
      ty,
      card.builtIn ? w : w - 3 * (bw + 10),
      toolH,
      'secondary',
      'edit',
      () => a.editTrack(card.id),
    );

    this.explain(edit, card.builtIn ? 'Edit a copy of Night Run' : 'Edit it', ['E']);

    if (card.builtIn) return;

    const tools: [IconName, string, string[], () => void, boolean, 'secondary' | 'danger'][] = [
      ['share', 'Share a link to it', [], () => this._share(card), card.ready, 'secondary'],
      ['copy', 'Duplicate it', [], () => a.duplicateTrack(card.id), true, 'secondary'],
      [
        'trash',
        armed ? 'Press again to delete' : 'Delete it',
        ['Del'],
        () => this._delete(card),
        true,
        armed ? 'danger' : 'secondary',
      ],
    ];
    const left = x + w - tools.length * (bw + 10) + 10;

    tools.forEach(([icon, label, keys, fn, on, variant], i) => {
      const b = this.add(iconButton(this.host.kit, icon, toolH, variant, fn).placeFace(left + i * (bw + 10), ty));

      b.label = icon === 'copy' ? 'Duplicate' : icon === 'trash' ? 'Delete' : 'Share';
      b.setDisabled(!on);
      this.explain(b, label, keys);
    });
  }

  private _press(card: TrackCard): void {
    const a = this.host.actions;

    // A second press on the track already shown picks it over the lobby, or races it.
    if (card.id === this._focusId && card.ready && (this._pick || card.selected)) {
      if (this._pick) a.selectTrack(card.id);
      else a.raceTrack(card.id, true);

      return;
    }

    this._focusId = card.id;
    this._armedUntil = 0;
    this.host.kit.sound.play('pluck');
    if (!this._pick) a.selectTrack(card.id);
    this.rebuild();
    const b = this._tiles.get(card.id);

    if (b && this.host.kit.keys) this.focus.focus(b);
  }

  private _focused(): TrackCard | null {
    return this.data.cards.find((c) => c.id === this._focusId) ?? null;
  }

  private _turn(by: number): void {
    const page = Math.min(this._pages - 1, Math.max(0, this._page + by));

    if (page === this._page) return;

    this._page = page;
    this.host.kit.sound.play('tick');
    this.rebuild();
  }

  private _delete(card: TrackCard): void {
    if (this._armedUntil > performance.now()) {
      this._armedUntil = 0;
      this.host.kit.sound.play('thock');
      this.host.actions.deleteTrack(card.id);

      return;
    }

    this._armedUntil = performance.now() + ARM_MS;
    this.host.kit.sound.play('arm');
    this.rebuild();
    this.motion.delay(ARM_MS / 1000 + 0.05, () => {
      if (this._armedUntil <= performance.now()) this.rebuild();
    });
  }

  private _share(card: TrackCard): void {
    const share = this.host.actions.shareTrack;

    if (!share) return;

    share
      .call(this.host.actions, card.id)
      .then((how) =>
        this.host.toast(
          how === 'shared' ? { kind: 'shared' } : { kind: 'notice', text: 'Track link copied. Paste it to a friend.' },
        ),
      )
      .catch(() => this.host.toast({ kind: 'notice', text: "Couldn't copy the link." }));
  }

  private _openNew(): void {
    this._sheet = 'new';
    this.host.kit.sound.play('whooshUp');
    this.rebuild();
  }

  /** Paste reads the clipboard where the browser lets it, else opens a field to paste into. */
  private _pasteClipboard(): void {
    const read = navigator.clipboard?.readText?.bind(navigator.clipboard);

    if (!read) {
      this._openPaste();

      return;
    }

    read().then(
      (text) => {
        if (text.trim()) this._import(text);
        else this._openPaste();
      },
      () => this._openPaste(),
    );
  }

  private _openPaste(): void {
    this._sheet = 'paste';
    this._paste = '';
    this.rebuild();
  }

  private _import(text: string): void {
    const id = this.host.actions.importTrack(text);

    if (id) {
      this._sheet = null;
      this._focusId = id;
      this._page = this._pageOf(id);
      this.host.kit.sound.play('confirm');
    } else {
      this.host.kit.sound.play('error');
    }
  }

  private _buildSheet(): void {
    const { k, W, H, S } = this;

    this.begin(true);
    const backdrop = this.dim(0.7);

    // A tap on the dimmed screen round the sheet closes it.
    backdrop.on('pointertap', () => void this.back());
    this.begin();

    if (this._sheet === 'new') {
      this.startsSheet({
        title: 'New track',
        note: 'Start from one of these. Shuffle rolls a random one.',
        pick: (start) => {
          this._sheet = null;
          this.host.actions.newTrack(start);
          // A full library keeps this screen up, with its toast: the sheet still goes.
          if (!this.destroyed) this.rebuild();
        },
        close: () => void this.back(),
        focus: 0,
      });

      return;
    }

    const w = k === 'p' ? W - 40 : 520;
    const h = 250;
    const x = (W - w) / 2;
    const y = k === 'p' ? S.t + 80 : (H - h) / 2;
    const p = this.panel(x, y, w, h, { accent: COLORS.cyan });

    p.sprite.eventMode = 'static';
    this.title('Paste a track', p.c.x + 24, p.c.y + 22, k === 'd' ? 32 : 26);
    this.text('A track link, or its code.', p.c.x + 24, p.c.y + 64, { s: 14, c: COLORS.mist });

    const well = this.panel(p.c.x + 24, p.c.y + 92, w - 48, 52, { tone: 'well', chamfer: 10 });
    const shown = this.text(this._paste || 'Paste here', well.c.x + 16, well.c.y + 16, {
      s: 18,
      w: 600,
      c: this._paste ? COLORS.white : COLORS.mist,
      max: w - 84,
    });
    const field = new TextField({
      value: this._paste,
      max: 2000,
      capitalize: 'off',
      onChange: (v) => {
        this._paste = v;
        shown.text = v || 'Paste here';
        shown.style.fill = v ? COLORS.white : COLORS.mist;
      },
      onEnter: () => this._import(this._paste),
      onEscape: () => void this.back(),
    });

    well.sprite.eventMode = 'static';
    well.sprite.on('pointertap', () => field.focus());
    this.onDispose(() => field.destroy());
    this.button('Cancel', p.c.x + 24, p.c.y + h - 72, (w - 64) / 2, 50, 'secondary', null, () => void this.back());
    this.button('Add track', p.c.x + 40 + (w - 64) / 2, p.c.y + h - 72, (w - 64) / 2, 50, 'primary', 'plus', () =>
      this._import(this._paste),
    );
    field.focus();
  }

  /** Art drawn into a tile as its child, at a point in the tile's own px. */
  private _artChild(parent: Container, art: SvgArt, x: number, y: number): Container {
    const prev = this.target;

    this.into(parent);
    const placed = this.put(art, x, y);

    this.into(prev);

    return placed.sprite;
  }

  private readonly _onKey = (e: KeyboardEvent): void => {
    if (this._sheet || e.target instanceof HTMLInputElement) return;

    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      this._turn(e.key === 'PageDown' ? 1 : -1);

      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && !this._pick) {
      const card = this._focused();

      if (card && !card.builtIn) {
        e.preventDefault();
        this._delete(card);
      }
    }
  };

  /** The wheel turns pages, one a notch. */
  private readonly _onWheel = (e: WheelEvent): void => {
    const now = performance.now();

    if (this._sheet || Math.abs(e.deltaY) < 4 || now - this._wheelAt < WHEEL_MS) return;

    this._wheelAt = now;
    this._turn(e.deltaY > 0 ? 1 : -1);
  };

  private readonly _onPaste = (e: ClipboardEvent): void => {
    if (this._pick || e.target instanceof HTMLInputElement) return;

    const text = e.clipboardData?.getData('text') ?? '';

    if (!text.trim()) return;

    e.preventDefault();
    this._import(text);
  };
}
