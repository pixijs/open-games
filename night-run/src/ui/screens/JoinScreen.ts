import type { Text } from 'pixi.js';
import { CanvasTextMetrics, Container, TextStyle } from 'pixi.js';

import type { CodeCellState } from '../art/buttons';
import { codeCellSvg } from '../art/buttons';
import { toastSvg } from '../art/panels';
import type { SvgArt } from '../art/svg';
import { COLORS, MOTION } from '../art/tokens';
import type { JoinError, NavInput, Screen } from '../contract';
import type { ArtSprite } from '../kit/ArtSprite';
import type { Button } from '../kit/Button';
import { keyButton } from '../kit/buttons';
import type { TextSpec } from '../kit/text';
import { capMiddle, makeText, textStyle } from '../kit/text';
import { TextField } from '../kit/TextField';
import { MenuScreen } from './MenuScreen';
import { centrePivot } from './ScreenView';

type JoinData = Extract<Screen, { id: 'join' }>;
type Shown = JoinError | 'typedBad';

/** The 24 letters a party code uses: A to Z without I and O. */
export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;

interface Cell {
  readonly sprite: ArtSprite;
  readonly char: Text;
  readonly size: number;
}

/** An error plate sized to its text: the plate's art, and the error's two text styles wrapped to its text column. */
interface ErrorFit {
  readonly art: SvgArt;
  readonly head: TextSpec;
  readonly sub: TextSpec;
  /** How far the title and the body sit below the plate's top */
  readonly headY: number;
  readonly subY: number;
  readonly copy: readonly [string, string];
}

/** How many lines `str` wraps to in `st` at `wrap` px. */
function lineCount(str: string, st: TextSpec, wrap: number): number {
  return CanvasTextMetrics.measureText(str, new TextStyle(textStyle({ ...st, wrap }))).lines.length;
}

/** An error with the connection, not the code: it shows amber and leaves the cells as typed. */
function isWarning(error: Shown | null): boolean {
  return error === 'unreachable' || error === 'version';
}

/** What each error says (title, then what to do). */
function errorCopy(error: Shown, code: string, wide: boolean): readonly [string, string] {
  switch (error) {
    case 'notFound':
      return [`No party has the code ${code}.`, 'Check it with your host. A code works while their tab is open.'];
    case 'full':
      return ['That party is full.', '8 people are already in it.'];
    case 'malformed':
    case 'typedBad':
      return ['Codes are five letters.', 'No numbers, and no I or O.'];
    case 'unreachable':
      return [
        "Can't reach that party.",
        wide
          ? `Party ${code} is open, but your connection to the host didn't get through. Some school and office networks block it.`
          : `Party ${code} is open, but the connection didn't get through. Some networks block it.`,
      ];
    case 'version':
      return [
        'Another version of Night Run.',
        wide
          ? "Reload this page and join again. If that doesn't do it, ask your host to reload theirs."
          : 'Reload this page and join again, or ask your host to reload.',
      ];
  }
}

/**
 * Typing a party code: five cells, typed on the real keyboard on desktop (letters, Backspace, paste) and on a 6 by 4
 * keypad on phones. A letter punches into its cell; a bad character, an unknown code, a full party or an unreachable
 * host swaps the cells to their error look, shakes the row twice and slots the error plate in.
 */
export class JoinScreen extends MenuScreen<JoinData> {
  private _code = '';
  private _error: Shown | null = null;
  private _busy = false;
  private _cells: Cell[] = [];
  private _row: Container | null = null;
  private _errorGroup: Container | null = null;
  private _join: Button | null = null;
  private _joinKey: Button | null = null;
  /** The keypad's keys by what they type ('A', 'Backspace'), so the keyboard can light the one it typed */
  private _keys = new Map<string, Button>();
  private _field: TextField | null = null;
  private _sheet: Container | null = null;
  /** The desktop sheet's height, so a rebuild that grows it can ease the difference */
  private _sheetH = 0;

  public override mount(): void {
    this._code = this.data.code.toUpperCase().slice(0, CODE_LENGTH);
    this._error = this.data.error;
    super.mount();
  }

