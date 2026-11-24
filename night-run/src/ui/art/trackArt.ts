/**
 * The track editor's board and every plan of a track, in the mini-map's language: dark asphalt with a cyan kerb over a
 * magenta glow and a faint dashed centre line. A board piece is one cell's road, keyed by the sides it opens onto, so
 * neighbouring pieces meet edge to edge; ghosts and the dashes that mark road about to go are drawn white and tinted.
 */

import type { ButtonState } from './buttons';
import { Draft } from './Draft';
import { minimapFit } from './hud';
import { plate } from './plate';
import type { Pt, SvgArt } from './svg';
import { chamferRect, n, poly } from './svg';
import { COLORS, RACERS } from './tokens';

/** Sides a piece opens onto, as bits: east 1, south 2, west 4, north 8. */
export type PieceMask = number;
/** How a piece is drawn: the road, a white ghost to tint, or white dashes to tint. */
export type PieceStyle = 'road' | 'ghost' | 'dash';

const ASPHALT = '#1a1f3e';

/** The road's width as a share of a cell. */
const ROAD = 0.56;

/** Padding round a piece's cell, for its glow. */
export function piecePad(cell: number): number {
  return Math.round(cell * 0.3);
}

/** The centreline of a piece in its art's px: midpoints of its open sides, joined straight or by a quarter arc. */
function pieceLine(mask: PieceMask, cell: number, pad: number): { d: string; caps: boolean } {
  const c = pad + cell / 2;
  const mid = [
    { x: pad + cell, y: c },
    { x: c, y: pad + cell },
    { x: pad, y: c },
    { x: c, y: pad },
  ];
  const sides = [0, 1, 2, 3].filter((s) => mask & (1 << s));

  if (sides.length === 0) return { d: `M${n(c - 0.01)} ${n(c)}L${n(c + 0.01)} ${n(c)}`, caps: true };
  if (sides.length === 1) {
    const m = mid[sides[0]];

    return { d: `M${n(m.x)} ${n(m.y)}L${n(c)} ${n(c)}`, caps: true };
  }

  const [a, b] = sides;
  const ma = mid[a];
  const mb = mid[b];

  if ((a + 2) % 4 === b) return { d: `M${n(ma.x)} ${n(ma.y)}L${n(mb.x)} ${n(mb.y)}`, caps: false };

  // A quarter arc round the cell corner the two sides share.
  const r = cell / 2;
  const sweep = (b - a + 4) % 4 === 1 ? 0 : 1;

  return { d: `M${n(ma.x)} ${n(ma.y)}A${n(r)} ${n(r)} 0 0 ${sweep} ${n(mb.x)} ${n(mb.y)}`, caps: false };
}

/**
 * One cell of road on the board.
 * @param mask - The sides it opens onto; 0 is a lone cell, one side an open end.
 * @param style - The road, or white to tint as a ghost or as hazard dashes.
 * @param cell - The cell's size in px.
 */
