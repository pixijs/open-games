/**
 * What the town is made of: its types (colliders, placements, the street graph), the building
 * catalogue, the builders for turned boxes, ramps and pits (`placeParts` puts a model's
 * colliders from kit.json down), and the placing of trash cans and coffee. Shared by both town
 * generators (the old grid in map.ts, the street graph in citygen.ts); map.ts re-exports it all.
 */
import { PICKUP_ZOOMIES } from "./constants.js";
import type { PartSet } from "./kit.js";

// ---------------------------------------------------------------- seeded random
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- types
/**
 * A turned rectangle: centre, half sizes along its own axes, and the cosine and sine of its yaw.
 * World → local is `lx = dx·c − dz·s, lz = dx·s + dz·c` (as `circleObb`): local +Z points along
 * the yaw, (sin, cos), and local +X along (cos, −sin).
 */
export interface Obb { cx: number; cz: number; hx: number; hz: number; c: number; s: number }

/**
 * Static collider: a column from the ground (or from `base`) up to `top`. Low ones can be stood
 * on. `minX..maxZ` is its exact footprint when it isn't turned, else the bounds of `rot`.
 */
export interface Box {
  minX: number; minZ: number; maxX: number; maxZ: number; top: number;
  /** The underside of a floating slab (a plank, a landing, an awning): there's room under it. */
  base?: number;
  /** Set when the box is turned off the axes: its exact shape. */
  rot?: Obb;
  /**
   * A lamp post (index into `City.poles`). Cars don't hit its box: the driving step knocks the
   * post over or stops at it (see `poleContact`). Walkers always bump into it, standing or not:
   * a knocked-over post leaves its stub.
   */
  pole?: number;
  /**
   * Street furniture (index into `City.loose`): cars drive straight through it, and every
   * client knocks it flying on its own screen, then stands it back up (`KnockView`). Walkers
   * always bump into it where it stands.
   */
  loose?: number;
  /** false: not a ledge to climb (signs, parapets, posts, trees). */
  grab?: false;
  /** What it is (`SolidTag`), for drawing and debugging. */
  tag?: number;
}

/**
 * A walkable slope over a turned rectangle, rising along its local +Z from `h0` (at local
 * z = −hz) to `h1` (at +hz). A plain ramp is only a floor (the station ramps); a `solid` one is
 * a wedge, a wall wherever its surface is out of step reach (stairs, rubble, a gable roof).
 */
export interface Ramp extends Obb {
  minX: number; minZ: number; maxX: number; maxZ: number;
  h0: number; h1: number;
  solid?: boolean;
  /** Floating: solid only this far under its surface (a fire-escape flight, an awning). */
  thick?: number;
  /** Drawn as steps rather than a paved slope. */
  stairs?: boolean;
  /** Drawn by a model: the ground layers leave it out. */
  model?: boolean;
  tag?: number;
}

/** A hole in the ground. Inside it the floor is `floor` (below 0); from down there its rim is a wall. */
export interface Pit extends Obb { minX: number; minZ: number; maxX: number; maxZ: number; floor: number }

/** What a collider is (`Box.tag`, `Ramp.tag`). */
export const SolidTag = {
  Building: 0, RoofClutter: 1, Prop: 2, Bin: 3, Platform: 4, Stairs: 5, Landing: 6, Plank: 7, Rubble: 8,
  Slab: 9, Wall: 10, Crane: 11, Barrier: 12, Awning: 13, Debris: 14, Roof: 15, Sign: 16,
} as const;

/** Height of a parking lot's surface, drawn a little over the road (props in a lot stand on it). */
export const LOT_Y = 0.034;

export interface Placement {
  model: string;
  x: number; z: number; y?: number;
  /** Yaw in radians (model front = +Z at 0). */
  rot: number;
  /** Optional wall/paint tint. */
  tint?: number;
  scale?: number;
  /** Footprint (bounds) + height, for camera occlusion fading. Not a collider: see `placeParts`. */
  box?: Box;
  /** The footprint exactly, in its own frame (half sizes along its axes): `box` is its bounds when turned. */
  fade?: { hx: number; hz: number; top: number };
  /** A building's (or a ruin's) own colliders, also in `City.boxes`/`ramps`: what can hide a raccoon from the camera. */
  parts?: { boxes: Box[]; ramps: Ramp[] };
  /** Where you stand on its roof (kit.json): up there it's the floor, never in the way. A ruin has none. */
  roof?: number;
}

