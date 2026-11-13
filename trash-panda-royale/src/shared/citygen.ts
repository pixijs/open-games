/**
 * Builds the town from its hand-drawn plan (`layout.ts`): the streets as given, then buildings
 * along both sides of every street (each turned to face it, following curves), their stairs and
 * fire escapes, planks between roofs a jump too far apart, each district's look (its colours, its
 * gardens, crates or planters: districts.ts), the street furniture, parks, parking lots, the
 * mishaps and the landmarks, the pedestrians' paths, loot, trash cans and spawn points.
 *
 * Deterministic: every stage draws from its own seeded stream (or a hash of what it's placing),
 * and positions are snapped to 1/1024 m, so the server and every client build the same town.
 */
import {
  CORRIDOR_HALF, LANE_OFFSET, MAP_HALF, PICKUP_FOOD, ROAD_HALF, Weapon,
} from "./constants.js";
import {
  BILLBOARD, BIN_R, BUILDINGS, LOOSE_PROPS, LOT_Y, PROP_COLLIDERS, SolidTag, axisRamp, clearOfLoot, cosSin, makeBox, mulberry32, placeBins,
  placeCoffee, placeParts, roomAmong, type Box, type City, type Dressing, type NavNode, type Placement, type Ramp, type RoadEdge, type RoadNode,
  type Station, type XZ,
} from "./town.js";
import { LOOKS, areaAt, type AreaKey } from "./districts.js";
import {
  arcPoints, distPointLine, distPointPoly, hash32, inPoly, inRect, lineAt, makeLine, q, rectClearOfLine, rectGap, rectTouchesPoly, rectsOverlap,
  type Line, type P2, type Rect,
} from "./geom.js";
import { KIT } from "./kit.js";
import {
  BILLBOARDS, BUILDINGS as PLACED, DISTRICTS, EDGES, EDGE_ALLEY, EDGE_RING, EDGE_SPOKE, KEEP_OPEN, LOTS, MAST, MENU_SPOT, NODES, PARKS, PLAZA,
  SET_PIECES,
} from "./layout.js";
import { RAIL_HALF, trackDistance, trackSFromPoint } from "./train.js";

// (map.ts imports this module and calls generateV2 while it loads: nothing at this level may be
// anything but a function declaration, or it isn't there yet when that happens)

/** Narrower stand-ins, tried when a building doesn't fit. */
function smaller(model: string): string[] {
  switch (model) {
    case "bld_tower": return ["bld_apartment", "bld_shop", "bld_house"];
    case "bld_apartment": return ["bld_shop", "bld_house"];
    case "bld_shop": case "bld_donut": return ["bld_house"];
    default: return [];
  }
}

interface Edge extends RoadEdge { line: Line; corridor: number; front: "l" | "r" | "both" | "none" }

/** A rectangle turned to `yaw`, centred at (x, z). */
function rectAt(x: number, z: number, yaw: number, hx: number, hz: number): Rect {
  const [c, s] = cosSin(yaw);
  return { cx: x, cz: z, hx, hz, c, s };
}
/** Local (lx, lz) in a frame at (x, z) turned by `yaw` → world. */
function toWorld(x: number, z: number, yaw: number, lx: number, lz: number): P2 {
  const [c, s] = cosSin(yaw);
  return { x: x + lx * c + lz * s, z: z - lx * s + lz * c };
}
function right(dx: number, dz: number) { return { x: -dz, z: dx }; }

