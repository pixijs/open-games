/**
 * The ground of a town built on a street graph (`CITY.roads`): lawn, paved districts and plots,
 * parks, the plaza, parking lots, and the streets: a sidewalk, a kerb and asphalt laid as bands
 * along every street, each trimmed where it meets its junction's polygon (built from the edges
 * of the streets that meet there), with caps at dead ends and a disc for a cul-de-sac. Pits
 * (the sinkhole) are cut out of every layer under them.
 *
 * Each district has its own lawn, pavements and kerbs (districts.ts): a street between two of them
 * gets each side's sidewalk in its own colour, a junction each corner's. Old Town's own streets
 * are cobbled, Millside's plots gravel; Maple Close's houses stand on their lawns.
 *
 * No two surfaces of different colour share a height (see the table in `HEIGHTS`), and where
 * two pieces of the same surface overlap they're the same colour and texture at the same
 * height: nothing to z-fight.
 */
import { MAP_HALF } from "../../shared/constants.js";
import { distPointLine, inPoly, lineAt, makeLine, type Line, type P2 } from "../../shared/geom.js";
import { KIT } from "../../shared/kit.js";
import { LOOKS, areaAt, lookAt } from "../../shared/districts.js";
import { DISTRICTS, EDGE_ALLEY, EDGE_RING, EDGE_SPOKE } from "../../shared/layout.js";
import { CITY, LOT_Y, mulberry32, type City, type RoadEdge } from "../../shared/map.js";
import { MeshBuilder } from "../gfx/MeshBuilder.js";

/**
 * Every ground surface's height (m). Big surfaces that overlap are 12 mm apart: over the
 * raccoon's back the camera's near plane is 0.2 m, and 24-bit depth there resolves ~12 mm at
 * 200 m, where the fog has the rest. Small ones (decals, markings) are 6 mm over what they lie
 * on. Surfaces at the same height never overlap (the plaza and the parks, the lots, the lawn
 * inside and outside the town, a footpath and the dirt round a mishap). The lawn is sunk below
 * the ground plane, so the asphalt (what cars and raccoons stand on most) stays low.
 */
export const HEIGHTS = {
  lawn: -0.024, stripes: -0.012, townLawn: -0.024, paved: -0.012, sidewalk: 0, dirt: 0.012, alley: 0.012,
  park: 0.012, plaza: 0.012, leaves: 0.018, lot: LOT_Y, curb: 0.024, pawDecal: 0.03, asphalt: 0.036, asphaltDecal: 0.042,
  lotStripe: 0.046, marking: 0.048, lotDecal: 0.052,
};

export const GROUND_COLORS = {
  grass: 0x8fd16a, grassDark: 0x7cc35a, townGrass: 0x98d672, asphalt: 0x4f5566, sidewalk: 0xe2cfb4, curb: 0xc9b597,
  paving: 0xecd9bd, plaza: 0xf6d7b0, alley: 0xefc89a, lane: 0xfff6d5, stripe: 0xffffff, lot: 0x6a6f7e, dirt: 0xa08466,
  cobbles: 0xa99c8f, gravel: 0xa8977e, path: 0xf1dfc2,
};
const C = GROUND_COLORS;

export interface GroundLayers {
  grass: MeshBuilder; paving: MeshBuilder; plaza: MeshBuilder; lot: MeshBuilder; asphalt: MeshBuilder; dirt: MeshBuilder;
}

interface Rect { minX: number; minZ: number; maxX: number; maxZ: number }

/** `r` with each of `holes` cut out of it: up to four rectangles per hole. */
function rectMinus(r: Rect, holes: readonly Rect[]): Rect[] {
  let out = [r];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const a of out) {
      if (h.maxX <= a.minX || h.minX >= a.maxX || h.maxZ <= a.minZ || h.minZ >= a.maxZ) { next.push(a); continue; }
      if (h.minZ > a.minZ) next.push({ minX: a.minX, minZ: a.minZ, maxX: a.maxX, maxZ: h.minZ });
      if (h.maxZ < a.maxZ) next.push({ minX: a.minX, minZ: h.maxZ, maxX: a.maxX, maxZ: a.maxZ });
      const z0 = Math.max(a.minZ, h.minZ), z1 = Math.min(a.maxZ, h.maxZ);
      if (h.minX > a.minX) next.push({ minX: a.minX, minZ: z0, maxX: h.minX, maxZ: z1 });
      if (h.maxX < a.maxX) next.push({ minX: h.maxX, minZ: z0, maxX: a.maxX, maxZ: z1 });
    }
    out = next;
  }
  return out;
}

