/**
 * The town and the queries over its static world. The town is built from a hand-drawn plan
 * (layout.ts, citygen.ts) the same way on the server and on every client, colliders and all, so
 * none of it is ever sent over the wire. What it's made of (types, the building catalogue, the
 * builders) is in town.ts, re-exported here.
 */
import { CAR_CLEAR, MAP_HALF, PLAYER_HEIGHT, STEP_UP } from "./constants.js";
import { generateV2 } from "./citygen.js";
import { BIN_HIT_R, type Box, type City, type Obb, type Pit, type Ramp, type XZ } from "./town.js";

export * from "./town.js";

/** The trash can whose centre is nearest (x, z) within `reach` (and whose floor is near `y`), or -1. */
export function nearestBin(x: number, y: number, z: number, reach: number): number {
  let best = -1, bestD = reach * reach;
  CITY.bins.forEach((b, i) => {
    const d = (b.x - x) ** 2 + (b.z - z) ** 2;
    if (d <= bestD && Math.abs(b.y - y) < 0.6) { bestD = d; best = i; }
  });
  return best;
}

// ---------------------------------------------------------------- the static world
const CELL = 8;
const GRID_N = Math.ceil((MAP_HALF * 2) / CELL) + 1;
const cellOf = (v: number) => Math.max(0, Math.min(GRID_N - 1, Math.floor((v + MAP_HALF) / CELL)));

/** Everything solid that never moves, with a spatial hash over its boxes and its ramps. */
export interface StaticWorld {
  boxes: Box[]; ramps: Ramp[]; pits: Pit[];
  boxGrid: number[][]; rampGrid: number[][];
  /** `boxGrid` with only the lamp posts' boxes (same order): what `polesNear` walks. */
  poleGrid: number[][];
  boxSeen: Uint32Array; rampSeen: Uint32Array;
  boxStamp: number; rampStamp: number;
}

function hashInto(items: readonly { minX: number; minZ: number; maxX: number; maxZ: number }[]): number[][] {
  const grid: number[][] = Array.from({ length: GRID_N * GRID_N }, (): number[] => []);
  items.forEach((b, i) => {
    for (let gx = cellOf(b.minX); gx <= cellOf(b.maxX); gx++) {
      for (let gz = cellOf(b.minZ); gz <= cellOf(b.maxZ); gz++) grid[gx * GRID_N + gz].push(i);
    }
  });
  return grid;
}

export function makeStaticWorld(boxes: Box[], ramps: Ramp[] = [], pits: Pit[] = []): StaticWorld {
  const boxGrid = hashInto(boxes);
  return {
    boxes, ramps, pits, boxGrid, rampGrid: hashInto(ramps),
    poleGrid: boxGrid.map((cell) => cell.filter((i) => boxes[i].pole !== undefined)),
    boxSeen: new Uint32Array(boxes.length), rampSeen: new Uint32Array(ramps.length), boxStamp: 0, rampStamp: 0,
  };
}

/** The world every query below reads: the town's (see the end of this file), or a test's own (`withStaticWorld`). */
let W = makeStaticWorld([]);

/** Runs `fn` with `w` as the static world (tests: synthetic geometry). */
export function withStaticWorld<T>(w: StaticWorld, fn: () => T): T {
  const prev = W;
  W = w;
  try { return fn(); } finally { W = prev; }
}

/** Calls `fn` once for every box whose bounds overlap the rectangle. */
export function forBoxesIn(minX: number, minZ: number, maxX: number, maxZ: number, fn: (b: Box) => void) {
  boxesIn(W.boxGrid, minX, minZ, maxX, maxZ, fn);
}

function boxesIn(grid: number[][], minX: number, minZ: number, maxX: number, maxZ: number, fn: (b: Box) => void) {
  const w = W;
  w.boxStamp = (w.boxStamp + 1) >>> 0;
  if (w.boxStamp === 0) { w.boxSeen.fill(0); w.boxStamp = 1; }
  const stamp = w.boxStamp, seen = w.boxSeen;
  for (let gx = cellOf(minX); gx <= cellOf(maxX); gx++) {
    for (let gz = cellOf(minZ); gz <= cellOf(maxZ); gz++) {
      for (const i of grid[gx * GRID_N + gz]) {
        if (seen[i] === stamp) continue;
        seen[i] = stamp;
        const b = w.boxes[i];
        if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
        fn(b);
      }
    }
  }
}