export function generateV2(): City {
  const DEF: Record<string, (typeof BUILDINGS)[number]> = Object.fromEntries(BUILDINGS.map((b) => [b.model, b]));
  const city: City = {
    boxes: [], ramps: [], pits: [], buildings: [], props: [], parks: [], lots: [],
    plaza: { ...PLAZA },
    nav: [], intersections: [], parking: [], pickups: [], crossings: [], stations: [], spawns: [], bins: [], poles: [], loose: [],
    roads: { nodes: [], edges: [] }, setPieces: [], dressing: [], landmarks: { menu: { ...MENU_SPOT } },
  };
  /** A wall colour from the district at (x, z): `u` in [0, 1) picks it. */
  const wallAt = (x: number, z: number, u: number, fallback: AreaKey = "plaza") => {
    const pal = LOOKS[areaAt(x, z) ?? fallback].walls;
    return pal[Math.min(pal.length - 1, Math.floor(u * pal.length))];
  };
  const unit = (h: number) => (h % 1000) / 1000;

  // ------------------------------------------------------------ streets
  const ids = Object.keys(NODES);
  const index = new Map(ids.map((id, i) => [id, i]));
  const nodes: RoadNode[] = ids.map((id): RoadNode => ({ x: NODES[id].x, z: NODES[id].z, kind: NODES[id].kind, r: 0, edges: [] }));
  const edges: Edge[] = EDGES.map((e, i) => {
    const a = index.get(e.a)!, b = index.get(e.b)!;
    const A = nodes[a], B = nodes[b];
    let pts: P2[];
    if (e.arc) {
      const { cx, cz } = e.arc;
      const r = Math.sqrt((A.x - cx) ** 2 + (A.z - cz) ** 2);
      const a0 = Math.atan2(A.z - cz, A.x - cx);
      let a1 = Math.atan2(B.z - cz, B.x - cx);
      // the shorter way round (unless asked for the long one)
      let d = a1 - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (e.arc.long) d += d > 0 ? -Math.PI * 2 : Math.PI * 2;
      a1 = a0 + d;
      const n = Math.max(2, Math.ceil((Math.abs(d) * r) / 3));
      pts = arcPoints(cx, cz, r, a0, a1, n);
      pts[0] = { x: A.x, z: A.z };
      pts[pts.length - 1] = { x: B.x, z: B.z };
    } else {
      pts = [{ x: A.x, z: A.z }, ...(e.via ?? []).map(([x, z]) => ({ x, z })), { x: B.x, z: B.z }];
    }
    pts = pts.map((p) => ({ x: q(p.x), z: q(p.z) }));
    const line = makeLine(pts);
    const half = e.half ?? ROAD_HALF, walk = e.walk ?? CORRIDOR_HALF - ROAD_HALF;
    A.edges.push(i);
    B.edges.push(i);
    return {
      a, b, pts, cum: line.cum, len: line.len, half, walk, flags: e.flags ?? 0, name: e.name,
      line, corridor: half + walk, front: e.front ?? "both",
    };
  });
  /** The direction edge `i` leaves node `n` in. */
  const armDir = (n: number, i: number) => {
    const e = edges[i], p = e.pts;
    const [a, b] = e.a === n ? [p[0], p[1]] : [p[p.length - 1], p[p.length - 2]];
    const l = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  };
  // junction paving: far enough out along each street that neighbouring corridors don't overlap
  nodes.forEach((nd, n) => {
    if (nd.kind === "culdesac") { nd.r = NODES[ids[n]].r ?? 9; return; }
    if (nd.edges.length < 3) return;
    let r = 0;
    for (const i of nd.edges) r = Math.max(r, edges[i].corridor + 1);
    const arms = nd.edges.map((i) => ({ i, d: armDir(n, i), a: 0 }));
    for (const arm of arms) arm.a = Math.atan2(arm.d.z, arm.d.x);
    arms.sort((p, q2) => p.a - q2.a);
    for (let k = 0; k < arms.length; k++) {
      const p = arms[k], o = arms[(k + 1) % arms.length];
      let th = o.a - p.a;
      if (th <= 0) th += Math.PI * 2;
      if (th < Math.PI * 0.95) r = Math.max(r, Math.max(edges[p.i].corridor, edges[o.i].corridor) / Math.tan(th / 2));
    }
    const shortest = Math.min(...nd.edges.map((i) => edges[i].len));
    nd.r = q(Math.min(r, shortest * 0.45));
  });
  city.roads = { nodes, edges: edges.map(({ line: _l, corridor: _c, front: _f, ...e }) => e) };

  // ------------------------------------------------------------ what's taken
  /** Rectangles taken by buildings, stairs and set pieces (what the next building mustn't overlap). */
  const taken: Rect[] = [];
  const keepRects: Rect[] = [];
  const parkPolys: P2[][] = PARKS;
  const lotRects = LOTS.map((l) => rectAt(l.x, l.z, l.yaw, l.hx, l.hz));
  const plazaRect: Rect = rectAt((PLAZA.minX + PLAZA.maxX) / 2, (PLAZA.minZ + PLAZA.maxZ) / 2, 0, (PLAZA.maxX - PLAZA.minX) / 2, (PLAZA.maxZ - PLAZA.minZ) / 2);
  /** Clear of every street's corridor (the paving, the sidewalks), by `pad`. */
  const offRoad = (r: Rect, pad: number) => edges.every((e) => rectClearOfLine(r, e.line, e.corridor + pad));
  const offReserved = (r: Rect) =>
    !rectsOverlap(r, plazaRect, 0.5) && !lotRects.some((l) => rectsOverlap(r, l, 1)) && !keepRects.some((k) => rectsOverlap(r, k, 0.5))
    && !parkPolys.some((p) => rectTouchesPoly(r, p, 1)) && !KEEP_OPEN.some((p) => rectTouchesPoly(r, p));
  const inTown = (r: Rect) => Math.abs(r.cx) + Math.max(r.hx, r.hz) < 101 && Math.abs(r.cz) + Math.max(r.hx, r.hz) < 101;

  // ------------------------------------------------------------ buildings
  /** Put a building up (its colliders from kit.json), and maybe its stairs (`stairs`: which side, or "try"). */
  const raise = (model: string, x: number, z: number, yaw: number, tint: number, stairs: "+X" | "-X" | "try" | null, rand: () => number) => {
    const d = DEF[model];
    x = q(x); z = q(z);
    const r = rectAt(x, z, yaw, d.w / 2, d.d / 2);
    const k = r;
    const ex = Math.abs(k.hx * k.c) + Math.abs(k.hz * k.s), ez = Math.abs(k.hx * k.s) + Math.abs(k.hz * k.c);
    const box: Box = { minX: x - ex, minZ: z - ez, maxX: x + ex, maxZ: z + ez, top: d.h };
    const parts = { boxes: [] as Box[], ramps: [] as Ramp[] };
    placeParts(KIT.buildings[model], x, z, yaw, parts);
    city.boxes.push(...parts.boxes);
    city.ramps.push(...parts.ramps);
    city.buildings.push({ model, x, z, rot: yaw, tint, box, fade: { hx: d.w / 2, hz: d.d / 2, top: d.h }, parts, roof: KIT.buildings[model].roof });
    taken.push(r);
    const st = KIT.buildings[model].stairs;
    if (!st || !stairs) return;
    // the stairs' footprint (in the building's frame), on whichever side has room
    const ext = partsExtent(st);
    const sides: ("+X" | "-X")[] = stairs === "try" ? (rand() < 0.5 ? ["+X", "-X"] : ["-X", "+X"]) : [stairs];
    for (const side of sides) {
      const m = side === "+X" ? 1 : -1;
      const c = toWorld(x, z, yaw, m * (ext.minX + ext.maxX) / 2, (ext.minZ + ext.maxZ) / 2);
      const sr = rectAt(c.x, c.z, yaw, (ext.maxX - ext.minX) / 2 + 0.3, (ext.maxZ - ext.minZ) / 2 + 0.3);
      if (stairs === "try" && (!offRoad(sr, 0.2) || !offReserved(sr) || taken.some((t) => t !== r && rectsOverlap(sr, t, 0.2)))) continue;
      placeParts(st, x, z, yaw, city, m < 0);
      taken.push(sr);
      return;
    }
  };

  // the mishaps first (the frontage leaves them room), then the hand-placed buildings
  for (const sp of SET_PIECES) {
    const kit = KIT.setpieces[sp.kind];
    const own = { boxes: [] as Box[], ramps: [] as Ramp[], pits: city.pits };
    placeParts(kit, sp.x, sp.z, sp.yaw, own);
    city.boxes.push(...own.boxes);
    city.ramps.push(...own.ramps);
    const kc = toWorld(sp.x, sp.z, sp.yaw, kit.keep.x ?? 0, kit.keep.z ?? 0);
    const keep = rectAt(kc.x, kc.z, sp.yaw, kit.keep.hx, kit.keep.hz);
    keepRects.push(keep);
    city.setPieces.push({ kind: sp.kind, x: sp.x, z: sp.z, yaw: sp.yaw });
    for (const m of kit.models ?? []) {
      const p = toWorld(sp.x, sp.z, sp.yaw, m.x, m.z);
      const big = m.model.startsWith("bld_") || m.fade !== undefined;
      // the ruins (and the clock tower, the old mill) fade out of the camera's way like
      // buildings; the crane, the sinkhole, the big maple and the raccoon sign don't
      if (big) {
        // its own footprint and height (not the ground the set piece keeps clear, which may hold a neighbour)
        const f = m.fade ?? ({ bld_demolished: [7, 6, 11.2], bld_collapsed: [6, 5, 7.5], bld_shell: [6, 5, 4.2] } as Record<string, number[]>)[m.model] ?? [kit.keep.hx - 1.5, kit.keep.hz - 1.5, 6];
        const fh = f[2];
        const fc = toWorld(p.x, p.z, sp.yaw + m.yaw, f[3] ?? 0, f[4] ?? 0);
        const fr = rectAt(fc.x, fc.z, sp.yaw + m.yaw, f[0], f[1]);
        const ex = Math.abs(fr.hx * fr.c) + Math.abs(fr.hz * fr.s), ez = Math.abs(fr.hx * fr.s) + Math.abs(fr.hz * fr.c);
        // what it's made of: the set piece's colliders standing in it (not the crane's ball hanging over it)
        const parts = {
          boxes: own.boxes.filter((b) => b.tag !== SolidTag.Crane && inRect(fr, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, 0.5)),
          ramps: own.ramps.filter((r) => inRect(fr, r.cx, r.cz, 0.5)),
        };
        city.buildings.push({
          model: m.model, x: q(p.x), z: q(p.z), rot: sp.yaw + m.yaw, tint: sp.kind === "shell" ? 0x8a8494 : wallAt(p.x, p.z, unit(hash32(7, sp.x | 0))),
          box: { minX: fc.x - ex, minZ: fc.z - ez, maxX: fc.x + ex, maxZ: fc.z + ez, top: fh }, fade: { hx: fr.hx, hz: fr.hz, top: fh }, parts,
          ...(m.roof !== undefined ? { roof: m.roof } : {}),
        });
      } else {
        city.props.push({ model: m.model, x: q(p.x), z: q(p.z), rot: sp.yaw + m.yaw, ...(m.tint !== undefined ? { tint: m.tint } : {}) });
        // street furniture (the clock tower's benches, the mill yard's oil drums): its collider is the set piece's, the one under it
        const under = LOOSE_PROPS.has(m.model) ? own.boxes.find((b) => b.tag === SolidTag.Prop && Math.hypot((b.minX + b.maxX) / 2 - p.x, (b.minZ + b.maxZ) / 2 - p.z) < 0.2) : undefined;
        if (under) {
          under.loose = city.loose.length;
          city.loose.push({ x: q(p.x), z: q(p.z), prop: city.props.length - 1 });
        }
      }
    }
    for (const b of kit.buildings ?? []) {
      const p = toWorld(sp.x, sp.z, sp.yaw, b.x, b.z);
      raise(b.model, p.x, p.z, sp.yaw + b.yaw, wallAt(p.x, p.z, unit(hash32(11, b.x | 0, sp.z | 0))), null, () => 0);
    }
  }
  for (const b of PLACED) {
    raise(b.model, b.x, b.z, b.yaw, b.tint ?? wallAt(b.x, b.z, unit(hash32(13, b.x | 0, b.z | 0))), b.stairs ?? null, () => 0);
  }
  // the billboards (after the tower one of them stands on): nothing gets built or planted on a
  // ground board's spot, nor grows through its pole
  const boards = placeBillboards(city);
  taken.push(...boards);

  // along the streets: a row of buildings facing each street, then a second row behind it where a
  // block is deep enough (backyards and roofs a jump apart between the two)
  const districtAt = (x: number, z: number) => DISTRICTS.find((d) => inPoly(d.poly, x, z)) ?? DISTRICTS[0];
  const pt = { x: 0, z: 0, dx: 0, dz: 0 };
  /** The front row's houses in Maple Close: their front gardens get a picket fence, hedges and a path. */
  const gardens: { x: number; z: number; yaw: number; hw: number; hd: number; depth: number }[] = [];
  for (const rowBack of [0, 13.5]) {
    edges.forEach((e, ei) => {
      if (e.front === "none" || e.flags & (EDGE_SPOKE | EDGE_ALLEY)) return;
      for (const side of [1, -1]) {
        if (e.front === "r" && side < 0) continue;
        if (e.front === "l" && side > 0) continue;
        // the ring road only builds on its inner side
        if (e.flags & EDGE_RING) {
          lineAt(e.line, e.len / 2, pt);
          const n = right(pt.dx, pt.dz);
          if ((n.x * side) * -pt.x + (n.z * side) * -pt.z < 0) continue;
        }
        const rand = mulberry32(hash32(0xf00d, ei, side, rowBack ? 2 : 1));
        // the whole street's length: near a junction, staying off the crossing street is what decides
        let s = rand() * 2;
        while (s < e.len - 8) {
          lineAt(e.line, s + 5, pt);
          const rn = right(pt.dx, pt.dz);
          const dist = districtAt(pt.x + rn.x * side * 10, pt.z + rn.z * side * 10);
          const want = pickWeighted(dist.mix, rand);
          let placed = false;
          for (const model of [want, ...smaller(want)]) {
            const d = DEF[model];
            if (s + d.w > e.len) continue;
            const p0 = lineAt(e.line, s), a = { x: p0.x, z: p0.z };
            const p1 = lineAt(e.line, s + d.w), b = { x: p1.x, z: p1.z };
            const cl = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
            const tx = (b.x - a.x) / cl, tz = (b.z - a.z) / cl;
            const n = right(tx, tz);
            const nx = n.x * side, nz = n.z * side;
            const back = e.corridor + 0.6 + rand() * 0.8 + rowBack + (dist.setback ?? 0) + d.d / 2;
            const cx = (a.x + b.x) / 2 + nx * back, cz = (a.z + b.z) / 2 + nz * back;
            // facing the street (a back row too: its front looks over the first row's backyards)
            const yaw = Math.atan2(-nx, -nz);
            const r = rectAt(cx, cz, yaw, d.w / 2, d.d / 2);
            if (!inTown(r) || !offRoad(r, 0.4) || !offReserved(r)) continue;
            const row = rand() < (dist.row ?? 0);
            if (taken.some((t) => rectsOverlap(r, t, row ? 0.15 : rowBack ? 1.2 : 0.6))) continue;
            const stairs = rand() < (dist.stairs ?? 0) ? "try" : null;
            raise(model, cx, cz, yaw, wallAt(cx, cz, rand(), dist.area), stairs, rand);
            if (!rowBack && dist.setback && areaAt(cx, cz) === dist.area) gardens.push({ x: cx, z: cz, yaw, hw: d.w / 2, hd: d.d / 2, depth: back - d.d / 2 - e.corridor });
            s += d.w + (row ? 0.4 : 1.5 + rand() * 2.5);
            placed = true;
            break;
          }
          if (!placed) s += 1.5;
        }
      }
    });
  }

  // planks across the roof gaps too wide to jump (but not too wide to bridge)
  placePlanks(city);

  // ------------------------------------------------------------ the districts' dressing
  /** What the dressing takes (nothing else goes there). */
  const dressRects: Rect[] = [];
  /** Clear for a piece of dressing: off the streets, buildings, set pieces, the plaza, lots, parks and other dressing. */
  const roomFor = (r: Rect, pad = 0.1) =>
    offRoad(r, 0.05) && !taken.some((t) => rectsOverlap(r, t, pad)) && !keepRects.some((k) => rectsOverlap(r, k, pad))
    && !rectsOverlap(r, plazaRect, pad) && !lotRects.some((l) => rectsOverlap(r, l, pad)) && !parkPolys.some((pp) => rectTouchesPoly(r, pp, pad))
    && !dressRects.some((o) => rectsOverlap(r, o, pad)) && !KEEP_OPEN.some((pp) => rectTouchesPoly(r, pp));
  /** Put a piece down (solid: a box too; `grab` false: no ledge to climb onto). */
  const dress = (kind: Dressing["kind"], x: number, z: number, yaw: number, hx: number, hz: number, h: number, solid: boolean, grab = true, y = 0) => {
    x = q(x); z = q(z);
    city.dressing.push({ kind, x, z, yaw, hx, hz, h, ...(y ? { y } : {}), seed: hash32(0xd7e5, Math.round(x * 64), Math.round(z * 64)) % 1000 });
    if (solid) city.boxes.push(makeBox(x, z, yaw, hx, hz, y + h, { tag: SolidTag.Prop, ...(grab ? {} : { grab: false as const }) }));
    dressRects.push(rectAt(x, z, yaw, hx, hz));
  };
  // Maple Close: a white picket fence across each front garden (a gate in the middle, a path up
  // to the door), hedges down its sides (a fence a raccoon hops, a hedge it hops or goes round)
  for (const g of gardens) {
    const wide = g.hw + 1;
    const piece = (kind: Dressing["kind"], lx0: number, lx1: number, lz0: number, lz1: number, h: number, solid: boolean, grab: boolean) => {
      const c = toWorld(g.x, g.z, g.yaw, (lx0 + lx1) / 2, (lz0 + lz1) / 2);
      const hx = Math.abs(lx1 - lx0) / 2, hz = Math.abs(lz1 - lz0) / 2;
      if (hx < 0.3 && hz < 0.3) return false;
      if (!roomFor(rectAt(c.x, c.z, g.yaw, hx, hz), 0.05)) return false;
      dress(kind, c.x, c.z, g.yaw, hx, hz, h, solid, grab);
      return true;
    };
    // (the fence stands just inside the sidewalk: further in where a curving street bulges toward it)
    let fz = 0;
    for (const back of [0.35, 0.75, 1.15]) {
      fz = g.hd + g.depth - back;
      let any = false;
      for (const side of [-1, 1]) {
        // the fence's half from the gate out (shorter if a neighbour's garden is in the way)
        for (const out of [wide, g.hw + 0.4, g.hw - 0.6]) {
          if (piece("fence", side * 0.75, side * out, fz - 0.06, fz + 0.06, 0.9, true, false)) {
            piece("hedge", side * (out - 0.3), side * (out + 0.3), g.hd - 0.2, fz - 0.3, 1.05, true, true);
            any = true;
            break;
          }
        }
      }
      if (any) break;
    }
    piece("path", -0.6, 0.6, g.hd + 0.15, fz - 0.15, 0, false, false);
  }
  // the Plaza: flag poles at its corners (the client strings bunting between them)
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) dress("flagpole", sx * 13.4, sz * 13.4, 0, 0.09, 0.09, 6.2, true, false);

  // ------------------------------------------------------------ props
  const addProp = (model: string, x: number, z: number, rot = 0, collide = true, extra: Partial<Placement> = {}) => {
    x = q(x); z = q(z);
    city.props.push({ model, x, z, rot, ...extra });
    const c = PROP_COLLIDERS[model];
    if (collide && c) {
      const box = makeBox(x, z, Math.round(rot / (Math.PI / 2)) * (Math.PI / 2), c.hx, c.hz, c.top + (extra.y ?? 0), { tag: SolidTag.Prop, grab: false });
      if (model === "lamp") {
        box.pole = city.poles.length;
        city.poles.push({ x, z, prop: city.props.length - 1 });
      } else if (LOOSE_PROPS.has(model)) {
        box.loose = city.loose.length;
        city.loose.push({ x, z, prop: city.props.length - 1 });
      }
      city.boxes.push(box);
    }
  };
  /** Is (x, z) clear for a prop of radius `r` (buildings, stairs, set pieces, the plaza, parks, lots)? */
  const clear = (x: number, z: number, r: number, keepOpenOk = false) => {
    const pr = rectAt(x, z, 0, r, r);
    if (taken.some((t) => rectsOverlap(pr, t, 0.1)) || keepRects.some((k) => rectsOverlap(pr, k))) return false;
    if (rectsOverlap(pr, plazaRect) || lotRects.some((l) => rectsOverlap(pr, l)) || parkPolys.some((p) => inPoly(p, x, z))) return false;
    if (!keepOpenOk && KEEP_OPEN.some((p) => inPoly(p, x, z))) return false;
    return true;
  };

  // the plaza: as it was (a fountain, flowerbeds, trees, benches)
  {
    const cx = 0, cz = 0;
    addProp("fountain", cx, cz, 0, false);
    city.boxes.push({ minX: cx - 2.4, minZ: cz - 2.4, maxX: cx + 2.4, maxZ: cz + 2.4, top: 0.8 });
    city.boxes.push({ minX: cx - 0.7, minZ: cz - 0.7, maxX: cx + 0.7, maxZ: cz + 0.7, top: 2.2 });
    for (const [dx, dz, r] of [[-9, 0, Math.PI / 2], [9, 0, Math.PI / 2], [0, -9, 0], [0, 9, 0]] as const) addProp("flowerbed", cx + dx, cz + dz, r);
    const rand = mulberry32(0x91a2a);
    for (const [dx, dz] of [[-10, -10], [10, -10], [-10, 10], [10, 10]]) addProp("tree_round", cx + dx, cz + dz, rand() * 6);
    for (const [dx, dz, r] of [[-5, -11.5, 0], [5, 11.5, Math.PI], [-11.5, 5, Math.PI / 2], [11.5, -5, -Math.PI / 2]] as const) addProp("bench", cx + dx, cz + dz, r);
  }

  // parks: trees, bushes, two benches
  parkPolys.forEach((poly, pi) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of poly) { minX = Math.min(minX, p.x); minZ = Math.min(minZ, p.z); maxX = Math.max(maxX, p.x); maxZ = Math.max(maxZ, p.z); }
    city.parks.push({ minX, minZ, maxX, maxZ, poly });
    const rand = mulberry32(hash32(0x9a12, pi));
    const area = Math.abs(polyAreaOf(poly));
    const inside = (m: number) => {
      for (let k = 0; k < 40; k++) {
        const x = minX + rand() * (maxX - minX), z = minZ + rand() * (maxZ - minZ);
        if (inPoly(poly, x, z) && distPointPoly(poly, x, z) >= m && !boards.some((r) => inRect(r, x, z, m)) && !keepRects.some((r) => inRect(r, x, z, m))) return { x, z };
      }
      return null;
    };
    const trees = Math.round(area / 45), bushes = Math.round(area / 90);
    for (let k = 0; k < trees; k++) { const p = inside(2); if (p) addProp(rand() < 0.6 ? "tree_round" : "tree_pine", p.x, p.z, rand() * 6.28); }
    for (let k = 0; k < bushes; k++) { const p = inside(1.5); if (p) addProp("bush", p.x, p.z, rand() * 6.28); }
    const c = centroidOf(poly);
    addProp("bench", c.x, c.z - 3, 0);
    addProp("bench", c.x, c.z + 3, Math.PI);
  });

  // parking lots: bays, a dumpster corner
  const junk = mulberry32(0xd0b5);
  LOTS.forEach((l, li) => {
    const r = lotRects[li];
    const k = [toWorld(l.x, l.z, l.yaw, -l.hx, -l.hz), toWorld(l.x, l.z, l.yaw, l.hx, -l.hz), toWorld(l.x, l.z, l.yaw, l.hx, l.hz), toWorld(l.x, l.z, l.yaw, -l.hx, l.hz)];
    const ex = Math.abs(r.hx * r.c) + Math.abs(r.hz * r.s), ez = Math.abs(r.hx * r.s) + Math.abs(r.hz * r.c);
    city.lots.push({ minX: l.x - ex, minZ: l.z - ez, maxX: l.x + ex, maxZ: l.z + ez, poly: k, yaw: l.yaw });
    for (let i = 0; i < l.spots; i++) {
      const p = toWorld(l.x, l.z, l.yaw, -l.hx + ((i + 0.5) * 2 * l.hx) / l.spots, 0.5);
      city.parking.push({ x: q(p.x), z: q(p.z), yaw: l.yaw + (i % 2 ? Math.PI : 0) });
    }
    const side = li % 2 ? 1 : -1;
    const d = toWorld(l.x, l.z, l.yaw, side * (l.hx - 1.4), -(l.hz - 0.9));
    addProp("dumpster", d.x, d.z, l.yaw + Math.PI, true, { y: LOT_Y });
    const tb = toWorld(l.x, l.z, l.yaw, side * (l.hx - 3.5), -(l.hz - 0.8) + (junk() - 0.5) * 0.3);
    addProp("trash_bags", tb.x, tb.z, l.yaw + (junk() - 0.5) * 0.6, true, { y: LOT_Y });
  });

  // street furniture: lamps every ~15 m, now and then a hydrant, a trash can, a tree
  const streetBins: (XZ & { dx: number; dz: number })[] = [];
  edges.forEach((e, ei) => {
    if (e.flags & (EDGE_SPOKE | EDGE_ALLEY)) return;
    for (const side of [1, -1]) {
      const rand = mulberry32(hash32(0xfa11, ei, side));
      let outer = false;
      if (e.flags & EDGE_RING) {
        lineAt(e.line, e.len / 2, pt);
        const n = right(pt.dx, pt.dz);
        outer = (n.x * side) * -pt.x + (n.z * side) * -pt.z < 0;
      }
      const s0 = nodes[e.a].r + 3, s1 = e.len - nodes[e.b].r - 3;
      const at = (s: number, off: number) => {
        lineAt(e.line, s, pt);
        const n = right(pt.dx, pt.dz);
        return { x: pt.x + n.x * side * off, z: pt.z + n.z * side * off, yaw: Math.atan2(-n.x * side, -n.z * side) };
      };
      // (lamps right behind the kerb, hydrants at the back of the sidewalk: the middle of it is where people walk)
      const curb = e.half + 0.35;
      for (let s = s0 + 2 + rand() * 4; s < s1; s += 14.5) {
        const p = at(s, curb);
        if (clear(p.x, p.z, 0.4, true)) addProp("lamp", p.x, p.z, p.yaw);
      }
      if (outer || s1 - s0 < 6) continue;
      if (rand() < 0.35) { const p = at(s0 + rand() * (s1 - s0), e.corridor - 0.35); if (clear(p.x, p.z, 0.5)) addProp("hydrant", p.x, p.z, 0); }
      if (rand() < 0.4) {
        const p = at(s0 + rand() * (s1 - s0), e.half + 0.42);
        // (slid along the street, if it has to make room: not across the sidewalk)
        if (clear(p.x, p.z, 0.6)) streetBins.push({ x: p.x, z: p.z, dx: Math.sin(p.yaw + Math.PI / 2), dz: Math.cos(p.yaw + Math.PI / 2) });
      }
      // a street tree on the verge just past the sidewalk (Maple Close has more; Downtown's stand
      // in concrete planters)
      const sideArea = areaAt(at((s0 + s1) / 2, e.corridor + 2).x, at((s0 + s1) / 2, e.corridor + 2).z);
      const trees = sideArea === "downtown" ? 2 : sideArea === "maple" ? 2 : 1;
      for (let k = 0; k < trees; k++) {
        if (rand() >= 0.3 * (sideArea === "downtown" ? 1.4 : 1)) continue;
        const potted = sideArea === "downtown", off = potted ? e.corridor + 0.85 : e.corridor + 0.45;
        const p = at(s0 + rand() * (s1 - s0), off);
        if (!clear(p.x, p.z, potted ? 0.85 : 0.6) || dressRects.some((r) => inRect(r, p.x, p.z, 0.9)) || !edges.every((o) => distPointLine(p.x, p.z, o.line) >= o.corridor + (potted ? 0.8 : 0.3))) continue;
        if (potted) {
          dress("planter", p.x, p.z, p.yaw, 0.7, 0.7, 0.55, true);
          addProp("tree_round", p.x, p.z, rand() * 6.28, false, { y: 0.55, scale: 0.62 });
        } else addProp("tree_round", p.x, p.z, rand() * 6.28);
      }
    }
  });

  // greenery in the leftover space between and behind the buildings
  {
    const rand = mulberry32(0x6ee5);
    // Millside's oil drums: props after the loop (sooner, they'd push later greenery off)
    const drums: XZ[] = [];
    for (let gx = -98; gx <= 98; gx += 5.5) {
      for (let gz = -98; gz <= 98; gz += 5.5) {
        const x = gx + (rand() - 0.5) * 4, z = gz + (rand() - 0.5) * 4, pick = rand();
        if (pick > 0.55) continue;
        const pr = rectAt(x, z, 0, 1.6, 1.6);
        if (!offRoad(pr, 0.8) || !clear(x, z, 2.2)) continue;
        if (city.props.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 9)) continue;
        if (dressRects.some((r) => inRect(r, x, z, 1.6))) continue;
        const area = areaAt(x, z);
        if (area === "downtown") {
          // concrete planters on the paving, a little tree in each
          const yaw = Math.floor(rand() * 4) * (Math.PI / 2);
          if (pick < 0.3) {
            dress("planter", x, z, yaw, 0.8, 0.8, 0.6, true);
            addProp(rand() < 0.5 ? "tree_round" : "bush", x, z, rand() * 6.28, false, { y: 0.6, scale: 0.6 });
          }
        } else if (area === "mill") {
          // a yard's worth of junk: crates (stacked: a step up), oil drums, pallets; a dry tree now and then
          const yaw = (rand() - 0.5) * 0.5;
          if (pick < 0.16) {
            dress("crate", x, z, yaw, 0.6, 0.6, rand() < 0.45 ? 2.4 : 1.2, true);
            if (rand() < 0.6) { const o = toWorld(x, z, yaw, 1.35, (rand() - 0.5) * 0.4); dress("crate", o.x, o.z, yaw + (rand() - 0.5) * 0.3, 0.6, 0.6, 1.2, true); }
          } else if (pick < 0.27) {
            for (let k = 0; k < 3; k++) { const o = toWorld(x, z, rand() * 6.28, k ? 0.8 : 0, 0); if (k < 2 || rand() < 0.5) { drums.push({ x: q(o.x), z: q(o.z) }); dressRects.push(rectAt(q(o.x), q(o.z), 0, 0.35, 0.35)); } }
          } else if (pick < 0.35) {
            dress("pallets", x, z, yaw, 0.6, 0.5, 0.15 * (1 + Math.floor(rand() * 4)), true);
          } else if (pick < 0.45) {
            addProp("tree_pine", x, z, rand() * 6.28, true, { scale: 0.75 + rand() * 0.3 });
          }
        } else if (area === "oldtown" && pick >= 0.32 && pick < 0.4) {
          addProp("flowerbed", x, z, Math.floor(rand() * 4) * (Math.PI / 2));
        } else if (pick < (area === "maple" ? 0.4 : 0.32)) addProp(rand() < (area === "maple" ? 0.8 : 0.65) ? "tree_round" : "tree_pine", x, z, rand() * 6.28, true, { scale: 0.85 + rand() * 0.35 });
        else addProp("bush", x, z, rand() * 6.28);
      }
    }
    for (const d of drums) addProp("drum", d.x, d.z, (hash32(0xd7e5, Math.round(d.x * 64), Math.round(d.z * 64)) % 628) / 100);
  }

  // Downtown's landmark: the radio mast on the tower (up where nobody gets)
  city.props.push({ model: "lm_mast", x: q(MAST.x), z: q(MAST.z), y: MAST.y, rot: 0 });

  // ------------------------------------------------------------ the railway
  for (const e of edges) {
    if (!(e.flags & EDGE_SPOKE)) continue;
    // where it meets the track: bisect on the sign of the distance to it
    let lo = 0, hi = e.len;
    const f = (s: number) => { lineAt(e.line, s, pt); return trackDistance(pt.x, pt.z); };
    if (Math.sign(f(lo)) === Math.sign(f(hi))) continue;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (Math.sign(f(m)) === Math.sign(f(lo))) lo = m; else hi = m; }
    lineAt(e.line, (lo + hi) / 2, pt);
    const x = Math.round(pt.x * 100) / 100, z = Math.round(pt.z * 100) / 100;
    city.crossings.push({ x, z, s: trackSFromPoint(x, z), roadAxis: Math.abs(pt.dx) > Math.abs(pt.dz) ? "x" : "z" });
  }
  for (const c of city.crossings) {
    const off = ROAD_HALF + 0.8;
    if (c.roadAxis === "z") {
      const sg = Math.sign(c.z);
      const near = sg > 0 ? 0 : Math.PI, far = sg > 0 ? Math.PI : 0;
      addProp("crossing_sign", c.x - sg * off, c.z - sg * 4.2, far);
      addProp("crossing_barrier", c.x - sg * off, c.z - sg * 5.4, near);
      addProp("crossing_sign", c.x + sg * off, c.z + sg * 4.2, near);
      addProp("crossing_barrier", c.x + sg * off, c.z + sg * 5.4, far);
    } else {
      const sg = Math.sign(c.x);
      addProp("crossing_sign", c.x - sg * 4.2, c.z + sg * off, -sg * Math.PI / 2);
      addProp("crossing_barrier", c.x - sg * 5.4, c.z + sg * off, sg * Math.PI / 2);
      addProp("crossing_sign", c.x + sg * 4.2, c.z - sg * off, sg * Math.PI / 2);
      addProp("crossing_barrier", c.x + sg * 5.4, c.z - sg * off, -sg * Math.PI / 2);
    }
  }
  // stations: raised platforms beside the track, ramps at both ends (as they were)
  const stationDefs = [
    { x: -45, z: RAIL_HALF - 3.5, rot: -Math.PI / 2, along: "x" as const },
    { x: 45, z: -(RAIL_HALF - 3.5), rot: Math.PI / 2, along: "x" as const },
    { x: RAIL_HALF - 3.5, z: 60, rot: 0, along: "z" as const },
  ];
  for (const sd of stationDefs) {
    const halfLen = 15, halfW = 2;
    const st: Station = sd.along === "x"
      ? { x: sd.x, z: sd.z, rot: sd.rot, minX: sd.x - halfLen, maxX: sd.x + halfLen, minZ: sd.z - halfW, maxZ: sd.z + halfW }
      : { x: sd.x, z: sd.z, rot: sd.rot, minX: sd.x - halfW, maxX: sd.x + halfW, minZ: sd.z - halfLen, maxZ: sd.z + halfLen };
    city.stations.push(st);
    city.boxes.push({ minX: st.minX, minZ: st.minZ, maxX: st.maxX, maxZ: st.maxZ, top: 1.6, tag: SolidTag.Platform });
    if (sd.along === "x") {
      city.ramps.push(axisRamp(st.minX - 6, st.minZ, st.minX, st.maxZ, "x", 0, 1.6));
      city.ramps.push(axisRamp(st.maxX, st.minZ, st.maxX + 6, st.maxZ, "x", 1.6, 0));
    } else {
      city.ramps.push(axisRamp(st.minX, st.minZ - 6, st.maxX, st.minZ, "z", 0, 1.6));
      city.ramps.push(axisRamp(st.minX, st.maxZ, st.maxX, st.maxZ + 6, "z", 1.6, 0));
    }
  }
  // the outer belt: trees on the grass between the town and the map's edge, off the track and the roads
  {
    const rand = mulberry32(0xbe17);
    let placed = 0;
    for (let k = 0; k < 900 && placed < 150; k++) {
      const x = (rand() * 2 - 1) * (MAP_HALF - 4), z = (rand() * 2 - 1) * (MAP_HALF - 4);
      if (Math.abs(x) < 120.5 && Math.abs(z) < 120.5) continue;
      if (Math.abs(trackDistance(x, z)) < 7) continue;
      if (edges.some((e) => distPointLine(x, z, e.line) < e.corridor + 2)) continue;
      if (city.stations.some((s) => x > s.minX - 9 && x < s.maxX + 9 && z > s.minZ - 5 && z < s.maxZ + 5)) continue;
      if (KEEP_OPEN.some((p) => inPoly(p, x, z))) continue;
      if (boards.some((r) => inRect(r, x, z, 2))) continue;
      addProp(rand() < 0.55 ? "tree_pine" : "tree_round", x, z, rand() * 6.28, true, { scale: 0.85 + rand() * 0.5 });
      placed++;
    }
  }
  // a few parking spots along the outer crossing roads (good train bait!)
  for (const r of [-22, 22]) {
    city.parking.push({ x: r + LANE_OFFSET + 3.6, z: 150, yaw: Math.PI });
    city.parking.push({ x: 150, z: r - LANE_OFFSET - 3.6, yaw: -Math.PI / 2 });
  }

  // ------------------------------------------------------------ the pedestrians' paths
  buildNav(city, nodes, edges);

  // ------------------------------------------------------------ loot
  const kinds = [Weapon.Pistol, Weapon.Smg, Weapon.Shotgun, Weapon.Grenade];
  for (const s of city.stations) city.pickups.push({ x: s.x, z: s.z, kind: Weapon.Grenade });
  city.pickups.push({ x: 6, z: 6, kind: Weapon.Shotgun });
  city.pickups.push({ x: -6, z: -6, kind: Weapon.Smg });
  let ki = 0;
  for (const p of parkPolys) { const c = centroidOf(p); city.pickups.push({ x: q(c.x), z: q(c.z), kind: kinds[ki++ % 4] }); }
  for (const l of LOTS) { const p = toWorld(l.x, l.z, l.yaw, 0, -(l.hz - 1.6)); city.pickups.push({ x: q(p.x), z: q(p.z), kind: kinds[ki++ % 4] }); }
  // in the mishaps and up on roofs: worth the climb (or the drop)
  const lootAt = (sp: string, lx: number, lz: number, y: number, kind: number) => {
    const d = SET_PIECES.find((p) => p.kind === sp);
    if (!d) return;
    const p = toWorld(d.x, d.z, d.yaw, lx, lz);
    city.pickups.push({ x: q(p.x), y, z: q(p.z), kind });
  };
  lootAt("sinkhole", -3, 0, -2.2, Weapon.Shotgun);
  lootAt("demolition", -4.6, -4.6, 9.9, Weapon.Smg);
  lootAt("collapsed", 3.6, -3.2, 4.97, Weapon.Grenade);
  lootAt("shell", -3.8, -3.2, 3.3, Weapon.Pistol);
  lootAt("millyard", -5.5, -2.5, 4.6, Weapon.Smg);
  for (const b of PLACED.slice(0, 2)) city.pickups.push({ x: b.x, y: KIT.buildings[b.model].roof, z: b.z + 2, kind: b === PLACED[0] ? Weapon.Shotgun : Weapon.Grenade });
  {
    const rand = mulberry32(0x1007);
    for (let k = 0; k < 8; k++) {
      const node = city.nav[Math.floor(rand() * city.nav.length)];
      city.pickups.push({ x: node.x, z: node.z, kind: kinds[ki++ % 4] });
    }
  }
  // spawn points: sidewalk corners near the middle of town (not on loot: see below)
  for (const node of city.nav) {
    if (Math.abs(node.x) < 80 && Math.abs(node.z) < 80) city.spawns.push({ x: node.x, z: node.z });
  }
  // snacks that heal
  for (const s of city.stations) {
    const alongX = s.maxX - s.minX > s.maxZ - s.minZ;
    city.pickups.push({ x: s.x + (alongX ? 8 : 0), z: s.z + (alongX ? 0 : 8), kind: PICKUP_FOOD });
  }
  city.pickups.push({ x: 6, z: -6, kind: PICKUP_FOOD });
  city.pickups.push({ x: -6, z: 6, kind: PICKUP_FOOD });
  for (const p of parkPolys) { const c = centroidOf(p); city.pickups.push({ x: q(c.x + 3), z: q(c.z + 3), kind: PICKUP_FOOD }); }
  lootAt("demolition", 0, -1.6, 3.3, PICKUP_FOOD);
  {
    const rand = mulberry32(0xf00d5);
    for (let k = 0; k < 6; k++) {
      const node = city.nav[Math.floor(rand() * city.nav.length)];
      city.pickups.push({ x: node.x + 1.2, z: node.z + 1.2, kind: PICKUP_FOOD });
    }
  }

  // ------------------------------------------------------------ trash cans, coffee, spawns
  const extraBins: (XZ & { y: number })[] = [];
  for (const sp of SET_PIECES) {
    for (const b of KIT.setpieces[sp.kind].bins ?? []) { const p = toWorld(sp.x, sp.z, sp.yaw, b.x, b.z); extraBins.push({ x: p.x, z: p.z, y: 0 }); }
  }
  // on a roof or two: the High Line's first, and a shop's
  extraBins.push({ x: PLACED[0].x - 3.5, z: PLACED[0].z + 2.5, y: KIT.buildings[PLACED[0].model].roof });
  const shop = city.buildings.find((b) => b.model === "bld_shop" && Math.abs(b.x) < 70 && Math.abs(b.z) < 70);
  if (shop) { const p = toWorld(shop.x, shop.z, shop.rot, -3, 1); extraBins.push({ x: p.x, z: p.z, y: KIT.buildings.bld_shop.roof }); }
  placeBins(city, streetBins, extraBins);
  placeCoffee(city);
  city.spawns = city.spawns.filter((s) => clearOfLoot(city, s.x, s.z));
  return city;
}

