import type { Text } from 'pixi.js';
import { Container, Graphics, Sprite, Texture } from 'pixi.js';

import type { TrackDoc } from '../../track/doc';
import { cellX, cellY, template } from '../../track/doc';
import type { ButtonVariant } from '../art/buttons';
import { collabSvg } from '../art/collab';
import type { IconName } from '../art/icons';
import { iconSvg } from '../art/icons';
import type { CodePlateState } from '../art/panels';
import { codePlateSvg, specBoardSvg } from '../art/panels';
import type { Box, Pt } from '../art/svg';
import { chamferRect, inset, leanShift } from '../art/svg';
import type { RacerColor } from '../art/tokens';
import { COLORS, MOTION } from '../art/tokens';
import { planSvg } from '../art/trackArt';
import type { NewTrack, Screen, TrackCard } from '../contract';
import type { ArtSprite } from '../kit/ArtSprite';
import type { Button } from '../kit/Button';
import { switchButton } from '../kit/buttons';
import { FocusRing } from '../kit/FocusRing';
import type { Focusable } from '../kit/kit';
import type { LayoutKind } from '../kit/layout';
import type { Motion } from '../kit/Motion';
import { capMiddle, fitText, makeText } from '../kit/text';
import { TextField } from '../kit/TextField';
import type { Placed } from './ScreenView';
import { ScreenView } from './ScreenView';

/** The NAME_LENGTH every name slot fits. */
export const NAME_MAX = 16;

/**
 * What every dialog sheet shares, so one sheet after another (Paused, then Leave the race?) never changes size: the
 * title's size per layout and its top, the copy's top, the inset of everything from the panel's sides and foot, and
 * the height of the sheet's buttons.
 */
export const SHEET = {
  title: { d: 36, p: 30, l: 28 } satisfies Record<LayoutKind, number>,
  titleY: 32,
  body: { d: 96, p: 92, l: 78 } satisfies Record<LayoutKind, number>,
  pad: 30,
  button: { d: 56, p: 56, l: 50 } satisfies Record<LayoutKind, number>,
} as const;

/** A full screen's title size per layout, beside the back button every screen leads with ({@link MenuScreen.header}). */
export const HEADER_TITLE = { d: 40, p: 32, l: 28 } satisfies Record<LayoutKind, number>;

/** The Colyseus × PixiJS row's height per layout, the same on every screen that shows it. */
export const COLLAB_SIZE = { d: 30, p: 20, l: 20 } satisfies Record<LayoutKind, number>;

/** One editable name: its drawn field and the hidden input behind it. */
export interface NameFieldView {
  readonly text: Text;
  focus(): void;
  blur(): void;
}

/**
 * A drawn code plate: its placement, the plate and its code in one `node` that scales about the plate's centre, the code
 * text, and a swap between idle, hover and copied.
 */
export type CodePlateView = Placed & {
  sprite: ArtSprite;
  node: Container;
  code: Text;
  setState: (s: CodePlateState) => void;
};

/** One button in a dialog sheet: label, variant, icon, what it does, and whether keys focus it first. */
export interface SheetButton {
  readonly label: string;
  readonly variant: ButtonVariant;
  readonly icon?: IconName;
  readonly onPress: () => void;
  readonly isDefault?: boolean;
}

export interface SheetOptions {
  readonly accent: string;
  readonly icon?: IconName;
  readonly title: string;
  readonly body: string;
  /** Primary first; side by side (second, first) on wide layouts, stacked on a phone */
  readonly buttons: readonly SheetButton[];
  readonly dim?: number;
  readonly w?: number;
  readonly wl?: number;
  /** @deprecated The sheet fits its copy and buttons on every layout; a height passed here is ignored. */
  readonly h?: number;
  /** @deprecated See {@link SheetOptions.h}. */
  readonly hp?: number;
  /** @deprecated See {@link SheetOptions.h}. */
  readonly hl?: number;
}

/** What a new track can start from, in the starting points' sheet. */
const STARTS: readonly (readonly [string, NewTrack])[] = [
  ['Night Run', 'nightrun'],
  ['Oval', 'oval'],
  ['Ring', 'ring'],
  ['Blank', 'blank'],
  ['Shuffle', 'shuffle'],
];

/**
 * A starting point's plan, from its start line round, so the picture's chequer is where the board puts it.
 * @param doc - The starting point.
 * @param turned - A tall phone's quarter turn clockwise, as its editor draws the board.
 */