/** Calls `fn` once for every ramp whose bounds overlap the rectangle. */
export function forRampsIn(minX: number, minZ: number, maxX: number, maxZ: number, fn: (r: Ramp) => void) {
  const w = W;
  if (!w.ramps.length) return;
  w.rampStamp = (w.rampStamp + 1) >>> 0;
  if (w.rampStamp === 0) { w.rampSeen.fill(0); w.rampStamp = 1; }
  const stamp = w.rampStamp, seen = w.rampSeen;
  for (let gx = cellOf(minX); gx <= cellOf(maxX); gx++) {
    for (let gz = cellOf(minZ); gz <= cellOf(maxZ); gz++) {
      for (const i of w.rampGrid[gx * GRID_N + gz]) {
        if (seen[i] === stamp) continue;
        seen[i] = stamp;
        const r = w.ramps[i];
        if (r.maxX < minX || r.minX > maxX || r.maxZ < minZ || r.minZ > maxZ) continue;
        fn(r);
      }
    }
  }
}

// ---------------------------------------------------------------- queries

const _loc: XZ = { x: 0, z: 0 };

/** (x, z) in `o`'s own frame. */
function toLocal(o: Obb, x: number, z: number, out: XZ): XZ {
  const dx = x - o.cx, dz = z - o.cz;
  out.x = dx * o.c - dz * o.s;
  out.z = dx * o.s + dz * o.c;
  return out;
}

/** Is (x, z) inside box `b`'s footprint? */
export function pointInBox(b: Box, x: number, z: number): boolean {
  if (!b.rot) return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  toLocal(b.rot, x, z, _loc);
  return Math.abs(_loc.x) <= b.rot.hx && Math.abs(_loc.z) <= b.rot.hz;
}

/** Is (x, z) over ramp `r`? */
export function inRamp(r: Ramp, x: number, z: number): boolean {
  toLocal(r, x, z, _loc);
  return Math.abs(_loc.x) <= r.hx && Math.abs(_loc.z) <= r.hz;
}

/** Ramp `r`'s surface height at local z `lz` (clamped to its ends). */
function rampAt(r: Ramp, lz: number): number {
  const t = (lz + r.hz) / (2 * r.hz);
  return r.h0 + (r.h1 - r.h0) * (t < 0 ? 0 : t > 1 ? 1 : t);
}

/** Ramp `r`'s surface height over (x, z) (clamped to its ends). */
export function rampHeight(r: Ramp, x: number, z: number): number {
  return rampAt(r, toLocal(r, x, z, _loc).z);
}

/** Push circle `p` (radius `r`) out of axis-aligned box `b`; `n` gets the unit way out. False: not touching. */
function pushOutAabb(p: XZ, b: Box, r: number, n: XZ): boolean {
  const cx = Math.max(b.minX, Math.min(p.x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
  let dx = p.x - cx, dz = p.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    dx /= d; dz /= d;
    p.x = cx + dx * r;
    p.z = cz + dz * r;
    n.x = dx; n.z = dz;
  } else {
    // centre inside the box: leave through the nearest face
    const l = p.x - b.minX, rr = b.maxX - p.x, t = p.z - b.minZ, bb = b.maxZ - p.z;
    const m = Math.min(l, rr, t, bb);
    if (m === l) { p.x = b.minX - r; n.x = -1; n.z = 0; }
    else if (m === rr) { p.x = b.maxX + r; n.x = 1; n.z = 0; }
    else if (m === t) { p.z = b.minZ - r; n.x = 0; n.z = -1; }
    else { p.z = b.maxZ + r; n.x = 0; n.z = 1; }
  }
  return true;
}

/** Push circle `p` (radius `r`) out of turned rectangle `o`; `n` gets the unit way out (world). False: not touching. */
function pushOutObb(p: XZ, o: Obb, r: number, n: XZ): boolean {
  const dx = p.x - o.cx, dz = p.z - o.cz;
  const lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
  const qx = lx < -o.hx ? -o.hx : lx > o.hx ? o.hx : lx;
  const qz = lz < -o.hz ? -o.hz : lz > o.hz ? o.hz : lz;
  let nx = lx - qx, nz = lz - qz;
  const d2 = nx * nx + nz * nz;
  if (d2 >= r * r) return false;
  let px: number, pz: number;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    nx /= d; nz /= d;
    px = qx + nx * r; pz = qz + nz * r;
  } else {
    // centre inside: leave through the nearest face
    const ex = o.hx - Math.abs(lx), ez = o.hz - Math.abs(lz);
    if (ex <= ez) { nx = lx < 0 ? -1 : 1; nz = 0; px = nx * (o.hx + r); pz = lz; }
    else { nx = 0; nz = lz < 0 ? -1 : 1; px = lx; pz = nz * (o.hz + r); }
  }
  // back to world: local x runs along (c, −s), local z along (s, c)
  p.x = o.cx + px * o.c + pz * o.s;
  p.z = o.cz - px * o.s + pz * o.c;
  n.x = nx * o.c + nz * o.s;
  n.z = -nx * o.s + nz * o.c;
  return true;
}