export interface NavNode { x: number; z: number; links: number[] }

export interface Intersection { ix: number; iz: number; x: number; z: number }

export interface ParkingSpot { x: number; z: number; yaw: number }

/** A loot can: where it stands (`y`: the surface under it, when it isn't the ground or a low step). */
export interface PickupSpot { x: number; y?: number; z: number; kind: number }

export interface Crossing {
  /** Where the road meets the track. */
  x: number; z: number;
  /** Track distance of the crossing point. */
  s: number;
  /** "x" when the road runs along X (barriers block X traffic). */
  roadAxis: "x" | "z";
}

export interface Station { x: number; z: number; rot: number; minX: number; minZ: number; maxX: number; maxZ: number }

/** A trash can a raccoon can hide in: where it stands (`y`: the ground under it) and its rim. */
export interface BinSpot { x: number; z: number; y: number; top: number; rot: number }

/** A lamp post a car can knock over: where it stands, and its placement (index into `City.props`). */
export interface PoleSpot { x: number; z: number; prop: number }

/** Street furniture a car drives through (`Box.loose`): a prop (index into `City.props`) or a trash can (into `City.bins`). */
export interface LooseSpot { x: number; z: number; prop?: number; bin?: number }

/** The props that are street furniture (`LooseSpot`): the rest stop a car (trees, signs, dumpsters). */
export const LOOSE_PROPS: ReadonlySet<string> = new Set(["hydrant", "bench", "trash_bags", "drum"]);

/**
 * A district's street dressing, drawn by the client from this (the solid ones are also boxes in
 * `City.boxes`): a picket fence, a hedge, a garden path, a crate, a pallet stack, a concrete
 * planter, a flag pole. Centre, turned by `yaw` (like a placement), half sizes along its
 * own x and z, its height; `seed` varies the look.
 */
export interface Dressing {
  kind: "fence" | "hedge" | "path" | "crate" | "pallets" | "planter" | "flagpole";
  x: number; z: number; yaw: number; hx: number; hz: number; h: number; y?: number; seed: number;
}

export interface City {
  boxes: Box[];
  ramps: Ramp[];
  /** Holes in the ground (the sinkhole). */
  pits: Pit[];
  buildings: Placement[];
  props: Placement[];
  /** Bounds, and (the new town) the exact outline. */
  parks: { minX: number; minZ: number; maxX: number; maxZ: number; poly?: XZ[] }[];
  /** Bounds, and (the new town) the exact outline and the way its bays face. */
  lots: { minX: number; minZ: number; maxX: number; maxZ: number; poly?: XZ[]; yaw?: number }[];
  plaza: { minX: number; minZ: number; maxX: number; maxZ: number };
  nav: NavNode[];
  intersections: Intersection[];
  parking: ParkingSpot[];
  pickups: PickupSpot[];
  crossings: Crossing[];
  stations: Station[];
  spawns: { x: number; z: number }[];
  /** Trash cans to hide in (`Mode.Hidden` keeps the index in `veh`). Each is also a collider box. */
  bins: BinSpot[];
  /** The lamp posts, which cars knock over (`GameState.poles` has the fallen ones). */
  poles: PoleSpot[];
  /** Street furniture cars drive through (hydrants, benches, trash bags, oil drums, trash cans). */
  loose: LooseSpot[];
  /** The street graph (empty in the old grid town, which has `intersections` instead). */
  roads: Roads;
  /** The mishaps and the landmarks (where each one is: the client animates the crane, draws the sinkhole). */
  setPieces: { kind: string; x: number; z: number; yaw: number }[];
  /** The districts' street dressing. */
  dressing: Dressing[];
  /** Spots the game refers to by name. */
  landmarks: { menu: XZ };
}

/** A street's end or a junction. `r`: how far its junction's paving reaches out along each street. */
export interface RoadNode { x: number; z: number; kind?: "culdesac" | "edge" | "dead"; r: number; edges: number[] }
/** A street between two nodes: its centre line (from `a` to `b`), half widths, flags (layout.ts EDGE_*). */
export interface RoadEdge {
  a: number; b: number; pts: XZ[]; cum: number[]; len: number;
  half: number; walk: number; flags: number; name?: string;
}
export interface Roads { nodes: RoadNode[]; edges: RoadEdge[] }

