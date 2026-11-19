/**
 * The traffic lanes, built once from the town's street graph (`CITY.roads`): each street open
 * to traffic has a lane each way, LANE_OFFSET to the right of its centre line (right-hand
 * traffic), trimmed back to where its junction's paving begins. Turning through a junction
 * follows a curve from the end of one lane to the start of the next (`connector`).
 */
import { LANE_OFFSET } from "./constants.js";
import { lineAt, makeLine, type Line, type P2 } from "./geom.js";
import { EDGE_NO_CARS, EDGE_NO_TRAFFIC } from "./layout.js";
import { CITY, type Roads } from "./map.js";

export interface Lane {
  /** The street (index into `CITY.roads.edges`), and whether it runs from its `a` to its `b`. */
  edge: number; fwd: boolean;
  /** The nodes it leaves and arrives at. */
  from: number; to: number;
  line: Line;
  /** The lanes it can carry on into at `to` (its own street's other lane only at a dead end). */
  next: number[];
}

/** Every lane, from `roads`. */
export function buildLanes(roads: Roads): Lane[] {
  const lanes: Lane[] = [];
  roads.edges.forEach((e, ei) => {
    if (e.flags & (EDGE_NO_CARS | EDGE_NO_TRAFFIC) || e.half <= 0) return;
    for (const fwd of [true, false]) {
      const pts = fwd ? e.pts : [...e.pts].reverse();
      const from = fwd ? e.a : e.b, to = fwd ? e.b : e.a;
      const off = offsetLine(pts, LANE_OFFSET);
      const line0 = makeLine(off);
      const r0 = roads.nodes[from].r, r1 = roads.nodes[to].r;
      if (line0.len - r0 - r1 < 2) continue;
      lanes.push({ edge: ei, fwd, from, to, line: makeLine(trim(line0, r0, line0.len - r1)), next: [] });
    }
  });
  // what each lane carries on into: the lanes leaving its end node (not back down its own street,
  // unless that's all there is)
  for (const l of lanes) {
    l.next = lanes.flatMap((o, i) => (o.from === l.to && o.edge !== l.edge ? [i] : []));
    if (!l.next.length) l.next = lanes.flatMap((o, i) => (o.from === l.to ? [i] : []));
  }
  return lanes;
}

/** A polyline moved `d` to its right (−dz, dx), corner points along their averaged normals. */
export function offsetLine(pts: P2[], d: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= l; dz /= l;
    out.push({ x: pts[i].x - dz * d, z: pts[i].z + dx * d });
  }
  return out;
}

/** The part of `l` between arc lengths s0 and s1. */
export function trim(l: Line, s0: number, s1: number): P2[] {
  const out: P2[] = [];
  const p = lineAt(l, s0);
  out.push({ x: p.x, z: p.z });
  for (let i = 1; i < l.pts.length - 1; i++) if (l.cum[i] > s0 + 0.05 && l.cum[i] < s1 - 0.05) out.push(l.pts[i]);
  const q = lineAt(l, s1);
  out.push({ x: q.x, z: q.z });
  return out;
}

const conns = new Map<number, Line>();

/** The curve from the end of lane `a` to the start of lane `b` (a short cubic Bézier). Memoised. */
export function connector(lanes: Lane[], a: number, b: number): Line {
  const key = a * 4096 + b;
  let c = conns.get(key);
  if (c) return c;
  c = joinLines(lanes[a].line, lanes[b].line);
  conns.set(key, c);
  return c;
}

/** The curve from the end of line `la` to the start of `lb` (a turn through a junction: see `connector`). */
export function joinLines(la: Line, lb: Line): Line {
  const e = lineAt(la, la.len), s = lineAt(lb, 0);
  const gap = Math.sqrt((s.x - e.x) ** 2 + (s.z - e.z) ** 2);
  const pts: P2[] = [];
  // (lanes that all but meet, where a street just bends: a straight join, not a curve that would fold back)
  if (gap < 1.5) pts.push({ x: e.x, z: e.z }, { x: s.x, z: s.z });
  else {
    // the handles reach toward where the two lanes' lines meet (so a turn hugs the corner), or
    // for a U-turn or a slight jog, a share of the gap
    let k1 = Math.max(1.5, gap * 0.45), k2 = k1;
    const cross = e.dx * s.dz - e.dz * s.dx;
    if (Math.abs(cross) > 0.15) {
      const wx = s.x - e.x, wz = s.z - e.z;
      const t = (wx * s.dz - wz * s.dx) / cross, u = (e.dx * wz - e.dz * wx) / cross;
      if (t > 0 && u > 0) { k1 = t * 0.9; k2 = u * 0.9; }
    }
    const p1 = { x: e.x + e.dx * k1, z: e.z + e.dz * k1 }, p2 = { x: s.x - s.dx * k2, z: s.z - s.dz * k2 };
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, u = 1 - t;
      pts.push({
        x: u * u * u * e.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * s.x,
        z: u * u * u * e.z + 3 * u * u * t * p1.z + 3 * u * t * t * p2.z + t * t * t * s.z,
      });
    }
  }
  return makeLine(pts);
}

/** The town's lanes. */
export const LANES: Lane[] = buildLanes(CITY.roads);