/**
 * The walls a body touched in one `collideBody` call: each one's top (where a climb would put
 * you), the unit way out of it (toward the body), and whether it's a ledge at all.
 */
export interface Contacts { n: number; top: number[]; nx: number[]; nz: number[]; grab: boolean[] }
export const newContacts = (): Contacts => ({ n: 0, top: [], nx: [], nz: [], grab: [] });
const MAX_CONTACTS = 6;

function addContact(c: Contacts, top: number, n: XZ, grab: boolean) {
  if (c.n >= MAX_CONTACTS) return;
  c.top[c.n] = top; c.nx[c.n] = n.x; c.nz[c.n] = n.z; c.grab[c.n] = grab;
  c.n++;
}

const _cn: XZ = { x: 0, z: 0 };

/**
 * Push a body (a circle of radius `r`, feet at `y`, `h` tall) out of the static world. A box or
 * a solid ramp is a wall where it stands more than STEP_UP over `y0`: the higher of where the
 * feet are and where they were (a body falling fast past a roof's edge is over it, not inside
 * it). Floating slabs leave room under them. Down in a pit, its rim is a wall all round. Returns
 * whether anything pushed; `outN` gets the summed push normal, and `contacts` (when given) the
 * walls themselves.
 */
export function collideBody(p: XZ, y: number, y0: number, r: number, h: number, outN?: XZ, contacts?: Contacts): boolean {
  let hit = false;
  let nx = 0, nz = 0;
  if (contacts) contacts.n = 0;
  forBoxesIn(p.x - r, p.z - r, p.x + r, p.z + r, (b) => {
    if (b.top <= y0 + STEP_UP) return;
    // a floating slab: over our head, or right above us (a ceiling: see `ceilingAbove`)
    if (b.base !== undefined && (b.base >= y + h || pointInBox(b, p.x, p.z))) return;
    if (!(b.rot ? pushOutObb(p, b.rot, r, _cn) : pushOutAabb(p, b, r, _cn))) return;
    hit = true;
    nx += _cn.x; nz += _cn.z;
    if (contacts) addContact(contacts, b.top, _cn, b.grab !== false && b.pole === undefined);
  });
  forRampsIn(p.x - r, p.z - r, p.x + r, p.z + r, (q) => {
    if (!q.solid) return;
    const lz = toLocal(q, p.x, p.z, _loc).z;
    const inside = Math.abs(_loc.x) <= q.hx && Math.abs(lz) <= q.hz;
    const hc = rampAt(q, lz); // the surface at the nearest point (under us, when over it)
    if (hc <= y0 + STEP_UP) return;
    if (q.thick !== undefined && (hc - q.thick >= y + h || inside)) return;
    if (!pushOutObb(p, q, r, _cn)) return;
    hit = true;
    nx += _cn.x; nz += _cn.z;
    if (contacts) addContact(contacts, hc, _cn, true);
  });
  if (y0 < -STEP_UP) {
    for (const q of W.pits) {
      toLocal(q, p.x, p.z, _loc);
      if (Math.abs(_loc.x) > q.hx || Math.abs(_loc.z) > q.hz) continue;
      const mx = q.hx - r, mz = q.hz - r;
      let px = _loc.x, pz = _loc.z, ix = 0, iz = 0;
      if (px > mx) { px = mx; ix = -1; } else if (px < -mx) { px = -mx; ix = 1; }
      if (pz > mz) { pz = mz; iz = -1; } else if (pz < -mz) { pz = -mz; iz = 1; }
      if (!ix && !iz) continue;
      p.x = q.cx + px * q.c + pz * q.s;
      p.z = q.cz - px * q.s + pz * q.c;
      const il = Math.sqrt(ix * ix + iz * iz);
      _cn.x = (ix * q.c + iz * q.s) / il;
      _cn.z = (-ix * q.s + iz * q.c) / il;
      hit = true;
      nx += _cn.x; nz += _cn.z;
      if (contacts) addContact(contacts, 0, _cn, true);
    }
  }
  if (outN) { outN.x = nx; outN.z = nz; }
  return edgeClamp(p, r, outN) || hit;
}

/** Keep a circle inside the map's square edge. */
function edgeClamp(p: XZ, r: number, outN?: XZ): boolean {
  const lim = MAP_HALF - r;
  let hit = false;
  if (p.x < -lim) { p.x = -lim; hit = true; if (outN) outN.x += 1; }
  if (p.x > lim) { p.x = lim; hit = true; if (outN) outN.x -= 1; }
  if (p.z < -lim) { p.z = -lim; hit = true; if (outN) outN.z += 1; }
  if (p.z > lim) { p.z = lim; hit = true; if (outN) outN.z -= 1; }
  return hit;
}

