/**
 * The editor's board: the 14 by 9 grid with the road on it, every preview a stroke makes, the start line, an open
 * road's ends (knobs with rings pulsing out of them, where the road goes on and where it closes), the keyboard's
 * cursor and the lap trail, plus the loupe a finger gets on touch and the pointer input that drives the strokes. It lives for the editor's whole life and redraws only from `render`, so a
 * stroke in progress never drops when the panel beside it rebuilds.
 *
 * A tall phone draws the board turned a quarter clockwise: board cell (bx, by) shows at screen cell (8 - by, bx).
 */

import type { FederatedPointerEvent, Texture } from 'pixi.js';
import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';

import type { BoardCell, Refusal, TrackDoc } from '../../track/doc';
import { BOARD_H, BOARD_W, cellAt, cellX, cellY, headingTo } from '../../track/doc';
import type { SvgArt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';
import { COLORS } from '../art/tokens';
import type { PieceMask, PieceStyle } from '../art/trackArt';
import { glowDotSvg, knobSvg, piecePad, pieceSvg, startCellSvg } from '../art/trackArt';
import { Motion } from '../kit/Motion';
import { makeText } from '../kit/text';
import type { StrokePaint } from './Strokes';

/** Everything the board draws. */
export interface BoardPaint {
  readonly doc: TrackDoc;
  readonly stroke: StrokePaint | null;
  /** New road previewed from outside a stroke: the start fix under the pointer, or a Shift+click route. */
  readonly preview: {
    readonly cells: readonly BoardCell[];
    readonly from: BoardCell;
    readonly to: BoardCell;
    readonly going: ReadonlySet<number>;
  } | null;
  /** The keyboard's cursor, or -1. */
  readonly cursor: BoardCell;
  /** Path indices outlined amber: a loop with no start shows its longest straight. */
  readonly amber: readonly number[];
  /** A loop that's a track: chevrons drift round it the way it races. */
  readonly ready: boolean;
}

/** What the board's input asks of the editor. */
export interface BoardInput {
  /** A press on a cell. */
  press(cell: BoardCell, o: { erase: boolean; touch: boolean; shift: boolean }): void;
  /** The press moved far enough to be a drag. */
  drag(): void;
  /** The pointer is over another cell; `off` when it's past the board's edge, the cell clamped onto it. */
  move(cell: BoardCell, off: boolean): void;
  release(): void;
  cancel(): void;
  /** Two or three fingers tapped together. */
  fingers(count: 2 | 3): void;
  /** A mouse over the board with no button down: the cell, or -1 off it. */
  hover(cell: BoardCell, shift: boolean): void;
}

/** Pixels a press moves before it's a drag. */
const SLOP = 6;
/** A multi-finger tap: every finger up within this, none moved further than this. */
const TAP_MS = 400;
const TAP_SLOP = 14;
/** Masks a path can make: lone cell, the four ends, the two straights and the four corners. */
const MASKS: readonly PieceMask[] = [0, 1, 2, 4, 8, 5, 10, 3, 6, 12, 9];
const STYLES: readonly PieceStyle[] = ['road', 'ghost', 'dash'];
const CELLS = BOARD_W * BOARD_H;
/** Rings out of an open road's ends: how often one leaves, seconds, and how far it grows, in cells. */
const BEACON_PERIOD = 1.1;
const BEACON_REACH = 0.6;
/** Chevrons round a ready loop: one every few cells, drifting this many cells a second. */
const CHEVRON_EVERY = 3;
const CHEVRON_SPEED = 1.1;
/**
 * Where the loupe can sit round a finger, as angles: above first, then the diagonals above, the sides, and below,
 * where the hand is, last.
 */
const LOUPE_ANGLES = [-90, -135, -45, 180, 0, 135, 45, 90].map((deg) => (deg * Math.PI) / 180);
/** What the loupe pays, in its placement's score, for sitting where it shouldn't. */
const LOUPE_COST = { finger: 1000, target: 40, end: 25, going: 8, ahead: 30, below: 12, outside: 6, moved: 8 } as const;
const hex = (color: string): number => Number(`0x${color.slice(1)}`);

/** The textures one board size draws with, made once per size and freed with it. */
class BoardArt {
  public readonly cell: number;
  private readonly _textures: SvgTextures;
  private readonly _density: number;
  private readonly _arts = new Map<string, SvgArt>();
  private readonly _loaded = new Map<string, Texture>();

  constructor(textures: SvgTextures, density: number, cell: number, onReady: () => void) {
    this._textures = textures;
    this._density = density;
    this.cell = cell;

    for (const style of STYLES)
      for (const mask of MASKS) this._arts.set(`${style}${mask}`, pieceSvg(mask, style, cell));

    this._arts.set('start', startCellSvg(cell));
    this._arts.set('startBad', startCellSvg(cell, true));
    this._arts.set('knob', knobSvg(cell));
    this._arts.set('dot', glowDotSvg(Math.max(3, cell * 0.12), COLORS.cyan));

    const loads = [...this._arts].map(([key, art]) =>
      textures.load(art, density).then((texture) => void this._loaded.set(key, texture)),
    );

    void Promise.all(loads).then(onReady, () => undefined);
  }

  public get(key: string): Texture | null {
    return this._loaded.get(key) ?? null;
  }

  public destroy(): void {
    for (const art of this._arts.values()) this._textures.release(art, this._density);
    this._arts.clear();
    this._loaded.clear();
  }
}

/** The sides a path index opens onto, as a {@link PieceMask}. */
function maskOf(path: readonly BoardCell[], closed: boolean, i: number): PieceMask {
  const n = path.length;
  let mask = 0;

  for (const j of [i - 1, i + 1]) {
    if (!closed && (j < 0 || j >= n)) continue;

    const d = headingTo(path[i], path[(j + n) % n]);

    if (d >= 0 && n > 1) mask |= 1 << d;
  }

  return mask;
}

/** A chain's piece masks: each cell opens onto the cells before and after it in the chain. */
function chainMasks(chain: readonly BoardCell[]): PieceMask[] {
  return chain.map((cell, i) => {
    let mask = 0;

    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= chain.length) continue;

      const d = headingTo(cell, chain[j]);

      if (d >= 0) mask |= 1 << d;
    }

    return mask;
  });
}

