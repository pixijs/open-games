import type { ButtonState } from './buttons';
import { Draft } from './Draft';
import { drawIcon } from './icons';
import { plate } from './plate';
import type { SvgArt } from './svg';
import { leanShift, mix, n, slantRect } from './svg';
import type { RacerColor } from './tokens';
import { COLORS } from './tokens';

/** How a truck silhouette is painted. */
export interface TruckPaint {
  readonly hi: string;
  readonly main: string;
  readonly deep: string;
}

/** A grey paint for seats nobody holds and trucks someone else took. */
export const GHOST_PAINT: TruckPaint = { hi: '#6a76b0', main: '#3a4580', deep: '#1c2350' };

/**
 * Draws the chunky pickup from the side, facing right, in a 120 by 64 unit box placed at `x`, `y` and scaled by `k`.
 * It follows the Kenney truck: boxy cab, raked windscreen, short bed, two roof lamps and fat tyres.
 */
export function drawTruck(d: Draft, paint: TruckPaint, x: number, y: number, k: number): void {
  const body = d.vgrad(20, 48, [
    [0, paint.hi],
    [0.35, paint.main],
    [1, paint.deep],
  ]);
  const cab = d.vgrad(6, 28, [
    [0, mix(paint.hi, '#ffffff', 0.2)],
    [1, paint.main],
  ]);
  const glass = d.lgrad(58, 10, 84, 22, [
    [0, '#1b2a66'],
    [0.45, '#0b1236'],
    [0.5, '#7ff3ff'],
    [0.56, '#0b1236'],
    [1, '#141d4c'],
  ]);
  const tyre = d.rgrad(0, 0, 13, [
    [0, '#3a3f5c'],
    [0.7, '#1a1d30'],
    [1, '#0a0b16'],
  ]);
  const wheel = (cx: number): string =>
    `<g transform="translate(${cx} 48)"><circle r="13.5" fill="url(#${tyre})"/>` +
    `<circle r="13.5" fill="none" stroke="#06070f" stroke-width="1.4"/>` +
    `<circle r="6.6" fill="#c9d0e6"/><circle r="6.6" fill="none" stroke="#5b6386" stroke-width="1.6"/>` +
    `<circle r="2.4" fill="#5b6386"/></g>`;
  const ink = COLORS.ink900;

  d.add(`<g transform="translate(${n(x)} ${n(y)}) scale(${n(k)})">`);
  d.add(`<ellipse cx="61" cy="62" rx="54" ry="3.2" fill="${ink}" opacity="0.5"/>`);
  d.add(`<path d="M15 46A16 16 0 0 1 45 46ZM77 46A16 16 0 0 1 107 46Z" fill="${ink}"/>`);
  d.add(
    `<path d="M52 10L56 6.5H80L90.5 20H108L114 26V42L110 46H107A16 16 0 0 0 77 46H45A16 16 0 0 0 15 46H11L7 42V22H52Z" ` +
      `fill="url(#${body})" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>`,
  );
  d.add(`<path d="M53 11L56.5 8H79.5L89 20H53Z" fill="url(#${cab})"/>`);
  d.add(`<path d="M58 11H78.5L85.5 20H58Z" fill="url(#${glass})" stroke="${ink}" stroke-width="1.5"/>`);
  d.add(`<path d="M8 22H51" stroke="${mix(paint.hi, '#ffffff', 0.4)}" stroke-width="1.6" opacity="0.8"/>`);
  d.add(`<path d="M9 25.5H51V29H9Z" fill="${paint.deep}" opacity="0.55"/>`);
  d.add(`<path d="M70 21V40M74 26H78" stroke="${ink}" stroke-width="1.4" opacity="0.55"/>`);
  d.add(`<path d="M8 36H112" stroke="${paint.hi}" stroke-width="1.2" opacity="0.35"/>`);
  d.add(`<rect x="105" y="39" width="10" height="5" rx="1" fill="#2b3150" stroke="${ink}" stroke-width="1.2"/>`);
  d.add(`<rect x="6" y="39" width="9" height="5" rx="1" fill="#2b3150" stroke="${ink}" stroke-width="1.2"/>`);
  d.add(`<rect x="109.5" y="27.5" width="5" height="5" rx="1" fill="#fff6c8" stroke="${ink}" stroke-width="1"/>`);
  d.add(`<rect x="7" y="28" width="4" height="5" rx="1" fill="#ff3a3a" stroke="${ink}" stroke-width="1"/>`);
  d.add(`<rect x="61" y="3" width="14" height="4" rx="1" fill="#1d2140" stroke="${ink}" stroke-width="1.2"/>`);
  d.add(`<circle cx="64.5" cy="3" r="2.6" fill="#ffd25a" stroke="${ink}" stroke-width="1"/>`);
  d.add(`<circle cx="71.5" cy="3" r="2.6" fill="#ffd25a" stroke="${ink}" stroke-width="1"/>`);
  d.add(wheel(30) + wheel(92));
  d.add('</g>');
}