function docPoints(doc: TrackDoc, turned: boolean): Pt[] {
  const n = doc.path.length;
  const from = doc.closed && doc.finish > 0 ? doc.finish : 0;

  return doc.path.map((_, i) => {
    const c = doc.path[(from + i) % n];

    return turned ? { x: -cellY(c), y: cellX(c) } : { x: cellX(c), y: cellY(c) };
  });
}

/**
 * A card's plan as points: a ready track's centreline turned the way its author drew it, a draft's cells.
 * @param card - The card.
 * @param turned - A tall phone's quarter turn clockwise, as its editor draws the board.
 * @returns Points, any scale.
 */
export function planPoints(card: TrackCard, turned = false): Pt[] {
  const pts: Pt[] = [];

  for (let i = 0; i + 1 < card.outline.length; i += 2) {
    const x = card.outline[i];
    const y = card.outline[i + 1];

    pts.push(turned ? { x: -y, y: x } : { x, y });
  }

  return pts;
}

/** A lap or race time as m:ss.t. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 100)) / 10;
  const m = Math.floor(t / 60);
  const s = t - m * 60;

  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * A card's facts in a line: length, lap and feel.
 * @param card - The card.
 * @returns The line.
 */
export function cardFacts(card: TrackCard): string {
  if (!card.ready) return 'Draft: finish its loop to race it';

  return `${Math.round(card.lengthM)} m · about ${Math.round(card.lapSeconds)} s · ${card.feel}`;
}

/** What {@link MenuScreen.trackBoard} says under a track's name, and what it holds at its foot. */
export interface TrackBoard {
  /** The line under the name. */
  readonly sub: string;
  /** Its colour; mist when left out. */
  readonly subColor?: string;
  /** How tall the actions at the board's foot are; 0 for none. */
  readonly actionsH: number;
  /** Draws them across the board's content, from its left `x` and their top `y`, `w` wide. */
  readonly actions?: (x: number, y: number, w: number) => void;
  /** Side by side, for a wide short box: the plan on the left, the words, readouts and actions in a column beside it. */
  readonly row?: boolean;
}

/** What {@link MenuScreen.startsSheet} shows and does. */
export interface StartsSheet {
  readonly title: string;
  /** A line under the title. */
  readonly note: string;
  readonly pick: (start: NewTrack) => void;
  readonly close: () => void;
  /** A button left of Close. */
  readonly extra?: Omit<SheetButton, 'variant'>;
  /** Which start keys focus first. */
  readonly focus: number;
}