/** Points along a chain of cells' centreline in layer px, with the distance to each, for things that ride it. */
export class CentreLine {
  public readonly x: number[] = [];
  public readonly y: number[] = [];
  public readonly s: number[] = [];

  constructor(cells: readonly BoardCell[], closed: boolean, cell: number) {
    const n = cells.length;
    const centre = (c: BoardCell): [number, number] => [(cellX(c) + 0.5) * cell, (cellY(c) + 0.5) * cell];
    const push = (x: number, y: number): void => {
      const k = this.x.length;
      const s = k === 0 ? 0 : this.s[k - 1] + Math.hypot(x - this.x[k - 1], y - this.y[k - 1]);

      this.x.push(x);
      this.y.push(y);
      this.s.push(s);
    };

    for (let i = 0; i < n; i++) {
      const [cx, cy] = centre(cells[i]);
      const prev = i > 0 || closed ? cells[(i - 1 + n) % n] : -1;
      const next = i < n - 1 || closed ? cells[(i + 1) % n] : -1;
      const din = prev >= 0 ? headingTo(prev, cells[i]) : -1;
      const dout = next >= 0 ? headingTo(cells[i], next) : -1;

      if (din < 0 || dout < 0 || din === dout) {
        const [ex, ey] = din >= 0 ? edge(cx, cy, (din + 2) % 4, cell) : [cx, cy];

        push(ex, ey);
        if (dout < 0) push(cx, cy);

        continue;
      }

      // A corner: a quarter arc round the corner the entry and exit sides share.
      const [ax, ay] = edge(cx, cy, (din + 2) % 4, cell);
      const [bx, by] = edge(cx, cy, dout, cell);
      const ox = ax + bx - cx;
      const oy = ay + by - cy;
      const a0 = Math.atan2(ay - oy, ax - ox);
      let a1 = Math.atan2(by - oy, bx - ox);

      if (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
      if (a0 - a1 > Math.PI) a1 += Math.PI * 2;

      for (let k = 0; k < 4; k++) {
        const a = a0 + ((a1 - a0) * k) / 4;

        push(ox + Math.cos(a) * (cell / 2), oy + Math.sin(a) * (cell / 2));
      }
    }

    if (closed && n > 0) push(this.x[0], this.y[0]);
  }

  public get length(): number {
    return this.s[this.s.length - 1] ?? 0;
  }

  /** The point `d` px along, and the heading there. */
  public at(d: number): { x: number; y: number; angle: number } {
    const s = this.s;
    let lo = 0;
    let hi = s.length - 1;

    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;

      if (s[mid] <= d) lo = mid;
      else hi = mid;
    }

    const span = s[hi] - s[lo] || 1;
    const t = Math.min(1, Math.max(0, (d - s[lo]) / span));

    return {
      x: this.x[lo] + (this.x[hi] - this.x[lo]) * t,
      y: this.y[lo] + (this.y[hi] - this.y[lo]) * t,
      angle: Math.atan2(this.y[hi] - this.y[lo], this.x[hi] - this.x[lo]),
    };
  }
}

/** The midpoint of one side of a cell centred on (cx, cy). */
function edge(cx: number, cy: number, side: number, cell: number): [number, number] {
  const h = cell / 2;

  return [cx + [h, 0, -h, 0][side], cy + [0, h, 0, -h][side]];
}

/** One drawing of the board at one cell size: the main board, or the loupe's enlargement. */
class BoardLayer extends Container {
  public art: BoardArt | null = null;
  private readonly _ground = new Graphics();
  private readonly _road: Sprite[] = [];
  private readonly _dash: Sprite[] = [];
  private readonly _ghost: Sprite[] = [];
  private readonly _marks = new Graphics();
  private readonly _start = new Sprite();
  private readonly _knobs = [new Sprite(), new Sprite()];
  private readonly _chevrons = new Graphics();
  private readonly _rings = new Graphics();
  private readonly _flash = new Graphics();
  /** Open ends to ring, in layer px; `strong` for the one a stroke under way closes on. */
  private _beacons: { x: number; y: number; strong: boolean }[] = [];
  private _loop: CentreLine | null = null;

  constructor() {
    super();

    const layers = [new Container(), new Container(), new Container()];

    for (let i = 0; i < CELLS; i++) {
      const road = new Sprite();
      const dash = new Sprite();
      const ghost = new Sprite();

      road.visible = dash.visible = ghost.visible = false;
      dash.tint = hex(COLORS.danger);
      this._road.push(road);
      this._dash.push(dash);
      this._ghost.push(ghost);
      layers[0].addChild(road);
      layers[1].addChild(ghost);
      layers[2].addChild(dash);
    }

    this._start.anchor.set(0.5);
    for (const k of this._knobs) k.anchor.set(0.5);
    this.addChild(this._ground, layers[0], this._chevrons, layers[1], layers[2], this._start, ...this._knobs);
    this.addChild(this._rings, this._marks, this._flash);
    this.eventMode = 'none';
  }

