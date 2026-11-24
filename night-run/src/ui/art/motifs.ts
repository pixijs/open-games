import { Draft } from './Draft';
import type { SvgArt } from './svg';
import { mix, n } from './svg';
import { COLORS } from './tokens';

/** Registers a chequer pattern of `cell` px squares and returns its id. */
export function chequerPattern(
  d: Draft,
  cell: number,
  dark: string = COLORS.ink900,
  light: string = COLORS.white,
  angle = 0,
): string {
  return d.def(
    'p',
    (id) =>
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(cell * 2)}" height="${n(cell * 2)}"` +
      (angle ? ` patternTransform="skewX(${n(-angle)})"` : '') +
      `><rect width="${n(cell * 2)}" height="${n(cell * 2)}" fill="${light}"/>` +
      `<path d="M0 0H${n(cell)}V${n(cell)}H0ZM${n(cell)} ${n(cell)}H${n(cell * 2)}V${n(cell * 2)}H${n(cell)}Z" fill="${dark}"/></pattern>`,
  );
}

/** Registers a 45 degree hazard-stripe pattern and returns its id. */
export function hazardPattern(d: Draft, stripe: number, a: string = COLORS.amber, b: string = COLORS.ink900): string {
  const p = stripe * 2;

  return d.def(
    'p',
    (id) =>
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(p)}" height="${n(p)}" patternTransform="rotate(45)">` +
      `<rect width="${n(p)}" height="${n(p)}" fill="${a}"/><rect width="${n(stripe)}" height="${n(p)}" fill="${b}"/></pattern>`,
  );
}

/**
 * A chequered strip that tiles sideways, for finish trims and wipes.
 * @param width - Width in px; a whole number of cell pairs tiles cleanly.
 * @param rows - Rows of cells.
 * @param cell - Cell size in px.
 * @param lean - Lean in degrees.
 */
export function chequerSvg(width = 128, rows = 2, cell = 16, lean = 0): SvgArt {
  const d = new Draft();
  const h = rows * cell;
  const id = chequerPattern(d, cell, COLORS.ink900, COLORS.white, lean);
  const shade = d.vgrad(0, h, [
    [0, '#ffffff', 0.2],
    [1, '#000000', 0.25],
  ]);

  d.add(
    `<rect width="${width}" height="${h}" fill="url(#${id})"/><rect width="${width}" height="${h}" fill="url(#${shade})"/>`,
  );

  return d.art(width, h);
}

/**
 * A hazard-stripe strip that tiles sideways, for wrong-way and danger trims.
 * @param width - Width in px; a multiple of `stripe` times 2.83 tiles cleanly.
 * @param height - Height in px.
 * @param stripe - Stripe width in px.
 * @param color - The bright stripe colour (danger or amber).
 */
export function hazardSvg(width = 136, height = 20, stripe = 12, color: string = COLORS.amber): SvgArt {
  const d = new Draft();
  const id = hazardPattern(d, stripe, color);

  d.add(`<rect width="${width}" height="${height}" fill="url(#${id})"/>`);
  d.add(
    `<rect width="${width}" height="2" fill="#ffffff" opacity="0.35"/><rect y="${height - 2}" width="${width}" height="2" fill="#000" opacity="0.4"/>`,
  );

  return d.art(width, height);
}

/** Confetti shapes; each is drawn front-lit, and the builder flips `scale.y` to tumble it. */
export type ConfettiKind = 'strip' | 'square' | 'chevron' | 'star' | 'disc';

/**
 * One piece of confetti in a colour, with a lit and a shaded half so a tumbling flip reads as a turning card.
 * @param kind - The shape.
 * @param color - Main colour (a racer colour for the winner, or gold).
 * @param size - Longest side in px.
 */
export function confettiSvg(kind: ConfettiKind, color: string, size = 16): SvgArt {
  const d = new Draft();
  const k = size / 16;
  const lit = mix(color, '#ffffff', 0.45);
  const shade = mix(color, '#000000', 0.35);
  const g = d.lgrad(0, 0, 16, 16, [
    [0, lit],
    [0.5, color],
    [1, shade],
  ]);
  const shapes: Record<ConfettiKind, string> = {
    strip: 'M1 6H15V10H1Z',
    square: 'M3 3H13V13H3Z',
    chevron: 'M1 9L8 3 15 9 15 13 8 7 1 13Z',
    star: 'M8 1L10 6 15 6.4 11.2 9.6 12.4 15 8 12 3.6 15 4.8 9.6 1 6.4 6 6Z',
    disc: 'M8 2A6 6 0 1 1 8 14A6 6 0 1 1 8 2Z',
  };

  d.add(
    `<g transform="scale(${n(k)})"><path d="${shapes[kind]}" fill="url(#${g})" stroke="${shade}" stroke-width="0.8"/>` +
      `<path d="${shapes[kind]}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="0.6" transform="translate(-0.4 -0.4)"/></g>`,
  );

  return d.art(Math.ceil(16 * k), Math.ceil(16 * k));
}