/**
 * Push a car's circle out of the static world: anything taller than a kerb (not lamp posts:
 * see `poleContact`; not street furniture: it drives through that, see `Box.loose`), floating
 * things low enough to hit (awnings and landings above CAR_CLEAR pass over), solid ramps, and
 * pits (it can't drive into one).
 */
export function collideCar(p: XZ, r: number, outN?: XZ): boolean {
  let hit = false;
  let nx = 0, nz = 0;
  forBoxesIn(p.x - r, p.z - r, p.x + r, p.z + r, (b) => {
    if (b.top < 0.3 || b.pole !== undefined || b.loose !== undefined || (b.base !== undefined && b.base > CAR_CLEAR)) return;
    if (!(b.rot ? pushOutObb(p, b.rot, r, _cn) : pushOutAabb(p, b, r, _cn))) return;
    hit = true;
    nx += _cn.x; nz += _cn.z;
  });
  forRampsIn(p.x - r, p.z - r, p.x + r, p.z + r, (q) => {
    if (!q.solid || (q.thick !== undefined && Math.min(q.h0, q.h1) - q.thick > CAR_CLEAR)) return;
    if (!pushOutObb(p, q, r, _cn)) return;
    hit = true;
    nx += _cn.x; nz += _cn.z;
  });
  for (const q of W.pits) {
    if (p.x + r < q.minX || p.x - r > q.maxX || p.z + r < q.minZ || p.z - r > q.maxZ) continue;
    if (!pushOutObb(p, q, r, _cn)) continue;
    hit = true;
    nx += _cn.x; nz += _cn.z;
  }
  if (outN) { outN.x = nx; outN.z = nz; }
  return edgeClamp(p, r, outN) || hit;
}

/**
 * Push a circle out of every static collider it overlaps. For a walker (`forCar` false), those
 * whose top is within STEP_UP of `y` are floors, not walls; cars collide with anything taller
 * than a kerb. Returns whether anything pushed; `outN` gets the summed push normal.
 */
export function collideCircle(p: XZ, y: number, r: number, forCar: boolean, outN?: XZ): boolean {
  return forCar ? collideCar(p, r, outN) : collideBody(p, y, y, r, PLAYER_HEIGHT, outN);
}

/** Every lamp post within `r` of (x, z), standing or not (indices into `CITY.poles`), appended to `out`. */
export function polesNear(x: number, z: number, r: number, out: number[] = []): number[] {
  boxesIn(W.poleGrid, x - r, z - r, x + r, z + r, (b) => {
    if (b.pole === undefined) return;
    const q = CITY.poles[b.pole];
    if ((q.x - x) ** 2 + (q.z - z) ** 2 <= r * r) out.push(b.pole);
  });
  return out;
}

/** The floor of the pit (x, z) is in, or 0 (the ground). */
export function pitFloor(x: number, z: number): number {
  let h = 0;
  for (const q of W.pits) {
    if (x < q.minX || x > q.maxX || z < q.minZ || z > q.maxZ) continue;
    toLocal(q, x, z, _loc);
    if (Math.abs(_loc.x) <= q.hx && Math.abs(_loc.z) <= q.hz && q.floor < h) h = q.floor;
  }
  return h;
}

/** Highest static floor under (x, z) that a body at height `y` can stand on. */
export function groundHeight(x: number, z: number, y: number): number {
  let h = pitFloor(x, z);
  const lim = y + STEP_UP;
  forBoxesIn(x, z, x, z, (b) => {
    if (b.top <= lim && b.top > h && pointInBox(b, x, z)) h = b.top;
  });
  forRampsIn(x, z, x, z, (r) => {
    const lz = toLocal(r, x, z, _loc).z;
    if (Math.abs(_loc.x) > r.hx || Math.abs(lz) > r.hz) return;
    const rh = rampAt(r, lz);
    if (rh <= lim && rh > h) h = rh;
  });
  return h;
}

/** The lowest underside of a floating slab over (x, z) at or above height `y` (Infinity: open sky). */
export function ceilingAbove(x: number, z: number, y: number): number {
  let c = Infinity;
  forBoxesIn(x, z, x, z, (b) => {
    if (b.base !== undefined && b.base >= y && b.base < c && pointInBox(b, x, z)) c = b.base;
  });
  forRampsIn(x, z, x, z, (r) => {
    if (r.thick === undefined) return;
    const lz = toLocal(r, x, z, _loc).z;
    if (Math.abs(_loc.x) > r.hx || Math.abs(lz) > r.hz) return;
    const under = rampAt(r, lz) - r.thick;
    if (under >= y && under < c) c = under;
  });
  return c;
}