/** The widgets several menu screens share: the name field, the code plate, steppers, switches and dialog sheets. */
export abstract class MenuScreen<D extends Screen = Screen> extends ScreenView<D> {
  /** The big icon a dialog sheet or the connection panel leads with, centred on its middle so it can punch */
  protected heroIcon: ArtSprite | null = null;
  private _tip: Container | null = null;
  /**
   * The well with the driver helmet (or `icon`), the name, a caret and the count. Tap it to type, or reach it with keys
   * or a gamepad like a button: its focus ring shows and typing goes straight in, Up or Down moves on, Enter runs
   * `onEnter`. Every letter ticks; the caret blinks only while the field has the keyboard. `limit` caps the length (a
   * driver's name by default); a longer name, a track's, has its count under the well, so the name has the room.
   */
  protected nameField(
    x: number,
    y: number,
    w: number,
    h: number,
    value: string,
    color: RacerColor,
    onChange: (name: string) => void,
    onEnter: () => void,
    isDefault = false,
    limit = NAME_MAX,
    icon: IconName = 'driver',
  ): NameFieldView {
    const f = this.panel(x, y, w, h, { tone: 'well', chamfer: 10 });
    const sound = this.host.kit.sound;
    const long = limit > NAME_MAX;

    this.put(
      iconSvg(icon, { size: 24, color: icon === 'driver' ? color.main : COLORS.white, accent: COLORS.ink900 }),
      f.c.x + 14,
      f.c.y + (h - 24) / 2,
    );
    const max = long ? w - 74 : w - 140;
    const t = this.text(value, f.c.x + 50, f.c.y + (h - 24) / 2 - 1, { s: 24, w: 600, i: true, max });
    const fit = (v: string): void => {
      t.style.fontSize = 24;
      t.text = v;
      // A track's name is long: it shrinks to fit the well, to 16 px at the least, before it's cut.
      if (long && t.width > max) t.style.fontSize = Math.max(16, Math.floor((24 * max) / t.width));
      fitText(t, max);
    };

    fit(value);
    const count = this.text(
      `${value.length} / ${limit}`,
      f.c.x + f.c.w - 14,
      long ? f.c.y + h + 10 : f.c.y + h / 2 - 7,
      { s: 13, c: COLORS.mist, a: 'r' },
    );
    const caret = new Sprite(Texture.WHITE);
    const ring = new FocusRing();
    let blink: ReturnType<Motion['to']> | null = null;
    let length = value.length;

    caret.tint = COLORS.cyan;
    caret.width = 3;
    caret.height = 30;
    caret.y = f.c.y + h / 2 - 15;
    caret.visible = false;
    this.target.addChild(caret, ring);
    const place = (): void => void (caret.x = t.x + t.width + 2);
    const showCaret = (on: boolean): void => {
      blink?.kill();
      blink = null;
      caret.visible = on;
      caret.alpha = 1;
      if (on) blink = this.motion.to(caret, { alpha: 0.15, duration: 0.5, repeat: -1, yoyo: true, ease: 'steps(1)' });
    };
    const field = new TextField({
      value,
      max: limit,
      clean: (raw) => raw.replace(/\s+/g, ' ').replace(/^\s/, ''),
      onChange: (v) => {
        fit(v);
        count.text = `${v.length} / ${limit}`;
        place();
        if (v.length !== length) sound.play('tick', v.length > length ? 1 + v.length * 0.025 : 0.8);
        length = v.length;
        if (v.length === limit) this.motion.punch(count.scale, 1.3, 0.4);
        onChange(v);
      },
      onEnter,
      onEscape: () => void this.back(),
      onNavigate: (input) => void this.navigate(input),
      onFocusChange: (on) => {
        if (!caret.destroyed) showCaret(on);
      },
    });
    const well = f.sprite;
    const item: Focusable = {
      node: well,
      get focusable(): boolean {
        if (well.destroyed) return false;
        for (let n: Container | null = well; n; n = n.parent) if (!n.visible) return false;

        return true;
      },
      setFocused: (on) => {
        if (!on) {
          ring.hide();
          field.blur();

          return;
        }
        sound.play('tick', 1.122);
        if (this.host.kit.keys) ring.show(inset(chamferRect(x, y, w, h, 10), -5));
        field.focus();
      },
      activate: () => field.focus(),
    };

    place();
    this.focus.add(item, isDefault);
    this.onDispose(() => {
      blink?.kill();
      field.destroy();
    });
    well.eventMode = 'static';
    well.cursor = 'text';
    well.label = 'name field';
    well.on('pointertap', () => field.focus());

    return { text: t, focus: () => field.focus(), blur: () => field.blur() };
  }

  /**
   * The licence-plate party code, its capitals sized to the white face under the chequer and centred in it, so the
   * room above and below them is even at any plate size; a narrow plate sizes them down to its width instead. Big
   * Shoulders' capitals sit a fiftieth of the size above the middle of their line box, hence the nudge down.
   */
  protected codePlate(x: number, y: number, w: number, h: number, state: CodePlateState, code: string): CodePlateView {
    const node = new Container();
    const prev = this.target;

    node.pivot.set(x + w / 2, y + h / 2);
    node.position.copyFrom(node.pivot);
    prev.addChild(node);
    this.into(node);
    const p = this.put(codePlateSvg(state, w, h), x, y);
    const tall = Math.round(p.c.h * 0.82);
    const spec = { f: 'b', w: 900, c: COLORS.ink900, flat: true } as const;
    const probe = makeText(code, 0, 0, { ...spec, s: tall, ls: tall * 0.16 }, this.L.textResolution);
    const s = Math.min(tall, Math.floor((tall * p.c.w) / probe.width));

    probe.destroy();
    const row = this.inbox(code, p.c, { ...spec, s, ls: s * 0.16, dy: s * 0.02 });

    this.into(prev);

    return { ...p, node, code: row.text!, setState: (s) => p.sprite.setArt(codePlateSvg(s, w, h)) };
  }