// ---------------------------------------------------------------- helpers
/**
 * The billboards (layout.ts): a pole, or a roof board's two legs (thin posts: no ledge to grab,
 * nothing to stop a bullet), and the panel, a floating slab turned exactly to face its way (cars
 * pass under a pole board's, a raccoon fits under a roof board's). Each is a prop whose `parts`
 * is its panel (what can hide the player from the camera). A roof board stands on the highest
 * roof under its middle. Returns the ground boards' spots, padded (the catwalk, room round the pole).
 */
function placeBillboards(city: City): Rect[] {
  const spots: Rect[] = [];
  for (const d of BILLBOARDS) {
    const model = d.roof ? "billboard_roof" : "billboard";
    const x = q(d.x), z = q(d.z);
    let y = 0;
    if (d.roof) {
      for (const b of city.boxes) {
        if (b.base === undefined && b.top > y && (b.rot ? inRect(b.rot, x, z, 0) : x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)) y = b.top;
      }
    }
    const extra = { tag: SolidTag.Prop, grab: false } as const;
    if (d.roof) {
      const k = BILLBOARD.billboard_roof;
      for (const lx of [-k.legX, k.legX]) {
        const p = toWorld(x, z, d.yaw, lx, 0);
        city.boxes.push(makeBox(q(p.x), q(p.z), d.yaw, k.leg, k.leg, y + k.base, { ...extra, base: y }));
      }
    } else {
      const k = BILLBOARD.billboard;
      city.boxes.push(makeBox(x, z, 0, k.post, k.post, k.base, extra));
    }
    const base = y + BILLBOARD[model].base;
    const panel = makeBox(x, z, d.yaw, BILLBOARD.hx, BILLBOARD.hz, base + BILLBOARD.height, { base, tag: SolidTag.Sign, grab: false });
    city.boxes.push(panel);
    city.props.push({ model, x, z, ...(y ? { y } : {}), rot: d.yaw, parts: { boxes: [panel], ramps: [] } });
    if (!d.roof) spots.push(rectAt(x, z, d.yaw, BILLBOARD.hx + 0.5, BILLBOARD.hz + 1.4));
  }
  return spots;
}

