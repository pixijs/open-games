import { Draft } from './Draft';
import type { SolidLetterStyle } from './glyphs';
import { glyphRun, runWidth, solidLetters } from './glyphs';
import { plate } from './plate';
import type { SvgArt } from './svg';
import { chamferRect, leanShift, n, slantRect } from './svg';
import { COLORS, PLACE_METALS } from './tokens';

/** A countdown step. */
export type CountdownStep = 3 | 2 | 1 | 'GO';

const STEP_COLORS: Record<string, { glow: string; side: readonly [string, string]; face: readonly [string, string] }> =
  {
    '3': { glow: COLORS.danger, side: ['#c4163c', '#4a0414'], face: ['#ffffff', '#ffd0da'] },
    '2': { glow: COLORS.danger, side: ['#c4163c', '#4a0414'], face: ['#ffffff', '#ffd0da'] },
    '1': { glow: COLORS.amber, side: ['#d65f00', '#4d2000'], face: ['#ffffff', '#ffd7b0'] },
    GO: { glow: COLORS.go, side: ['#00b86e', '#00381f'], face: ['#f2fff8', '#7dffc0'] },
  };

/**
 * A countdown numeral, 3, 2, 1 or GO, as solid extruded letters with a lamp-coloured halo: red, red, amber, green,
 * the start lights' own sequence.
 * @param step - Which numeral.
 * @param size - Cap height in px.
 */
export function countdownSvg(step: CountdownStep, size = 220): SvgArt {
  const run = glyphRun(String(step), 1.1);
  const c = STEP_COLORS[String(step)];
  const lean = 12;
  const depth = size * 0.07;
  const pad = size * 0.32;
  const width = runWidth(run, size, lean) + depth + pad * 2;
  const d = new Draft();

  solidLetters(
    d,
    run,
    { x: pad, y: pad, size, lean },
    {
      face: c.face,
      side: c.side,
      depth,
      lip: '#ffffff',
      glow: { color: c.glow, blur: size * 0.12, opacity: 0.85 },
      shadow: 0.6,
    },
  );

  return d.art(Math.ceil(width), Math.ceil(size + depth + pad * 2), {
    face: { x: pad, y: pad, w: width - pad * 2, h: size },
  });
}

/**
 * The start-light gantry: three lamps on a bar. `lit` lamps burn red (the last amber); `go` turns every lamp green.
 * @param lit - Lamps lit, 0 to 3.
 * @param go - Every lamp green.
 * @param width - Width of the bar in px.
 */
export function startLightsSvg(lit: number, go = false, width = 300): SvgArt {
  const h = width * 0.3;
  const pad = width * 0.12;
  const d = new Draft();
  const bar = chamferRect(pad, pad, width, h, h * 0.22);

  plate(d, bar, {
    face: [COLORS.ink600, COLORS.ink800],
    depth: h * 0.12,
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#8fa0ff',
    rimOpacity: 0.55,
    shadow: 0.6,
    shade: 0.5,
  });
  const r = h * 0.3;

  for (let i = 0; i < 3; i++) {
    const cx = pad + (width * (i + 0.5)) / 3;
    const cy = pad + h * 0.5;
    const on = go || i < lit;
    const color = go ? COLORS.go : i === 2 ? COLORS.amber : COLORS.danger;
    const deep = go ? COLORS.goDeep : i === 2 ? COLORS.amberDeep : COLORS.dangerDeep;

    d.add(`<circle cx="${n(cx)}" cy="${n(cy + r * 0.08)}" r="${n(r * 1.12)}" fill="${COLORS.ink900}"/>`);
    if (on) {
      const halo = d.blur(r * 0.55);

      d.add(
        `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 1.35)}" fill="${color}" opacity="0.75" filter="url(#${halo})"/>`,
      );
    }
    const lens = d.rgrad(
      cx,
      cy,
      r,
      on
        ? [
            [0, '#ffffff'],
            [0.35, color],
            [1, deep],
          ]
        : [
            [0, '#2b345f'],
            [1, '#0b0f2c'],
          ],
      cy - r * 0.35,
    );

    d.add(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${lens})"/>`);
    d.add(
      `<ellipse cx="${n(cx - r * 0.25)}" cy="${n(cy - r * 0.45)}" rx="${n(r * 0.45)}" ry="${n(r * 0.22)}" ` +
        `fill="#ffffff" opacity="${on ? 0.7 : 0.18}"/>`,
    );
  }

  return d.art(Math.ceil(width + pad * 2), Math.ceil(h * 1.12 + pad * 2), { face: { x: pad, y: pad, w: width, h } });
}