  public get cell(): number {
    return this.art?.cell ?? 0;
  }

  /** The loop's centreline, for chevrons and the direction light. */
  public get loop(): CentreLine | null {
    return this._loop;
  }

  public setArt(art: BoardArt): void {
    this.art?.destroy();
    this.art = art;

    const c = art.cell;
    const g = this._ground;

    g.clear();
    g.rect(0, 0, BOARD_W * c, BOARD_H * c).fill({ color: hex(COLORS.ink800) });

    for (let x = 0; x <= BOARD_W; x++) g.moveTo(x * c, 0).lineTo(x * c, BOARD_H * c);
    for (let y = 0; y <= BOARD_H; y++) g.moveTo(0, y * c).lineTo(BOARD_W * c, y * c);

    g.stroke({ color: hex(COLORS.line), alpha: 0.25, width: 1 });
    g.rect(0, 0, BOARD_W * c, BOARD_H * c).stroke({ color: hex(COLORS.line), alpha: 0.7, width: 2 });
  }

  public render(p: BoardPaint): void {
    const art = this.art;

    if (!art) return;

    const c = art.cell;
    const pad = piecePad(c);
    const stroke = p.stroke;
    const doc = stroke?.doc ?? p.doc;
    const path = doc.path;
    const going = new Set<number>(stroke?.going ?? []);

    for (const i of p.preview?.going ?? []) going.add(i);

    for (let i = 0; i < CELLS; i++) {
      this._road[i].visible = false;
      this._dash[i].visible = false;
      this._ghost[i].visible = false;
    }

    const place = (sprite: Sprite, cell: BoardCell, key: string): void => {
      const texture = art.get(key);

      sprite.visible = texture !== null;
      if (!texture) return;

      sprite.texture = texture;
      sprite.position.set(cellX(cell) * c - pad, cellY(cell) * c - pad);
    };

    path.forEach((cell, i) => {
      const mask = maskOf(path, doc.closed, i);
      const road = this._road[cell];

      place(road, cell, `road${mask}`);
      road.alpha = going.has(i) ? 0.4 : 1;
      if (going.has(i)) place(this._dash[cell], cell, `dash${mask}`);
    });

    // Ghosts: a stroke's new road, then a preview's.
    const ghosts: { chain: BoardCell[]; tint: string; alpha: number; skip: number }[] = [];

    if (stroke && stroke.ghost.length > 0) {
      const chain = [stroke.ghostFrom, ...stroke.ghost, stroke.ghostTo].filter((x) => x >= 0);

      ghosts.push({
        chain,
        tint: stroke.ghostWarn ? COLORS.amber : COLORS.cyan,
        alpha: 1,
        skip: stroke.ghostFrom >= 0 ? 1 : 0,
      });
    }

    if (p.preview && p.preview.cells.length > 0) {
      const chain = [p.preview.from, ...p.preview.cells, p.preview.to].filter((x) => x >= 0);

      ghosts.push({ chain, tint: COLORS.cyan, alpha: 1, skip: p.preview.from >= 0 ? 1 : 0 });
    }

    for (const g of ghosts) {
      const masks = chainMasks(g.chain);
      const last = g.chain.length - (g.skip && g.chain.length > g.skip + 1 ? 1 : 0);

      for (let k = g.skip; k < last; k++) {
        const cell = g.chain[k];
        const sprite = this._ghost[cell];

        if (sprite.visible) continue;

        place(sprite, cell, `ghost${masks[k]}`);
        sprite.tint = hex(g.tint);
        sprite.alpha = g.alpha;
      }
    }

    // The start line, where it is or where a drag would put it.
    const at = stroke?.kind === 'start' && stroke.startAt >= 0 ? stroke.startAt : doc.closed ? doc.finish : -1;
    const bad = stroke?.startBad ?? -1;
    const startCell = bad >= 0 ? bad : at >= 0 ? path[at] : -1;

    this._start.visible = startCell >= 0;

    if (startCell >= 0) {
      const texture = art.get(bad >= 0 ? 'startBad' : 'start');
      const i = path.indexOf(startCell);
      const dir = i >= 0 ? headingTo(path[i], path[(i + 1) % path.length]) : 0;

      this._start.visible = texture !== null;
      if (texture) this._start.texture = texture;
      this._start.position.set((cellX(startCell) + 0.5) * c, (cellY(startCell) + 0.5) * c);
      this._start.rotation = (Math.max(0, dir) * Math.PI) / 2;
    }

    const ends = !doc.closed && path.length > 0 ? [path[path.length - 1], path[0]] : [];

    this._knobs.forEach((knob, k) => {
      const cell = ends[k];
      const texture = art.get('knob');

      knob.visible = cell !== undefined && texture !== null && !(k === 1 && path.length === 1);
      if (!knob.visible || !texture) return;

      knob.texture = texture;
      knob.position.set((cellX(cell) + 0.5) * c, (cellY(cell) + 0.5) * c);
    });

    // An open road's ends ring; while a stroke lays road from one of them, only the end it would close on does.
    const target = stroke?.target ?? -1;
    const rung = target >= 0 ? [target] : ends.slice(0, path.length > 1 ? 2 : 1);

    this._beacons = rung.map((cell) => ({
      x: (cellX(cell) + 0.5) * c,
      y: (cellY(cell) + 0.5) * c,
      strong: target >= 0,
    }));
    this._loop = doc.closed && path.length > 0 ? new CentreLine(rotateTo(path, doc.finish), true, c) : null;
    this._drawMarks(p, stroke);
  }