export function pieceSvg(mask: PieceMask, style: PieceStyle, cell: number): SvgArt {
  const pad = piecePad(cell);
  const size = cell + pad * 2;
  const d = new Draft();
  const { d: path, caps } = pieceLine(mask, cell, pad);
  const cap = caps ? 'round' : 'butt';
  const tw = cell * ROAD;
  const stroke = (color: string, width: number, extra = ''): string =>
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="${n(width)}" stroke-linecap="${cap}"${extra}/>`;

  if (style === 'road') {
    // The glow is stepped strokes, not a blur: a blur spills past the piece's edges and shows as a square there.
    d.add(stroke(COLORS.magenta, tw * 1.62, ' opacity="0.14"'));
    d.add(stroke(COLORS.magenta, tw * 1.4, ' opacity="0.22"'));
    d.add(stroke(COLORS.cyan, tw * 1.16));
    d.add(stroke(ASPHALT, tw));
    d.add(
      stroke(
        '#ffffff',
        tw * 0.07,
        ` stroke-opacity="0.24" stroke-dasharray="${n(cell / 8)} ${n(cell / 8)}" stroke-dashoffset="${n(cell / 16)}"`,
      ),
    );
  } else if (style === 'ghost') {
    d.add(stroke('#ffffff', tw * 1.16, ' opacity="0.95"'));
    d.add(stroke('#0c1234', tw * 0.92, ' opacity="0.72"'));
    d.add(stroke('#ffffff', tw * 0.92, ' opacity="0.22"'));
  } else {
    d.add(
      stroke(
        '#ffffff',
        tw * 0.9,
        ` stroke-dasharray="${n(cell / 7)} ${n(cell / 7)}" stroke-dashoffset="${n(cell / 14)}" opacity="0.95"`,
      ),
    );
  }

  return d.art(size, size, { face: { x: pad, y: pad, w: cell, h: cell } });
}

/**
 * The start line's cell, drawn for a race heading east (turn it for the others): a chequer band across the road at
 * the line, an arrow the way the race runs, and the four grid slots behind it in the racer colours.
 * @param cell - The cell's size in px.
 * @param bad - Drawn red: a place the start line can't go.
 */
export function startCellSvg(cell: number, bad = false): SvgArt {
  const pad = piecePad(cell);
  const size = cell + pad * 2;
  const d = new Draft();
  const c = pad + cell / 2;
  const tw = cell * ROAD;
  const band = Math.max(4, cell * 0.16);
  const rows = 4;
  const sq = tw / rows;
  const glow = d.blur(cell * 0.05);

  if (bad) {
    d.add(
      `<rect x="${n(c - band / 2 - 2)}" y="${n(c - tw / 2 - 2)}" width="${n(band + 4)}" height="${n(tw + 4)}" fill="${COLORS.danger}"/>`,
    );
  }

  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < 2; k++) {
      d.add(
        `<rect x="${n(c - band / 2 + (k * band) / 2)}" y="${n(c - tw / 2 + r * sq)}" width="${n(band / 2)}" ` +
          `height="${n(sq)}" fill="${(r + k) % 2 === 0 ? (bad ? COLORS.danger : '#ffffff') : COLORS.ink900}"/>`,
      );
    }
  }

  // The arrow ahead of the line.
  const ax = c + band / 2 + cell * 0.08;
  const ah = tw * 0.34;
  const aw = cell * 0.18;

  d.add(
    `<path d="M${n(ax)} ${n(c - ah)}L${n(ax + aw)} ${n(c)}L${n(ax)} ${n(c + ah)}Z" fill="${bad ? COLORS.danger : COLORS.white}" ` +
      `filter="url(#${glow})" opacity="0.6"/>`,
  );
  d.add(
    `<path d="M${n(ax)} ${n(c - ah)}L${n(ax + aw)} ${n(c)}L${n(ax)} ${n(c + ah)}Z" fill="${bad ? COLORS.danger : COLORS.white}"/>`,
  );

  // The grid behind it: two rows of two.
  const r = Math.max(1.6, cell * 0.055);

  for (let i = 0; i < 4; i++) {
    const gx = c - band / 2 - cell * (0.12 + Math.floor(i / 2) * 0.17);
    const gy = c + (i % 2 === 0 ? -1 : 1) * tw * 0.22;

    d.add(
      `<circle cx="${n(gx)}" cy="${n(gy)}" r="${n(r)}" fill="${RACERS[i].main}" stroke="${COLORS.ink900}" stroke-width="${n(r * 0.5)}"/>`,
    );
  }

  return d.art(size, size, { face: { x: pad, y: pad, w: cell, h: cell }, anchor: { x: 0.5, y: 0.5 } });
}

/**
 * An open end's knob: an amber cap ringed in white with a glow, sized to the cell.
 * @param cell - The cell's size in px.
 */
export function knobSvg(cell: number): SvgArt {
  const r = cell * 0.24;
  const pad = Math.ceil(r * 0.8);
  const size = Math.ceil(r * 2 + pad * 2);
  const c = size / 2;
  const d = new Draft();
  const glow = d.blur(r * 0.35);

  d.add(
    `<circle cx="${n(c)}" cy="${n(c)}" r="${n(r * 1.05)}" fill="${COLORS.amber}" opacity="0.7" filter="url(#${glow})"/>`,
  );
  d.add(
    `<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="${COLORS.amber}" stroke="${COLORS.white}" stroke-width="${n(r * 0.22)}"/>`,
  );
  d.add(`<circle cx="${n(c)}" cy="${n(c)}" r="${n(r * 0.36)}" fill="${COLORS.white}"/>`);

  return d.art(size, size, { anchor: { x: 0.5, y: 0.5 } });
}

/**
 * A soft dot of light: the direction light that runs round the loop.
 * @param r - Radius in px.
 * @param color - Its colour.
 */
export function glowDotSvg(r: number, color: string = COLORS.white): SvgArt {
  const pad = Math.ceil(r * 1.4);
  const size = Math.ceil(r * 2 + pad * 2);
  const c = size / 2;
  const d = new Draft();
  const glow = d.blur(r * 0.6);

  d.add(`<circle cx="${n(c)}" cy="${n(c)}" r="${n(r * 1.4)}" fill="${color}" opacity="0.75" filter="url(#${glow})"/>`);
  d.add(`<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="${COLORS.white}"/>`);

  return d.art(size, size, { anchor: { x: 0.5, y: 0.5 } });
}

/**
 * A track's plan for a card: the mini-map's drawing of the loop with its start tick, or a draft's open road ending in
 * amber caps.
 * @param points - The centreline, any scale; for a loop the first point is the start line.
 * @param closed - A loop, or a draft's open road.
 * @param width - Width in px.
 * @param height - Height in px.
 */
export function planSvg(points: readonly Pt[], closed: boolean, width: number, height: number): SvgArt {
  const d = new Draft();

  if (points.length === 0) return d.art(width, height);

  const fit = minimapFit(points, width, height);
  const pts = points.map((p) => ({ x: fit.x + p.x * fit.scale, y: fit.y + p.y * fit.scale }));
  const path = `M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}${closed ? 'Z' : ''}`;
  const tw = Math.max(4, Math.min(width, height) * 0.075);
  const glow = d.blur(tw * 0.5);
  const cap = closed ? 'butt' : 'round';

  d.add(
    `<path d="${path}" fill="none" stroke="${COLORS.magenta}" stroke-width="${n(tw * 1.9)}" stroke-linejoin="round" stroke-linecap="${cap}" opacity="0.45" filter="url(#${glow})"/>`,
  );
  d.add(
    `<path d="${path}" fill="none" stroke="${COLORS.cyan}" stroke-width="${n(tw * 1.45)}" stroke-linejoin="round" stroke-linecap="${cap}"/>`,
  );
  d.add(
    `<path d="${path}" fill="none" stroke="${ASPHALT}" stroke-width="${n(tw * 1.1)}" stroke-linejoin="round" stroke-linecap="${cap}"/>`,
  );

  if (closed && pts.length > 1) {
    const a = pts[0];
    const b = pts[1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);

    d.add(
      `<g transform="translate(${n(a.x)} ${n(a.y)}) rotate(${n(ang)})"><rect x="${n(-tw * 0.3)}" y="${n(-tw * 0.75)}" ` +
        `width="${n(tw * 0.6)}" height="${n(tw * 1.5)}" fill="#ffffff"/><rect x="${n(-tw * 0.3)}" y="${n(-tw * 0.75)}" ` +
        `width="${n(tw * 0.3)}" height="${n(tw * 0.5)}" fill="${COLORS.ink900}"/><rect x="0" y="${n(-tw * 0.25)}" ` +
        `width="${n(tw * 0.3)}" height="${n(tw * 0.5)}" fill="${COLORS.ink900}"/><rect x="${n(-tw * 0.3)}" y="${n(tw * 0.25)}" ` +
        `width="${n(tw * 0.3)}" height="${n(tw * 0.5)}" fill="${COLORS.ink900}"/></g>`,
    );
  } else if (!closed) {
    for (const p of [pts[0], pts[pts.length - 1]]) {
      d.add(
        `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(tw * 0.55)}" fill="${COLORS.amber}" stroke="${COLORS.white}" stroke-width="${n(tw * 0.15)}"/>`,
      );
    }
  }

  return d.art(width, height);
}