  public override update(data: JoinData): void {
    const fresh = data.error !== null && (data.error !== this._error || data.code !== this._code);
    const grew = !this._error && !!data.error;

    this.data = data;
    this._code = data.code.toUpperCase().slice(0, CODE_LENGTH);
    this._error = data.error;
    this._busy = data.busy;
    const sheetH = this._sheetH;

    this.rebuild();
    if (fresh) this._errorJuice();
    if (grew) this._settle(sheetH);
  }

  protected override entered(): void {
    if (this._error) this._errorJuice();
  }

  protected override build(): void {
    const { k, W, H, S } = this;
    const err = this._error ? errorCopy(this._error, this._code, k === 'd') : null;
    const retry = this._error === 'unreachable';
    const goLabel = this._busy ? 'Joining…' : retry ? 'Try again' : 'Join party';
    const back = (): void => void this.back();
    const go = (): void => this._go();

    this._cells = [];
    this._join = null;
    this._joinKey = null;
    this._keys = new Map();
    this._row = null;
    this._errorGroup = null;
    this._field = null;
    this._sheet = null;
    if (k === 'd') {
      this.begin(true);
      this.scrim('center', 0.8, 0.7);
      this._sheet = this.begin();
      const w = 560;
      const cw = 76;
      const fit = err ? this._errorFit(w - 56, err) : null;
      const plateY = 136 + Math.round(cw * 1.25) + 32;
      const goY = plateY + (fit ? fit.art.content!.h + 32 : 0);
      const h = goY + 60 + 24;
      const x = (W - w) / 2;
      const y = (H - h) / 2;
      const accent = err ? (isWarning(this._error) ? COLORS.amber : COLORS.danger) : COLORS.cyan;
      const p = this.panel(x, y, w, h, { accent });

      this.iconBtn('back', p.c.x + 22, p.c.y + 24, 40, 'secondary', back);
      this.title('Join a party', p.c.x + 84, p.c.y + 24, 40);
      this.text('Type the 5-letter code your host sees on their screen.', p.c.x + 30, p.c.y + 92, {
        s: 16,
        c: COLORS.mist,
      });
      this._drawCells(p.c.x + (w - cw * 5 - 18 * 4) / 2, p.c.y + 136, cw, 18);
      if (fit) this._errorPlate(p.c.x + 28, p.c.y + plateY, fit);
      this._sheetH = h;
      this._join = this.button(
        goLabel,
        p.c.x + 30,
        p.c.y + goY,
        w - 60,
        60,
        'primary',
        retry ? 'rematch' : 'forward',
        go,
        true,
      );
      this._field = new TextField({
        value: this._code,
        max: CODE_LENGTH,
        capitalize: 'characters',
        clean: (raw) => raw.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        onChange: (v) => this._setCode(v),
        onEnter: go,
        onEscape: () => void this.back(),
        // Up or Down hands the keys to the buttons; letters still type through the window.
        onNavigate: (input) => {
          this._field?.blur();
          this.navigate(input);
        },
      });
      const field = this._field;

      this.onDispose(() => field.destroy());
      for (const c of this._cells) {
        c.sprite.eventMode = 'static';
        c.sprite.cursor = 'text';
        c.sprite.on('pointertap', () => field.focus());
      }
    } else if (k === 'p') {
      this.begin(true);
      this.dim(0.5);
      this.scrim('bottom', 0.95, 0.75);
      this.begin();
      this.iconBtn('back', S.l, S.t, 40, 'secondary', back);
      this.title('Join a party', S.l + 66, S.t + 4, 32);
      this.text('Type the code from your host.', S.l, S.t + 62, { s: 15, c: COLORS.mist });
      this.begin();
      const cw = 56;

      this._drawCells(S.l, S.t + 98, cw, (W - S.l - S.r - cw * 5) / 4);
      const eh = err ? this._errorPlate(S.l, S.t + 206, this._errorFit(W - S.l - S.r, err)) : 0;

      if (retry) {
        this.into(this._errorGroup!);
        this._join = this.button(
          'Try again',
          S.l,
          S.t + 206 + eh + 16,
          W - S.l - S.r,
          56,
          'primary',
          'rematch',
          go,
          true,
        );
      }
      this.begin();
      this._keypad(S.l, H - S.b - 5 * 52 - 4 * 8, W - S.l - S.r, 52, 8);
    } else {
      this.begin(true);
      this.dim(0.45);
      this.scrim('left', 0.9, 0.8);
      this.begin();
      this.iconBtn('back', S.l, S.t, 36, 'secondary', back);
      this.title('Join a party', S.l + 58, S.t + 3, 28);
      this.text('Type the code from your host.', S.l, S.t + 54, { s: 14, c: COLORS.mist });
      // The keypad takes the right, the cells and the error the left column; both narrow on a 16:9 or notched phone,
      // where the column keeps 332 px: the error plate's icon cell grows with its height and needs that room beside it.
      const kw = Math.min(390, W - S.l - S.r - 360);
      const col = Math.min(360, W - S.r - kw - 28 - S.l);

      this.begin();
      const cw = Math.min(56, (col - 48) / 5);

      this._drawCells(S.l, S.t + 84, cw, (col - cw * 5) / 4);
      const eh = err ? this._errorPlate(S.l, S.t + 180, this._errorFit(col, err)) : 0;

      if (retry) {
        this.into(this._errorGroup!);
        this._join = this.button('Try again', S.l, S.t + 180 + eh + 10, col, 46, 'primary', 'rematch', go, true);
      }
      this.begin();
      // The keys grow to span the safe height, level with the back button at the top and on the bottom margin as in
      // portrait, so a taller box gives bigger keys instead of an empty band under them.
      this._keypad(W - S.r - kw, S.t, kw, (H - S.t - S.b - 4 * 8) / 5, 8);
    }
    this._syncGo();
    if (k === 'd' && !this.host.kit.touch) this.motion.delay(0, () => this._field?.focus());
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text') ?? '';

      if (!text || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      this._setCode(
        text
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, CODE_LENGTH),
      );
    };

