import { Container, Sprite } from 'pixi.js';

import type { GlyphFont } from './GlyphFont';
import { COLON, DOT, MINUS, PLUS, SLASH } from './GlyphFont';

type ReadoutAlign = 'left' | 'center' | 'right';

/**
 * A number readout drawn from a {@link GlyphFont}'s glyph textures: one sprite per character, digits in fixed cells.
 * The format methods write character indices into a typed array and only touch sprites when a character changes, so
 * a readout updated every frame allocates nothing. Placed like CSS text with `line-height: 1`: `y` is the top of a
 * box as tall as the font size.
 */
export class DigitReadout extends Container {
  public align: ReadoutAlign = 'left';
  private _font: GlyphFont | null = null;
  private _size = 24;
  private _width = 0;
  private readonly _sprites: Sprite[] = [];
  private readonly _codes: Uint8Array;
  private readonly _shown: Uint8Array;
  private _count = 0;
  private _shownCount = -1;

  /** @param capacity - The most characters it shows. */
  constructor(capacity: number) {
    super();
    this._codes = new Uint8Array(capacity);
    this._shown = new Uint8Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const s = new Sprite();

      s.visible = false;
      this._sprites.push(s);
      this.addChild(s);
    }
  }

  /** Width of what it shows, in its own px */
  public get textWidth(): number {
    return this._width;
  }

  /** Font size in px */
  public get size(): number {
    return this._size;
  }

  /** Sets the font and size; redraws */
  public setFont(font: GlyphFont, size: number): void {
    this._font = font;
    this._size = size;
    this._shownCount = -1;
    this._flush();
  }

  /** `m:ss.cc` */
  public showTime(ms: number): void {
    this._count = 0;
    this._time(Math.max(0, ms));
    this._flush();
  }

  /** `-:--.--`, a time not set yet */
  public showNoTime(): void {
    this._count = 0;
    this._push(MINUS);
    this._push(COLON);
    this._push(MINUS);
    this._push(MINUS);
    this._push(DOT);
    this._push(MINUS);
    this._push(MINUS);
    this._flush();
  }

  /** A whole number */
  public showInt(value: number): void {
    this._count = 0;
    this._int(Math.max(0, Math.round(value)));
    this._flush();
  }

  /** `a/b` */
  public showFraction(a: number, b: number): void {
    this._count = 0;
    this._int(a);
    this._push(SLASH);
    this._int(b);
    this._flush();
  }

  /** A signed time difference: `+0.84`, `-0.42`, `+1:02.31` */
  public showDelta(ms: number): void {
    this._count = 0;
    this._push(ms < 0 ? MINUS : PLUS);
    const abs = Math.abs(ms);

    if (abs >= 60000) this._time(abs);
    else this._seconds(abs);
    this._flush();
  }

  private _time(ms: number): void {
    const total = Math.floor(ms / 10);
    const minutes = Math.floor(total / 6000);

    this._int(minutes);
    this._push(COLON);
    const seconds = Math.floor(total / 100) % 60;

    this._push(Math.floor(seconds / 10));
    this._push(seconds % 10);
    this._push(DOT);
    const cs = total % 100;

    this._push(Math.floor(cs / 10));
    this._push(cs % 10);
  }

  private _seconds(ms: number): void {
    const total = Math.floor(ms / 10);

    this._int(Math.floor(total / 100));
    this._push(DOT);
    const cs = total % 100;

    this._push(Math.floor(cs / 10));
    this._push(cs % 10);
  }

  private _int(value: number): void {
    let div = 1;

    while (div * 10 <= value) div *= 10;
    for (; div >= 1; div /= 10) this._push(Math.floor(value / div) % 10);
  }

  private _push(code: number): void {
    if (this._count < this._codes.length) this._codes[this._count++] = code;
  }

  private _flush(): void {
    const font = this._font;

    if (!font) return;
    if (this._count === this._shownCount) {
      let same = true;

      for (let i = 0; i < this._count; i++) {
        if (this._codes[i] !== this._shown[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    const k = this._size;
    let width = 0;

    for (let i = 0; i < this._count; i++) {
      const code = this._codes[i];

      width += (code < 10 ? font.cell : font.advances[code]) * k;
    }
    let x = this.align === 'left' ? 0 : this.align === 'right' ? -width : -width / 2;
    const y = font.offsetY * k + (k * (1 - font.lineBox)) / 2;
    const scale = k * font.unit;

    for (let i = 0; i < this._sprites.length; i++) {
      const s = this._sprites[i];

      if (i >= this._count) {
        s.visible = false;
        continue;
      }
      const code = this._codes[i];
      const advance = (code < 10 ? font.cell : font.advances[code]) * k;
      const centre = code < 10 ? (advance - font.advances[code] * k) / 2 : 0;

      s.texture = font.textures[code];
      s.scale.set(scale);
      s.position.set(x + centre + font.offsetX * k, y);
      s.visible = true;
      this._shown[i] = code;
      x += advance;
    }
    this._shownCount = this._count;
    this._width = width;
  }
}