/** True when a car may not drive over (x, z): ramps count as solid for cars (not the ones high over the street). */
export function onRamp(x: number, z: number): boolean {
  let on = false;
  forRampsIn(x, z, x, z, (r) => {
    if (on) return;
    const lz = toLocal(r, x, z, _loc).z;
    if (Math.abs(_loc.x) > r.hx || Math.abs(lz) > r.hz) return;
    if (r.thick !== undefined && rampAt(r, lz) - r.thick > CAR_CLEAR) return;
    on = true;
  });
  return on;
}

/** Is (x, z) inside something solid that stands on the ground (a building, a wall)? */
export function insideSolid(x: number, z: number): boolean {
  let inside = false;
  forBoxesIn(x, z, x, z, (b) => {
    if (!inside && b.top > STEP_UP && b.base === undefined && pointInBox(b, x, z)) inside = true;
  });
  return inside;
}

/** Is the point (x, y, z) inside something: a box, under a ramp's surface, or under the ground? */
export function solidAt(x: number, y: number, z: number): boolean {
  if (y < pitFloor(x, z)) return true;
  let solid = false;
  forBoxesIn(x, z, x, z, (b) => {
    if (!solid && y < b.top && y > (b.base ?? -Infinity) && pointInBox(b, x, z)) solid = true;
  });
  if (solid) return true;
  forRampsIn(x, z, x, z, (r) => {
    if (solid) return;
    const lz = toLocal(r, x, z, _loc).z;
    if (Math.abs(_loc.x) > r.hx || Math.abs(lz) > r.hz) return;
    const h = rampAt(r, lz);
    if (y < h && (r.thick === undefined || y > h - r.thick)) solid = true;
  });
  return solid;
}

/** Posts, trunks, hydrants and trash cans: too thin to stop a bullet (or hide a raccoon). */
export const thin = (b: Box) => (b.rot ? b.rot.hx < 0.5 && b.rot.hz < 0.5 : b.maxX - b.minX < 1 && b.maxZ - b.minZ < 1);

/** Ray vs turned rectangle in 2D: entry distance, or -1. */
function rayObbCS(ox: number, oz: number, dx: number, dz: number, o: Obb): number {
  const px = ox - o.cx, pz = oz - o.cz;
  const lox = px * o.c - pz * o.s, loz = px * o.s + pz * o.c;
  const ldx = dx * o.c - dz * o.s, ldz = dx * o.s + dz * o.c;
  return raySlab(lox, loz, ldx, ldz, -o.hx, -o.hz, o.hx, o.hz);
}

/**
 * 2D ray against static colliders taller than `minTop` (floating ones only if they reach down
 * to `atY`). Returns the distance to the first hit, or `maxT` when nothing blocks the ray.
 */
export function raycastStatic(ox: number, oz: number, dx: number, dz: number, maxT: number, minTop: number, atY = Infinity): number {
  let best = maxT;
  const ex = ox + dx * maxT, ez = oz + dz * maxT;
  const minX = Math.min(ox, ex), minZ = Math.min(oz, ez), maxX = Math.max(ox, ex), maxZ = Math.max(oz, ez);
  forBoxesIn(minX, minZ, maxX, maxZ, (b) => {
    if (b.top < minTop || (b.base !== undefined && b.base > atY) || thin(b)) return;
    const t = b.rot ? rayObbCS(ox, oz, dx, dz, b.rot) : raySlab(ox, oz, dx, dz, b.minX, b.minZ, b.maxX, b.maxZ);
    if (t >= 0 && t < best) best = t;
  });
  forRampsIn(minX, minZ, maxX, maxZ, (r) => {
    if (!r.solid || Math.max(r.h0, r.h1) < minTop) return;
    if (r.thick !== undefined && Math.min(r.h0, r.h1) - r.thick > atY) return;
    const t = rayObbCS(ox, oz, dx, dz, r);
    if (t >= 0 && t < best) best = t;
  });
  return best;
}

const _clip = { t0: 0, t1: 0 };

/** Clip the segment from (ox, oz) along (dx, dz), t in [0, 1], to a rectangle in its own frame. False: misses it. */
function clipSeg(o: Obb, ox: number, oz: number, dx: number, dz: number): boolean {
  const px = ox - o.cx, pz = oz - o.cz;
  const lox = px * o.c - pz * o.s, loz = px * o.s + pz * o.c;
  const ldx = dx * o.c - dz * o.s, ldz = dx * o.s + dz * o.c;
  return clipSlab(lox, loz, ldx, ldz, -o.hx, -o.hz, o.hx, o.hz);
}