/**
 * A track's tile in My tracks: a slate like the editor's board, its faint grid behind where the plan goes and a name
 * strip along the bottom. Hover lifts the rim; `lit` (the track shown beside the grid) rings it cyan and glows.
 * @param width - Face width in px.
 * @param height - Face height in px.
 * @param strip - The name strip's height in px.
 * @param state - The button state.
 * @param lit - The selected track's tile.
 */
export function trackTileSvg(width: number, height: number, strip: number, state: ButtonState, lit: boolean): SvgArt {
  const d = new Draft();
  const pad = 16;
  const sink = state === 'press' ? 2 : 0;
  const pts = chamferRect(pad, pad + sink, width, height, [12, 3.6, 12, 3.6]);
  const hot = state === 'hover' || state === 'focus';

  plate(d, pts, {
    face: ['#151a3a', '#070a1c'],
    faceOpacity: 0.96,
    depth: 4 - sink,
    side: [COLORS.ink800, COLORS.ink900],
    rim: lit ? COLORS.cyan : hot ? '#c9d3ff' : '#6d7bc4',
    rimOpacity: lit ? 0.9 : 0.55,
    rimWidth: lit ? 2 : 1.5,
    glow: lit ? { color: COLORS.cyan, blur: 9, opacity: 0.55 } : undefined,
    shadow: 0.55,
  });

  const clip = d.clip(poly(pts));
  const top = pad + sink;
  const gridH = height - strip;
  const step = Math.max(14, Math.round(gridH / 6));
  let grid = '';

  for (let x = pad + step; x < pad + width; x += step) grid += `M${n(x)} ${n(top)}V${n(top + gridH)}`;
  for (let y = top + step; y < top + gridH; y += step) grid += `M${pad} ${n(y)}H${n(pad + width)}`;

  d.add(`<path d="${grid}" stroke="${COLORS.line}" stroke-opacity="0.28" stroke-width="1" clip-path="url(#${clip})"/>`);
  d.add(
    `<rect x="${pad}" y="${n(top + gridH)}" width="${width}" height="${strip}" fill="${lit ? COLORS.ink600 : COLORS.ink700}" ` +
      `clip-path="url(#${clip})"/>`,
  );
  d.add(
    `<path d="M${pad} ${n(top + gridH)}H${n(pad + width)}" stroke="${lit ? COLORS.cyan : COLORS.line}" stroke-width="${lit ? 2 : 1}" ` +
      `clip-path="url(#${clip})"/>`,
  );
  d.add(
    `<path d="${poly(pts)}" fill="none" stroke="${lit ? COLORS.cyan : hot ? '#c9d3ff' : COLORS.line}" ` +
      `stroke-width="${lit ? 2.5 : 1.5}" opacity="${state === 'disabled' ? 0.5 : 1}"/>`,
  );

  return d.art(width + pad * 2, height + pad * 2 + 4, {
    face: { x: pad, y: pad, w: width, h: height },
    content: { x: pad, y: top, w: width, h: height },
  });
}

/**
 * A dashed card outline, for My tracks' New track tile.
 * @param width - Width in px.
 * @param height - Height in px.
 */
export function dashedCardSvg(width: number, height: number): SvgArt {
  const d = new Draft();
  const pad = 4;

  d.add(
    `<path d="M${pad + 14} ${pad}H${n(width - pad)}V${n(height - pad - 14)}L${n(width - pad - 14)} ${n(height - pad)}H${pad}V${pad + 14}Z" ` +
      `fill="${COLORS.ink800}" fill-opacity="0.6" stroke="${COLORS.cyan}" stroke-width="2" stroke-dasharray="10 7" opacity="0.85"/>`,
  );

  return d.art(width, height, { face: { x: 0, y: 0, w: width, h: height } });
}
