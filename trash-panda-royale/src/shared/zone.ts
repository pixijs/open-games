/**
 * The battle-royale fumes: a circle that closes in stages. Like the trains, it is drawn
 * from the room clock on every client and evaluated by the server from the same few
 * numbers — but only the current and the NEXT circle are ever synced (the `Zone` schema),
 * never the whole plan, so no client can know where the final circle will be.
 */
import { forBoxesIn, mulberry32 } from "./map.js";
import { STEP_UP } from "./constants.js";

/** The first circle covers the whole map, railway corners included (they reach ~179 m). */
export const ZONE_R0 = 185;
/** Circle k's centre stays within ±(ZONE_BOUND − r_k) of the map centre. */
export const ZONE_BOUND = 150;

/** Per stage: hold the current circle, then close to the next one (radius `r`). Seconds; dps while in the stage. */
export const ZONE_STAGES = [
  { hold: 40, close: 30, r: 115, dps: 1 },
  { hold: 25, close: 25, r: 70, dps: 2 },
  { hold: 20, close: 20, r: 40, dps: 4 },
  { hold: 20, close: 15, r: 20, dps: 7 },
  { hold: 15, close: 15, r: 8, dps: 10 },
  { hold: 30, close: 20, r: 0, dps: 15 },
] as const;

/** Damage per second after the last stage (sudden death). */
export const ZONE_FINAL_DPS = 15;

/** The synced part (the `Zone` schema). */
export interface ZoneLike {
  x0: number; z0: number; r0: number;
  x1: number; z1: number; r1: number;
  shrinkAt: number; doneAt: number;
  stage: number;
}

/** The fumes at one instant. */
export interface ZoneState {
  /** The safe circle now. */
  x: number; z: number; r: number;
  /** Where it's heading (the dashed ring). */
  nx: number; nz: number; nr: number;
  stage: number;
  closing: boolean;
  /** Seconds until it starts closing (holding) or stops (closing); Infinity in sudden death. */
  left: number;
  /** Damage per second outside, before the depth multiplier. */
  dps: number;
  /** Sudden death: the last circle has closed. */
  final: boolean;
}

export const newZoneState = (): ZoneState => ({ x: 0, z: 0, r: ZONE_R0, nx: 0, nz: 0, nr: ZONE_R0, stage: 0, closing: false, left: Infinity, dps: 0, final: false });

/** The fumes at room time `t` (frozen at `stopAt` once the round is decided, when non-zero). */
export function zoneAt(z: ZoneLike, t: number, stopAt: number, out: ZoneState): ZoneState {
  if (stopAt > 0 && t > stopAt) t = stopAt;
  const final = z.stage >= ZONE_STAGES.length;
  out.stage = z.stage;
  out.final = final;
  out.dps = final ? ZONE_FINAL_DPS : ZONE_STAGES[z.stage].dps;
  out.nx = z.x1; out.nz = z.z1; out.nr = z.r1;
  if (final || t <= z.shrinkAt) {
    out.x = z.x0; out.z = z.z0; out.r = z.r0;
    out.closing = false;
    out.left = final ? Infinity : (z.shrinkAt - t) / 1000;
    return out;
  }
  const f = Math.min(1, (t - z.shrinkAt) / Math.max(1, z.doneAt - z.shrinkAt));
  out.x = z.x0 + (z.x1 - z.x0) * f;
  out.z = z.z0 + (z.z1 - z.z0) * f;
  out.r = z.r0 + (z.r1 - z.r0) * f;
  out.closing = f < 1;
  out.left = Math.max(0, (z.doneAt - t) / 1000);
  return out;
}

/** How far outside the safe circle (x, z) is (negative: inside). */
export const zoneDepth = (s: ZoneState, x: number, z: number) => Math.hypot(x - s.x, z - s.z) - s.r;

/** Damage per second at `depth` metres into the fumes: deeper hurts more (so the last circle rarely draws). */
export const zoneDamage = (s: ZoneState, depth: number) => (depth <= 0 ? 0 : s.dps * (1 + Math.min(2, depth / 40)));

function insideBuilding(x: number, z: number): boolean {
  let hit = false;
  forBoxesIn(x, z, x, z, (b) => { if (b.top > STEP_UP && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) hit = true; });
  return hit;
}

/**
 * The next circle (radius `rNext`) inside the current one (centre cx, cz, radius r):
 * its centre is a random point in the disc of radius r − rNext, kept inside the map
 * bound, and — for small circles — not in a solid building. Falls back to the current
 * centre, which always satisfies all of that.
 */
export function nextCircle(rand: () => number, cx: number, cz: number, r: number, rNext: number, out: { x: number; z: number }) {
  const bound = Math.max(0, ZONE_BOUND - rNext);
  for (let k = 0; k < 24; k++) {
    const a = Math.PI * 2 * rand();
    const d = Math.sqrt(rand()) * Math.max(0, r - rNext);
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    if (Math.abs(x) > bound || Math.abs(z) > bound) continue;
    if (rNext < 25 && insideBuilding(x, z)) continue;
    out.x = x; out.z = z;
    return out;
  }
  out.x = cx; out.z = cz;
  return out;
}

/** A fresh per-round RNG for the circles (server side only). */
export const zoneRandom = (seed: number) => mulberry32(seed ^ 0x5eed);
