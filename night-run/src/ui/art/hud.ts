import { Draft } from './Draft';
import { glyphRun, paintedLetters, runWidth } from './glyphs';
import { plate } from './plate';
import type { Pt, SvgArt } from './svg';
import { chamferRect, inset, mix, n, poly, slantRect } from './svg';
import type { RacerColor } from './tokens';
import { COLORS } from './tokens';

/** Segments round the speed dial. */
export const SPEED_SEGMENTS = 24;
/** Segments from this index up are the red line. */
export const SPEED_REDLINE = 19;
const ARC_START = 145;
const ARC_END = 395;

/** Where one dial segment sits: centre in the dial art's px and rotation in radians. */
export interface SegmentPlace {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

/** The size of the dial's padding, so geometry and art agree. */
function dialPad(size: number): number {
  return Math.round(size * 0.1);
}

/**
 * Where each lit segment goes on a speed dial of `size`: the builder places one {@link gaugeSegmentSvg} sprite per
 * entry (one texture, one batch) and lights the first `speed / max * count` of them.
 * @param size - Dial size in px, as passed to {@link speedDialSvg}.
 */
export function speedDialGeometry(size = 168): SegmentPlace[] {
  const c = dialPad(size) + size / 2;
  const r = size * 0.39;
  const out: SegmentPlace[] = [];

  for (let i = 0; i < SPEED_SEGMENTS; i++) {
    const a = ((ARC_START + ((ARC_END - ARC_START) * (i + 0.5)) / SPEED_SEGMENTS) * Math.PI) / 180;

    out.push({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r, rotation: a + Math.PI / 2 });
  }

  return out;
}

/**
 * The speed dial's frame: an octagonal smoked plate with a ring of dark segment wells (the last ones tinted for the
 * red line) and ticks. The speed number sits in `content`; the boost meter tucks into the open bottom.
 * @param size - Plate size in px.
 */
export function speedDialSvg(size = 168): SvgArt {
  const pad = dialPad(size);
  const d = new Draft();
  const pts = chamferRect(pad, pad, size, size, size * 0.29);

  plate(d, pts, {
    face: ['#18215a', '#090d2c'],
    faceOpacity: 0.86,
    depth: 4,
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#9fb0ff',
    rimOpacity: 0.45,
    tape: { color: COLORS.cyan, width: 1.5, inset: 4, opacity: 0.35 },
    shadow: 0.5,
    shade: 0.3,
  });
  const seg = segmentShape(size);

  speedDialGeometry(size).forEach((p, i) => {
    d.add(
      `<g transform="translate(${n(p.x)} ${n(p.y)}) rotate(${n((p.rotation * 180) / Math.PI)})">` +
        `<path d="${poly(seg)}" fill="${i >= SPEED_REDLINE ? '#3a0f3a' : '#0a1036'}" stroke="${i >= SPEED_REDLINE ? '#6a1858' : '#26306c'}" stroke-width="1"/></g>`,
    );
  });
  const c = pad + size / 2;
  const r0 = size * 0.47;
  const r1 = size * 0.445;

  for (let i = 0; i <= 8; i++) {
    const a = ((ARC_START + ((ARC_END - ARC_START) * i) / 8) * Math.PI) / 180;

    d.add(
      `<path d="M${n(c + Math.cos(a) * r0)} ${n(c + Math.sin(a) * r0)}L${n(c + Math.cos(a) * r1)} ${n(c + Math.sin(a) * r1)}" ` +
        `stroke="${COLORS.mist}" stroke-opacity="0.6" stroke-width="1.6"/>`,
    );
  }

  return d.art(size + pad * 2, size + pad * 2 + 4, {
    anchor: { x: 0.5, y: 0.5 },
    content: { x: pad + size * 0.2, y: pad + size * 0.26, w: size * 0.6, h: size * 0.42 },
    face: { x: pad, y: pad, w: size, h: size },
  });
}

function segmentShape(size: number): Pt[] {
  const l = size * 0.075;
  const t = size * 0.032;

  return slantRect(-t / 2, -l / 2, t, l, 0).map((p) => ({ x: p.x, y: p.y }));
}

/**
 * A dial segment's state: `on` cyan, `hot` the magenta red line, `boost` white-hot while boosting, `off` the dark well
 * (the phone strip lays wells under its lit segments; the dial draws its own).
 */
export type SegmentState = 'on' | 'hot' | 'boost' | 'off';

/**
 * One lit segment for the speed dial, centred on its anchor.
 * @param state - Its colour.
 * @param size - The dial's size, so the segment matches its wells.
 */
export function gaugeSegmentSvg(state: SegmentState = 'on', size = 168): SvgArt {
  const seg = segmentShape(size);
  const pad = size * 0.04;
  const w = size * 0.032 + pad * 2;
  const h = size * 0.075 + pad * 2;
  const d = new Draft();
  const color = state === 'hot' ? COLORS.magenta : state === 'boost' ? '#ffffff' : COLORS.cyan;
  const glow = d.blur(size * 0.012);
  const at = `translate(${n(w / 2)} ${n(h / 2)})`;

  if (state === 'off') {
    d.add(`<g transform="${at}"><path d="${poly(seg)}" fill="#0a1036" stroke="#26306c" stroke-width="1"/></g>`);

    return d.art(Math.ceil(w), Math.ceil(h), { anchor: { x: 0.5, y: 0.5 } });
  }

  d.add(
    `<g transform="${at}"><path d="${poly(inset(seg, -1.5))}" fill="${color}" opacity="0.6" filter="url(#${glow})"/>`,
  );
  d.add(
    `<path d="${poly(seg)}" fill="${color}"/><path d="${poly(inset(seg, 1))}" fill="#ffffff" opacity="${state === 'boost' ? 1 : 0.45}"/></g>`,
  );

  return d.art(Math.ceil(w), Math.ceil(h), { anchor: { x: 0.5, y: 0.5 } });
}

/** A charge-meter chevron: the empty socket, lit while the drift charge builds, or lit once the ultra is ready. */
export type ChevronState = 'off' | 'charging' | 'ready';

/** Chevron colours, matched to the game's charge sparks: blue as the charge builds, purple once the ultra is ready. */
const CHEVRON_COLORS = { off: '#4fc3ff', charging: '#4fc3ff', ready: '#e070ff' } as const;

/**
 * One chevron of the boost meter: three sit side by side and light one after another as a held slide charges the
 * ultra boost.
 * @param state - Empty, charging or ready.
 * @param size - Height in px.
 */
export function boostChevronSvg(state: ChevronState, size = 28): SvgArt {
  const d = new Draft();
  const pad = size * 0.3;
  const w = size * 0.8;
  const lit = state !== 'off';
  const color = CHEVRON_COLORS[state];
  const pts: Pt[] = [
    { x: pad, y: pad },
    { x: pad + w * 0.45, y: pad },
    { x: pad + w, y: pad + size / 2 },
    { x: pad + w * 0.45, y: pad + size },
    { x: pad, y: pad + size },
    { x: pad + w * 0.55, y: pad + size / 2 },
  ];

  if (lit) {
    const glow = d.blur(size * 0.14);

    d.add(`<path d="${poly(pts)}" fill="${color}" opacity="0.85" filter="url(#${glow})"/>`);
  }
  const g = d.vgrad(
    pad,
    pad + size,
    lit
      ? [
          [0, mix(color, '#ffffff', 0.6)],
          [1, color],
        ]
      : [
          [0, '#1a2256'],
          [1, '#0a0f30'],
        ],
  );

  d.add(
    `<path d="${poly(pts)}" fill="url(#${g})" stroke="${lit ? mix(color, '#000000', 0.5) : COLORS.line}" stroke-width="1.4" stroke-linejoin="miter"/>`,
  );

  return d.art(Math.ceil(w + pad * 2), Math.ceil(size + pad * 2), { anchor: { x: 0.5, y: 0.5 } });
}

/**
 * The mini-map's frame: a smoked chamfered plate with corner marks, like a broadcast's track map.
 * @param width - Width in px.
 * @param height - Height in px.
 */
export function minimapFrameSvg(width = 180, height = 180): SvgArt {
  const pad = 12;
  const d = new Draft();
  const pts = chamferRect(pad, pad, width, height, [16, 5, 16, 5]);

  plate(d, pts, {
    face: ['#141c4e', '#070b26'],
    faceOpacity: 0.78,
    depth: 3,
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#9fb0ff',
    rimOpacity: 0.35,
    shadow: 0.45,
  });
  const m = 8;
  const l = 12;
  const corners = [
    `M${pad + m + 8} ${pad + m}h${l}M${pad + m} ${pad + m + 8}v${l}`,
    `M${pad + width - m - l} ${pad + m}h${l}v${l}`,
    `M${pad + width - m - 8} ${pad + height - m}h${-l}M${pad + width - m} ${pad + height - m - 8}v${-l}`,
    `M${pad + m + l} ${pad + height - m}h${-l}v${-l}`,
  ];

  d.add(`<path d="${corners.join('')}" fill="none" stroke="${COLORS.cyan}" stroke-opacity="0.7" stroke-width="2"/>`);

  return d.art(width + pad * 2, height + pad * 2 + 3, {
    content: { x: pad, y: pad, w: width, h: height },
    face: { x: pad, y: pad, w: width, h: height },
  });
}

/**
 * How the mini-map fits the track into its area, keeping its shape: a point `p` in the track's 0 to 1 coordinates
 * lands at `x + p.x * scale`, `y + p.y * scale`. The builder places racer dots with the same numbers.
 * @param points - The track's centre line.
 * @param width - Width of the map area in px.
 * @param height - Height of the map area in px.
 */
export function minimapFit(
  points: readonly Pt[],
  width: number,
  height: number,
): { x: number; y: number; scale: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const m = Math.min(width, height) * 0.13;
  const scale = Math.min((width - m * 2) / Math.max(1e-6, x1 - x0), (height - m * 2) / Math.max(1e-6, y1 - y0));

  return {
    x: (width - (x1 - x0) * scale) / 2 - x0 * scale,
    y: (height - (y1 - y0) * scale) / 2 - y0 * scale,
    scale,
  };
}

/**
 * The track drawn for the mini-map: asphalt with white kerbs, a neon edge glow and a chequer tick at the finish.
 * `points` is the track's centre line as a closed loop (the builder projects the game's track onto the map, any
 * scale; it is fitted with {@link minimapFit}); the first point is the finish line.
 * @param points - The centre line, 0 to 1 in x and y.
 * @param width - Width in px of the area the track fills (same as the frame's content).
 * @param height - Height in px.
 */
export function minimapTrackSvg(points: readonly Pt[], width = 180, height = 180): SvgArt {
  const d = new Draft();
  const fit = minimapFit(points, width, height);
  const pts = points.map((p) => ({ x: fit.x + p.x * fit.scale, y: fit.y + p.y * fit.scale }));
  const path = `M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}Z`;
  const tw = Math.max(5, Math.min(width, height) * 0.085);
  const glow = d.blur(tw * 0.5);

  d.add(
    `<path d="${path}" fill="none" stroke="${COLORS.magenta}" stroke-width="${n(tw * 1.9)}" stroke-linejoin="round" opacity="0.45" filter="url(#${glow})"/>`,
  );
  d.add(
    `<path d="${path}" fill="none" stroke="${COLORS.cyan}" stroke-width="${n(tw * 1.45)}" stroke-linejoin="round"/>`,
  );
  d.add(`<path d="${path}" fill="none" stroke="#1a1f3e" stroke-width="${n(tw * 1.1)}" stroke-linejoin="round"/>`);
  d.add(
    `<path d="${path}" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="${n(tw * 0.12)}" stroke-dasharray="${n(tw * 0.5)} ${n(tw * 0.5)}" stroke-linejoin="round"/>`,
  );
  const a = pts[0];
  const b = pts[1];
  const ang = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
  const cell = tw * 0.36;

  d.add(
    `<g transform="translate(${n(a.x)} ${n(a.y)}) rotate(${n(ang)})"><rect x="${n(-cell)}" y="${n(-tw * 0.75)}" width="${n(cell * 2)}" ` +
      `height="${n(tw * 1.5)}" fill="#ffffff"/><path d="M${n(-cell)} ${n(-tw * 0.75)}h${n(cell)}v${n(cell)}h${n(-cell)}Z` +
      `M0 ${n(-tw * 0.75 + cell)}h${n(cell)}v${n(cell)}h${n(-cell)}ZM${n(-cell)} ${n(-tw * 0.75 + cell * 2)}h${n(cell)}v${n(cell)}h${n(-cell)}Z` +
      `M0 ${n(-tw * 0.75 + cell * 3)}h${n(cell)}v${n(tw * 1.5 - cell * 3)}h${n(-cell)}Z" fill="${COLORS.ink900}"/></g>`,
  );

  return d.art(width, height);
}

/**
 * A racer's dot on the mini-map. Others are a disc in their colour with their place drawn in it, so nobody has to
 * tell red from green; you are an arrow in your colour inside a cyan ring, pointing up (rotate it to your heading).
 * Swap the texture when a place changes (16 textures cover every racer and place; load them with the HUD).
 * @param color - The racer colour.
 * @param options - Size in px, whether it's you, and the place to draw in the dot.
 */
export function racerDotSvg(color: RacerColor, options: { size?: number; you?: boolean; place?: number } = {}): SvgArt {
  const size = options.size ?? (options.you ? 22 : options.place ? 17 : 14);
  const pad = Math.ceil(size * 0.3);
  const c = pad + size / 2;
  const d = new Draft();
  const g = d.rgrad(
    c,
    c,
    size / 2,
    [
      [0, color.hi],
      [0.6, color.main],
      [1, color.deep],
    ],
    c - size * 0.2,
  );

  if (options.you) {
    const glow = d.blur(size * 0.15);

    d.add(
      `<circle cx="${n(c)}" cy="${n(c)}" r="${n(size * 0.55)}" fill="${COLORS.cyan}" opacity="0.6" filter="url(#${glow})"/>`,
    );
    d.add(
      `<circle cx="${n(c)}" cy="${n(c)}" r="${n(size * 0.5)}" fill="${COLORS.ink900}" stroke="${COLORS.cyan}" stroke-width="2"/>`,
    );
    const r = size * 0.36;
    const arrow = `M${n(c)} ${n(c - r)}L${n(c + r * 0.8)} ${n(c + r * 0.75)}L${n(c)} ${n(c + r * 0.35)}L${n(c - r * 0.8)} ${n(c + r * 0.75)}Z`;

    d.add(`<path d="${arrow}" fill="url(#${g})" stroke="${COLORS.white}" stroke-width="1.2" stroke-linejoin="miter"/>`);
  } else {
    d.add(`<circle cx="${n(c)}" cy="${n(c + 1)}" r="${n(size / 2 + 1)}" fill="${COLORS.ink900}"/>`);
    d.add(
      `<circle cx="${n(c)}" cy="${n(c)}" r="${n(size / 2)}" fill="url(#${g})" stroke="${COLORS.ink900}" stroke-width="1.6"/>`,
    );
    if (options.place) {
      const run = glyphRun(String(options.place));
      const k = size * 0.56;

      paintedLetters(d, run, { x: c - runWidth(run, k, 0) / 2 + k * 0.04, y: c - k / 2, size: k, lean: 0 }, color.on);
    } else {
      d.add(
        `<circle cx="${n(c - size * 0.12)}" cy="${n(c - size * 0.15)}" r="${n(size * 0.14)}" fill="#ffffff" opacity="0.75"/>`,
      );
    }
  }

  return d.art(Math.ceil(size + pad * 2), Math.ceil(size + pad * 2), {
    anchor: { x: 0.5, y: 0.5 },
    face: { x: pad, y: pad, w: size, h: size },
  });
}

/**
 * A meter for a time running out (the lobby countdown on the results, Start anyway, the race closing): a recessed
 * `track` and a lit `fill` that stretches with `slice` and shrinks as the time drains. Lay the fill over the track,
 * inset by `content`.
 * @param part - The track or the fill.
 * @param options - Width and height in px, and the fill colour.
 */
export function meterSvg(
  part: 'track' | 'fill',
  options: { width?: number; height?: number; color?: string } = {},
): SvgArt {
  const w = options.width ?? 200;
  const h = options.height ?? 10;
  const color = options.color ?? COLORS.cyan;
  const pad = Math.ceil(h * 0.6);
  const d = new Draft();
  const pts = slantRect(pad, pad, w, h, 12, 0);
  const edge = pad + h * 0.4 + 2;

  if (part === 'track') {
    plate(d, pts, {
      face: [COLORS.ink900, COLORS.ink800],
      faceOpacity: 0.9,
      tape: { color: COLORS.line, width: 1, inset: 0.5, opacity: 0.9 },
    });
  } else {
    const glow = d.blur(h * 0.35);

    d.add(`<path d="${poly(pts)}" fill="${color}" opacity="0.55" filter="url(#${glow})"/>`);
    plate(d, pts, { face: [mix(color, '#ffffff', 0.55), color], rim: '#ffffff', rimOpacity: 0.8 });
  }

  return d.art(w + pad * 2, h + pad * 2, {
    slice: { left: edge, right: edge, top: 0, bottom: 0 },
    content: { x: pad + 2, y: pad + 2, w: w - 4, h: h - 4 },
    face: { x: pad, y: pad, w, h },
  });
}