function pickWeighted(mix: Record<string, number>, rand: () => number): string {
  const keys = Object.keys(mix);
  let total = 0;
  for (const k of keys) total += mix[k];
  let r = rand() * total;
  for (const k of keys) { r -= mix[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

/** The bounds of a part set (boxes and ramps), in its own frame. */
function partsExtent(set: { boxes?: { x: number; z: number; hx: number; hz: number }[]; ramps?: { x: number; z: number; hx: number; hz: number; ax?: "x" }[] }) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const b of set.boxes ?? []) { minX = Math.min(minX, b.x - b.hx); maxX = Math.max(maxX, b.x + b.hx); minZ = Math.min(minZ, b.z - b.hz); maxZ = Math.max(maxZ, b.z + b.hz); }
  for (const r of set.ramps ?? []) {
    const hx = r.ax === "x" ? r.hz : r.hx, hz = r.ax === "x" ? r.hx : r.hz;
    minX = Math.min(minX, r.x - hx); maxX = Math.max(maxX, r.x + hx); minZ = Math.min(minZ, r.z - hz); maxZ = Math.max(maxZ, r.z + hz);
  }
  return { minX, minZ, maxX, maxZ };
}

function polyAreaOf(poly: P2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return a / 2;
}

function centroidOf(poly: P2[]): P2 {
  let x = 0, z = 0;
  for (const p of poly) { x += p.x; z += p.z; }
  return { x: x / poly.length, z: z / poly.length };
}

/**
 * Planks between flat roofs of the same height whose facing sides are 3.5 to 6.5 m apart (too far
 * to jump at a walk, close enough to bridge) and side by side over at least 3 m. A floating box,
 * 0.9 m wide, resting 0.4 m onto each roof.
 */
function placePlanks(city: City) {
  const flat = new Set(["bld_shop", "bld_apartment", "bld_donut"]);
  const bs = city.buildings.filter((b) => flat.has(b.model) && b.fade);
  let count = 0;
  for (let i = 0; i < bs.length && count < 10; i++) {
    for (let j = i + 1; j < bs.length && count < 10; j++) {
      const A = bs[i], B = bs[j];
      const roof = KIT.buildings[A.model].roof;
      if (Math.abs(KIT.buildings[B.model].roof - roof) > 0.3) continue;
      if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 > 30 * 30) continue;
      // the same way round, give or take quarter turns
      const dq = (B.rot - A.rot) / (Math.PI / 2);
      if (Math.abs(dq - Math.round(dq)) > 1e-3) continue;
      const swap = Math.abs(Math.round(dq)) % 2 === 1;
      const ka = KIT.buildings[A.model].boxes![0], kb = KIT.buildings[B.model].boxes![0];
      const ra = rectAt(A.x, A.z, A.rot, ka.hx, ka.hz);
      const bhx = swap ? kb.hz : kb.hx, bhz = swap ? kb.hx : kb.hz;
      // B's middle in A's frame
      const dx = B.x - A.x, dz = B.z - A.z;
      const lx = dx * ra.c - dz * ra.s, lz = dx * ra.s + dz * ra.c;
      let along: "x" | "z", gap: number, o0: number, o1: number;
      if (Math.abs(lx) - bhx >= ka.hx && Math.abs(lz) < ka.hz + bhz) {
        along = "x"; gap = Math.abs(lx) - bhx - ka.hx;
        o0 = Math.max(-ka.hz, lz - bhz); o1 = Math.min(ka.hz, lz + bhz);
      } else if (Math.abs(lz) - bhz >= ka.hz && Math.abs(lx) < ka.hx + bhx) {
        along = "z"; gap = Math.abs(lz) - bhz - ka.hz;
        o0 = Math.max(-ka.hx, lx - bhx); o1 = Math.min(ka.hx, lx + bhx);
      } else continue;
      if (gap < 3.5 || gap > 6.5 || o1 - o0 < 3) continue;
      const mid = (o0 + o1) / 2, sg = along === "x" ? Math.sign(lx) : Math.sign(lz);
      const len = gap + 0.8, c0 = (along === "x" ? ka.hx : ka.hz) + gap / 2;
      const lcx = along === "x" ? sg * c0 : mid, lcz = along === "x" ? mid : sg * c0;
      const p = toWorld(A.x, A.z, A.rot, lcx, lcz);
      const plank = makeBox(q(p.x), q(p.z), A.rot, along === "x" ? len / 2 : 0.45, along === "x" ? 0.45 : len / 2, roof, { base: roof - 0.12, tag: SolidTag.Plank });
      // nothing in the way on either roof where it lands
      const ends = [toWorld(A.x, A.z, A.rot, along === "x" ? sg * (c0 - len / 2) : mid, along === "x" ? mid : sg * (c0 - len / 2)),
        toWorld(A.x, A.z, A.rot, along === "x" ? sg * (c0 + len / 2) : mid, along === "x" ? mid : sg * (c0 + len / 2))];
      const blocked = ends.some((e) => city.boxes.some((b) => b.top > roof + 0.45 && b.base === undefined
        && e.x > b.minX - 0.7 && e.x < b.maxX + 0.7 && e.z > b.minZ - 0.7 && e.z < b.maxZ + 0.7));
      if (blocked) continue;
      // nor anything else built in the gap (stairs, a fire escape)
      const pr = rectAt(p.x, p.z, A.rot, along === "x" ? gap / 2 : 0.45, along === "x" ? 0.45 : gap / 2);
      if (city.ramps.some((r) => r.solid && rectGap(pr, { cx: r.cx, cz: r.cz, hx: r.hx, hz: r.hz, c: r.c, s: r.s }) < 0.2)) continue;
      city.boxes.push(plank);
      count++;
    }
  }
}

