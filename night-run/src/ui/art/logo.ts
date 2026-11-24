import { Draft } from './Draft';
import { glyphRun, runWidth, solidLetters } from './glyphs';
import type { SolidLetterStyle } from './glyphs';
import { chequerPattern } from './motifs';
import { plate } from './plate';
import type { SvgArt } from './svg';
import { chamferRect, mix, n, poly } from './svg';
import { COLORS, MOTION } from './tokens';

/** Options for {@link logoSvg}. */
export interface LogoOptions {
  /** `line` sets NIGHT RUN on one line; `stack` sets NIGHT over a bigger RUN, for portrait screens. */
  readonly layout?: 'line' | 'stack';
  /** Cap height of NIGHT in px; RUN is scaled to match in the stacked layout. */
  readonly size?: number;
  /** Face colours for NIGHT and RUN: the track's two neon colours. */
  readonly tubes?: readonly [string, string];
  /** Lit (the default) or off: the faces dark and the lamps out, for the flicker-on at title enter. */
  readonly lit?: boolean;
  /** The wet track's reflection under the sign. */
  readonly reflection?: boolean;
  /**
   * How far the hanging poles rise above the cabinet, px; the art starts at their tops. The title sets it past the
   * screen's top edge, so the sign hangs from something off screen.
   */
  readonly hang?: number;
}

/** Channel letters with lit acrylic faces: a dark metal return, an ink keyline and the face colour's halo. */
function letterStyle(tube: string, size: number, lit: boolean): SolidLetterStyle {
  return {
    face: lit ? [mix(tube, '#ffffff', 0.4), tube] : ['#2b3466', '#1a2150'],
    side: ['#2e3874', '#070a22'],
    depth: size * 0.11,
    lip: lit ? '#ffffff' : '#4a5590',
    glow: lit ? { color: tube, blur: size * 0.16, opacity: 0.75 } : undefined,
    shadow: 0.7,
  };
}

/**
 * The NIGHT RUN wordmark as a trackside sign, the way the track's own arch sign is built: lit channel letters (NIGHT
 * cyan, RUN magenta, leaning forward) on a raceway cabinet hung from two rods, with a chequer band and three start
 * lamps along its foot, and the sign's reflection in the wet track under it. All paths; `face` is the cabinet.
 * @param options - Layout, size, face colours, lit state and reflection.
 */