  /** Per frame: rings pulse out of an open road's ends; chevrons drift round a ready loop. */
  public animate(time: number, ready: boolean, reduced: boolean): void {
    const g = this._chevrons;
    const rings = this._rings;
    const c = this.cell;

    g.clear();
    rings.clear();

    if (!c) return;

    for (const b of this._beacons) {
      const reach = c * (b.strong ? BEACON_REACH * 1.4 : BEACON_REACH);
      const width = Math.max(2, c * (b.strong ? 0.09 : 0.06));

      if (reduced) {
        rings.circle(b.x, b.y, c * 0.3 + reach * 0.6).stroke({ color: hex(COLORS.cyan), width, alpha: 0.8 });
        continue;
      }

      for (let k = 0; k < 2; k++) {
        const phase = (time / BEACON_PERIOD + k / 2) % 1;

        rings
          .circle(b.x, b.y, c * 0.3 + reach * phase)
          .stroke({ color: hex(COLORS.cyan), width, alpha: (1 - phase) * (b.strong ? 1 : 0.8) });
      }
    }

    const loop = this._loop;

    if (ready && loop && loop.length > 0) {
      const step = c * CHEVRON_EVERY;
      const shift = (time * CHEVRON_SPEED * c) % step;
      const s = c * 0.12;

      for (let d = shift; d < loop.length; d += step) {
        const { x, y, angle } = loop.at(d);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const pt = (u: number, v: number): [number, number] => [x + u * cos - v * sin, y + u * sin + v * cos];
        const [ax, ay] = pt(-s, -s * 1.1);
        const [bx, by] = pt(s, 0);
        const [cx, cy] = pt(-s, s * 1.1);

        g.moveTo(ax, ay).lineTo(bx, by).lineTo(cx, cy);
      }

      g.stroke({ color: hex(COLORS.cyan), alpha: 0.55, width: Math.max(1.5, c * 0.05), cap: 'round', join: 'round' });
    }
  }

  /** A soft flash over cells that just changed (undo, redo). */
  public flashCells(cells: readonly BoardCell[], motion: Motion): void {
    const g = this._flash;
    const c = this.cell;

    g.clear();
    for (const cell of cells) g.rect(cellX(cell) * c, cellY(cell) * c, c, c);
    g.fill({ color: 0xffffff, alpha: 0.35 });
    motion.stop(g);
    motion.fromTo(g, { alpha: 1 }, { alpha: 0, duration: motion.reduced ? 0.15 : 0.45, ease: 'power2.out' });
  }

  /** The knobs punch, or the whole loop flashes, to say where drawing goes on from. */
  public pulseEnds(motion: Motion): void {
    if (this._knobs[0].visible) {
      for (const k of this._knobs) if (k.visible) motion.punch(k.scale, 1.6, 0.5);

      return;
    }

    for (const sprite of this._road) {
      if (!sprite.visible) continue;
      motion.stop(sprite);
      motion.fromTo(sprite, { alpha: 0.35 }, { alpha: 1, duration: 0.5, ease: 'power2.out' });
    }
  }

  /** The start line lands: it punches in. */
  public punchStart(motion: Motion): void {
    if (this._start.visible) motion.punch(this._start.scale, 1.7, 0.6);
  }

  private _drawMarks(p: BoardPaint, stroke: StrokePaint | null): void {
    const g = this._marks;
    const c = this.cell;
    const doc = stroke?.doc ?? p.doc;

    g.clear();

    // A loop with no start: its longest straight, outlined amber.
    for (const i of p.amber) {
      const cell = doc.path[i];

      if (cell !== undefined) g.rect(cellX(cell) * c + 2, cellY(cell) * c + 2, c - 4, c - 4);
    }

    if (p.amber.length > 0) g.stroke({ color: hex(COLORS.amber), width: 2, alpha: 0.9 });

    // Cells an erase touched that stay: a grey X.
    for (const cell of stroke?.kept ?? []) cross(g, cell, c, 0.22);
    if ((stroke?.kept.size ?? 0) > 0) g.stroke({ color: hex(COLORS.mist), width: Math.max(2, c * 0.07), alpha: 0.8 });

    // The road cell a release would snap onto.
    if (stroke && stroke.magnet >= 0) {
      g.circle((cellX(stroke.magnet) + 0.5) * c, (cellY(stroke.magnet) + 0.5) * c, c * 0.42).stroke({
        color: hex(COLORS.cyan),
        width: 3,
        alpha: 0.9,
      });
    }

    // The keyboard's cursor: cyan brackets.
    if (p.cursor >= 0) {
      const x = cellX(p.cursor) * c;
      const y = cellY(p.cursor) * c;
      const k = c * 0.3;
      const w = Math.max(2.5, c * 0.07);

      g.moveTo(x, y + k)
        .lineTo(x, y)
        .lineTo(x + k, y);
      g.moveTo(x + c - k, y)
        .lineTo(x + c, y)
        .lineTo(x + c, y + k);
      g.moveTo(x + c, y + c - k)
        .lineTo(x + c, y + c)
        .lineTo(x + c - k, y + c);
      g.moveTo(x + k, y + c)
        .lineTo(x, y + c)
        .lineTo(x, y + c - k);
      g.stroke({ color: hex(COLORS.cyan), width: w, alpha: 1 });
    }
  }
}

