import type { Draft } from './Draft';
import { n } from './svg';
import { COLORS } from './tokens';

/**
 * NIGHT RUN's drawn letters: an octagonal monoline skeleton on a cap height of 10 units, stroked 2.4 units thick and
 * clipped to the cap band. Square letters stay square; round ones turn their corners at 45 degrees, like cut sheet
 * metal and racing numbers. Only the characters the art needs are drawn.
 */
interface Glyph {
  readonly w: number;
  readonly paths: readonly (readonly number[])[];
  readonly closed?: readonly boolean[];
}

/** Stroke weight in glyph units (cap height 10). */
export const GLYPH_WEIGHT = 2.4;
const CAP = 10;

const GLYPHS: Record<string, Glyph> = {
  N: {
    w: 7,
    paths: [
      [1.2, -2, 1.2, 12],
      [5.8, -2, 5.8, 12],
      [1.2, -0.4, 5.8, 10.4],
    ],
  },
  I: { w: 2.4, paths: [[1.2, -2, 1.2, 12]] },
  G: { w: 7, paths: [[7, 1.2, 2.9, 1.2, 1.2, 2.9, 1.2, 7.1, 2.9, 8.8, 4.1, 8.8, 5.8, 7.1, 5.8, 5.2, 3.4, 5.2]] },
  H: {
    w: 7,
    paths: [
      [1.2, -2, 1.2, 12],
      [5.8, -2, 5.8, 12],
      [1.2, 5, 5.8, 5],
    ],
  },
  T: {
    w: 7,
    paths: [
      [0, 1.2, 7, 1.2],
      [3.5, 1.2, 3.5, 12],
    ],
  },
  R: {
    w: 7,
    paths: [
      [1.2, 12, 1.2, 1.2, 4.1, 1.2, 5.8, 2.9, 5.8, 3.9, 4.3, 5.4, 1.2, 5.4],
      [3.1, 5.4, 6.2, 11],
    ],
  },
  U: { w: 7, paths: [[1.2, -2, 1.2, 7.1, 2.9, 8.8, 4.1, 8.8, 5.8, 7.1, 5.8, -2]] },
  Y: {
    w: 7,
    paths: [
      [1.2, -2, 1.2, 2.9, 3.5, 5.2, 5.8, 2.9, 5.8, -2],
      [3.5, 5.2, 3.5, 12],
    ],
  },
  S: { w: 7, paths: [[7, 1.2, 2.9, 1.2, 1.2, 2.9, 1.2, 3.3, 2.9, 5, 4.1, 5, 5.8, 6.7, 5.8, 7.1, 4.1, 8.8, 0, 8.8]] },
  D: { w: 7, paths: [[1.2, 1.2, 4.1, 1.2, 5.8, 2.9, 5.8, 7.1, 4.1, 8.8, 1.2, 8.8]], closed: [true] },
  O: {
    w: 7,
    paths: [[2.9, 1.2, 4.1, 1.2, 5.8, 2.9, 5.8, 7.1, 4.1, 8.8, 2.9, 8.8, 1.2, 7.1, 1.2, 2.9]],
    closed: [true],
  },
  '1': {
    w: 4.8,
    paths: [
      [3.6, -2, 3.6, 12],
      [0.4, 3.4, 2.6, 1.2, 3.6, 1.2],
    ],
  },
  '2': { w: 7, paths: [[1.2, 3.8, 1.2, 2.9, 2.9, 1.2, 4.1, 1.2, 5.8, 2.9, 5.8, 4.1, 1.2, 7.6, 1.2, 8.8, 7, 8.8]] },
  '3': {
    w: 7,
    paths: [
      [0, 1.2, 4.1, 1.2, 5.8, 2.9, 5.8, 3.4, 4.2, 5, 2.4, 5],
      [4.2, 5, 5.8, 6.6, 5.8, 7.1, 4.1, 8.8, 0, 8.8],
    ],
  },
  '4': {
    w: 7.2,
    paths: [
      [1.2, -2, 1.2, 6.4, 7.2, 6.4],
      [5, -2, 5, 12],
    ],
  },
  ' ': { w: 3.4, paths: [] },
};

/** Letters laid out in glyph units: path data, and the run's width. */
export interface GlyphRun {
  readonly d: string;
  readonly width: number;
}

/** Lays `text` out as one path. `tracking` is the gap between letters in glyph units. */
export function glyphRun(text: string, tracking = 0.9): GlyphRun {
  let x = 0;
  let d = '';
  const chars = text.toUpperCase().split('');

  chars.forEach((ch, i) => {
    const g = GLYPHS[ch];

    if (!g) return;
    g.paths.forEach((p, k) => {
      d += `M${n(p[0] + x)} ${n(p[1])}`;
      for (let j = 2; j < p.length; j += 2) d += `L${n(p[j] + x)} ${n(p[j + 1])}`;
      if (g.closed?.[k]) d += 'Z';
    });
    x += g.w + (i < chars.length - 1 ? tracking : 0);
  });

  return { d, width: x };
}

