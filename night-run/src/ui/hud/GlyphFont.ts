import { ImageSource, Rectangle, Texture } from 'pixi.js';

import { FONTS } from '../art/tokens';

/** The characters HUD readouts use; a readout stores each as its index here */
export const GLYPHS = '0123456789:.+-/';
export const COLON = 10;
export const DOT = 11;
export const PLUS = 12;
export const MINUS = 13;
export const SLASH = 14;

const COLUMNS = 8;
const PAD = 6;

/**
 * One weight of Big Shoulders holding only {@link GLYPHS}, drawn once into a small canvas, white with the ink drop
 * shadow baked in so readouts tint it. A whole font is one texture of about 750 x 330 device px, and mipmapped, so
 * one size serves every readout. Metrics are for a font size of 1: multiply by the size a readout draws at.
 */
export class GlyphFont {
  /** Device px per CSS px the glyphs were drawn at */
  public readonly density: number = 1;
  /** Glyph texture per character index */
  public readonly textures: Texture[] = [];
  /** Advance per character index */
  public readonly advances = new Float32Array(GLYPHS.length);
  /** Every digit sits in a cell this wide, so readouts never jitter */
  public readonly cell: number = 0;
  public readonly offsetX: number = 0;
  public readonly offsetY: number = 0;
  /** The font's line box (ascent plus descent) as a share of its size */
  public readonly lineBox: number = 1;
  /** Sprite scale per px of font size */
  public readonly unit: number = 1;
  private readonly _source: ImageSource;
  private readonly _canvas: HTMLCanvasElement;

  /**
   * @param weight - 700 for small readouts, 900 for the big ones.
   * @param density - Device px per CSS px to draw the glyphs at.
   */
  constructor(weight: '700' | '900', density: number) {
    this.density = density;
    const size = weight === '900' ? 56 : 32;
    const font = `${weight} ${size}px ${FONTS.board}`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) throw new Error('GlyphFont: no 2D canvas context');
    ctx.font = font;
    const metrics = ctx.measureText('0');
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    let widest = 0;
    let digit = 0;

    for (let i = 0; i < GLYPHS.length; i++) {
      const w = ctx.measureText(GLYPHS[i]).width;

      this.advances[i] = w / size;
      widest = Math.max(widest, w);
      if (i < 10) digit = Math.max(digit, w);
    }
    const cellW = Math.ceil(widest) + PAD * 2;
    const cellH = Math.ceil(ascent + descent) + PAD * 2;
    const rows = Math.ceil(GLYPHS.length / COLUMNS);

    canvas.width = Math.ceil(COLUMNS * cellW * density);
    canvas.height = Math.ceil(rows * cellH * density);
    ctx.scale(density, density);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(6, 9, 32, 0.65)';
    ctx.shadowBlur = 4 * density;
    ctx.shadowOffsetY = 2 * density;
    for (let i = 0; i < GLYPHS.length; i++) {
      ctx.fillText(GLYPHS[i], (i % COLUMNS) * cellW + PAD, Math.floor(i / COLUMNS) * cellH + PAD + ascent);
    }
    this._canvas = canvas;
    this._source = new ImageSource({
      resource: canvas,
      resolution: density,
      autoGenerateMipmaps: true,
      alphaMode: 'premultiply-alpha-on-upload',
    });
    for (let i = 0; i < GLYPHS.length; i++) {
      const frame = new Rectangle((i % COLUMNS) * cellW, Math.floor(i / COLUMNS) * cellH, cellW, cellH);

      this.textures.push(new Texture({ source: this._source, frame }));
    }
    this.cell = digit / size;
    this.unit = 1 / size;
    this.offsetX = -PAD / size;
    this.offsetY = -PAD / size;
    this.lineBox = (ascent + descent) / size;
  }

  /** Frees the glyph texture and its canvas; the source is unloaded, not destroyed, as `SvgTextures` frees its own */
  public destroy(): void {
    for (const t of this.textures) t.destroy(false);
    this.textures.length = 0;
    this._source.unload();
    this._canvas.width = 0;
    this._canvas.height = 0;
  }
}