/** A loop's cells from index `at` round. */
function rotateTo(path: readonly BoardCell[], at: number): BoardCell[] {
  const k = Math.max(0, at);

  return [...path.slice(k), ...path.slice(0, k)];
}

/** An X over a cell. */
function cross(g: Graphics, cell: BoardCell, c: number, inset: number): void {
  const x = cellX(cell) * c;
  const y = cellY(cell) * c;
  const k = c * inset;

  g.moveTo(x + k, y + k).lineTo(x + c - k, y + c - k);
  g.moveTo(x + c - k, y + k).lineTo(x + k, y + c - k);
}

/** A finger on the board. */
interface Finger {
  readonly id: number;
  readonly x0: number;
  readonly y0: number;
  moved: number;
}

/**
 * The board on screen: its layer, the loupe, the effects over it and the pointer input. Box px in, cells out.
 */
export class BoardView extends Container {
  /** The board's size on screen, in box px, as last laid out. */
  public readonly box = new Rectangle();
  private readonly _textures: SvgTextures;
  private readonly _input: BoardInput;
  private readonly _motion = new Motion();
  private readonly _layer = new BoardLayer();
  private readonly _loupe = new Container();
  private readonly _loupeLayer = new BoardLayer();
  private readonly _loupeMask = new Graphics();
  private readonly _loupeRing = new Graphics();
  private readonly _fx = new Graphics();
  private readonly _bubble = new Container();
  private readonly _light = new Sprite();
  private readonly _trail = new Graphics();
  private readonly _hit = new Graphics();
  private _density = 1;
  private _textResolution = 1;
  private _turned = false;
  private _paint: BoardPaint | null = null;
  private _fingers = new Map<number, Finger>();
  /** The pointer driving the stroke, and whether it has turned into a drag. */
  private _driver = -1;
  private _dragging = false;
  private _erase = false;
  private _multi: { count: number; at: number; moved: boolean } | null = null;
  private _lastCell: BoardCell = -1;
  private _loupeOn = false;
  private _loupeAt = { x: 0, y: 0 };
  /** The screen's size, box px, which the loupe stays inside. */
  private _view = { w: 0, h: 0 };
  /** The finger's recent movement, box px, fading as it goes: the loupe keeps out of its way. */
  private _travel = { x: 0, y: 0 };
  /** The angle the loupe last sat at, from {@link LOUPE_ANGLES}, or -1. */
  private _loupeSide = -1;
  private _unTick: (() => void) | null = null;

  constructor(textures: SvgTextures, input: BoardInput) {
    super();
    this._textures = textures;
    this._input = input;
    this._loupe.addChild(this._loupeLayer, this._loupeRing);
    this._loupeLayer.mask = this._loupeMask;
    this._loupe.addChild(this._loupeMask);
    this._loupe.visible = false;
    this._light.anchor.set(0.5);
    this._light.visible = false;
    this._trail.eventMode = 'none';
    this._layer.addChild(this._trail);
    this.addChild(this._hit, this._layer, this._fx, this._light, this._loupe, this._bubble);
    this._hit.eventMode = 'static';
    this._hit.cursor = 'crosshair';
    this._hit.on('pointerdown', this._down);
    this._hit.on('globalpointermove', this._move);
    this._hit.on('pointerup', this._up);
    this._hit.on('pointerupoutside', this._up);
    this._hit.on('pointercancel', this._up);
    this._hit.on('pointerleave', this._leave);
    this._bubble.eventMode = 'none';
    this._loupe.eventMode = 'none';
    this.eventMode = 'passive';
    this._unTick = this._motion.tick(this._tick);
  }

  /** A cell's size on screen, box px. */
  public get cellSize(): number {
    return this._layer.cell;
  }

  /** Box px of a board cell's centre. */
  public cellCentre(cell: BoardCell): { x: number; y: number } {
    const c = this._layer.cell;
    const lx = (cellX(cell) + 0.5) * c;
    const ly = (cellY(cell) + 0.5) * c;

    return this._turned
      ? { x: this.box.x + BOARD_H * c - ly, y: this.box.y + lx }
      : { x: this.box.x + lx, y: this.box.y + ly };
  }

  /** The cell under a point in box px; `off` when the point is past the edge, the cell clamped onto the board. */
  public cellAtBox(x: number, y: number): { cell: BoardCell; off: boolean } {
    const c = this._layer.cell || 1;
    let lx: number;
    let ly: number;

    if (this._turned) {
      lx = y - this.box.y;
      ly = this.box.x + BOARD_H * c - x;
    } else {
      lx = x - this.box.x;
      ly = y - this.box.y;
    }

    const bx = Math.floor(lx / c);
    const by = Math.floor(ly / c);
    const cx = Math.min(BOARD_W - 1, Math.max(0, bx));
    const cy = Math.min(BOARD_H - 1, Math.max(0, by));

    return { cell: cellAt(cx, cy), off: cx !== bx || cy !== by };
  }