/** Where and how big a run is drawn: its top-left at `x`, `y` before leaning, cap height `size` px. */
export interface GlyphPlacement {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** Lean in degrees; the baseline stays put and the top moves right. */
  readonly lean: number;
}

/** The SVG transform that places glyph units on the page. */
export function glyphTransform(p: GlyphPlacement): string {
  const k = p.size / CAP;

  return `translate(${n(p.x)} ${n(p.y + p.size)}) skewX(${n(-p.lean)}) translate(0 ${n(-p.size)}) scale(${n(k)})`;
}

/** Width in px of a run placed at `size`, including how far its top leans right. */
export function runWidth(run: GlyphRun, size: number, lean: number): number {
  return (run.width * size) / CAP + size * Math.tan((lean * Math.PI) / 180);
}

/** Registers a run as a reusable def, clipped to the cap band, and returns its id. Stroke and width come from use. */
export function defineRun(d: Draft, run: GlyphRun, band = 0): string {
  const clip = d.def(
    'cb',
    (id) =>
      `<clipPath id="${id}"><rect x="-4" y="${n(band)}" width="${n(run.width + 8)}" height="${n(CAP - band * 2)}"/></clipPath>`,
  );

  return d.def(
    'gr',
    (id) => `<g id="${id}" clip-path="url(#${clip})"><path d="${run.d}" fill="none" stroke-miterlimit="3"/></g>`,
  );
}

/** How solid letters are finished: enamel face, extruded return, keyline and halo. */
export interface SolidLetterStyle {
  readonly face: readonly [string, string];
  readonly side: readonly [string, string];
  /** Extrusion depth in px, down and slightly right. */
  readonly depth: number;
  /** The lit top lip of each stroke. */
  readonly lip: string;
  /** A coloured halo behind the letters. */
  readonly glow?: { readonly color: string; readonly blur: number; readonly opacity: number };
  /** Opacity of the soft shadow cast below. */
  readonly shadow?: number;
}

/** Draws `run` as solid extruded letters. */
export function solidLetters(d: Draft, run: GlyphRun, at: GlyphPlacement, s: SolidLetterStyle): void {
  const id = defineRun(d, run);
  const tf = glyphTransform(at);
  const k = at.size / CAP;
  const unit = 1 / k;
  const w = GLYPH_WEIGHT;
  const use = (stroke: string, width: number, dx = 0, dy = 0, extra = ''): string =>
    `<g transform="translate(${n(dx)} ${n(dy)})"><g transform="${tf}"><use href="#${id}" xlink:href="#${id}" ` +
    `stroke="${stroke}" stroke-width="${n(width)}"${extra}/></g></g>`;
  const ex = s.depth * 0.28;
  const ey = s.depth;

  if (s.shadow) {
    const f = d.blur(Math.max(2, at.size * 0.05));

    d.add(
      `<g filter="url(#${f})" opacity="${n(s.shadow)}">${use(COLORS.ink900, w + unit * 4, ex * 1.4, ey * 1.6)}</g>`,
    );
  }
  if (s.glow) {
    const f = d.blur(s.glow.blur);

    d.add(
      `<g filter="url(#${f})" opacity="${n(s.glow.opacity)}">${use(s.glow.color, w + unit * 6, ex * 0.5, ey * 0.5)}</g>`,
    );
  }
  d.add(use(COLORS.ink900, w + unit * 3, ex, ey));
  const steps = Math.max(1, Math.ceil(s.depth));
  const sideGrad = d.vgrad(at.y, at.y + at.size + ey, [
    [0, s.side[0]],
    [1, s.side[1]],
  ]);

  for (let i = steps; i >= 1; i--) {
    const t = i / steps;

    d.add(use(`url(#${sideGrad})`, w, ex * t, ey * t));
  }
  d.add(use(COLORS.ink900, w + unit * 2.2, 0, 0, ' stroke-opacity="0.55"'));
  d.add(use(s.lip, w, 0, 0));
  const faceGrad = d.vgrad(at.y, at.y + at.size, [
    [0, s.face[0]],
    [1, s.face[1]],
  ]);

  d.add(use(`url(#${faceGrad})`, w, 0, Math.max(1.2, at.size * 0.025)));
  const sheen = d.vgrad(at.y, at.y + at.size * 0.5, [
    [0, '#ffffff', 0.38],
    [0.6, '#ffffff', 0.06],
    [1, '#ffffff', 0],
  ]);

  d.add(use(`url(#${sheen})`, w * 0.5, -at.size * 0.012, at.size * 0.02));
}

/**
 * Draws `run` as flat painted letters, one colour, no depth: a bay number on a garage wall, YOU on a tab, a place
 * digit in a map dot.
 */
export function paintedLetters(d: Draft, run: GlyphRun, at: GlyphPlacement, color: string, opacity = 1): void {
  const id = defineRun(d, run);

  d.add(
    `<g transform="${glyphTransform(at)}" opacity="${n(opacity)}"><use href="#${id}" xlink:href="#${id}" ` +
      `stroke="${color}" stroke-width="${n(GLYPH_WEIGHT)}"/></g>`,
  );
}