/** Options for {@link truckSvg}. */
export interface TruckOptions {
  /** Width in px; the height follows the 120 by 64 box. */
  readonly width?: number;
  /** The paint; leave out for the grey ghost. */
  readonly color?: RacerColor | TruckPaint;
}

/**
 * The truck silhouette on its own, in a racer's paint or the grey ghost.
 * @param options - Width and paint.
 */
export function truckSvg(options: TruckOptions = {}): SvgArt {
  const w = options.width ?? 120;
  const k = w / 120;
  const pad = Math.ceil(4 * k);
  const d = new Draft();

  drawTruck(d, options.color ?? GHOST_PAINT, pad, pad + 2 * k, k);

  return d.art(w + pad * 2, Math.ceil(66 * k + pad * 2), { face: { x: pad, y: pad, w, h: 66 * k } });
}

/** States of a colour swatch in the truck-colour picker. */
export type SwatchState = ButtonState | 'selected' | 'taken';

/**
 * A truck-colour swatch: a leaning tile with the truck in that colour. `selected` floods the tile with the colour and
 * lights its tape; `taken` (someone else has it) greys the truck and adds a lock.
 * @param color - The racer colour.
 * @param state - The swatch's state.
 * @param size - Face height in px; the face is 1.3 times as wide.
 */
export function truckSwatchSvg(color: RacerColor, state: SwatchState = 'idle', size = 96): SvgArt {
  const h = size;
  const w = Math.round(size * 1.3);
  const pad = Math.round(size * 0.22);
  const depth = Math.round(h * 0.07);
  const lift = state === 'hover' || state === 'focus' || state === 'selected' ? 3 : state === 'press' ? -depth + 1 : 0;
  const d = new Draft();
  const pts = slantRect(pad, pad - lift, w, h, 12, h * 0.12);
  const selected = state === 'selected';
  const taken = state === 'taken';

  plate(d, pts, {
    face: selected
      ? [mix(color.deep, '#000000', 0.15), mix(color.deep, COLORS.ink900, 0.6)]
      : [COLORS.ink600, COLORS.ink800],
    faceOpacity: taken ? 0.75 : 0.96,
    depth: depth + lift,
    side: selected ? [color.deep, mix(color.deep, '#000000', 0.6)] : [COLORS.ink800, COLORS.ink900],
    rim: selected ? color.hi : '#9fb0ff',
    rimOpacity: selected ? 0.9 : 0.45,
    tape: {
      color: selected || state === 'hover' || state === 'focus' ? color.main : COLORS.line,
      width: selected ? 3 : 1.5,
      inset: selected ? 3.5 : 2.5,
      opacity: taken ? 0.5 : 1,
    },
    glow: selected ? { color: color.main, blur: h * 0.14, opacity: 0.7 } : undefined,
    gloss: 0.12,
    shadow: 0.55,
  });
  const tw = w * 0.72;
  const tk = tw / 120;
  const tx = pad + (w - tw) / 2 + leanShift(h, 12) * 0.12;
  const ty = pad - lift + (h - 64 * tk) / 2 + 2;

  if (selected) {
    const spot = d.rgrad(tx + tw / 2, ty + 40 * tk, tw * 0.6, [
      [0, color.main, 0.45],
      [1, color.main, 0],
    ]);

    d.add(
      `<ellipse cx="${n(tx + tw / 2)}" cy="${n(ty + 40 * tk)}" rx="${n(tw * 0.6)}" ry="${n(h * 0.35)}" fill="url(#${spot})"/>`,
    );
  }
  drawTruck(d, taken ? GHOST_PAINT : color, tx, ty, tk);
  if (taken) {
    const s = h * 0.3;

    drawIcon(d, 'lock', pad + w - s - h * 0.12, pad - lift + h * 0.1, {
      size: s,
      color: COLORS.mist,
      accent: COLORS.ink800,
    });
  }
  if (selected) {
    const s = h * 0.26;

    drawIcon(d, 'check', pad + w - s - h * 0.1, pad - lift + h * 0.08, { size: s, color: color.main });
  }

  return d.art(w + pad * 2, h + pad * 2 + depth, {
    content: { x: pad, y: pad - lift, w, h },
    face: { x: pad, y: pad, w, h },
  });
}
