import type { TextStyleFontWeight } from 'pixi.js';
import { CanvasTextMetrics, Text, TextStyle } from 'pixi.js';

import { COLORS, FONTS } from '../art/tokens';

/** A CSS hex colour as a pixi colour number */
export function hex(color: string): number {
  return Number(`0x${color.slice(1)}`);
}

export const INK = hex(COLORS.ink900);
export const WHITE = hex(COLORS.white);
export const MIST = hex(COLORS.mist);
export const CYAN = hex(COLORS.cyan);
export const AMBER = hex(COLORS.amber);

/** How a piece of HUD text is set: the board voice (Big Shoulders) or the driver voice (Kanit) */
export interface TextRole {
  readonly family: 'board' | 'driver';
  readonly weight: TextStyleFontWeight;
  readonly italic?: boolean;
  /** Ink on a bright plate: no shadow */
  readonly flat?: boolean;
  readonly spacing?: number;
}

/**
 * A pixi Text in a HUD role, white so it can be tinted, with the ink shadow over the scene unless `flat`.
 * @param role - Family, weight and finish.
 * @param size - Font size in box px.
 * @param color - Tint.
 * @param value - The words.
 */
export function hudText(role: TextRole, size: number, color = WHITE, value = ''): Text {
  const text = new Text({
    text: value,
    style: new TextStyle({
      fontFamily: role.family === 'board' ? FONTS.board : FONTS.driver,
      fontWeight: role.weight,
      fontStyle: role.italic ? 'italic' : 'normal',
      fontSize: size,
      fill: 0xffffff,
      letterSpacing: role.spacing ?? 0,
      padding: 8,
      dropShadow: role.flat ? false : { color: INK, alpha: 0.65, blur: 4, distance: 2, angle: Math.PI / 2 },
    }),
  });

  text.tint = color;

  return text;
}

/** Changes a text's size, keeping its role */
export function resize(text: Text, size: number): void {
  if (text.style.fontSize !== size) text.style.fontSize = size;
}

/**
 * Places a text like CSS with `line-height: 1`: `top` is the top of a box as tall as the font size, `x` its left,
 * middle or right edge by `align`.
 */
export function place(text: Text, x: number, top: number, align: 'left' | 'center' | 'right' = 'left'): void {
  const size = Number(text.style.fontSize);
  const box = CanvasTextMetrics.measureText('0', text.style).fontProperties.fontSize;

  text.anchor.set(align === 'left' ? 0 : align === 'right' ? 1 : 0.5, 0);
  text.position.set(x, top + (size - box) / 2);
}

/** Places a text centred on `y` */
export function placeMiddle(text: Text, x: number, y: number, align: 'left' | 'center' | 'right' = 'center'): void {
  place(text, x, y - Number(text.style.fontSize) / 2, align);
}

/**
 * Sets a name or message that has to fit `max` px: drawn at `size`, shrunk to 85 % if it doesn't fit, then cut with
 * an ellipsis. Only for values that change rarely: it re-measures.
 */
export function fit(text: Text, value: string, size: number, max: number): void {
  resize(text, size);
  text.text = value;
  if (text.width <= max) return;
  resize(text, Math.round(size * 0.85));
  if (text.width <= max) return;
  let cut = value.length - 1;

  while (cut > 1) {
    text.text = `${value.slice(0, cut).trimEnd()}…`;
    if (text.width <= max) return;
    cut--;
  }
}

export const BOARD_900: TextRole = { family: 'board', weight: '900' };
export const BOARD_800: TextRole = { family: 'board', weight: '800' };
export const BOARD_700: TextRole = { family: 'board', weight: '700' };
export const LABEL: TextRole = { family: 'driver', weight: '600', spacing: 0.4 };
export const NAME: TextRole = { family: 'driver', weight: '600', italic: true };
export const BODY: TextRole = { family: 'driver', weight: '500' };
