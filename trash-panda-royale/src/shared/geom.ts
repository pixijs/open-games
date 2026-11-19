/**
 * Plane geometry for building the town (polylines, turned rectangles, polygons) and a hash for
 * per-item random numbers. Pure and deterministic: the server and every client build the same
 * town with it.
 */

export interface P2 { x: number; z: number }

/** A turned rectangle (see `Obb` in map.ts): world → local is lx = dx·c − dz·s, lz = dx·s + dz·c. */
export interface Rect { cx: number; cz: number; hx: number; hz: number; c: number; s: number }

/** A polyline with its cumulative lengths. */
export interface Line { pts: P2[]; cum: number[]; len: number }

export function makeLine(pts: P2[]): Line {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** The point at arc length `s` along `l` (clamped), and the unit direction there. */
export function lineAt(l: Line, s: number, out: { x: number; z: number; dx: number; dz: number } = { x: 0, z: 0, dx: 0, dz: 0 }) {
  const { pts, cum } = l;
  if (s <= 0) s = 0;
  if (s >= l.len) s = l.len;
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1;
  const t = (s - cum[i - 1]) / seg;
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.dx = (b.x - a.x) / seg;
  out.dz = (b.z - a.z) / seg;
  return out;
}

/** The part of `l` from arc length s0 to s1, as points. */
export function subLine(l: Line, s0: number, s1: number): P2[] {
  const out: P2[] = [];
  const a = lineAt(l, s0);
  out.push({ x: a.x, z: a.z });
  for (let i = 1; i < l.pts.length - 1; i++) if (l.cum[i] > s0 && l.cum[i] < s1) out.push({ x: l.pts[i].x, z: l.pts[i].z });
  const b = lineAt(l, s1);
  out.push({ x: b.x, z: b.z });
  return out;
}

/** Points along an arc around (cx, cz) of radius r, from angle a0 to a1 (radians, atan2(z, x)), `n` segments. */
export function arcPoints(cx: number, cz: number, r: number, a0: number, a1: number, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return out;
}

/** Distance from point p to segment ab. */
export function distPointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t - px, z = az + dz * t - pz;
  return Math.sqrt(x * x + z * z);
}

/** Distance from point p to polyline `l`. */
export function distPointLine(px: number, pz: number, l: Line): number {
  let d = Infinity;
  for (let i = 1; i < l.pts.length; i++) d = Math.min(d, distPointSeg(px, pz, l.pts[i - 1].x, l.pts[i - 1].z, l.pts[i].x, l.pts[i].z));
  return d;
}

/** A rectangle's four corners (world), counter-clockwise in its own frame. */
export function rectCorners(r: Rect): P2[] {
  // local x runs along (c, −s), local z along (s, c)
  const ax = r.hx * r.c, az = -r.hx * r.s, bx = r.hz * r.s, bz = r.hz * r.c;
  return [
    { x: r.cx - ax - bx, z: r.cz - az - bz }, { x: r.cx + ax - bx, z: r.cz + az - bz },
    { x: r.cx + ax + bx, z: r.cz + az + bz }, { x: r.cx - ax + bx, z: r.cz - az + bz },
  ];
}

/** A rectangle's bounds. */
export function rectBounds(r: Rect) {
  const ex = Math.abs(r.hx * r.c) + Math.abs(r.hz * r.s), ez = Math.abs(r.hx * r.s) + Math.abs(r.hz * r.c);
  return { minX: r.cx - ex, minZ: r.cz - ez, maxX: r.cx + ex, maxZ: r.cz + ez };
}

/** Is point p inside rectangle r (grown by `pad`)? */
export function inRect(r: Rect, x: number, z: number, pad = 0): boolean {
  const dx = x - r.cx, dz = z - r.cz;
  const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
  return Math.abs(lx) <= r.hx + pad && Math.abs(lz) <= r.hz + pad;
}

/** Distance from point p to rectangle r (0 inside). */
export function distPointRect(r: Rect, x: number, z: number): number {
  const dx = x - r.cx, dz = z - r.cz;
  const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
  const ex = Math.max(0, Math.abs(lx) - r.hx), ez = Math.max(0, Math.abs(lz) - r.hz);
  return Math.sqrt(ex * ex + ez * ez);
}