/** The place metal finish for solid letters: gold, silver, bronze, then night steel. */
function placeLetterStyle(place: number, size: number): SolidLetterStyle {
  const m = PLACE_METALS[Math.min(3, Math.max(0, place - 1))];

  return {
    face: [m.hi, m.mid],
    side: [m.lo, m.deep],
    depth: size * 0.075,
    lip: '#ffffff',
    glow: place === 1 ? { color: '#ffb800', blur: size * 0.1, opacity: 0.45 } : undefined,
    shadow: 0.7,
  };
}

const SUFFIX = ['ST', 'ND', 'RD', 'TH'];

/** Options for {@link ordinalSvg}. */
export interface OrdinalOptions {
  /** Cap height of the numeral in px. */
  readonly size?: number;
  /** Sit the ordinal on a leaning place-metal plate (results rows, finish card) instead of bare (HUD). */
  readonly plate?: boolean;
}

/**
 * A place, 1ST to 4TH, drawn as paths: a big solid numeral in its place metal with a small suffix at its shoulder.
 * @param place - 1 to 4.
 * @param options - Size and whether it sits on a plate.
 */
export function ordinalSvg(place: number, options: OrdinalOptions = {}): SvgArt {
  const size = options.size ?? 96;
  const lean = 12;
  const num = glyphRun(String(place));
  const suf = glyphRun(SUFFIX[Math.min(3, Math.max(0, place - 1))], 0.7);
  const sufSize = size * 0.4;
  const depth = size * 0.075;
  const style = placeLetterStyle(place, size);
  const d = new Draft();

  if (options.plate) {
    const pw = runWidth(num, size, lean) + runWidth(suf, sufSize, lean) + size * 0.55;
    const ph = size * 1.5;
    const pad = size * 0.18;
    const m = PLACE_METALS[Math.min(3, Math.max(0, place - 1))];

    plate(d, slantRect(pad, pad, pw, ph, lean, ph * 0.12), {
      face: [COLORS.ink700, COLORS.ink900],
      depth: ph * 0.08,
      side: [m.lo, m.deep],
      rim: m.hi,
      rimOpacity: 0.7,
      tape: { color: m.mid, width: 2, inset: 4, opacity: 0.85 },
      shadow: 0.5,
    });
    const x = pad + leanShift(ph, lean) * 0.5 + size * 0.12;
    const y = pad + (ph - size) * 0.42;

    solidLetters(d, num, { x, y, size, lean }, style);
    solidLetters(
      d,
      suf,
      { x: x + runWidth(num, size, 0) + size * 0.08, y, size: sufSize, lean },
      {
        ...style,
        depth: depth * 0.5,
        glow: undefined,
        face: ['#ffffff', '#dfe6ff'],
      },
    );

    return d.art(Math.ceil(pw + pad * 2), Math.ceil(ph * 1.08 + pad * 2), { face: { x: pad, y: pad, w: pw, h: ph } });
  }
  const pad = size * 0.22;

  solidLetters(d, num, { x: pad, y: pad, size, lean }, style);
  solidLetters(
    d,
    suf,
    { x: pad + runWidth(num, size, 0) + size * 0.1, y: pad + size * 0.02, size: sufSize, lean },
    {
      ...style,
      depth: depth * 0.55,
      glow: undefined,
      face: ['#ffffff', '#dfe6ff'],
    },
  );
  const width = pad * 2 + runWidth(num, size, 0) + size * 0.1 + runWidth(suf, sufSize, lean) + depth;

  return d.art(Math.ceil(width), Math.ceil(size + depth + pad * 2), {
    face: { x: pad, y: pad, w: width - pad * 2, h: size },
  });
}