  /**
   * Places the board.
   * @param x - Left, box px.
   * @param y - Top, box px.
   * @param cell - A cell's size, box px.
   * @param turned - Drawn a quarter turn clockwise, for a tall phone.
   * @param density - Art density, from the layout.
   * @param textResolution - Text resolution, from the layout.
   * @param view - The screen's size, box px: the loupe stays inside it.
   */
  public layout(
    x: number,
    y: number,
    cell: number,
    turned: boolean,
    density: number,
    textResolution: number,
    view: { w: number; h: number },
  ): void {
    const w = (turned ? BOARD_H : BOARD_W) * cell;
    const h = (turned ? BOARD_W : BOARD_H) * cell;
    const sameSize = this._layer.cell === cell && this._density === density;

    this.box.x = x;
    this.box.y = y;
    this.box.width = w;
    this.box.height = h;
    this._view = { w: view.w, h: view.h };
    this._turned = turned;
    this._density = density;
    this._textResolution = textResolution;

    if (!sameSize) {
      this._layer.setArt(new BoardArt(this._textures, density, cell, () => this._redraw()));
      this._loupeLayer.setArt(new BoardArt(this._textures, density, cell * 2, () => this._redraw()));
    }

    this._layer.rotation = turned ? Math.PI / 2 : 0;
    this._layer.position.set(turned ? x + w : x, y);
    this._loupeLayer.rotation = this._layer.rotation;
    this._hit.clear().rect(x, y, w, h).fill({ color: 0xffffff, alpha: 0.001 });
    this._hit.hitArea = new Rectangle(x, y, w, h);

    const r = cell * 3;

    this._loupeMask.clear().circle(0, 0, r).fill({ color: 0xffffff });
    this._loupeRing
      .clear()
      .circle(0, 0, r)
      .stroke({ color: hex(COLORS.cyan), width: 3 })
      .circle(0, 0, r + 4)
      .stroke({ color: hex(COLORS.ink900), width: 4, alpha: 0.6 });
    this._redraw();
  }

  /** Draws the board's state. */
  public render(paint: BoardPaint): void {
    this._paint = paint;
    this._redraw();
  }

  /** A refusal: an amber X on the cell and a bubble over the finger, or the border glowing at the edge. */
  public refuse(cell: BoardCell, why: Refusal, text: string): void {
    const g = this._fx;

    this.refusals[why]++;
    const c = this._layer.cell;

    g.clear();

    if (why === 'edge') {
      g.rect(this.box.x - 3, this.box.y - 3, this.box.width + 6, this.box.height + 6).stroke({
        color: hex(COLORS.amber),
        width: 6,
        alpha: 0.9,
      });
    } else if (cell >= 0) {
      const { x, y } = this.cellCentre(cell);
      const h = c / 2;

      g.rect(x - h, y - h, c, c).fill({ color: hex(COLORS.amber), alpha: 0.35 });
      g.moveTo(x - h * 0.55, y - h * 0.55)
        .lineTo(x + h * 0.55, y + h * 0.55)
        .moveTo(x + h * 0.55, y - h * 0.55)
        .lineTo(x - h * 0.55, y + h * 0.55)
        .stroke({ color: hex(COLORS.amber), width: Math.max(3, c * 0.1) });
    }

    this._motion.stop(g);
    this._motion.fromTo(g, { alpha: 1 }, { alpha: 0, duration: 0.7, delay: 0.25, ease: 'power2.in' });
    this.bubble(text, cell >= 0 ? cell : this._lastCell);
  }

  /**
   * A short line in a bubble 56 px over a cell (over the finger on touch).
   * @param text - The line.
   * @param cell - The cell it points at; -1 clears the bubble.
   * @param tone - `warn` (amber) for a refusal, `info` (cyan) for a tip.
   */
  public bubble(text: string, cell: BoardCell, tone: 'warn' | 'info' = 'warn'): void {
    const b = this._bubble;

    this.lastBubble = text;
    for (const child of b.removeChildren()) child.destroy();
    if (cell < 0) return;

    const t = makeText(text, 0, 0, { s: 15, w: 600, a: 'c', flat: true }, this._textResolution);
    const w = t.width + 28;
    const h = 34;
    const panel = new Graphics()
      .roundRect(-w / 2, -h / 2, w, h, 8)
      .fill({ color: hex(COLORS.ink900), alpha: 0.94 })
      .stroke({ color: hex(tone === 'warn' ? COLORS.amber : COLORS.cyan), width: 2 });
    const { x, y } = this.cellCentre(cell);

    t.position.set(0, -8);
    b.addChild(panel, t);
    b.position.set(
      Math.min(this.box.x + this.box.width - w / 2, Math.max(this.box.x + w / 2, x)),
      Math.max(h / 2 + 4, y - 56),
    );
    this._motion.stop(b);
    this._motion.fromTo(b, { alpha: 1 }, { alpha: 0, duration: 0.4, delay: 1.3, ease: 'power2.in' });
  }

  public pulseEnds(): void {
    this._layer.pulseEnds(this._motion);
  }

  public punchStart(): void {
    this._layer.punchStart(this._motion);
  }

  public flash(cells: readonly BoardCell[]): void {
    this._layer.flashCells(cells, this._motion);
  }

  /**
   * A light runs once round the loop the way the race goes, from the start line.
   * @param color - Its colour: white to show the direction, cyan as a loop first closes.
   */
  public runLight(color: string = COLORS.white): void {
    const loop = this._layer.loop;
    const texture = this._layer.art?.get('dot');

    if (!loop || !texture || loop.length === 0) return;

    const light = this._light;
    const state = { d: 0 };

    light.texture = texture;
    light.tint = hex(color);
    light.visible = true;
    this._motion.stop(state);
    this._motion.to(state, {
      d: loop.length,
      duration: this._motion.reduced ? 0.01 : Math.min(2.2, 0.9 + loop.length / 900),
      ease: 'power1.inOut',
      onUpdate: () => {
        const pt = loop.at(state.d);
        const g = this._layer.toGlobal(pt);
        const local = this.toLocal(g);

        light.position.copyFrom(local);
      },
      onComplete: () => void (light.visible = false),
    });
  }