function clipSlab(ox: number, oz: number, dx: number, dz: number, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < 1e-12) { if (ox < minX || ox > maxX) return false; }
  else {
    let a = (minX - ox) / dx, b = (maxX - ox) / dx;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
  }
  if (Math.abs(dz) < 1e-12) { if (oz < minZ || oz > maxZ) return false; }
  else {
    let a = (minZ - oz) / dz, b = (maxZ - oz) / dz;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
  }
  if (t0 > t1) return false;
  _clip.t0 = t0; _clip.t1 = t1;
  return true;
}

/** Does the straight line from (ax, ay, az) to (bx, by, bz) pass through box `b` (a column from `base`, or the ground, up to `top`)? */
export function segmentHitsBox(b: Box, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dx = bx - ax, dz = bz - az;
  if (!(b.rot ? clipSeg(b.rot, ax, az, dx, dz) : clipSlab(ax, az, dx, dz, b.minX, b.minZ, b.maxX, b.maxZ))) return false;
  const y0 = ay + (by - ay) * _clip.t0, y1 = ay + (by - ay) * _clip.t1;
  return Math.min(y0, y1) < b.top && Math.max(y0, y1) > (b.base ?? -Infinity);
}

/** Does the straight line from (ax, ay, az) to (bx, by, bz) pass through solid ramp `r` (a wedge, or a slab `thick` deep)? */
export function segmentHitsRamp(r: Ramp, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dx = bx - ax, dz = bz - az;
  if (!r.solid || !clipSeg(r, ax, az, dx, dz)) return false;
  // the line and the surface are both straight over the clipped stretch: check its ends and middle
  const t0 = _clip.t0, t1 = _clip.t1;
  for (let k = 0; k < 3; k++) {
    const t = t0 + (t1 - t0) * k / 2;
    const sh = rampHeight(r, ax + dx * t, az + dz * t), y = ay + (by - ay) * t;
    if (y < sh && (r.thick === undefined || y > sh - r.thick)) return true;
  }
  return false;
}

/**
 * Is the straight line from (ax, ay, az) to (bx, by, bz) clear of the static world? Boxes are
 * columns (from `base`, or the ground, up to `top`), solid ramps are wedges, and below ground
 * only a pit is open. Posts, trunks and trash cans don't count (see `thin`), nor any part in
 * `past` (what the client draws see-through).
 */