// ---------------------------------------------------------------- building catalogue
export interface BuildingDef { model: string; w: number; d: number; h: number; weight: number }
export const BUILDINGS: BuildingDef[] = [
  { model: "bld_house", w: 9, d: 9, h: 8, weight: 3 },
  { model: "bld_shop", w: 12, d: 9, h: 6.5, weight: 3 },
  { model: "bld_apartment", w: 12, d: 12, h: 14, weight: 3 },
  { model: "bld_tower", w: 14, d: 14, h: 26, weight: 2 },
  { model: "bld_donut", w: 10, d: 10, h: 10, weight: 1 },
];
export const WALL_TINTS = [0xffb3c7, 0xa8e6cf, 0xffe8a3, 0xcdb4ff, 0xffcfa8, 0xa0d8ff, 0xfff5e1, 0xb8f2e6];

/** A trash can's radius (its collider is the square around it) and its height to the rim. */
export const BIN_R = 0.42;
export const BIN_H = 1.0;
/** How close a shot has to pass to a can's middle to hit it: generous, like the players' hit circle. */
export const BIN_HIT_R = 0.6;

/** Collision footprint of props (half sizes) and height. Bushes have none: you walk (and drive) through them. */
export const PROP_COLLIDERS: Record<string, { hx: number; hz: number; top: number }> = {
  lamp: { hx: 0.18, hz: 0.18, top: 4.2 },
  tree_round: { hx: 0.3, hz: 0.3, top: 4.2 },
  tree_pine: { hx: 0.35, hz: 0.35, top: 4.5 },
  hydrant: { hx: 0.22, hz: 0.22, top: 0.7 },
  bench: { hx: 0.9, hz: 0.3, top: 0.45 },
  flowerbed: { hx: 1.5, hz: 0.5, top: 0.5 },
  crossing_sign: { hx: 0.15, hz: 0.15, top: 3 },
  crossing_barrier: { hx: 0.25, hz: 0.25, top: 1.1 },
  dumpster: { hx: 0.95, hz: 0.55, top: 1.3 },
  trash_bags: { hx: 0.6, hz: 0.45, top: 0.6 },
  drum: { hx: 0.35, hz: 0.35, top: 0.95 },
};

/**
 * The billboards (`build_billboard` in assets-src/blender/build_characters_props.py): a frame
 * `hx` × `hz` (half sizes) and `height` tall, the poster on both sides, its underside `base` up
 * from where it stands. `billboard` stands on a pole (out of jump reach, cars pass under);
 * `billboard_roof` on two legs at ±`legX` (room to walk under it, not to jump).
 */
export const BILLBOARD = {
  hx: 4.15, hz: 0.2, height: 4.3,
  billboard: { base: 5.45, post: 0.32 },
  billboard_roof: { base: 1.45, legX: 2.6, leg: 0.12 },
} as const;


/**
 * Coffee to go (the zoomies): six cups on sidewalk corners inside the ring road (the fumes
 * close in toward the middle), spread as far apart as they go, clear of every other loot can,
 * the trash cans and the walls. Placed after the cans, so nothing placed before moves (and
 * every earlier pickup keeps its key).
 */