  /** Minus, the value in a well, plus; returns the value text. */
  protected stepper(
    x: number,
    y: number,
    value: number,
    h: number,
    onMinus: () => void,
    onPlus: () => void,
  ): { value: Text; minus: Button; plus: Button } {
    const minus = this.iconBtn('minus', x, y, h, 'secondary', onMinus);
    const bw = h + leanShift(h, 12);
    const vx = x + bw + 10;
    const v = this.panel(vx, y, h * 1.5, h, { tone: 'well', chamfer: 8 });
    const shown = this.text(String(value), v.c.x + v.c.w / 2, v.c.y + v.c.h / 2, {
      f: 'b',
      s: h * 0.66,
      w: 900,
      a: 'c',
    });
    const plus = this.iconBtn('plus', vx + h * 1.5 + 10, y, h, 'secondary', onPlus);

    // On its capitals' middle, so a new count punches in about the middle of the box too.
    shown.pivot.y = capMiddle(shown);

    return { value: shown, minus, plus };
  }

  /** A labelled switch row (Sound: on). */
  protected settingRow(x: number, y: number, w: number, label: string, on: () => boolean, toggle: () => void): Button {
    const icon = this.put(iconSvg(on() ? 'sound' : 'mute', { size: 22, accent: COLORS.cyan }), x, y + 5);

    this.text(label, x + 34, y + 7, { s: 18, w: 600 });
    const state = this.text(on() ? 'On' : 'Off', 0, y + 9, {
      s: 15,
      w: 600,
      c: on() ? COLORS.cyan : COLORS.mist,
      a: 'r',
    });
    const sw: Button = switchButton(this.host.kit, 30, on, () => {
      toggle();
      sw.refresh();
      icon.sprite.setArt(iconSvg(on() ? 'sound' : 'mute', { size: 22, accent: COLORS.cyan }));
      state.text = on() ? 'On' : 'Off';
      state.style.fill = on() ? COLORS.cyan : COLORS.mist;
      this.host.kit.sound.play(on() ? 'confirm' : 'back');
    });

    sw.placeFace(x + w - sw.faceBox.w - 6, y + 2);
    state.x = x + w - sw.faceBox.w - 18;

    return this.add(sw);
  }

  /**
   * A full screen's header: the back button in the top-left corner and the title beside it, its capitals centred on
   * the button, at one size and place on every screen. With no `onBack` the title takes the corner.
   * @param right - Room the title leaves at the right for the screen's own control.
   */
  protected header(title: string, onBack: (() => void) | null, right = 0): { back: Button | null; title: Text } {
    const { k, W, S } = this;
    const s = HEADER_TITLE[k];
    const back = onBack ? this.iconBtn('back', S.l, S.t, 44, 'secondary', onBack) : null;
    const x = onBack ? S.l + 44 + leanShift(44, 12) + 16 : S.l;
    // Big Shoulders' capitals centre 0.46 of the size under the line's top: this puts them on the button's middle.
    const t = this.text(title, x, S.t + Math.round(22 - 0.46 * s), { f: 'b', s, w: 900, max: W - S.r - right - x });

    return { back, title: t };
  }

  /**
   * A centred dialog sheet: dim, a panel with an accent bar, an icon, a title, body copy and its buttons. The panel
   * fits the copy however many lines it wraps to, so every sheet has the same room between its copy and its buttons.
   */
  protected sheetDialog(o: SheetOptions): Placed {
    const { k, W, H } = this;
    const pad = SHEET.pad;

    this.begin(true);
    this.dim(o.dim ?? 0.66);
    this.begin();
    const w = k === 'd' ? (o.w ?? 500) : k === 'p' ? W - 40 : (o.wl ?? 440);
    const bw = w - pad * 2;
    const bh = SHEET.button[k];
    const side = o.buttons.length === 2 && k !== 'p';
    const block = side ? bh : o.buttons.length * (bh + 10) - 10;
    // Drawn first so it can be measured; it moves over the panel once the panel is up.
    const body = this.body(o.body, 0, 0, bw);
    const h = SHEET.body[k] + Math.ceil(body.height) + 28 + block + pad;
    const x = (W - w) / 2;
    const y = (H - h) / 2 - (k === 'p' ? 20 : 0);
    const p = this.panel(x, y, w, h, { accent: o.accent });
    let tx = p.c.x + pad;

    if (o.icon) {
      this.heroIcon = this.centred(
        this.put(
          iconSvg(o.icon, { size: k === 'd' ? 40 : 34, color: COLORS.white, accent: o.accent }),
          p.c.x + 28,
          p.c.y + 30,
        ),
      );
      tx = p.c.x + (k === 'd' ? 84 : 76);
    }
    this.title(o.title, tx, p.c.y + SHEET.titleY, SHEET.title[k]);
    this.target.addChild(body);
    body.position.set(p.c.x + pad, p.c.y + SHEET.body[k]);
    let by = p.c.y + h - pad - block;

    if (side) {
      const half = (bw - 16) / 2;
      const [a, b] = o.buttons;

      this.button(b.label, p.c.x + pad, by, half, bh, b.variant, b.icon ?? null, b.onPress, b.isDefault);
      this.button(a.label, p.c.x + pad + 16 + half, by, half, bh, a.variant, a.icon ?? null, a.onPress, a.isDefault);
    } else {
      for (const b of o.buttons) {
        this.button(b.label, p.c.x + pad, by, bw, bh, b.variant, b.icon ?? null, b.onPress, b.isDefault);
        by += bh + 10;
      }
    }

    return p;
  }