const right = (d: P2): P2 => ({ x: -d.z, z: d.x });

interface Arm { e: number; d: P2; a: number; h: number }
/** Per street end: how far from its node each band begins (its junction's polygon covers the rest). */
type Trim = Map<string, number>;
/** A band's colour at (x, z) on street `e` (−1: a junction whose streets disagree). */
type Paint = number | ((x: number, z: number, e: number) => number);

/**
 * One band (sidewalk, kerb or asphalt) of every street: `width(e)` its half width (≤ 0: the street
 * has no such band). Junction polygons where three or more meet, the outside of a bend where a
 * street bends at a node, a cap at a dead end (none where it stops at a pit), the cul-de-sac's
 * disc; then the bands themselves, trimmed. Returns the trims (markings start past them). `target`
 * picks the layer per street (a junction goes in its streets' layer if they all share one, else in
 * street −1's); `paint` the colour: a street whose two sides differ gets two half bands, a junction
 * a colour per corner. Pieces of different colours never overlap: a junction's polygon ends exactly
 * where its streets' bands begin, and its corners split down the middle of each street.
 */
function lay(target: MeshBuilder | ((e: number) => MeshBuilder), city: City, lines: Line[], width: (e: RoadEdge) => number, y: number, paint: Paint, culdesacExtra: number): Trim {
  const trim: Trim = new Map();
  const { nodes, edges } = city.roads;
  const layer = (e: number) => (typeof target === "function" ? target(e) : target);
  const col = (x: number, z: number, e: number) => (typeof paint === "number" ? paint : paint(x, z, e));
  const pt = { x: 0, z: 0, dx: 0, dz: 0 };
  const junctions: { n: number; arms: Arm[]; corners: P2[] }[] = [];
  nodes.forEach((nd, n) => {
    const arms: Arm[] = [];
    for (const i of nd.edges) {
      const h = width(edges[i]);
      if (h <= 0) continue;
      const p = edges[i].pts;
      const [a, c] = edges[i].a === n ? [p[0], p[1]] : [p[p.length - 1], p[p.length - 2]];
      const l = Math.hypot(c.x - a.x, c.z - a.z) || 1;
      const d = { x: (c.x - a.x) / l, z: (c.z - a.z) / l };
      arms.push({ e: i, d, a: Math.atan2(d.z, d.x), h });
    }
    if (!arms.length) return;
    const key = (e: number) => `${n}:${e}`;
    if (nd.kind === "culdesac") {
      layer(arms[0].e).disc(nd.x, nd.z, nd.r + culdesacExtra, y, col(nd.x, nd.z, arms[0].e), 32);
      for (const a of arms) trim.set(key(a.e), 0);
      return;
    }
    if (arms.length === 1) {
      trim.set(key(arms[0].e), 0);
      if (nd.kind !== "dead" && nd.kind !== "edge") layer(arms[0].e).disc(nd.x, nd.z, arms[0].h, y, col(nd.x, nd.z, arms[0].e), 20);
      return;
    }
    if (arms.length === 2) {
      for (const a of arms) trim.set(key(a.e), 0);
      // a bend: the bands overlap on its inside (the same district's colour) and leave a wedge open
      // on its outside, filled here (not where they're different surfaces)
      const [p, o] = arms;
      if (layer(p.e) !== layer(o.e) || Math.abs(p.d.x * o.d.z - p.d.z * o.d.x) < 1e-3) return;
      const sp = right(p.d), so = right(o.d);
      if (sp.x * o.d.x + sp.z * o.d.z > 0) { sp.x = -sp.x; sp.z = -sp.z; }
      if (so.x * p.d.x + so.z * p.d.z > 0) { so.x = -so.x; so.z = -so.z; }
      const a0 = Math.atan2(sp.z, sp.x);
      let da = Math.atan2(so.z, so.x) - a0;
      if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 16)));
      const arc: P2[] = [];
      for (let k = 0; k <= steps; k++) {
        const a = a0 + (da * k) / steps, r = p.h + ((o.h - p.h) * k) / steps;
        arc.push({ x: nd.x + Math.cos(a) * r, z: nd.z + Math.sin(a) * r });
      }
      const m = Math.max(p.h, o.h) * 0.75, bl = Math.hypot(sp.x + so.x, sp.z + so.z) || 1;
      layer(p.e).sector(nd.x, nd.z, arc, y, col(nd.x + ((sp.x + so.x) / bl) * m, nd.z + ((sp.z + so.z) / bl) * m, p.e));
      return;
    }
    arms.sort((p, q) => p.a - q.a);
    const corners: P2[] = [];
    for (let k = 0; k < arms.length; k++) {
      const p = arms[k], o = arms[(k + 1) % arms.length];
      const rp = right(p.d), lo = { x: o.d.z, z: -o.d.x };
      const ax = nd.x + rp.x * p.h, az = nd.z + rp.z * p.h;
      const bx = nd.x + lo.x * o.h, bz = nd.z + lo.z * o.h;
      const den = p.d.x * o.d.z - p.d.z * o.d.x;
      let cx: number, cz: number;
      if (Math.abs(den) < 0.17) { cx = (ax + bx) / 2; cz = (az + bz) / 2; }
      else {
        const t = ((bx - ax) * o.d.z - (bz - az) * o.d.x) / den;
        cx = ax + p.d.x * t; cz = az + p.d.z * t;
      }
      const far = Math.max(p.h, o.h) * 3, dd = Math.hypot(cx - nd.x, cz - nd.z);
      if (dd > far) { cx = nd.x + ((cx - nd.x) * far) / dd; cz = nd.z + ((cz - nd.z) * far) / dd; }
      corners.push({ x: cx, z: cz });
    }
    // each band ends where both its corners are behind it (along the street, curving or not)
    for (let k = 0; k < arms.length; k++) {
      const a = arms[k], e = edges[a.e], cs = [corners[(k - 1 + arms.length) % arms.length], corners[k]];
      let t = Math.max(0.5, ...cs.map((c) => (c.x - nd.x) * a.d.x + (c.z - nd.z) * a.d.z));
      for (let it = 0; it < 8 && t < e.len; it++) {
        lineAt(lines[a.e], e.a === n ? t : e.len - t, pt);
        const s = e.a === n ? 1 : -1;
        const ahead = Math.max(...cs.map((c) => ((c.x - pt.x) * pt.dx + (c.z - pt.z) * pt.dz) * s));
        if (ahead <= 0.01) break;
        t += ahead;
      }
      trim.set(key(a.e), t);
    }
    junctions.push({ n, arms, corners });
  });
  // a street too short for both its junctions' trims shares its length between them
  edges.forEach((e, i) => {
    const ka = `${e.a}:${i}`, kb = `${e.b}:${i}`, ta = trim.get(ka) ?? 0, tb = trim.get(kb) ?? 0, room = e.len - 0.1;
    if (ta + tb > room) { trim.set(ka, (ta * room) / (ta + tb)); trim.set(kb, (tb * room) / (ta + tb)); }
  });
  /** Where street `i`'s band ends at node `n`: its end's middle and the way into the street, as `ribbon` lays it. */
  const mouth = (n: number, i: number) => {
    const e = edges[i], s0 = trim.get(`${e.a}:${i}`) ?? 0, s1 = Math.max(e.len - (trim.get(`${e.b}:${i}`) ?? 0), s0 + 0.05);
    const pts = sub(lines[i], s0, s1);
    const [p, q] = e.a === n ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    return { x: p.x, z: p.z, dx: (q.x - p.x) / l, dz: (q.z - p.z) / l };
  };
  for (const { n, arms, corners } of junctions) {
    const nd = nodes[n];
    const ends = arms.map((a) => {
      const m = mouth(n, a.e), r = right({ x: m.dx, z: m.dz });
      return { m, l: { x: m.x - r.x * a.h, z: m.z - r.z * a.h }, r: { x: m.x + r.x * a.h, z: m.z + r.z * a.h } };
    });
    // (a corner past either street's end, on a street too short for both its junctions, is left out)
    const ahead = (c: P2, m: { x: number; z: number; dx: number; dz: number }) => (c.x - m.x) * m.dx + (c.z - m.z) * m.dz > 0.01;
    const corner = (k: number) => (ahead(corners[k], ends[k].m) || ahead(corners[k], ends[(k + 1) % arms.length].m) ? [] : [corners[k]]);
    const same = arms.every((a) => layer(a.e) === layer(arms[0].e));
    const b = same ? layer(arms[0].e) : layer(-1), e0 = same ? arms[0].e : -1;
    if (typeof paint === "number") { b.fan(nd.x, nd.z, ends.flatMap((q, k) => [q.l, q.r, ...corner(k)]), y, paint); continue; }
    // a colour per corner: each corner's wedge (from the middle of one street's end, round the
    // corner, to the middle of the next street's) in the colour of the district it's in
    for (let k = 0; k < arms.length; k++) {
      const p = ends[k], o = ends[(k + 1) % arms.length], c = corner(k);
      const at = c[0] ?? { x: (p.r.x + o.l.x) / 2, z: (p.r.z + o.l.z) / 2 };
      b.sector(nd.x, nd.z, [p.m, p.r, ...c, o.l, o.m], y, col(at.x, at.z, e0));
    }
  }
  const mid = { x: 0, z: 0, dx: 0, dz: 0 };
  edges.forEach((e, i) => {
    const h = width(e);
    if (h <= 0) return;
    const s0 = trim.get(`${e.a}:${i}`) ?? 0, s1 = e.len - (trim.get(`${e.b}:${i}`) ?? 0);
    if (s1 - s0 < 0.05) return;
    const pts = sub(lines[i], s0, s1);
    // each side in its own district's colour (they meet down the middle, under the asphalt)
    lineAt(lines[i], e.len / 2, mid);
    const o = h * 0.75, cl = col(mid.x + mid.dz * o, mid.z - mid.dx * o, i), cr = col(mid.x - mid.dz * o, mid.z + mid.dx * o, i);
    if (cl === cr) layer(i).ribbon(pts, -h, h, y, cl);
    else { layer(i).ribbon(pts, -h, 0, y, cl); layer(i).ribbon(pts, 0, h, y, cr); }
  });
  return trim;
}

