import type { TextStyleFontWeight, TextStyleOptions } from 'pixi.js';
import { CanvasTextMetrics, fontStringFromTextStyle, Text, TextStyle } from 'pixi.js';

import { COLORS, FONTS } from '../art/tokens';

/**
 * A text style in short: `f` board (Big Shoulders) or driver (Kanit), `s` size, `w` weight, `i`
 * italic, `c` colour, `a` align, `ls` tracking, `flat` (no shadow: text on a bright plate), `glow` (a soft ink halo in
 * place of the drop shadow: helper copy over a bright scene), `wrap` width, `lh` line height multiplier, `max` width to
 * fit a name into (shrink to 85 % but not under 12 px, then ellipsis), `op` alpha.
 */
export interface TextSpec {
  readonly f?: 'b' | 'd';
  readonly s?: number;
  readonly w?: number;
  readonly i?: boolean;
  readonly c?: string;
  readonly a?: 'l' | 'c' | 'r';
  readonly ls?: number;
  readonly flat?: boolean;
  readonly glow?: boolean;
  readonly wrap?: number;
  readonly lh?: number;
  readonly max?: number;
  readonly op?: number;
}

/** White at 80 %, for labels over the scene. */
export const WHITE80 = 'rgba(244,247,255,0.8)';

const SHADOW = { color: 0x060920, alpha: 0.65, blur: 4, distance: 2, angle: Math.PI / 2 } as const;
const GLOW = { color: 0x060920, alpha: 0.9, blur: 9, distance: 1, angle: Math.PI / 2 } as const;

/** The pixi style for a spec. Single lines get `lineHeight = size` so `y` is the top of the glyph box, as in CSS. */
export function textStyle(st: TextSpec): TextStyleOptions {
  const size = st.s ?? 16;
  const weight = st.w ?? (st.f === 'b' ? 800 : 500);

  return {
    fontFamily: st.f === 'b' ? FONTS.board : FONTS.driver,
    fontSize: size,
    fontWeight: String(weight) as TextStyleFontWeight,
    fontStyle: st.i ? 'italic' : 'normal',
    fill: st.c ?? COLORS.white,
    letterSpacing: st.ls ?? 0,
    lineHeight: size * (st.lh ?? 1),
    align: st.a === 'c' ? 'center' : st.a === 'r' ? 'right' : 'left',
    wordWrap: st.wrap !== undefined,
    wordWrapWidth: st.wrap ?? 100,
    dropShadow: st.flat ? false : st.glow ? GLOW : SHADOW,
    padding: st.glow ? 10 : st.i ? Math.ceil(size * 0.12) : 2,
  };
}

const shifts = new Map<string, number>();

/** Forgets measured baselines, after the web fonts arrive. */
export function clearBaselines(): void {
  shifts.clear();
}

/**
 * How far pixi draws a line below where CSS would: pixi puts the baseline at the glyphs' ink ascent (centring that box
 * only when the line is taller than it), CSS centres the font's own ascent and descent. The layouts were drawn in CSS, so every Text moves up by this. CSS's baseline comes from a
 * hidden probe element, pixi's from its own font metrics; both are measured once per font.
 */
function baselineShift(style: TextStyleOptions): number {
  const size = Number(style.fontSize);
  const line = Number(style.lineHeight) || size;
  const font = `${String(style.fontStyle)} normal ${String(style.fontWeight)} ${size}px ${String(style.fontFamily)}`;
  const key = `${font}/${line}`;
  let shift = shifts.get(key);

  if (shift !== undefined) return shift;
  const probe = document.createElement('div');
  const mark = document.createElement('span');

  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;font:${font};line-height:${line}px`;
  mark.style.cssText = 'display:inline-block;width:0;height:0';
  probe.append('M', mark);
  document.body.appendChild(probe);
  const css = mark.offsetTop;

  probe.remove();
  const m = CanvasTextMetrics.measureFont(font);
  const pixi = m.ascent + Math.max(0, (line - m.fontSize) / 2);

  shift = Number.isFinite(pixi - css) ? pixi - css : 0;
  shifts.set(key, shift);

  return shift;
}

/** A Text at `x`, `y` (its top edge; left, centre or right by `a`). */
export function makeText(str: string, x: number, y: number, st: TextSpec, resolution: number): Text {
  const style = textStyle(st);
  const t = new Text({ text: str, style, resolution });

  t.pivot.y = baselineShift(style);
  t.anchor.set(st.a === 'c' ? 0.5 : st.a === 'r' ? 1 : 0, 0);
  t.position.set(x, y);
  if (st.op !== undefined) t.alpha = st.op;
  if (st.max !== undefined) fitText(t, st.max);

  return t;
}

/** The smallest a fitted text shrinks to, px: smaller is hard to read on a phone. */
const MIN_FIT_SIZE = 12;

/** Fits a name into `max` px: its role size, then 85 % of it but no smaller than 12 px, then cut with an ellipsis. */
export function fitText(t: Text, max: number): void {
  const full = t.text;

  if (t.width <= max) return;
  const size = Number(t.style.fontSize);

  t.style.fontSize = Math.max(Math.min(size, MIN_FIT_SIZE), size * 0.85);
  if (t.width <= max) return;
  let lo = 0;
  let hi = full.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);

    t.text = `${full.slice(0, mid).trimEnd()}…`;
    if (t.width <= max) lo = mid;
    else hi = mid - 1;
  }
  t.text = `${full.slice(0, lo).trimEnd()}…`;
}

/** How many lines `str` wraps to in `st`, so a panel can be sized before its text is drawn. */
export function lineCount(str: string, st: TextSpec): number {
  return CanvasTextMetrics.measureText(str, new TextStyle(textStyle(st))).lines.length;
}

/**
 * The narrowest wrap, up to `st.wrap`, that keeps `str` on as few lines, so its lines come out even instead of ending
 * on a lone word (CSS's `text-wrap: balance`).
 */
export function balancedWrap(str: string, st: TextSpec): number {
  const wrap = st.wrap ?? 0;
  const lines = lineCount(str, st);
  let lo = wrap / lines;
  let hi = wrap;

  if (lines < 2) return wrap;
  while (hi - lo > 2) {
    const mid = (lo + hi) / 2;

    if (lineCount(str, { ...st, wrap: mid }) <= lines) hi = mid;
    else lo = mid;
  }

  return Math.ceil(hi);
}

let capContext: CanvasRenderingContext2D | null = null;

/**
 * How far below a Text's top its capitals' middle sits. Pixi's anchor centres the font's whole ink box, accents to
 * descenders, which leaves a capital top-heavy in a code cell, so a code cell or a number box centres the cap height instead. It is
 * measured on the font in use, so the fallback face centres too.
 */
export function capMiddle(t: Text): number {
  const font = fontStringFromTextStyle(t.style);
  const m = CanvasTextMetrics.measureFont(font);
  const line = Number(t.style.lineHeight) || m.fontSize;

  capContext ??= document.createElement('canvas').getContext('2d');
  if (capContext) capContext.font = font;
  const cap = capContext?.measureText('H').actualBoundingBoxAscent ?? m.ascent;

  return m.ascent + Math.max(0, (line - m.fontSize) / 2) - cap / 2;
}