  /**
   * Colyseus × PixiJS, with its foot at `bottom`: at the left or right margin, or across the middle.
   * @param size - Height of the PixiJS logo, the row's tallest, in px.
   * @param align - Which margin, or the middle.
   * @param bottom - Where its foot goes.
   * @param x - Left of the run it aligns in, the box's own left margin by default.
   * @param w - Width of that run, out to the right margin by default.
   */
  protected collab(
    size: number,
    align: 'left' | 'right' | 'centre',
    bottom: number,
    x = this.S.l,
    w = this.W - this.S.r - x,
  ): Placed {
    const art = collabSvg({ size });
    const f = art.face!;
    const left = align === 'left' ? x : align === 'right' ? x + w - f.w : x + (w - f.w) / 2;

    return this.put(art, left, bottom - f.h);
  }

  /**
   * The sheet of starting points for a new track (Night Run, Oval, Ring, Blank, Shuffle): each a picture that presses
   * its button too, then Close, and `extra` beside it on the left. A phone's two columns leave the last row a free
   * cell, and Close takes it.
   */
  protected startsSheet(o: StartsSheet): void {
    const { k, W, H, S } = this;
    const pad = SHEET.pad;
    const gap = 12;
    const cols = k === 'p' ? 2 : STARTS.length;
    // Landscape tiles narrow on a small box so the sheet stays inside the safe area.
    const cw =
      k === 'p'
        ? (W - 40 - pad * 2 - gap) / 2
        : k === 'l'
          ? Math.min(128, Math.floor((W - S.l - S.r - pad * 2 - (cols - 1) * gap) / cols))
          : 140;
    const ch = k === 'l' ? 56 : 88;
    const bh = 44;
    const cellH = ch + 8 + bh;
    const rowGap = 14;
    const rows = Math.ceil(STARTS.length / cols);
    const spare = cols * rows > STARTS.length;
    const footer = !spare || !!o.extra;
    const titleS = SHEET.title[k];
    const noteY = SHEET.titleY + titleS + 8;
    const gridY = noteY + 34;
    const w = cols * cw + (cols - 1) * gap + pad * 2;
    const h = gridY + rows * cellH + (rows - 1) * rowGap + (footer ? 18 + bh : 0) + pad;
    const x = (W - w) / 2;
    const y = Math.max(S.t, (H - h) / 2);
    const p = this.panel(x, y, w, h, { accent: COLORS.cyan });
    const cell = (i: number): Pt => ({
      x: p.c.x + pad + (i % cols) * (cw + gap),
      y: p.c.y + gridY + Math.floor(i / cols) * (cellH + rowGap),
    });

    // The panel takes its own taps.
    p.sprite.eventMode = 'static';
    this.title(o.title, p.c.x + pad, p.c.y + SHEET.titleY, titleS);
    this.text(o.note, p.c.x + pad, p.c.y + noteY, { s: 13, c: COLORS.mist, max: w - pad * 2 });
    STARTS.forEach(([label, start], i) => {
      const { x: cx, y: cy } = cell(i);
      const pic = this.panel(cx, cy, cw, ch, { tone: 'well', chamfer: 8 });

      if (start === 'shuffle') {
        const size = Math.min(ch - 16, 44);

        this.put(
          iconSvg('dice', { size, color: COLORS.cyan, accent: COLORS.ink900 }),
          cx + (cw - size) / 2,
          cy + (ch - size) / 2,
        );
      } else {
        const doc = template(start);

        if (doc.path.length > 0) this.put(planSvg(docPoints(doc, k === 'p'), doc.closed, cw, ch), cx, cy);
        else this.inbox('Empty board', { x: cx, y: cy, w: cw, h: ch }, { s: 13, c: COLORS.mist });
      }

      pic.sprite.eventMode = 'static';
      pic.sprite.cursor = 'pointer';
      pic.sprite.on('pointertap', () => o.pick(start));
      this.button(label, cx, cy + ch + 8, cw, bh, 'secondary', null, () => o.pick(start), i === o.focus);
    });

    const by = p.c.y + h - pad - bh;
    const free = cell(STARTS.length);

    if (o.extra)
      this.button(o.extra.label, p.c.x + pad, by, 168, bh, 'secondary', o.extra.icon ?? null, o.extra.onPress);
    if (spare) this.button('Close', free.x, free.y + ch + 8, cw, bh, 'secondary', 'close', o.close);
    else this.button('Close', p.c.x + w - pad - 136, by, 136, bh, 'secondary', 'close', o.close);
  }

