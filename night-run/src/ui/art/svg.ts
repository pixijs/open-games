/** Insets, in CSS px, a `NineSliceSprite` keeps unstretched. */
export interface SliceInsets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * One piece of UI art: a complete SVG document and its size in CSS px. `slice` is set on art made to stretch with
 * `NineSliceSprite`; `anchor` is where the art's visual centre or pivot sits, as 0 to 1 of its size, when that isn't
 * the middle (padding for glow and shadow is part of the size). `content` is the box, in the art's px, where pixi
 * Text or a child sprite goes: a button's face, a card's name area. `face` is the visible plate's box at rest, without
 * the padding for glow and shadow: lay screens out by faces.
 */
export interface SvgArt {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly slice?: SliceInsets;
  readonly anchor?: { readonly x: number; readonly y: number };
  readonly content?: Box;
  readonly face?: Box;
}

/** A box in px. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A 2D point. */
export interface Pt {
  x: number;
  y: number;
}

/** Rounds to 2 decimals so the markup stays short. */
export function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Wraps defs and body into an SVG document `width` by `height` CSS px. */
export function doc(width: number, height: number, defs: string, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(width)}" ` +
    `height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">` +
    (defs ? `<defs>${defs}</defs>` : '') +
    body +
    '</svg>'
  );
}

/** A gradient stop: offset 0 to 1, colour, and opacity (1 when left out). */
export type Stop = readonly [number, string, number?];

/** Path data for a closed polygon. */
export function poly(points: Pt[]): string {
  return `M${points.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}Z`;
}

/** Moves every point by `dx`, `dy`. */
export function shift(points: Pt[], dx: number, dy: number): Pt[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** A rectangle with every corner cut at 45 degrees by `c`, clockwise from the top-left cut. */
export function chamferRect(x: number, y: number, w: number, h: number, c: number | readonly number[]): Pt[] {
  const [tl, tr, br, bl] = typeof c === 'number' ? [c, c, c, c] : c;

  return [
    { x: x + tl, y },
    { x: x + w - tr, y },
    { x: x + w, y: y + tr },
    { x: x + w, y: y + h - br },
    { x: x + w - br, y: y + h },
    { x: x + bl, y: y + h },
    { x, y: y + h - bl },
    { x, y: y + tl },
  ].filter((p, i, all) => i === 0 || p.x !== all[i - 1].x || p.y !== all[i - 1].y);
}

/**
 * A parallelogram leaning right by `lean` degrees, with its two sharp corners cut by `c` so they don't spike. `x` is
 * the left edge of the bottom side.
 */
export function slantRect(x: number, y: number, w: number, h: number, lean: number, c = 0): Pt[] {
  const s = h * Math.tan((lean * Math.PI) / 180);
  const len = Math.hypot(s, h);
  const ux = (s / len) * c;
  const uy = (h / len) * c;

  if (c <= 0) {
    return [
      { x: x + s, y },
      { x: x + w, y },
      { x: x + w - s, y: y + h },
      { x, y: y + h },
    ];
  }

  return [
    { x: x + s, y },
    { x: x + w - c, y },
    { x: x + w - ux, y: y + uy },
    { x: x + w - s, y: y + h },
    { x: x + c, y: y + h },
    { x: x + ux, y: y + h - uy },
  ];
}

/** How far a shape `h` tall shifts sideways when it leans `lean` degrees. */
export function leanShift(h: number, lean: number): number {
  return h * Math.tan((lean * Math.PI) / 180);
}

/** Insets every edge of a convex polygon inward by `d` (approximate for chamfers, exact for straight runs). */
export function inset(points: Pt[], d: number): Pt[] {
  const count = points.length;
  let area = 0;

  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % count];

    area += a.x * b.y - b.x * a.y;
  }
  const sign = area > 0 ? 1 : -1;
  const lines = points.map((a, i) => {
    const b = points[(i + 1) % count];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / len) * sign;
    const ny = ((b.x - a.x) / len) * sign;

    return { a: { x: a.x + nx * d, y: a.y + ny * d }, b: { x: b.x + nx * d, y: b.y + ny * d } };
  });

  return lines.map((l1, i) => {
    const l0 = lines[(i - 1 + count) % count];

    return intersect(l0.a, l0.b, l1.a, l1.b) ?? l1.a;
  });
}

function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);

  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;

  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** The convex hull of a polygon and itself moved by `dx`, `dy`: the side walls of an extruded convex shape. */
export function extrude(points: Pt[], dx: number, dy: number): Pt[] {
  return hull([...points, ...shift(points, dx, dy)]);
}

function hull(pts: Pt[]): Pt[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  const upper: Pt[] = [];

  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];

    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();

  return [...lower, ...upper];
}

/** The bounding box of a set of points. */
export function bounds(points: Pt[]): { x: number; y: number; w: number; h: number } {
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

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Mixes two `#rrggbb` colours, `t` 0 gives `a`. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number => {
    const ca = (pa >> shift) & 255;
    const cb = (pb >> shift) & 255;

    return Math.round(ca + (cb - ca) * t);
  };

  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}