/**
 * The pedestrians' paths: a corner node on each sidewalk corner of every junction (where the
 * sidewalks of neighbouring streets meet), crosswalks across each street at its junctions, and
 * the sidewalks themselves between, with nodes along the way every ≤ 20 m (round curves too).
 */
function buildNav(city: City, nodes: RoadNode[], edges: Edge[]) {
  const nav = city.nav;
  const add = (x: number, z: number): number => { nav.push({ x: q(x), z: q(z), links: [] }); return nav.length - 1; };
  const link = (a: number, b: number) => {
    if (a === b || nav[a].links.includes(b)) return;
    nav[a].links.push(b); nav[b].links.push(a);
  };
  const walked = (e: Edge) => !(e.flags & EDGE_SPOKE);
  // (a little nearer the buildings than the kerb: the kerb has the lamps and the trash cans)
  const off = (e: Edge) => (e.flags & EDGE_ALLEY ? 0 : e.half + e.walk * 0.6);
  /** Per node, per arm (edge index): the corner node on the arm's right (going out along it) and on its left. */
  const corner = new Map<string, { r: number; l: number }>();
  nodes.forEach((nd, n) => {
    const arms = nd.edges.filter((i) => walked(edges[i])).map((i) => {
      const e = edges[i], p = e.pts;
      const [a, b] = e.a === n ? [p[0], p[1]] : [p[p.length - 1], p[p.length - 2]];
      const l = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
      const d = { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
      return { i, d, a: Math.atan2(d.z, d.x), o: off(e) };
    });
    if (!arms.length) return;
    arms.sort((p, q2) => p.a - q2.a);
    if (arms.length === 1) {
      // a street's end: a corner either side, joined round the end
      const { i, d, o } = arms[0];
      const rr = right(d.x, d.z);
      const ext = nd.kind === "culdesac" ? nd.r : 0;
      const r = add(nd.x + rr.x * o - d.x * ext, nd.z + rr.z * o - d.z * ext);
      const l = add(nd.x - rr.x * o - d.x * ext, nd.z - rr.z * o - d.z * ext);
      corner.set(`${n}:${i}`, { r, l });
      link(r, l);
      return;
    }
    const at: number[] = [];
    for (let k = 0; k < arms.length; k++) {
      const p = arms[k], o = arms[(k + 1) % arms.length];
      // p's sidewalk on o's side meets o's sidewalk on p's side
      const rp = right(p.d.x, p.d.z), lo = { x: o.d.z, z: -o.d.x };
      const ax = nd.x + rp.x * p.o, az = nd.z + rp.z * p.o;
      const bx = nd.x + lo.x * o.o, bz = nd.z + lo.z * o.o;
      const den = p.d.x * o.d.z - p.d.z * o.d.x;
      let cx: number, cz: number;
      if (Math.abs(den) < 0.17) { cx = (ax + bx) / 2; cz = (az + bz) / 2; }
      else {
        const t = ((bx - ax) * o.d.z - (bz - az) * o.d.x) / den;
        cx = ax + p.d.x * t; cz = az + p.d.z * t;
      }
      // (an acute corner reaches far out: keep it near)
      const far = Math.max(p.o, o.o) * 3, dd = Math.sqrt((cx - nd.x) ** 2 + (cz - nd.z) ** 2);
      if (dd > far) { cx = nd.x + ((cx - nd.x) * far) / dd; cz = nd.z + ((cz - nd.z) * far) / dd; }
      at.push(add(cx, cz));
    }
    for (let k = 0; k < arms.length; k++) {
      const r = at[k], l = at[(k - 1 + arms.length) % arms.length];
      corner.set(`${n}:${arms[k].i}`, { r, l });
      // a crosswalk across this street (not across a kink or the bend in a lane)
      if (arms.length >= 3) link(r, l);
    }
  });
  // the sidewalks along each street (both sides), with nodes every ≤ 20 m
  const pt = { x: 0, z: 0, dx: 0, dz: 0 };
  edges.forEach((e, i) => {
    if (!walked(e)) return;
    const A = corner.get(`${e.a}:${i}`), B = corner.get(`${e.b}:${i}`);
    if (!A || !B) return;
    const o = off(e);
    // going a → b: its right side starts at A's right corner and ends at B's left one
    const sides: [number, number, number][] = e.flags & EDGE_ALLEY ? [[A.r, B.l, 0]] : [[A.r, B.l, 1], [A.l, B.r, -1]];
    // a node at every bend (so a path never cuts inside one, toward the kerb), and every <= 20 m between
    const s0 = nodes[e.a].r, s1 = e.len - nodes[e.b].r;
    const at: number[] = [s0];
    for (let i = 1; i < e.pts.length - 1; i++) if (e.cum[i] > s0 + 1 && e.cum[i] < s1 - 1) at.push(e.cum[i]);
    at.push(s1);
    const ss: number[] = [];
    for (let k = 0; k + 1 < at.length; k++) {
      const n = Math.ceil((at[k + 1] - at[k]) / 20);
      for (let j = k === 0 ? 1 : 0; j < n; j++) ss.push(at[k] + ((at[k + 1] - at[k]) * j) / n);
    }
    for (const [from, to, sg] of sides) {
      let prev = from;
      for (const s of ss) {
        // (offset along the mitred normal at a bend: the average of the two segments')
        const a = lineAt(e.line, Math.max(0, s - 0.05), { x: 0, z: 0, dx: 0, dz: 0 }), b = lineAt(e.line, Math.min(e.len, s + 0.05), { x: 0, z: 0, dx: 0, dz: 0 });
        lineAt(e.line, s, pt);
        let nx = -(a.dz + b.dz), nz = a.dx + b.dx;
        const nl = Math.sqrt(nx * nx + nz * nz) || 1;
        nx /= nl; nz /= nl;
        const k = 1 / Math.max(0.5, nx * -a.dz + nz * a.dx);
        const id = add(pt.x + nx * o * sg * k, pt.z + nz * o * sg * k);
        link(prev, id);
        prev = id;
      }
      link(prev, to);
    }
  });
  // a path that would take townsfolk through something (a building's corner at a sharp bend, a
  // post) is left out, and so is whatever that cuts off from the rest
  const blocked = (a: NavNode, b: NavNode) => {
    const len = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    const x0 = Math.min(a.x, b.x) - 0.3, x1 = Math.max(a.x, b.x) + 0.3, z0 = Math.min(a.z, b.z) - 0.3, z1 = Math.max(a.z, b.z) + 0.3;
    const near = <T extends { minX: number; minZ: number; maxX: number; maxZ: number }>(l: readonly T[]) =>
      l.filter((q) => q.maxX >= x0 && q.minX <= x1 && q.maxZ >= z0 && q.minZ <= z1);
    const bx = near(city.boxes), rx = near(city.ramps), px = near(city.pits);
    for (let t = 0; t <= len; t += 0.5) {
      const x = a.x + ((b.x - a.x) * t) / Math.max(len, 1e-6), z = a.z + ((b.z - a.z) * t) / Math.max(len, 1e-6);
      if (!roomAmong(bx, rx, px, x, z, 0, 0.2)) return true;
    }
    return false;
  };
  for (let i = 0; i < nav.length; i++) {
    for (const j of [...nav[i].links]) {
      if (j < i || !blocked(nav[i], nav[j])) continue;
      nav[i].links = nav[i].links.filter((k) => k !== j);
      nav[j].links = nav[j].links.filter((k) => k !== i);
    }
  }
  const comp = new Int32Array(nav.length).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < nav.length; i++) {
    if (comp[i] >= 0) continue;
    const c = sizes.length, todo = [i];
    comp[i] = c;
    let n = 0;
    while (todo.length) {
      const k = todo.pop()!;
      n++;
      for (const j of nav[k].links) if (comp[j] < 0) { comp[j] = c; todo.push(j); }
    }
    sizes.push(n);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const remap = new Int32Array(nav.length).fill(-1);
  const kept: NavNode[] = [];
  nav.forEach((n, i) => { if (comp[i] === main) { remap[i] = kept.length; kept.push(n); } });
  for (const n of kept) n.links = n.links.map((j) => remap[j]);
  city.nav = kept;
}