export function segmentClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, past?: ReadonlySet<Box | Ramp>): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let clear = true;
  const minX = Math.min(ax, bx), minZ = Math.min(az, bz), maxX = Math.max(ax, bx), maxZ = Math.max(az, bz);
  forBoxesIn(minX, minZ, maxX, maxZ, (b) => {
    if (clear && !thin(b) && !past?.has(b) && segmentHitsBox(b, ax, ay, az, bx, by, bz)) clear = false;
  });
  if (!clear) return false;
  forRampsIn(minX, minZ, maxX, maxZ, (r) => {
    if (clear && !past?.has(r) && segmentHitsRamp(r, ax, ay, az, bx, by, bz)) clear = false;
  });
  if (!clear) return false;
  // below ground: only inside a pit (where the line crosses its rim, it must be above the ground)
  if (ay < 0 || by < 0) {
    for (const q of W.pits) {
      if (!clipSeg(q, ax, az, dx, dz)) continue;
      if (_clip.t0 > 0 && ay + dy * _clip.t0 < 0) return false;
      if (_clip.t1 < 1 && ay + dy * _clip.t1 < 0) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- rays in 3D
const _iv = { t0: 0, t1: 0 };

/**
 * Where on [0, 1] a straight `g` (g0 at 0, g1 at 1) is between `lo` and `hi`: into `_iv`.
 * False: nowhere.
 */
function linBetween(g0: number, g1: number, lo: number, hi: number): boolean {
  const dg = g1 - g0;
  if (Math.abs(dg) < 1e-12) {
    if (!(g0 > lo && g0 < hi)) return false;
    _iv.t0 = 0; _iv.t1 = 1;
    return true;
  }
  let a = (lo - g0) / dg, b = (hi - g0) / dg;
  if (a > b) { const s = a; a = b; b = s; }
  _iv.t0 = Math.max(0, a); _iv.t1 = Math.min(1, b);
  return _iv.t0 <= _iv.t1;
}

/** Where (0..1) the segment from (ax, ay, az) along (sx, sy, sz) first goes into box `b`, or -1. */
function segEnterBox(b: Box, ax: number, ay: number, az: number, sx: number, sy: number, sz: number): number {
  if (!(b.rot ? clipSeg(b.rot, ax, az, sx, sz) : clipSlab(ax, az, sx, sz, b.minX, b.minZ, b.maxX, b.maxZ))) return -1;
  const t0 = _clip.t0, t1 = _clip.t1;
  if (!linBetween(ay + sy * t0, ay + sy * t1, b.base ?? -Infinity, b.top)) return -1;
  return t0 + (t1 - t0) * _iv.t0;
}

/** …into solid ramp `r` (under its surface, and no more than `thick` under it). */
function segEnterRamp(r: Ramp, ax: number, ay: number, az: number, sx: number, sy: number, sz: number): number {
  if (!r.solid || !clipSeg(r, ax, az, sx, sz)) return -1;
  // over the clipped stretch the line and the surface are both straight: so is the gap between them
  const t0 = _clip.t0, t1 = _clip.t1;
  const g0 = ay + sy * t0 - rampHeight(r, ax + sx * t0, az + sz * t0);
  const g1 = ay + sy * t1 - rampHeight(r, ax + sx * t1, az + sz * t1);
  if (!linBetween(g0, g1, r.thick === undefined ? -Infinity : -r.thick, 0)) return -1;
  return t0 + (t1 - t0) * _iv.t0;
}

const _pitA: number[] = [], _pitB: number[] = [];

/** …into the ground: below 0 outside the pits, below a pit's floor in it (so its rim is a wall from down there). */
function segEnterGround(ax: number, ay: number, az: number, sx: number, sy: number, sz: number): number {
  let best = 2;
  _pitA.length = 0; _pitB.length = 0;
  for (const q of W.pits) {
    if (!clipSeg(q, ax, az, sx, sz)) continue;
    const p0 = _clip.t0, p1 = _clip.t1;
    _pitA.push(p0); _pitB.push(p1);
    if (linBetween(ay + sy * p0, ay + sy * p1, -Infinity, q.floor)) best = Math.min(best, p0 + (p1 - p0) * _iv.t0);
  }
  if (linBetween(ay, ay + sy, -Infinity, 0)) {
    // below the street from u on: the first of it that isn't over a pit
    let u = _iv.t0;
    const end = _iv.t1;
    for (let moved = true; moved && u <= end;) {
      moved = false;
      for (let k = 0; k < _pitA.length; k++) {
        if (_pitA[k] <= u + 1e-9 && _pitB[k] > u + 1e-9) { u = _pitB[k]; moved = true; }
      }
    }
    if (u <= end) best = Math.min(best, u);
  }
  return best <= 1 ? best : -1;
}

/** A long ray is looked at in stretches this long (m): the first stretch with something in it ends the search. */
const RAY_STRETCH = 12;

/**
 * The ray from (ox, oy, oz) along the unit (dx, dy, dz) against the static world, as
 * `segmentClear` sees it: boxes are columns, solid ramps wedges, the ground is solid but for its
 * pits, and posts, trunks and trash cans don't count (`thin`). The distance to where it first
 * goes in (0: it starts inside), or `maxT` when nothing stops it.
 */
export function rayStatic(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const sx = dx * maxT, sy = dy * maxT, sz = dz * maxT;
  const g = segEnterGround(ox, oy, oz, sx, sy, sz);
  let best = g >= 0 ? g : 1;
  // (each stretch looks up what's around it, but tests the whole line: a box's entry may lie further on)
  const n = Math.max(1, Math.ceil(maxT / RAY_STRETCH));
  for (let k = 0; k < n && k / n < best; k++) {
    const u0 = k / n, u1 = Math.min(best, (k + 1) / n);
    const x0 = ox + sx * u0, z0 = oz + sz * u0, x1 = ox + sx * u1, z1 = oz + sz * u1;
    const minX = Math.min(x0, x1), minZ = Math.min(z0, z1), maxX = Math.max(x0, x1), maxZ = Math.max(z0, z1);
    forBoxesIn(minX, minZ, maxX, maxZ, (b) => {
      if (thin(b)) return;
      const u = segEnterBox(b, ox, oy, oz, sx, sy, sz);
      if (u >= 0 && u < best) best = u;
    });
    forRampsIn(minX, minZ, maxX, maxZ, (r) => {
      const u = segEnterRamp(r, ox, oy, oz, sx, sy, sz);
      if (u >= 0 && u < best) best = u;
    });
  }
  return best * maxT;
}

/**
 * The ray from (ox, oy, oz) along the unit (dx, dy, dz), no further than `maxT`, against an
 * upright cylinder (middle (cx, cz), radius `r`, from `y0` up to `y1`): the distance to where it
 * goes in (0: it starts inside), or -1.
 */
export function rayCylinder(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, cx: number, cz: number, r: number, y0: number, y1: number): number {
  let t0 = 0, t1 = maxT;
  const fx = ox - cx, fz = oz - cz, a = dx * dx + dz * dz, c = fx * fx + fz * fz - r * r;
  if (a < 1e-12) { if (c > 0) return -1; }
  else {
    const b = fx * dx + fz * dz, disc = b * b - a * c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    t0 = Math.max(t0, (-b - s) / a);
    t1 = Math.min(t1, (-b + s) / a);
  }
  if (Math.abs(dy) < 1e-12) { if (oy < y0 || oy > y1) return -1; }
  else {
    let a2 = (y0 - oy) / dy, b2 = (y1 - oy) / dy;
    if (a2 > b2) { const s = a2; a2 = b2; b2 = s; }
    t0 = Math.max(t0, a2);
    t1 = Math.min(t1, b2);
  }
  return t0 <= t1 ? t0 : -1;
}

/** …against an upright box: `o`'s footprint (turned), from `y0` up to `y1`. */
export function rayPrism(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, o: Obb, y0: number, y1: number): number {
  if (!clipSeg(o, ox, oz, dx * maxT, dz * maxT)) return -1;
  const ta = _clip.t0, tb = _clip.t1;
  if (!linBetween(oy + dy * maxT * ta, oy + dy * maxT * tb, y0, y1)) return -1;
  return (ta + (tb - ta) * _iv.t0) * maxT;
}

/**
 * The first trash can the ray from (ox, oy, oz) along the unit (dx, dy, dz) hits before `maxT`
 * (i = -1: none): up to its rim, or a little over it (the lid). Never the can the ray starts in
 * (the one the shooter just hopped out of, firing).
 */
export function binOnRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) {
  const out = { i: -1, t: maxT };
  CITY.bins.forEach((b, i) => {
    if ((ox - b.x) ** 2 + (oz - b.z) ** 2 < BIN_HIT_R * BIN_HIT_R) return;
    const t = rayCylinder(ox, oy, oz, dx, dy, dz, out.t, b.x, b.z, BIN_HIT_R, b.y, b.top + 0.2);
    if (t >= 0 && t < out.t) { out.i = i; out.t = t; }
  });
  return out;
}

/** Ray vs AABB in 2D, returns entry distance or -1. */
export function raySlab(ox: number, oz: number, dx: number, dz: number, minX: number, minZ: number, maxX: number, maxZ: number): number {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-9) { if (ox < minX || ox > maxX) return -1; }
  else {
    let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dz) < 1e-9) { if (oz < minZ || oz > maxZ) return -1; }
  else {
    let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  }
  if (tmax < Math.max(tmin, 0)) return -1;
  return tmin < 0 ? 0 : tmin;
}