/** The points of `l` between arc lengths s0 and s1. */
function sub(l: Line, s0: number, s1: number): P2[] {
  const out: P2[] = [];
  const a = lineAt(l, s0);
  out.push({ x: a.x, z: a.z });
  for (let i = 1; i < l.pts.length - 1; i++) if (l.cum[i] > s0 + 0.01 && l.cum[i] < s1 - 0.01) out.push(l.pts[i]);
  const b = lineAt(l, s1);
  out.push({ x: b.x, z: b.z });
  return out;
}

/** Which streets are cobbled: those wholly inside Old Town (both sides there), not the ring road. */
export function cobbledStreets(city: City = CITY): boolean[] {
  return city.roads.edges.map((e) => {
    if (e.flags & (EDGE_RING | EDGE_SPOKE | EDGE_ALLEY) || e.half <= 0) return false;
    const p = lineAt(makeLine(e.pts), e.len / 2), o = e.half + e.walk + 1;
    return areaAt(p.x + p.dz * o, p.z - p.dx * o) === "oldtown" && areaAt(p.x - p.dz * o, p.z + p.dx * o) === "oldtown";
  });
}

/** The ground layers of the town on a street graph. */
export function buildRoadGround(L: GroundLayers, city: City = CITY) {
  const { edges, nodes } = city.roads;
  const lines = edges.map((e) => makeLine(e.pts));
  const holes: Rect[] = city.pits.map((p) => ({ minX: p.minX, minZ: p.minZ, maxX: p.maxX, maxZ: p.maxZ }));
  const rect = (b: MeshBuilder, r: Rect, y: number, color: number) => b.rect(r.minX, r.minZ, r.maxX, r.maxZ, y, color);

  // ---- lawn: outside the town (mowed stripes) and inside it (a touch brighter)
  const lawn = MAP_HALF + 100, T = 117.5;
  const town: Rect = { minX: -T, minZ: -T, maxX: T, maxZ: T };
  for (const r of rectMinus({ minX: -lawn, minZ: -lawn, maxX: lawn, maxZ: lawn }, [town])) rect(L.grass, r, HEIGHTS.lawn, C.grass);
  for (let x = -MAP_HALF; x < MAP_HALF; x += 10) {
    for (const r of rectMinus({ minX: x, minZ: -MAP_HALF, maxX: x + 5, maxZ: MAP_HALF }, [town])) rect(L.grass, r, HEIGHTS.stripes, C.grassDark);
  }
  // each district's lawn (their outlines tile the town; a pit is cut out of Millside's)
  const isBox = (pts: readonly P2[]) => pts.length === 4 && pts.every((p, i) => p.x === pts[(i + 1) % 4].x || p.z === pts[(i + 1) % 4].z);
  const boundsOf = (pts: readonly P2[]): Rect => ({ minX: Math.min(...pts.map((p) => p.x)), minZ: Math.min(...pts.map((p) => p.z)), maxX: Math.max(...pts.map((p) => p.x)), maxZ: Math.max(...pts.map((p) => p.z)) });
  const fill = (b: MeshBuilder, pts: readonly P2[], y: number, color: number) => {
    if (isBox(pts)) for (const r of rectMinus(boundsOf(pts), holes)) rect(b, r, y, color);
    else b.poly(pts, y, color);
  };
  for (const d of DISTRICTS) fill(L.grass, d.poly, HEIGHTS.townLawn, LOOKS[d.area].lawn);

  // ---- paved: the busy districts (inside the ring road's far kerb), and a plot under every
  // building: paving, Millside's gravel, none in Maple Close (its houses stand on their lawns)
  const inner = (pts: readonly P2[]) => pts.map((p) => ({ x: Math.max(-110, Math.min(110, p.x)), z: Math.max(-110, Math.min(110, p.z)) }));
  for (const d of DISTRICTS) if (d.area === "downtown" || d.area === "oldtown" || d.area === "plaza") fill(L.paving, inner(d.poly), HEIGHTS.paved, LOOKS[d.area].paving);
  const plots: { area: ReturnType<typeof areaAt>; ox: number; oz: number; c: number; s: number; hx: number; hz: number }[] = [];
  for (const bl of city.buildings) {
    if (!bl.fade) continue;
    const area = areaAt(bl.x, bl.z);
    if (area === "maple") continue;
    // (a footprint off the model's middle: the old mill's boiler house)
    const ox = (bl.box!.minX + bl.box!.maxX) / 2, oz = (bl.box!.minZ + bl.box!.maxZ) / 2;
    plots.push({ area, ox, oz, c: Math.cos(bl.rot), s: Math.sin(bl.rot), hx: bl.fade.hx + 1.2, hz: bl.fade.hz + 1.2 });
  }
  const walkW = edges.map((e) => (e.flags & EDGE_ALLEY || e.half <= 0 ? 0 : e.half + (e.flags & EDGE_SPOKE ? 0 : e.walk)));
  /** The streets whose sidewalks come within `r` of (x, z), and whether a point is on one of them. */
  const walksNear = (x: number, z: number, r: number) => edges.flatMap((_, i) => (walkW[i] > 0 && distPointLine(x, z, lines[i]) < walkW[i] + r ? [i] : []));
  const onWalk = (near: number[], x: number, z: number) => near.some((i) => distPointLine(x, z, lines[i]) < walkW[i]);
  const inPlot = (p: (typeof plots)[number], x: number, z: number) => {
    const dx = x - p.ox, dz = z - p.oz;
    return Math.abs(dx * p.c - dz * p.s) < p.hx && Math.abs(dx * p.s + dz * p.c) < p.hz;
  };
  const elsewhere = [...city.parks, ...city.lots].map((r) => r.poly ?? [{ x: r.minX, z: r.minZ }, { x: r.maxX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { x: r.minX, z: r.maxZ }]);
  for (const p of plots) {
    const k = (lx: number, lz: number): P2 => ({ x: p.ox + lx * p.c + lz * p.s, z: p.oz - lx * p.s + lz * p.c });
    const near = walksNear(p.ox, p.oz, Math.hypot(p.hx, p.hz) + 1);
    // a side that stops just short of the sidewalk, or of the next plot like it, reaches it (or
    // a hairline of lawn shows between them): over the lawn only, never into another surface
    const reach = (ax: number, az: number) => {
      let most = 0;
      for (const f of [-0.7, 0, 0.7]) {
        for (let d = 0.05; d <= 0.8; d += 0.05) {
          const q = ax ? k(ax * (p.hx + d), f * p.hz) : k(f * p.hx, az * (p.hz + d));
          if (onWalk(near, q.x, q.z) || plots.some((o) => o !== p && o.area === p.area && inPlot(o, q.x, q.z))) { most = Math.max(most, d + 0.05); break; }
          if (areaAt(q.x, q.z) !== p.area || elsewhere.some((poly) => inPoly(poly, q.x, q.z))) break;
        }
      }
      return most;
    };
    // (the paved districts' plots lie on paving of their own colour already)
    const lawn = p.area === "run" || p.area === "mill";
    const x0 = p.hx + (lawn ? reach(-1, 0) : 0), x1 = p.hx + (lawn ? reach(1, 0) : 0);
    const z0 = p.hz + (lawn ? reach(0, -1) : 0), z1 = p.hz + (lawn ? reach(0, 1) : 0);
    const corners = [k(-x0, -z0), k(x1, -z0), k(x1, z1), k(-x0, z1)];
    if (p.area === "mill") L.dirt.poly(corners, HEIGHTS.paved, LOOKS.mill.paving);
    else L.paving.poly(corners, HEIGHTS.paved, p.area ? LOOKS[p.area].paving : C.paving);
  }

  // ---- parks, the plaza, parking lots
  for (const p of city.parks) {
    const poly = p.poly ?? [{ x: p.minX, z: p.minZ }, { x: p.maxX, z: p.minZ }, { x: p.maxX, z: p.maxZ }, { x: p.minX, z: p.maxZ }];
    L.grass.poly(poly, HEIGHTS.park, C.grass);
  }
  rect(L.plaza, city.plaza, HEIGHTS.plaza, C.plaza);
  for (const l of city.lots) {
    const poly = l.poly ?? [{ x: l.minX, z: l.minZ }, { x: l.maxX, z: l.minZ }, { x: l.maxX, z: l.maxZ }, { x: l.minX, z: l.maxZ }];
    L.lot.poly(poly, HEIGHTS.lot, C.lot);
    // bays at both ends, in the lot's own frame (its first corner is local (−hx, −hz))
    const yaw = l.yaw ?? 0, c = Math.cos(yaw), s = Math.sin(yaw);
    const cx = (poly[0].x + poly[2].x) / 2, cz = (poly[0].z + poly[2].z) / 2;
    const hx = Math.hypot(poly[1].x - poly[0].x, poly[1].z - poly[0].z) / 2, hz = Math.hypot(poly[3].x - poly[0].x, poly[3].z - poly[0].z) / 2;
    for (let x = -hx + 1.5; x < hx; x += 3) {
      for (const z of [-hz + 2.75, hz - 2.75]) {
        L.lot.quad(cx + x * c + z * s, cz - x * s + z * c, yaw, 4.5, 0.12, HEIGHTS.lotStripe, C.stripe);
      }
    }
  }

  // ---- dirt where the mishaps happened (round the demolition site and the collapsed building),
  // gravel in the old mill's yard, cobbles on the clock tower's square
  for (const sp of city.setPieces) {
    if (sp.kind !== "demolition" && sp.kind !== "collapsed" && sp.kind !== "millyard" && sp.kind !== "clocktower") continue;
    const k = KIT.setpieces[sp.kind].keep, c = Math.cos(sp.yaw), s = Math.sin(sp.yaw);
    const ox = k.x ?? 0, oz = k.z ?? 0;
    const at = (lx: number, lz: number): P2 => ({ x: sp.x + (ox + lx) * c + (oz + lz) * s, z: sp.z - (ox + lx) * s + (oz + lz) * c });
    if (sp.kind === "clocktower") {
      const hx = k.hx - 0.3, hz = k.hz - 0.3;
      L.plaza.poly([at(-hx, -hz), at(hx, -hz), at(hx, hz), at(-hx, hz)], HEIGHTS.plaza, C.cobbles);
      continue;
    }
    const hx = k.hx - (sp.kind === "millyard" ? 0.5 : 1), hz = k.hz - (sp.kind === "millyard" ? 0.5 : 1.5);
    L.dirt.poly([at(-hx, -hz), at(hx, -hz), at(hx, hz), at(-hx, hz)], HEIGHTS.dirt, sp.kind === "millyard" ? C.gravel : C.dirt);
  }

  // ---- Maple Close: a path up each front garden (on through its gate to the sidewalk), leaves
  // fallen round its trees
  for (const d of city.dressing) {
    if (d.kind !== "path") continue;
    const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
    const k = (lx: number, lz: number): P2 => ({ x: d.x + lx * c + lz * s, z: d.z - lx * s + lz * c });
    const near = walksNear(d.x, d.z, d.hx + d.hz + 1.6);
    const on = (end: number, t: number) => [-1, 1].every((side) => { const q = k(side * d.hx, end * (d.hz + t)); return onWalk(near, q.x, q.z); });
    // (it lies over the sidewalk, so it stops as soon as it's on it: to the centimetre)
    const out = (end: number) => {
      for (let t = 0.05; t <= 1.5; t += 0.05) if (on(end, t)) { while (t > 0.01 && on(end, t - 0.01)) t -= 0.01; return t; }
      return 0;
    };
    const z0 = d.hz + out(-1), z1 = d.hz + out(1);
    L.plaza.poly([k(-d.hx, -z0), k(d.hx, -z0), k(d.hx, z1), k(-d.hx, z1)], HEIGHTS.alley, C.path);
  }
  {
    const rand = mulberry32(0x1eaf5);
    const leaves = LOOKS.maple.leaves;
    const fallen: { x: number; z: number; r: number }[] = [];
    for (const pr of city.props) {
      if (pr.model !== "tree_round" || (pr.y ?? 0) > 0 || areaAt(pr.x, pr.z) !== "maple") continue;
      for (let k = 0; k < 26; k++) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * 3.2;
        const len = 0.22 + rand() * 0.14, yaw = rand() * Math.PI, c = leaves[Math.floor(rand() * leaves.length)];
        const x = pr.x + Math.cos(a) * d, z = pr.z + Math.sin(a) * d, r = len * 0.61;
        // (none on another: two colours at one height)
        if (fallen.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < (q.r + r) ** 2)) continue;
        fallen.push({ x, z, r });
        L.grass.quad(x, z, yaw, len, len * 0.7, HEIGHTS.leaves, c);
      }
    }
  }

  // ---- the streets: sidewalk, kerb, asphalt (spokes out in the country have neither sidewalk nor kerb)
  const rural = (e: RoadEdge) => (e.flags & EDGE_SPOKE) !== 0;
  const alley = (e: RoadEdge) => (e.flags & EDGE_ALLEY) !== 0;
  const cobbled = cobbledStreets(city);
  lay(L.paving, city, lines, (e) => (alley(e) ? 0 : rural(e) ? e.half : e.half + e.walk), HEIGHTS.sidewalk, (x, z) => lookAt(x, z)?.sidewalk ?? C.sidewalk, 2.5);
  lay(L.paving, city, lines, (e) => (alley(e) ? 0 : e.half + 0.25), HEIGHTS.curb, (x, z) => lookAt(x, z)?.curb ?? C.curb, 0.25);
  const trim = lay((i) => (i >= 0 && cobbled[i] ? L.plaza : L.asphalt), city, lines, (e) => (alley(e) ? 0 : e.half), HEIGHTS.asphalt, (_x, _z, i) => (i >= 0 && cobbled[i] ? C.cobbles : C.asphalt), 0);
  // footpaths: herringbone pavers, the whole way
  edges.forEach((e, i) => { if (alley(e)) L.plaza.ribbon(e.pts, -e.walk, e.walk, HEIGHTS.alley, C.alley); });

  // ---- round a pit: the asphalt and the sidewalks close in on its edge
  for (const p of city.pits) {
    const near = edges.filter((e) => e.half > 0 && [e.a, e.b].some((n) => nodes[n].kind === "dead" && Math.hypot(nodes[n].x - (p.minX + p.maxX) / 2, nodes[n].z - (p.minZ + p.maxZ) / 2) < 14));
    if (!near.length) continue;
    const e = near[0], hole: Rect = { minX: p.minX, minZ: p.minZ, maxX: p.maxX, maxZ: p.maxZ };
    const cz = (p.minZ + p.maxZ) / 2, ex = 2.6;
    // (the pit is on the line between two districts: each side's sidewalk in its own colour)
    for (const r of rectMinus({ minX: p.minX - ex, minZ: cz - e.half - e.walk, maxX: p.maxX + ex, maxZ: cz + e.half + e.walk }, [hole])) {
      for (const [z0, z1] of [[r.minZ, Math.min(r.maxZ, cz)], [Math.max(r.minZ, cz), r.maxZ]]) {
        if (z1 > z0) rect(L.paving, { ...r, minZ: z0, maxZ: z1 }, HEIGHTS.sidewalk, lookAt(p.cx, (z0 + z1) / 2)?.sidewalk ?? C.sidewalk);
      }
    }
    for (const r of rectMinus({ minX: p.minX - ex, minZ: cz - e.half - 0.25, maxX: p.maxX + ex, maxZ: cz + e.half + 0.25 }, [hole])) {
      for (const [z0, z1] of [[r.minZ, Math.min(r.maxZ, cz)], [Math.max(r.minZ, cz), r.maxZ]]) {
        if (z1 > z0) rect(L.paving, { ...r, minZ: z0, maxZ: z1 }, HEIGHTS.curb, lookAt(p.cx, (z0 + z1) / 2)?.curb ?? C.curb);
      }
    }
    for (const r of rectMinus({ minX: p.minX - ex, minZ: cz - e.half, maxX: p.maxX + ex, maxZ: cz + e.half }, [hole])) rect(L.asphalt, r, HEIGHTS.asphalt, C.asphalt);
  }

  // ---- markings: centre dashes (stopping short of the zebras and the stop lines), zebra crossings
  // at junctions, stop lines before the railway
  const pt = { x: 0, z: 0, dx: 0, dz: 0 };
  const zebras = (n: number) => nodes[n].edges.filter((i) => !alley(edges[i]) && !rural(edges[i]) && edges[i].half > 0).length >= 3;
  const nearStopLine = (x: number, z: number) =>
    city.crossings.some((c) => (c.roadAxis === "z" ? Math.abs(x - c.x) < 6 && Math.abs(z - c.z) < 8.3 : Math.abs(z - c.z) < 6 && Math.abs(x - c.x) < 8.3));
  edges.forEach((e, i) => {
    if (alley(e) || e.half < 3.5 || cobbled[i]) return;
    const gap = (n: number) => (!rural(e) && zebras(n) ? 3 : 1.5);
    const s0 = (trim.get(`${e.a}:${i}`) ?? 0) + gap(e.a), s1 = e.len - (trim.get(`${e.b}:${i}`) ?? 0) - gap(e.b);
    for (let s = s0; s + 2 <= s1; s += 4) {
      lineAt(lines[i], s + 1, pt);
      if (nearStopLine(pt.x, pt.z)) continue;
      L.asphalt.quad(pt.x, pt.z, Math.atan2(pt.dx, pt.dz), 2, 0.18, HEIGHTS.marking, C.lane);
    }
  });
  nodes.forEach((nd, n) => {
    if (!zebras(n)) return;
    const arms = nd.edges.filter((i) => !alley(edges[i]) && !rural(edges[i]) && edges[i].half > 0);
    for (const i of arms) {
      const e = edges[i], t = trim.get(`${n}:${i}`) ?? 0;
      const back = e.a === n;
      const s = back ? t + 1.3 : e.len - t - 1.3;
      if (s < 1 || s > e.len - 1) continue;
      lineAt(lines[i], s, pt);
      const r = right({ x: pt.dx, z: pt.dz });
      const count = Math.floor((2 * e.half - 0.6) / 1.05);
      for (let k = 0; k < count; k++) {
        const o = (k - (count - 1) / 2) * 1.05;
        L.asphalt.quad(pt.x + r.x * o, pt.z + r.z * o, Math.atan2(pt.dx, pt.dz), 2, 0.55, HEIGHTS.marking, C.stripe);
      }
    }
  });
  for (const c of city.crossings) {
    const yaw = c.roadAxis === "z" ? 0 : Math.PI / 2, fx = Math.sin(yaw), fz = Math.cos(yaw);
    for (const side of [-1, 1]) L.asphalt.quad(c.x + fx * side * 6.4, c.z + fz * side * 6.4, yaw + Math.PI / 2, 10, 0.4, HEIGHTS.marking, C.stripe);
  }
}