export function logoSvg(options: LogoOptions = {}): SvgArt {
  const layout = options.layout ?? 'line';
  const size = options.size ?? 96;
  const lean = MOTION.lean;
  const [tubeA, tubeB] = options.tubes ?? [COLORS.cyan, COLORS.magenta];
  const lit = options.lit ?? true;
  const reflect = options.reflection ?? true;
  const night = glyphRun('NIGHT', 1);
  const run = glyphRun('RUN', 1);
  const margin = size * 0.34;
  const band = size * 0.24;
  const pad = size * 0.3;
  const hang = options.hang ?? size * 0.72;
  const d = new Draft();
  let cabW: number;
  let cabH: number;
  const letters: { run: typeof night; x: number; y: number; size: number; tube: string }[] = [];

  if (layout === 'line') {
    const gap = size * 0.42;
    const wNight = runWidth(night, size, 0);

    cabW = margin * 2 + wNight + gap + runWidth(run, size, lean) + size * 0.12;
    cabH = margin * 1.6 + size + band + size * 0.12;
    letters.push({ run: night, x: margin, y: margin * 0.8, size, tube: tubeA });
    letters.push({ run, x: margin + wNight + gap, y: margin * 0.8, size, tube: tubeB });
  } else {
    const runSize = (size * night.width) / run.width;
    const gap = size * 0.24;

    cabW = margin * 2 + Math.max(runWidth(night, size, lean), runWidth(run, runSize, lean)) + runSize * 0.12;
    cabH = margin * 1.6 + size + gap + runSize + band + runSize * 0.12;
    letters.push({
      run: night,
      x: margin + (cabW - margin * 2 - runWidth(night, size, lean)) / 2,
      y: margin * 0.8,
      size,
      tube: tubeA,
    });
    letters.push({ run, x: margin, y: margin * 0.8 + size + gap, size: runSize, tube: tubeB });
  }
  const depth = size * 0.1;
  const x0 = pad;
  const y0 = hang;
  const cabinet = chamferRect(x0, y0, cabW, cabH, [size * 0.22, size * 0.07, size * 0.22, size * 0.07]);
  const metal = { hi: '#c6cee6', lo: '#59648a' };
  const rod = size * 0.1;

  for (const fx of [0.2, 0.8]) {
    const bx = x0 + cabW * fx;
    // Shaded across, not along: a rod of any length reads the same wherever the screen cuts it.
    const shine = d.lgrad(bx - rod / 2, 0, bx + rod / 2, 0, [
      [0, metal.lo],
      [0.35, metal.hi],
      [1, metal.lo],
    ]);

    d.add(`<rect x="${n(bx - rod / 2)}" y="0" width="${n(rod)}" height="${n(y0 + rod)}" fill="url(#${shine})"/>`);
    plate(d, chamferRect(bx - size * 0.16, y0 - size * 0.12, size * 0.32, size * 0.16, size * 0.04), {
      face: [metal.hi, metal.lo],
      depth: size * 0.03,
      side: ['#3a4468', '#1a2040'],
      rim: '#ffffff',
      rimOpacity: 0.8,
    });
  }
  plate(d, cabinet, {
    face: ['#1e275c', '#090d2c'],
    depth,
    side: ['#2a3470', '#04061a'],
    rim: '#b8c4ff',
    rimOpacity: 0.7,
    rimWidth: 2,
    gloss: 0.08,
    shade: 0.4,
    shadow: 0.7,
    tape: { color: '#ffffff', width: 1.5, inset: size * 0.06, opacity: 0.14 },
  });
  d.add(`<path d="${poly(cabinet)}" fill="none" stroke="${COLORS.ink900}" stroke-width="${n(size * 0.02)}"/>`);
  for (const [rx, ry] of [
    [x0 + size * 0.2, y0 + size * 0.14],
    [x0 + cabW - size * 0.14, y0 + size * 0.14],
    [x0 + size * 0.14, y0 + cabH - band - size * 0.14],
    [x0 + cabW - size * 0.2, y0 + cabH - band - size * 0.14],
  ]) {
    d.add(
      `<circle cx="${n(rx)}" cy="${n(ry)}" r="${n(size * 0.035)}" fill="#7d89ad" stroke="${COLORS.ink900}" stroke-width="${n(size * 0.012)}"/>`,
    );
  }
  for (const l of letters) {
    solidLetters(d, l.run, { x: x0 + l.x, y: y0 + l.y, size: l.size, lean }, letterStyle(l.tube, l.size, lit));
  }
  const by = y0 + cabH - band - size * 0.06;
  const lampsW = band * 3.4;
  const strip = chamferRect(x0 + size * 0.22, by, cabW - size * 0.22 - size * 0.12 - lampsW, band, 0);

  d.add(`<path d="${poly(strip)}" fill="url(#${chequerPattern(d, band / 2, COLORS.ink900, '#e9eefb', lean)})"/>`);
  d.add(`<path d="${poly(strip)}" fill="none" stroke="${COLORS.ink900}" stroke-width="1.5"/>`);
  const lampColors = [COLORS.danger, COLORS.danger, COLORS.go];

  for (let i = 0; i < 3; i++) {
    const cx = x0 + cabW - size * 0.12 - lampsW + band * 0.55 + i * band * 1.1;
    const cy = by + band / 2;
    const r = band * 0.42;
    const c = lampColors[i];

    d.add(`<circle cx="${n(cx)}" cy="${n(cy + r * 0.1)}" r="${n(r * 1.15)}" fill="${COLORS.ink900}"/>`);
    if (lit) {
      const halo = d.blur(r * 0.6);

      d.add(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 1.4)}" fill="${c}" opacity="0.7" filter="url(#${halo})"/>`);
    }
    const lens = d.rgrad(
      cx,
      cy,
      r,
      lit
        ? [
            [0, '#ffffff'],
            [0.4, c],
            [1, mix(c, '#000000', 0.5)],
          ]
        : [
            [0, '#2b345f'],
            [1, '#0b0f2c'],
          ],
      cy - r * 0.35,
    );

    d.add(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${lens})"/>`);
  }
  const signH = y0 + cabH + depth;
  const reflectH = reflect ? cabH * 0.55 : 0;
  const width = Math.ceil(x0 * 2 + cabW + depth * 0.3);
  const height = Math.ceil(signH + pad * 0.5 + reflectH);

  if (reflect) {
    const sign = d.ids.get('sign');
    const fade = d.vgrad(signH, signH + reflectH, [
      [0, '#ffffff', 0.6],
      [1, '#ffffff', 0],
    ]);
    const gap = size * 0.09;
    const ripple = d.def(
      'p',
      (id) =>
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="8" height="${n(gap)}">` +
        `<rect y="${n(gap * 0.62)}" width="8" height="${n(gap * 0.38)}" fill="#000000"/></pattern>`,
    );
    const mask = d.def(
      'm',
      (id) =>
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="${n(signH)}" width="${width}" height="${n(reflectH)}">` +
        `<rect x="0" y="${n(signH)}" width="${width}" height="${n(reflectH)}" fill="url(#${fade})"/>` +
        `<rect x="0" y="${n(signH)}" width="${width}" height="${n(reflectH)}" fill="url(#${ripple})"/></mask>`,
    );
    const blur = d.blur(size * 0.025);

    d.defs += `<g id="${sign}">${d.body}</g>`;
    d.body =
      `<use href="#${sign}" xlink:href="#${sign}"/>` +
      `<g mask="url(#${mask})"><g filter="url(#${blur})"><use href="#${sign}" xlink:href="#${sign}" ` +
      `transform="translate(0 ${n(signH * 2 + size * 0.04)}) scale(1 -1)"/></g></g>`;
  }

  return d.art(width, height, { face: { x: x0, y: y0, w: cabW, h: cabH + depth } });
}