  /**
   * A track's pit board, in the title's steel frame under its chequer: the track's plan in neon where there's room
   * (else a small one beside its name, so the board always shows which track it is), its name and a line under it,
   * then for a track that can be raced its length, lap and your best, and the actions at its foot.
   * @param card - The track.
   * @param r - The board's face.
   * @param o - The line under the name, and the actions.
   */
  protected trackBoard(card: TrackCard, r: Box, o: TrackBoard): void {
    const { k } = this;
    const c = this.put(specBoardSvg(r.w, r.h), r.x, r.y).c;
    const pad = k === 'd' ? 18 : 14;
    const x = c.x + pad;
    const w = c.w - pad * 2;
    const actionsY = c.y + c.h - pad - o.actionsH;
    const numbers = card.ready ? (k === 'd' ? 50 : 40) : 0;
    const nameS = k === 'd' ? 36 : k === 'p' ? 28 : 24;

    if (o.row) {
      const planW = Math.round(w * 0.42);
      const rx = x + planW + 20;
      const rw = x + w - rx;
      const plan = this.put(planSvg(planPoints(card), card.ready, planW, c.h - pad * 2), x, c.y + pad);

      plan.sprite.alpha = card.ready ? 1 : 0.85;
      this.text(card.name || 'Untitled', rx, c.y + pad, { f: 'b', s: nameS, w: 900, max: rw });
      this.text(o.sub, rx, c.y + pad + nameS + 8, { s: 13, w: 600, c: o.subColor ?? COLORS.mist, max: rw });
      if (card.ready) this._readouts(card, rx, actionsY - (o.actionsH ? 14 : 0) - numbers, rw, numbers);
      o.actions?.(rx, actionsY, rw);

      return;
    }
    const textH = nameS + 8 + 16;
    const factsFoot = actionsY - (o.actionsH ? (k === 'd' ? 22 : 14) : 0) - numbers;
    const nameFoot = factsFoot - (numbers ? 12 : 4) - textH;
    const planH = nameFoot - c.y - pad - 12;
    const small = planH < 56;
    // The room a small plan leaves is shared above and below the name and readouts, so they don't sink to the foot.
    const lift = small ? Math.max(0, Math.round((planH + 12) / 2)) : 0;
    const factsY = factsFoot - lift;
    const nameY = nameFoot - lift;
    const points = planPoints(card, k === 'p');
    const pw = small ? Math.round(textH * 1.7) : 0;
    const plan = small
      ? this.put(planSvg(points, card.ready, pw, textH), x + w - pw, nameY)
      : this.put(planSvg(points, card.ready, w, planH), x, c.y + pad);
    const nameW = small ? w - pw - 12 : w;

    plan.sprite.alpha = card.ready ? 1 : 0.85;
    this.text(card.name || 'Untitled', x, nameY, { f: 'b', s: nameS, w: 900, max: nameW });
    this.text(o.sub, x, nameY + nameS + 8, {
      s: k === 'l' ? 13 : 14,
      w: 600,
      c: o.subColor ?? COLORS.mist,
      max: nameW,
    });
    if (card.ready) this._readouts(card, x, factsY, w, numbers);
    o.actions?.(x, actionsY, w);
  }