function orient(p: P2, q: P2, r: P2) { return (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x); }

/** Do segments ab and cd cross? */
function segsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Distance from rectangle r to segment ab (0 if they touch). */
export function distRectSeg(r: Rect, a: P2, b: P2): number {
  if (inRect(r, a.x, a.z) || inRect(r, b.x, b.z)) return 0;
  const k = rectCorners(r);
  let d = Math.min(distPointRect(r, a.x, a.z), distPointRect(r, b.x, b.z));
  for (let i = 0; i < 4; i++) {
    const p = k[i], q = k[(i + 1) % 4];
    if (segsCross(p, q, a, b)) return 0;
    d = Math.min(d, distPointSeg(p.x, p.z, a.x, a.z, b.x, b.z));
  }
  return d;
}

/** Distance from rectangle r to polyline `l`. */
export function distRectLine(r: Rect, l: Line): number {
  let d = Infinity;
  for (let i = 1; i < l.pts.length && d > 0; i++) d = Math.min(d, distRectSeg(r, l.pts[i - 1], l.pts[i]));
  return d;
}

/** Is rectangle r at least `min` from polyline `l` (segments whose bounds are farther don't need measuring)? */
export function rectClearOfLine(r: Rect, l: Line, min: number): boolean {
  const b = rectBounds(r);
  for (let i = 1; i < l.pts.length; i++) {
    const p = l.pts[i - 1], q2 = l.pts[i];
    if (Math.min(p.x, q2.x) > b.maxX + min || Math.max(p.x, q2.x) < b.minX - min) continue;
    if (Math.min(p.z, q2.z) > b.maxZ + min || Math.max(p.z, q2.z) < b.minZ - min) continue;
    if (distRectSeg(r, p, q2) < min) return false;
  }
  return true;
}

/** Do rectangles a and b overlap, once each is grown by `pad`? (Separating axes.) */
export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  const axes = [[a.c, -a.s], [a.s, a.c], [b.c, -b.s], [b.s, b.c]];
  for (const [ax, az] of axes) {
    const pa = Math.abs(a.hx * (a.c * ax - a.s * az)) + Math.abs(a.hz * (a.s * ax + a.c * az)) + pad;
    const pb = Math.abs(b.hx * (b.c * ax - b.s * az)) + Math.abs(b.hz * (b.s * ax + b.c * az)) + pad;
    const d = Math.abs((b.cx - a.cx) * ax + (b.cz - a.cz) * az);
    if (d > pa + pb) return false;
  }
  return true;
}

/** Distance between two rectangles (0 if they overlap): the least corner-to-rectangle distance. */
export function rectGap(a: Rect, b: Rect): number {
  if (rectsOverlap(a, b)) return 0;
  const ka = rectCorners(a), kb = rectCorners(b);
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    d = Math.min(d, distRectSeg(b, ka[i], ka[(i + 1) % 4]), distRectSeg(a, kb[i], kb[(i + 1) % 4]));
  }
  return d;
}

/** Is p inside polygon `poly` (any winding)? */
export function inPoly(poly: readonly P2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from p to polygon `poly`'s outline. */
export function distPointPoly(poly: readonly P2[], x: number, z: number): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distPointSeg(x, z, poly[j].x, poly[j].z, poly[i].x, poly[i].z));
  return d;
}

/** Does rectangle r touch polygon `poly` (inside it, or crossing its outline)? */
export function rectTouchesPoly(r: Rect, poly: readonly P2[], pad = 0): boolean {
  if (inPoly(poly, r.cx, r.cz)) return true;
  for (const k of rectCorners(r)) if (inPoly(poly, k.x, k.z)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distRectSeg(r, poly[j], poly[i]) <= pad) return true;
  }
  return false;
}

/** Signed area of a polygon (positive: counter-clockwise in x/z as drawn with z down). */
export function polyArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x * poly[i].z - poly[i].x * poly[j].z);
  return a / 2;
}

/** murmur3's finaliser over a few integers: a well-mixed 32-bit hash. */
export function hash32(...ints: number[]): number {
  let h = 0x9e3779b9;
  for (const v of ints) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** Snap to 1/1024 m: generated positions come out identical in every engine. */
export const q = (v: number) => Math.round(v * 1024) / 1024;