export function placeCoffee(city: City) {
  const R = 0.6;
  const near = (q: XZ, x: number, z: number, d: number) => (q.x - x) ** 2 + (q.z - z) ** 2 < d * d;
  const free = (x: number, z: number) => roomAt(city, x, z, 0, R)
    && !city.pickups.some((q) => near(q, x, z, 4)) && !city.bins.some((q) => near(q, x, z, 2.5));
  // a free spot by each corner: a step off it diagonally (the corner itself may have loot)
  const spots: XZ[] = [];
  for (const n of city.nav) {
    if (Math.abs(n.x) > 90 || Math.abs(n.z) > 90) continue;
    for (const [dx, dz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
      if (free(n.x + dx, n.z + dz)) { spots.push({ x: n.x + dx, z: n.z + dz }); break; }
    }
  }
  // the one nearest the middle of town, then each time the one farthest from every cup so far
  const cups: XZ[] = [];
  let next = spots.reduce((a, b) => (a.x ** 2 + a.z ** 2 <= b.x ** 2 + b.z ** 2 ? a : b));
  while (cups.length < 6) {
    cups.push(next);
    let best = -1;
    for (const s of spots) {
      const d = Math.min(...cups.map((c) => (c.x - s.x) ** 2 + (c.z - s.z) ** 2));
      if (d > best) { best = d; next = s; }
    }
  }
  for (const c of cups) city.pickups.push({ x: c.x, z: c.z, kind: PICKUP_ZOOMIES });
}

/**
 * The trash cans raccoons hide in: the street bins (slid along the kerb until they're clear
 * of the lamp posts), two by the plaza's benches, one by a bench in each park, one next to
 * every lot's dumpster and one at the back of each station platform. Each is solid (the
 * square round the can). A spot with no room near it is left out. Placed after everything
 * else, so nothing placed before them moves.
 */
export function placeBins(city: City, street: (XZ & { dx?: number; dz?: number })[], extra: (XZ & { y: number })[] = []) {
  const R = BIN_R + 0.12; // with a little room round each can
  const free = (x: number, z: number, y: number) => {
    if (!roomAt(city, x, z, y, R)) return false;
    // not on a loot can (you'd loot it diving in), a parking spot, a corner people spawn on, another can
    const near = (q: XZ, d: number) => (q.x - x) ** 2 + (q.z - z) ** 2 < d * d;
    return !city.pickups.some((q) => near(q, 2.5)) && !city.parking.some((q) => near(q, 3.2))
      && !city.spawns.some((q) => near(q, 2.5)) && !city.bins.some((q) => near(q, 2.5));
  };
  /** A can at (x, z), or as close as there's room to it along (dx, dz): up to 3 m either way. */
  const add = (x: number, z: number, y: number, dx = 0, dz = 0) => {
    for (let k = 0; k <= (dx || dz ? 12 : 0); k++) {
      const s = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5; // 0, +0.5, -0.5, +1, -1…
      const px = x + dx * s, pz = z + dz * s;
      if (!free(px, pz, y)) continue;
      // each turned its own way (the same for everyone), so they don't all look alike
      city.bins.push({ x: px, z: pz, y, top: y + BIN_H, rot: Math.abs(px * 7.3 + pz * 3.1) % (Math.PI * 2) });
      return;
    }
  };

  // the sidewalks (all along roads that run north-south)
  for (const b of street) add(b.x, b.z, 0, b.dx ?? 0, b.dz ?? 1);
  // by the plaza's benches, and a bench in each park: they have loot
  const pz = city.plaza, pcx = (pz.minX + pz.maxX) / 2, pcz = (pz.minZ + pz.maxZ) / 2;
  add(pcx - 7.2, pcz - 11.6, 0, 1, 0);
  add(pcx + 7.2, pcz + 11.6, 0, 1, 0);
  for (const p of city.parks) add((p.minX + p.maxX) / 2 + 2.1, (p.minZ + p.maxZ) / 2 - 3, 0, 1, 0);
  // the trash corner of every parking lot: past the dumpster's bags
  city.lots.forEach((l, i) => {
    const side = i % 2 ? 1 : -1;
    add((side > 0 ? l.maxX - 1.4 : l.minX + 1.4) - side * 3.5, l.maxZ - 0.75, LOT_Y, 1, 0);
  });
  // at the back of each station platform, between two canopy posts, at the end away from its loot
  for (const s of city.stations) {
    const c = Math.cos(s.rot), sn = Math.sin(s.rot);
    const at = (lx: number, lz: number): XZ => ({ x: s.x + lx * c + lz * sn, z: s.z - lx * sn + lz * c });
    const loot = (q: XZ) => Math.min(...city.pickups.map((p) => Math.hypot(p.x - q.x, p.z - q.z)));
    const a = at(-1.2, 6.75), b = at(-1.2, -6.75);
    const e = loot(a) >= loot(b) ? a : b;
    add(e.x, e.z, 1.6);
  }
  // the town's own (in the mishaps, on roofs)
  for (const e of extra) add(e.x, e.z, e.y, 1, 0);

  city.bins.forEach((b, i) => {
    city.boxes.push({ minX: b.x - BIN_R, minZ: b.z - BIN_R, maxX: b.x + BIN_R, maxZ: b.z + BIN_R, top: b.top, loose: city.loose.length });
    city.loose.push({ x: b.x, z: b.z, bin: i });
  });
}

/**
 * Is there room for something of radius `r` standing at (x, y, z), going by the town's colliders
 * so far (the floor it stands on doesn't count, nor anything floating over its head)?
 */
export function roomAt(city: City, x: number, z: number, y: number, r: number): boolean {
  return roomAmong(city.boxes, city.ramps, city.pits, x, z, y, r);
}

/** `roomAt`, among just these colliders (a caller testing many points nearby picks them out once). */
export function roomAmong(boxes: readonly Box[], ramps: readonly Ramp[], pits: readonly Pit[], x: number, z: number, y: number, r: number): boolean {
  for (const b of boxes) {
    if (b.top <= y + 0.05 || (b.base !== undefined && b.base > y + 1.3)) continue;
    if (x + r < b.minX || x - r > b.maxX || z + r < b.minZ || z - r > b.maxZ) continue;
    if (!b.rot) return false;
    const dx = x - b.rot.cx, dz = z - b.rot.cz;
    const lx = dx * b.rot.c - dz * b.rot.s, lz = dx * b.rot.s + dz * b.rot.c;
    if (Math.max(0, Math.abs(lx) - b.rot.hx) ** 2 + Math.max(0, Math.abs(lz) - b.rot.hz) ** 2 < r * r) return false;
  }
  for (const q of ramps) {
    if (!q.solid || x + r < q.minX || x - r > q.maxX || z + r < q.minZ || z - r > q.maxZ) continue;
    const dx = x - q.cx, dz = z - q.cz;
    const lx = dx * q.c - dz * q.s, lz = dx * q.s + dz * q.c;
    if (Math.max(0, Math.abs(lx) - q.hx) ** 2 + Math.max(0, Math.abs(lz) - q.hz) ** 2 < r * r) return false;
  }
  for (const q of pits) {
    if (y >= 0 && x + r > q.minX && x - r < q.maxX && z + r > q.minZ && z - r < q.maxZ) return false;
  }
  return true;
}

/** Is (x, z) at least `r` m from every loot can (a spawn point)? */
export function clearOfLoot(city: City, x: number, z: number, r = 4) {
  return city.pickups.every((p) => (p.x - x) ** 2 + (p.z - z) ** 2 >= r * r);
}

// ---------------------------------------------------------------- shapes
/** The cosine and sine of a yaw: exact on the quarter turns, float32 elsewhere (the same in every engine). */
export function cosSin(yaw: number): [number, number] {
  const q = yaw / (Math.PI / 2), k = Math.round(q);
  if (Math.abs(q - k) < 1e-9) {
    switch (((k % 4) + 4) % 4) {
      case 0: return [1, 0];
      case 1: return [0, 1];
      case 2: return [-1, 0];
      default: return [0, -1];
    }
  }
  return [Math.fround(Math.cos(yaw)), Math.fround(Math.sin(yaw))];
}

/** Sets `out`'s min/max to the world bounds of a turned rectangle. */
function obbBounds(o: Obb, out: { minX: number; minZ: number; maxX: number; maxZ: number }) {
  const ex = Math.abs(o.hx * o.c) + Math.abs(o.hz * o.s);
  const ez = Math.abs(o.hx * o.s) + Math.abs(o.hz * o.c);
  out.minX = o.cx - ex; out.maxX = o.cx + ex;
  out.minZ = o.cz - ez; out.maxZ = o.cz + ez;
}

/** A box 2·hx × 2·hz along its own axes, centred at (cx, cz), turned by `yaw`, standing up to `top`. */
export function makeBox(cx: number, cz: number, yaw: number, hx: number, hz: number, top: number, extra: Partial<Box> = {}): Box {
  const [c, s] = cosSin(yaw);
  if (c === 0 || s === 0) {
    // on the axes: a plain box (a quarter turn swaps its sizes)
    const ax = c === 0 ? hz : hx, az = c === 0 ? hx : hz;
    return { minX: cx - ax, minZ: cz - az, maxX: cx + ax, maxZ: cz + az, top, ...extra };
  }
  const rot: Obb = { cx, cz, hx, hz, c, s };
  const b: Box = { minX: 0, minZ: 0, maxX: 0, maxZ: 0, top, ...extra, rot };
  obbBounds(rot, b);
  return b;
}

/** A ramp over a 2·hx × 2·hz rectangle centred at (cx, cz), rising toward `yaw` from h0 to h1. */
export function makeRamp(cx: number, cz: number, yaw: number, hx: number, hz: number, h0: number, h1: number, extra: Partial<Ramp> = {}): Ramp {
  const [c, s] = cosSin(yaw);
  const r: Ramp = { cx, cz, hx, hz, c, s, minX: 0, minZ: 0, maxX: 0, maxZ: 0, h0, h1, ...extra };
  obbBounds(r, r);
  return r;
}

/** A ramp over [minX, maxX] × [minZ, maxZ], rising from h0 to h1 toward +x or +z. */
export function axisRamp(minX: number, minZ: number, maxX: number, maxZ: number, axis: "x" | "z", h0: number, h1: number, extra: Partial<Ramp> = {}): Ramp {
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return axis === "x"
    ? makeRamp(cx, cz, Math.PI / 2, (maxZ - minZ) / 2, (maxX - minX) / 2, h0, h1, extra)
    : makeRamp(cx, cz, 0, (maxX - minX) / 2, (maxZ - minZ) / 2, h0, h1, extra);
}

/** A hole 2·hx × 2·hz centred at (cx, cz), turned by `yaw`, with its floor at `floor` (below 0). */
export function makePit(cx: number, cz: number, yaw: number, hx: number, hz: number, floor: number): Pit {
  const [c, s] = cosSin(yaw);
  const p: Pit = { cx, cz, hx, hz, c, s, minX: 0, minZ: 0, maxX: 0, maxZ: 0, floor };
  obbBounds(p, p);
  return p;
}

/**
 * Put a collider template (`kit.json`, in a model's own frame) into `out`, the model standing at
 * (x, z) turned by `rot` (and mirrored across its own x = 0 first, with `mirror`).
 */
export function placeParts(set: PartSet, x: number, z: number, rot: number, out: { boxes: Box[]; ramps: Ramp[]; pits?: Pit[] }, mirror = false) {
  const [c, s] = cosSin(rot);
  const m = mirror ? -1 : 1;
  const wx = (lx: number, lz: number) => x + lx * m * c + lz * s;
  const wz = (lx: number, lz: number) => z - lx * m * s + lz * c;
  const tag = (t?: string) => (t ? (SolidTag as Record<string, number>)[t] : undefined);
  for (const b of set.boxes ?? []) {
    const extra: Partial<Box> = {};
    if (b.base !== undefined) extra.base = b.base;
    if (b.grab === false) extra.grab = false;
    const t = tag(b.tag);
    if (t !== undefined) extra.tag = t;
    out.boxes.push(makeBox(wx(b.x, b.z), wz(b.x, b.z), rot, b.hx, b.hz, b.top, extra));
  }
  for (const r of set.ramps ?? []) {
    const extra: Partial<Ramp> = {};
    if (r.solid) extra.solid = true;
    if (r.thick !== undefined) extra.thick = r.thick;
    if (r.stairs) { extra.stairs = true; extra.model = true; }
    const t = tag(r.tag);
    if (t !== undefined) extra.tag = t;
    // (rising toward the model's −z: the same ramp turned round; along its x: a quarter turn, the
    // way the mirror leaves it)
    const turn = r.ax === "x" ? (r.dir * m > 0 ? Math.PI / 2 : -Math.PI / 2) : r.dir < 0 ? Math.PI : 0;
    out.ramps.push(makeRamp(wx(r.x, r.z), wz(r.x, r.z), rot + turn, r.hx, r.hz, r.lo, r.hi, extra));
  }
  for (const p of set.pits ?? []) out.pits?.push(makePit(wx(p.x, p.z), wz(p.x, p.z), rot, p.hx, p.hz, p.floor));
}

export interface XZ { x: number; z: number }