    window.addEventListener('paste', onPaste);
    this.onDispose(() => window.removeEventListener('paste', onPaste));
  }

  /** A key typed on the keyboard: it types, and on a phone layout its keypad key sinks as if tapped. */
  public override key(key: string): boolean {
    const used = this._type(key);

    if (used) this._keys.get(key === 'Backspace' ? key : key.toUpperCase())?.pulse();

    return used;
  }

  /** Enter or A presses what keys focus, or joins when they focus nothing (or a key that can't be pressed now). */
  public override navigate(input: NavInput): boolean {
    if (input === 'confirm' && !this.focus.current?.focusable) {
      this._go();

      return true;
    }

    return super.navigate(input);
  }

  private _type(key: string): boolean {
    if (key === 'Backspace') {
      this._setCode(this._code.slice(0, -1));

      return true;
    }
    if (!/^[a-zA-Z0-9]$/.test(key) || this._code.length >= CODE_LENGTH) return false;
    this._setCode(this._code + key.toUpperCase());

    return true;
  }

  /** Phones: above the keypad (portrait), or at the left column's foot (landscape). */
  public override toastBottom(): number | null {
    const { k, H, S } = this;

    return k === 'p' ? H - S.b - 304 : k === 'l' ? H - S.b - 8 : null;
  }

  public override back(): boolean {
    this.host.kit.sound.play('back');
    if (!this.host.backLocal()) this.host.showLocal(this.host.titleScreen(), true);

    return true;
  }

  private _drawCells(x: number, y: number, cw: number, gap: number): void {
    const row = new Container();

    this.target.addChild(row);
    this._row = row;
    const states = this._cellStates();

    const prev = this.target;

    for (let i = 0; i < CODE_LENGTH; i++) {
      this.into(row);
      const p = this.put(codeCellSvg(states[i], cw), x + i * (cw + gap), y);
      const char = makeText(
        this._code[i] ?? '',
        p.c.x + p.c.w / 2,
        p.c.y + p.c.h / 2,
        { f: 'b', s: cw * 0.78, w: 900, a: 'c' },
        this.L.textResolution,
      );

      char.pivot.y = capMiddle(char);
      char.style.fill = states[i] === 'error' ? '#ffb3c1' : COLORS.white;
      row.addChild(char);
      this._cells.push({ sprite: p.sprite, char, size: cw });
    }
    this.into(prev);
  }

  private _cellStates(): CodeCellState[] {
    const out: CodeCellState[] = [];
    const e = this._error;

    for (let i = 0; i < CODE_LENGTH; i++) {
      const ch = this._code[i];

      if (e === 'notFound' || e === 'full') out.push('error');
      else if (isWarning(e)) out.push('filled');
      else if ((e === 'malformed' || e === 'typedBad') && ch && !CODE_LETTERS.includes(ch)) out.push('error');
      else if (i < this._code.length) out.push('filled');
      else if (i === this._code.length) out.push('active');
      else out.push('empty');
    }

    return out;
  }

  /**
   * The error plate for a `w` wide slot, as tall as its title and body need when both wrap to its text column. The
   * plate's icon cell and slant widen as it grows taller, narrowing that column, so the text rewraps at each height until
   * the plate holds it.
   */
  private _errorFit(w: number, err: readonly [string, string]): ErrorFit {
    const small = this.k !== 'd';
    const tone = isWarning(this._error) ? 'warn' : 'error';
    const headSize = this.k === 'd' ? 17 : this.k === 'p' ? 15 : 14;
    const subSize = small ? 12 : 14;
    const headY = small ? 12 : 14;
    const gap = small ? 5 : 6;
    const bottom = small ? 16 : 17;
    let h = Math.ceil(headY + headSize * 1.15 + gap + subSize * 1.3 + bottom);

    for (;;) {
      const art = toastSvg(tone, { width: w, height: h });
      const wrap = art.content!.w - 12;
      const head: TextSpec = { s: headSize, w: 700, lh: 1.15, wrap };
      const sub: TextSpec = { s: subSize, c: COLORS.mist, lh: 1.3, wrap };
      const subY = headY + lineCount(err[0], head, wrap) * headSize * 1.15 + gap;
      const need = Math.ceil(subY + lineCount(err[1], sub, wrap) * subSize * 1.3 + bottom);

      if (need <= h) return { art, head, sub, headY, subY, copy: err };
      h = need;
    }
  }

  /** The error plate with the error and what to do, slotted in as one group; returns its height. */
  private _errorPlate(x: number, y: number, fit: ErrorFit): number {
    const prev = this.target;
    const group = new Container();

    this.target.addChild(group);
    this._errorGroup = group;
    this.into(group);
    const p = this.put(fit.art, x, y);

    this.text(fit.copy[0], p.c.x, p.c.y + fit.headY, fit.head);
    this.text(fit.copy[1], p.c.x, p.c.y + fit.subY, fit.sub);
    this.into(prev);

    return p.c.h;
  }

  private _keypad(x: number, y: number, w: number, kh: number, gap: number): void {
    const kw = (w - gap * 5) / 6;
    // Labels scale with a key's shorter side, so a tall key on a narrow keypad keeps "Paste" inside its key.
    const face = Math.min(kw, kh);
    const kit = this.host.kit;

    for (let i = 0; i < CODE_LETTERS.length; i++) {
      const letter = CODE_LETTERS[i];
      const key = keyButton(kit, kw, kh, 'char', { label: letter, size: face * 0.5, board: true }, () =>
        this._type(letter),
      );

      key.placeFace(x + (i % 6) * (kw + gap), y + Math.floor(i / 6) * (kh + gap));
      this.add(key, i === 0 && !this._join);
      this._keys.set(letter, key);
    }
    const ry = y + 4 * (kh + gap);
    const wide = kw * 1.5 + gap * 0.5;
    const del = keyButton(kit, wide, kh, 'action', { icon: 'backspace', size: face * 0.48 }, () =>
      this._type('Backspace'),
    );
    const paste = keyButton(kit, wide, kh, 'action', { label: 'Paste', size: face * 0.34 }, () => this._paste());
    const jw = w - (kw * 3 + gap * 3);
    const join = keyButton(kit, jw, kh, 'go', { label: 'Join', size: face * 0.38 }, () => this._go());

    this.add(del.placeFace(x, ry));
    this.add(paste.placeFace(x + wide + gap, ry));
    this.add(join.placeFace(x + kw * 3 + gap * 3, ry));
    this._joinKey = join;
    this._keys.set('Backspace', del);
  }

  private _paste(): void {
    const clip = navigator.clipboard;

    if (!clip?.readText) return;
    clip.readText().then(
      (text) =>
        this._setCode(
          text
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, CODE_LENGTH),
        ),
      () => this.host.toast({ kind: 'notice', text: 'Paste is blocked here. Type the code instead.' }),
    );
  }

  /** The typed code changed: cells and chars swap in place, a new letter punches in, a bad one errors. */
  private _setCode(next: string): void {
    if (next === this._code || this._busy) return;
    const grew = next.length > this._code.length;
    const hadError = this._error;
    this._code = next;
    const bad = this._badChars();

    if (this._field && this._field.value !== next) this._field.value = next;
    this._error = bad ? 'typedBad' : null;
    if (hadError !== this._error && (hadError || this._error)) {
      const fresh = this._error && !hadError;
      const sheetH = this._sheetH;

      this.rebuild();
      if (fresh) {
        this._errorJuice();
        this._settle(sheetH);
      } else this.host.kit.sound.play(grew ? 'tick' : 'back');

      return;
    }
    const states = this._cellStates();

    this._cells.forEach((cell, i) => {
      cell.sprite.setArt(codeCellSvg(states[i], cell.size));
      cell.char.text = next[i] ?? '';
      cell.char.style.fill = states[i] === 'error' ? '#ffb3c1' : COLORS.white;
    });
    if (grew) {
      const cell = this._cells[next.length - 1];

      if (cell) this.motion.punch(cell.char.scale, 1.5, 0.45);
      this.host.kit.sound.play('tick', 1.2);
    } else this.host.kit.sound.play('tick', 0.8);
    this._syncGo();
    if (grew && next.length === CODE_LENGTH) this._ready();
  }

  /** The code is whole: the cells jump once left to right, Join glints, and keys move to it so Enter joins. */
  private _ready(): void {
    const go = this._joinKey ?? this._join;

    if (!go || go.disabled) return;
    this._cells.forEach((cell, i) => {
      if (this.motion.reduced) return;
      this.motion.fromTo(
        cell.char,
        { y: cell.char.y - 7 },
        { y: cell.char.y, duration: 0.3, ease: 'back.out(3)', delay: 0.12 + i * 0.04 },
      );
    });
    this.motion.delay(0.3, () => {
      if (!go.destroyed) go.sweep();
    });
    this.host.kit.sound.play('pluck', 1.5);
    if (this.host.kit.keys) this.focus.focus(go);
  }

  /**
   * Whether joining can go now: a whole code with no error on it, or a retry after the host was unreachable. A code
   * that was not found or full stays refused until it is edited, on the keypad's Join key and Enter as on the button.
   */
  private _canGo(): boolean {
    if (this._busy) return false;
    const valid = this._code.length === CODE_LENGTH && !this._badChars();

    return (valid && !this._error) || this._error === 'unreachable';
  }

  private _syncGo(): void {
    const can = this._canGo();

    this._join?.setDisabled(!can);
    this._joinKey?.setDisabled(!can);
  }

  private _badChars(): boolean {
    return this._code.split('').some((ch) => !CODE_LETTERS.includes(ch));
  }

  /** Cells shake 6 px left and right twice, the error plate slots in, the buzzer sounds. */
  private _errorJuice(): void {
    this.host.kit.sound.play('error');
    if (this._row) this.motion.shake(this._row, 6, 0.3, 2);
    const g = this._errorGroup;

    if (!g || this.motion.reduced) return;
    centrePivot(g);
    this.motion.fromTo(g, { y: g.y - 14, alpha: 0 }, { y: g.y, alpha: 1, ...MOTION.slot, delay: 0.06 });
    this.motion.fromTo(g.scale, { x: 0.96, y: 0.96 }, { x: 1, y: 1, ...MOTION.slot, delay: 0.06 });
  }

  /** The desktop sheet grew taller from `fromH` for the error plate: it eases up into place instead of jumping. */
  private _settle(fromH: number): void {
    const sheet = this._sheet;
    const dy = (this._sheetH - fromH) / 2;

    if (this.k !== 'd' || !sheet || this.motion.reduced || dy <= 0) return;
    this.motion.fromTo(sheet, { y: sheet.y + dy }, { y: sheet.y, ...MOTION.slot });
  }

  private _go(): void {
    if (this._busy) return;
    if (!this._canGo()) {
      if (this._code.length < CODE_LENGTH && this._row) {
        this.host.kit.sound.play('error');
        this.motion.shake(this._row, 4, 0.2, 1);
      }

      return;
    }
    this._busy = true;
    this._error = null;
    this.host.kit.sound.play('confirm');
    this.rebuild();
    this.host.join(this._code);
  }
}