/**
 * The waiting spinner: twelve chevrons round a ring, brightest at the top, so one texture spun in twelfths reads as
 * travelling light.
 * @param size - Diameter in px.
 * @param color - Lit colour.
 */
export function spinnerSvg(size = 64, color: string = COLORS.cyan): SvgArt {
  const d = new Draft();
  const r = size * 0.36;
  const c = size / 2;
  const glow = d.blur(size * 0.03);
  let ring = '';

  for (let i = 0; i < 12; i++) {
    const a = (-i / 12) * 360;
    const t = i / 11;
    const op = 0.12 + 0.88 * (1 - t) ** 1.6;
    const w = size * 0.07;

    ring +=
      `<path transform="rotate(${n(a)} ${n(c)} ${n(c)})" d="M${n(c - w)} ${n(c - r - w * 0.6)}L${n(c + w * 0.4)} ${n(c - r)}` +
      `L${n(c - w)} ${n(c - r + w * 0.6)}" fill="none" stroke="${i === 0 ? '#ffffff' : color}" stroke-width="${n(size * 0.055)}" ` +
      `stroke-opacity="${n(op)}"/>`;
  }
  d.add(`<g filter="url(#${glow})" opacity="0.8">${ring}</g>${ring}`);

  return d.art(size, size, { anchor: { x: 0.5, y: 0.5 } });
}

/**
 * A scrim: ink fading to clear, laid between the live scene and a menu so text reads without hiding the race.
 * Draw it small and stretch it; it's a gradient, so stretching costs nothing.
 * @param from - The edge the ink starts at.
 * @param strength - Ink opacity at that edge, 0 to 1.
 * @param reach - How far across the ink reaches, 0 to 1.
 */
export function scrimSvg(
  from: 'left' | 'right' | 'top' | 'bottom' | 'center' = 'left',
  strength = 0.85,
  reach = 0.65,
): SvgArt {
  const d = new Draft();
  const size = 64;
  const ink = COLORS.ink900;

  if (from === 'center') {
    const g = d.rgrad(size / 2, size / 2, size * 0.75, [
      [0, ink, strength],
      [reach, ink, strength * 0.6],
      [1, ink, strength * 0.2],
    ]);

    d.add(`<rect width="${size}" height="${size}" fill="url(#${g})"/>`);

    return d.art(size, size);
  }
  const vec = { left: [0, 0, size, 0], right: [size, 0, 0, 0], top: [0, 0, 0, size], bottom: [0, size, 0, 0] }[from];
  const g = d.lgrad(vec[0], vec[1], vec[2], vec[3], [
    [0, ink, strength],
    [reach * 0.55, ink, strength * 0.7],
    [reach, ink, 0],
    [1, ink, 0],
  ]);

  d.add(`<rect width="${size}" height="${size}" fill="url(#${g})"/>`);

  return d.art(size, size);
}

/**
 * The light sweep that crosses a plate on hover, a record, or a copy: a leaning white bar, soft at both sides. Run it
 * across the face under a mask of the face (one at a time, so one mask), with `blendMode = 'add'`.
 * @param height - Height in px; the bar is a third as wide.
 */
export function glintSvg(height = 64): SvgArt {
  const d = new Draft();
  const w = height * 0.34;
  const s = height * Math.tan((12 * Math.PI) / 180);
  const g = d.lgrad(0, 0, w + s, 0, [
    [0, '#ffffff', 0],
    [0.5, '#ffffff', 0.55],
    [1, '#ffffff', 0],
  ]);

  d.add(`<path d="M${n(s)} 0H${n(s + w)}L${n(w)} ${n(height)}H0Z" fill="url(#${g})"/>`);

  return d.art(Math.ceil(w + s), height, { anchor: { x: 0.5, y: 0.5 } });
}

/**
 * A screen-edge glow for boost (magenta) and wrong way (danger): clear in the middle, the colour at the edges. Draw it
 * small, stretch it over the screen and tween its alpha.
 * @param color - The glow colour.
 * @param strength - Opacity at the corners, 0 to 1.
 */
export function vignetteSvg(color: string = COLORS.magenta, strength = 0.75): SvgArt {
  const d = new Draft();
  const size = 64;
  const g = d.rgrad(size / 2, size / 2, size * 0.72, [
    [0, color, 0],
    [0.55, color, 0],
    [0.85, color, strength * 0.55],
    [1, color, strength],
  ]);

  d.add(`<rect width="${size}" height="${size}" fill="url(#${g})"/>`);

  return d.art(size, size);
}