/** Ray vs circle in 2D. Returns entry distance or -1. */
export function rayCircle(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, r: number): number {
  const fx = ox - cx, fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  return -b + s >= 0 ? 0 : -1;
}

/** Ray vs oriented box (yaw-rotated, half extents hw × hl). Returns entry distance or -1. */
export function rayObb(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, yaw: number, hw: number, hl: number): number {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // into the box's local frame: local x = (cos, -sin), local z = (sin, cos)
  const px = ox - cx, pz = oz - cz;
  const lox = px * c - pz * s, loz = px * s + pz * c;
  const ldx = dx * c - dz * s, ldz = dx * s + dz * c;
  return raySlab(lox, loz, ldx, ldz, -hw, -hl, hw, hl);
}

/** Is a point (with radius) inside a yaw-rotated box? Returns penetration info. */
export function circleObb(px: number, pz: number, r: number, cx: number, cz: number, yaw: number, hw: number, hl: number, out?: XZ & { depth: number }): boolean {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = px - cx, dz = pz - cz;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  const qx = Math.max(-hw, Math.min(lx, hw)), qz = Math.max(-hl, Math.min(lz, hl));
  let nx = lx - qx, nz = lz - qz;
  const d2 = nx * nx + nz * nz;
  if (d2 >= r * r) return false;
  if (out) {
    let depth: number;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      nx /= d; nz /= d; depth = r - d;
    } else {
      // inside: exit along the shallowest local axis
      const ex = hw - Math.abs(lx), ez = hl - Math.abs(lz);
      if (ex < ez) { nx = Math.sign(lx) || 1; nz = 0; depth = ex + r; }
      else { nx = 0; nz = Math.sign(lz) || 1; depth = ez + r; }
    }
    // back to world: world = local x * (c, -s) + local z * (s, c)
    out.x = nx * c + nz * s;
    out.z = -nx * s + nz * c;
    out.depth = depth;
  }
  return true;
}

// ---------------------------------------------------------------- the town
/**
 * The town (a street graph: see layout.ts and citygen.ts). The same on the server and every
 * client: it's built, never sent.
 */
export const CITY: City = generateV2();
export const CITY_WORLD = makeStaticWorld(CITY.boxes, CITY.ramps, CITY.pits);
W = CITY_WORLD;