  /**
   * The player's last lap as a trail coloured by speed, amber slow to cyan fast, with sparks at hits and respawns.
   * @param trail - x, y in board cells, speed 0 to 1 and an event, four numbers a sample; null clears it.
   */
  public setTrail(trail: Float32Array | null): void {
    const g = this._trail;
    const c = this._layer.cell;

    g.clear();

    if (!trail || !c) return;

    for (let i = 0; i + 3 < trail.length; i += 4) {
      const x = (trail[i] + 0.5) * c;
      const y = (trail[i + 1] + 0.5) * c;
      const speed = Math.min(1, Math.max(0, trail[i + 2]));
      const event = trail[i + 3];
      const color = mixHex(COLORS.amber, COLORS.cyan, speed);

      g.circle(x, y, Math.max(1.5, c * 0.05)).fill({ color, alpha: 0.85 });

      if (event > 0) {
        const r = c * 0.18;

        g.moveTo(x - r, y)
          .lineTo(x + r, y)
          .moveTo(x, y - r)
          .lineTo(x, y + r);
        g.stroke({ color: hex(event === 1 ? COLORS.danger : COLORS.white), width: 2 });
      }
    }
  }

  /** The loupe is up over a finger. */
  public get loupeShown(): boolean {
    return this._loupeOn;
  }

  /** The bubble's last line, and how many refusals of each kind it has shown. */
  public lastBubble = '';
  public readonly refusals = { cross: 0, edge: 0 };

  /** Whether a stroke's pointer is down. */
  public get pressing(): boolean {
    return this._driver >= 0;
  }

  public override destroy(): void {
    this._unTick?.();
    this._motion.destroy();
    this._layer.art?.destroy();
    this._loupeLayer.art?.destroy();
    this._hit.removeAllListeners();
    super.destroy({ children: true });
  }

  private _redraw(): void {
    const p = this._paint;

    if (!p) return;

    this._layer.render(p);
    if (this._loupe.visible) this._loupeLayer.render(p);
  }

  private readonly _tick = (time: number): void => {
    const ready = this._paint?.ready ?? false;

    const reduced = this._motion.reduced;

    this._layer.animate(time, ready, reduced);
    if (this._loupe.visible) this._loupeLayer.animate(time, ready, reduced);
  };

  /**
   * The loupe beside a point in box px, showing the cells round it at twice the size. It sits on the screen, clear of
   * the finger, of where the finger is heading, and of what the stroke is about (the far end it closes on, the road it
   * rejoins, the red road that goes), above the finger by choice and below it, under the hand, last of all.
   */
  private _placeLoupe(x: number, y: number): void {
    const c = this._layer.cell;
    const r = c * 3;
    const reach = r + c * 0.8;
    const clear = r + c * 0.5;
    const keep = this._keepClear();
    const view = this._view;
    const speed = Math.hypot(this._travel.x, this._travel.y);
    let best = 0;
    let bestScore = Infinity;
    let lx = x;
    let ly = y;

    LOUPE_ANGLES.forEach((angle, i) => {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const cx = view.w > 2 * r ? Math.min(view.w - r - 4, Math.max(r + 4, x + dx * reach)) : x + dx * reach;
      const cy = view.h > 2 * r ? Math.min(view.h - r - 4, Math.max(r + 4, y + dy * reach)) : y + dy * reach;
      let score = i * 0.5;

      if (Math.hypot(cx - x, cy - y) < clear) score += LOUPE_COST.finger;
      if (dy > 0.5) score += LOUPE_COST.below;
      if (speed > c * 0.5) score += LOUPE_COST.ahead * Math.max(0, (dx * this._travel.x + dy * this._travel.y) / speed);
      if (cy - r < this.box.y) score += (LOUPE_COST.outside * (this.box.y - cy + r)) / r;
      if (i === this._loupeSide) score -= LOUPE_COST.moved;

      for (const [px, py, cost] of keep) if (Math.hypot(cx - px, cy - py) < clear) score += cost;

      if (score < bestScore) {
        bestScore = score;
        best = i;
        lx = cx;
        ly = cy;
      }
    });

    this._loupeSide = best;

    // The finger's point in the main layer's px, doubled for the loupe's.
    const local = this._layer.toLocal(this.toGlobal({ x, y }));
    const ux = local.x * 2;
    const uy = local.y * 2;

    this._loupe.position.set(lx, ly);
    // The loupe's layer turns like the board's, so the finger's point lands at its centre.
    if (this._turned) this._loupeLayer.position.set(uy, -ux);
    else this._loupeLayer.position.set(-ux, -uy);
    this._loupeAt = { x, y };
  }

  /** Box px the loupe keeps off, with what covering each costs: the stroke's target, the ends, and the road that goes. */
  private _keepClear(): [number, number, number][] {
    const stroke = this._paint?.stroke;
    const out: [number, number, number][] = [];

    if (!stroke) return out;

    const add = (cell: BoardCell, cost: number): void => {
      if (cell < 0) return;

      const p = this.cellCentre(cell);

      out.push([p.x, p.y, cost]);
    };
    const path = stroke.doc.path;

    add(stroke.ghostTo, LOUPE_COST.target);
    add(stroke.magnet, LOUPE_COST.target);
    add(stroke.target, LOUPE_COST.target);
    if (stroke.kind === 'start' && stroke.startAt >= 0) add(path[stroke.startAt], LOUPE_COST.target);
    if (!stroke.doc.closed && path.length > 1) {
      add(path[0], LOUPE_COST.end);
      add(path[path.length - 1], LOUPE_COST.end);
    }

    for (const i of stroke.going) add(path[i], LOUPE_COST.going);

    return out;
  }