  /** Length, lap and your best, as three readouts. */
  private _readouts(card: TrackCard, x: number, y: number, w: number, h: number): void {
    const items: [string, string][] = [
      [`${Math.round(card.lengthM)} m`, 'Length'],
      [`~${Math.round(card.lapSeconds)} s`, 'Lap'],
      [card.best > 0 ? clock(card.best) : 'None yet', 'Your best'],
    ];
    const cw = w / items.length;
    const vs = this.k === 'd' ? 28 : 22;
    const ls = this.k === 'd' ? 13 : 12;

    items.forEach(([value, label], i) => {
      const cx = x + i * cw + (i > 0 ? 14 : 0);

      if (i > 0) this.panel(x + i * cw, y + 2, 2, h - 4, { tone: 'well', chamfer: 0 });
      this.text(value, cx, y, {
        f: 'b',
        s: vs,
        w: 800,
        c: card.best > 0 || i < 2 ? COLORS.white : COLORS.mist,
        max: cw - 18,
      });
      this.text(label, cx, y + vs + 6, { s: ls, w: 600, c: COLORS.mist });
    });
  }

  /**
   * On a desktop, the mouse over `node` names it, and its keys as keycaps, in a tip just over it; touch shows none.
   * @param node - The control.
   * @param label - What it does.
   * @param keys - Its keys, each a keycap.
   */
  protected explain(node: Container, label: string, keys: readonly string[] = []): void {
    if (this.host.kit.touch) return;

    node.on('pointerover', (e) => {
      if (e.pointerType === 'mouse') this._showTip(node, label, keys);
    });
    node.on('pointerout', () => this._hideTip());
    this.onDispose(() => this._hideTip());
  }

  private _showTip(node: Container, label: string, keys: readonly string[]): void {
    this._hideTip();

    const res = this.L.textResolution;
    const tip = new Container();
    const words = makeText(label, 12, 8, { s: 14, w: 600, flat: true }, res);
    const caps = new Graphics();
    let x = 12 + words.width + 10;

    tip.addChild(caps, words);

    for (const key of keys) {
      const t = makeText(key, x + 7, 9, { s: 12, w: 700, c: COLORS.cyan, flat: true }, res);

      caps.roundRect(x, 6, t.width + 14, 20, 4).stroke({ color: COLORS.line, width: 1.5 });
      tip.addChild(t);
      x += t.width + 14 + 6;
    }

    const w = (keys.length ? x - 6 : x - 10) + 12;
    const back = new Graphics()
      .roundRect(0, 0, w, 32, 6)
      .fill({ color: COLORS.ink900, alpha: 0.95 })
      .stroke({ color: COLORS.line, width: 1.5 });
    const b = node.getBounds();
    const at = this.root.toLocal({ x: b.x + b.width / 2, y: b.y });

    tip.addChildAt(back, 0);
    tip.position.set(Math.min(this.W - this.S.r - w, Math.max(this.S.l, at.x - w / 2)), Math.max(4, at.y - 36));
    tip.eventMode = 'none';
    tip.label = 'tip';
    this.root.addChild(tip);
    this._tip = tip;
  }

  private _hideTip(): void {
    this._tip?.destroy({ children: true });
    this._tip = null;
  }

  /** Moves a placed sprite's anchor to its middle without moving it, so it scales and turns about its centre. */
  protected centred(placed: Placed & { sprite: ArtSprite }): ArtSprite {
    const s = placed.sprite;

    s.anchor.set(0.5);
    s.position.set(placed.x + placed.w / 2, placed.y + placed.h / 2);

    return s;
  }

  /** Moves a text's anchor to its vertical middle without moving it, so a punch grows it about its line. */
  protected middled(t: Text): Text {
    t.y += (0.5 - t.anchor.y) * t.height;
    t.anchor.y = 0.5;

    return t;
  }

  /** The hero icon lands: it punches in from 1.6x as the panel seats. */
  protected punchHero(delay = 0.1): void {
    const icon = this.heroIcon;

    if (!icon) return;
    if (this.motion.reduced) return;
    icon.scale.set(0);
    this.motion.delay(delay, () => {
      if (!icon.destroyed) this.motion.punch(icon.scale, 1.6);
    });
  }

  /** Punches a text or sprite in from oversize about its centre. */
  protected punchIn(node: { scale: { x: number; y: number } }, from = 1.4): void {
    this.motion.punch(node.scale, from, MOTION.punch.duration);
  }
}