  private _showLoupe(on: boolean): void {
    if (on === this._loupeOn) return;

    this._loupeOn = on;

    const l = this._loupe;

    this._motion.stop(l);

    if (on) {
      l.visible = true;
      if (this._paint) this._loupeLayer.render(this._paint);
      this._placeLoupe(this._loupeAt.x, this._loupeAt.y);
      if (this._motion.reduced) l.alpha = 1;
      else this._motion.fromTo(l, { alpha: 0 }, { alpha: 1, duration: 0.15 });
    } else if (this._motion.reduced) {
      l.visible = false;
    } else {
      this._motion.to(l, { alpha: 0, duration: 0.15, onComplete: () => void (l.visible = false) });
    }
  }

  private _boxPoint(e: FederatedPointerEvent): { x: number; y: number } {
    return this.toLocal(e.global);
  }

  private readonly _down = (e: FederatedPointerEvent): void => {
    const p = this._boxPoint(e);
    const touch = e.pointerType === 'touch';

    this._fingers.set(e.pointerId, { id: e.pointerId, x0: e.global.x, y0: e.global.y, moved: 0 });

    // A second finger mid-stroke cancels it; fingers landing together may be a two- or three-finger tap.
    if (touch && this._fingers.size >= 2) {
      if (this._driver >= 0) {
        this._input.cancel();
        this._driver = -1;
        this._showLoupe(false);
      }

      this._multi = {
        count: this._fingers.size,
        at: this._multi?.at ?? performance.now(),
        moved: this._multi?.moved ?? false,
      };

      return;
    }

    if (this._driver >= 0) return;

    const { cell } = this.cellAtBox(p.x, p.y);

    this._driver = e.pointerId;
    this._dragging = false;
    this._erase = e.button === 2;
    this._lastCell = cell;
    this._loupeAt = p;
    this._travel = { x: 0, y: 0 };
    this._loupeSide = -1;
    this._input.press(cell, { erase: this._erase, touch, shift: e.shiftKey });
  };

  private readonly _move = (e: FederatedPointerEvent): void => {
    const finger = this._fingers.get(e.pointerId);

    if (finger) {
      finger.moved = Math.max(finger.moved, Math.hypot(e.global.x - finger.x0, e.global.y - finger.y0));
      if (this._multi && finger.moved > TAP_SLOP) this._multi.moved = true;
    }

    const p = this._boxPoint(e);

    if (this._driver < 0) {
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        const inside = this.box.contains(p.x, p.y);

        this._input.hover(inside ? this.cellAtBox(p.x, p.y).cell : -1, e.shiftKey);
      }

      return;
    }

    if (e.pointerId !== this._driver) return;

    // A right-click during a left drag cancels the stroke.
    if (e.pointerType === 'mouse' && !this._erase && e.buttons & 2) {
      this._input.cancel();
      this._driver = -1;

      return;
    }

    if (!this._dragging) {
      if (!finger || finger.moved < SLOP) return;

      this._dragging = true;
      this._input.drag();
    }

    const { cell, off } = this.cellAtBox(p.x, p.y);

    this._travel = {
      x: this._travel.x * 0.85 + (p.x - this._loupeAt.x),
      y: this._travel.y * 0.85 + (p.y - this._loupeAt.y),
    };
    this._loupeAt = p;

    if (e.pointerType === 'touch') {
      this._showLoupe(true);
      this._placeLoupe(p.x, p.y);
    }

    if (cell !== this._lastCell || off) {
      this._lastCell = cell;
      this._input.move(cell, off);
    }
  };

  private readonly _up = (e: FederatedPointerEvent): void => {
    this._fingers.delete(e.pointerId);

    if (this._multi) {
      if (this._fingers.size > 0) return;

      const multi = this._multi;

      this._multi = null;

      if (!multi.moved && performance.now() - multi.at < TAP_MS && multi.count >= 2) {
        this._input.fingers(multi.count >= 3 ? 3 : 2);
      }

      return;
    }

    if (e.pointerId !== this._driver) return;

    this._driver = -1;
    this._showLoupe(false);
    this._input.release();
  };

  private readonly _leave = (e: FederatedPointerEvent): void => {
    if (e.pointerType === 'mouse' && this._driver < 0) this._input.hover(-1, false);
  };

  /** Cancels whatever the pointer was doing, as Esc does. */
  public cancelPointer(): void {
    this._driver = -1;
    this._showLoupe(false);
  }

  /**
   * Forgets the fingers down, as the layout changes under them: one lifted after the phone turned may never report its
   * lift, and a finger still counted would make every later touch a second finger.
   */
  public dropFingers(): void {
    this.cancelPointer();
    this._fingers.clear();
    this._multi = null;
  }
}

/** Mixes two `#rrggbb` colours into a pixi colour number. */
function mixHex(a: string, b: string, t: number): number {
  const pa = hex(a);
  const pb = hex(b);
  const ch = (shift: number): number => {
    const ca = (pa >> shift) & 255;
    const cb = (pb >> shift) & 255;

    return Math.round(ca + (cb - ca) * t);
  };

  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
