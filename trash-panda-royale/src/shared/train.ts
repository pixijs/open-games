/**
 * Trains are NOT networked. They run on a fixed timetable that is a pure function
 * of the room clock (ms since the room started), so the server and every client
 * evaluate the exact same poses for the same instant:
 *
 *   - clients render them at `room.clock.renderNow()`,
 *   - the predicted player step evaluates them at `ctx.reckonTime` (the integer ms
 *     stamp carried by each input), and the server evaluates them at the very same
 *     stamp (`inputs.get(sid).reckonTime`) — so riding, climbing onto and getting
 *     run over by trains is predicted bit-for-bit.
 */
import {
  LOCO_LENGTH, TRAIN_BRIDGE, TRAIN_CARS, TRAIN_COUNT, TRAIN_EDGE, TRAIN_GAP, TRAIN_HALF_W, TRAIN_ROOF, TRAIN_SPEED, WAGON_LENGTH,
} from "./constants.js";

/** Half size of the rounded-rectangle track loop. */
export const RAIL_HALF = 132;
/** Corner radius of the loop. */
export const RAIL_RADIUS = 18;

const S = RAIL_HALF - RAIL_RADIUS; // straight half-length (114)
const STRAIGHT = 2 * S;
const ARC = (Math.PI / 2) * RAIL_RADIUS;
/** Total loop length (m). */
export const TRACK_LENGTH = 4 * STRAIGHT + 4 * ARC;

export interface PathPoint { x: number; z: number; /** tangent direction */ dx: number; dz: number }

/**
 * Point on the loop at distance `s` (wraps). The loop runs counter-clockwise seen
 * from above: south straight (+X), east straight (+Z), north straight (-X), west (-Z).
 */
export function trackPoint(s: number, out: PathPoint): PathPoint {
  s = ((s % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
  const seg = STRAIGHT + ARC;
  const side = Math.floor(s / seg);
  let t = s - side * seg;
  // canonical side 0: straight from (-S, -H) to (S, -H) then arc around (S, -S)
  let x: number, z: number, dx: number, dz: number;
  if (t < STRAIGHT) {
    x = -S + t; z = -RAIL_HALF; dx = 1; dz = 0;
  } else {
    t -= STRAIGHT;
    const a = -Math.PI / 2 + t / RAIL_RADIUS;
    x = S + Math.cos(a) * RAIL_RADIUS;
    z = -S + Math.sin(a) * RAIL_RADIUS;
    dx = -Math.sin(a); dz = Math.cos(a);
  }
  // rotate the canonical side by side * 90° (counter-clockwise from above: (x,z) -> (-z, x))
  for (let k = 0; k < side; k++) {
    const nx = -z, nz = x; x = nx; z = nz;
    const ndx = -dz, ndz = dx; dx = ndx; dz = ndz;
  }
  out.x = x; out.z = z; out.dx = dx; out.dz = dz;
  return out;
}

/** Signed distance from (x, z) to the track centre line (negative = inside the loop). */
export function trackDistance(x: number, z: number): number {
  const qx = Math.abs(x) - S, qz = Math.abs(z) - S;
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - RAIL_RADIUS;
}

/** Track distance of the point of the loop closest to (x, z). */
export function trackSFromPoint(x: number, z: number): number {
  let best = 0, bestD = Infinity;
  const p: PathPoint = { x: 0, z: 0, dx: 0, dz: 0 };
  for (let s = 0; s < TRACK_LENGTH; s += 0.5) {
    trackPoint(s, p);
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// ---------------------------------------------------------------- train cars

/** Length of each car of a train (index 0 = locomotive). */
export const CAR_LENGTHS: number[] = Array.from({ length: TRAIN_CARS }, (_, i) => (i === 0 ? LOCO_LENGTH : WAGON_LENGTH));

/** Distance from the train's nose to each car's centre. */
export const CAR_OFFSETS: number[] = (() => {
  const out: number[] = [];
  let d = 0;
  for (let i = 0; i < TRAIN_CARS; i++) {
    out.push(d + CAR_LENGTHS[i] / 2);
    d += CAR_LENGTHS[i] + TRAIN_GAP;
  }
  return out;
})();

/** Total number of train cars in the world (slot ids 0..N-1 used by riders). */
export const TRAIN_SLOTS = TRAIN_COUNT * TRAIN_CARS;

/**
 * What stands up through the locomotive's deck (train_loco.glb): solid columns in the
 * loco's own frame (x across, z along, +z toward the nose; metres), which riders walk
 * round (or jump over). Everything else on top of a train car is flat at TRAIN_ROOF.
 */
export const LOCO_OBSTACLES: readonly { x: number; z: number; r: number; top: number }[] = [
  { x: 0, z: 2.6, r: 0.41, top: 3.625 }, // the chimney
  { x: 0, z: 1.0, r: 0.32, top: 3.194 }, // the steam dome
];

export interface CarPose {
  x: number; z: number; yaw: number;
  /** World velocity of the car centre (m/s). */
  vx: number; vz: number;
  halfL: number; halfW: number; roof: number;
}

const _a: PathPoint = { x: 0, z: 0, dx: 0, dz: 0 };
const _b: PathPoint = { x: 0, z: 0, dx: 0, dz: 0 };

/** Nose distance of train `t` at room time `timeMs`. */
export function trainHead(t: number, timeMs: number): number {
  return (timeMs / 1000) * TRAIN_SPEED + (t * TRACK_LENGTH) / TRAIN_COUNT;
}

/** Pose of train car `slot` (train = slot / TRAIN_CARS) at room time `timeMs`. */
export function trainCarPose(slot: number, timeMs: number, out: CarPose): CarPose {
  const t = Math.floor(slot / TRAIN_CARS), i = slot % TRAIN_CARS;
  const centre = trainHead(t, timeMs) - CAR_OFFSETS[i];
  const bogie = CAR_LENGTHS[i] / 2 - 1.3;
  trackPoint(centre + bogie, _a);
  trackPoint(centre - bogie, _b);
  out.x = (_a.x + _b.x) / 2;
  out.z = (_a.z + _b.z) / 2;
  const fx = _a.x - _b.x, fz = _a.z - _b.z;
  out.yaw = Math.atan2(fx, fz);
  // velocity: speed along the averaged tangent
  const tx = _a.dx + _b.dx, tz = _a.dz + _b.dz;
  const tl = Math.hypot(tx, tz) || 1;
  out.vx = (tx / tl) * TRAIN_SPEED;
  out.vz = (tz / tl) * TRAIN_SPEED;
  out.halfL = CAR_LENGTHS[i] / 2;
  out.halfW = TRAIN_HALF_W;
  out.roof = TRAIN_ROOF;
  return out;
}

// ---------------------------------------------------------------- riders
//
// A train rider's `lz` is not local to the car they stand on but to the whole train:
// U = car-local z − the car's offset from the nose (metres from the nose, so riders
// are at U < 0). It runs on continuously from car to car, so interpolating it (the
// remote lerp, the server's rewind) stays valid when a rider walks over a coupling.
// `lx`, `ly` and `lyaw` stay relative to the car in `veh`.

/** A rider's train coordinate U from their z in car `slot`'s frame. */
export const trainU = (slot: number, lzCar: number) => lzCar - CAR_OFFSETS[slot % TRAIN_CARS];

/** Car `slot`'s local z for train coordinate U. */
export const carLocalZ = (slot: number, u: number) => u + CAR_OFFSETS[slot % TRAIN_CARS];

const _rp: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };

/** World x/z of a rider at (lx, U) on car `slot` at `timeMs` (riders, hit tests, drawing). */
export function trainPointWorld(slot: number, timeMs: number, lx: number, u: number, out: { x: number; z: number }) {
  const p = trainCarPose(slot, timeMs, _rp);
  const lz = carLocalZ(slot, u);
  // local +Z = forward, +X = left (same convention as sim.ts localToWorld)
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  out.x = p.x + lx * c + lz * s;
  out.z = p.z - lx * s + lz * c;
  return out;
}

/**
 * Is the point (x, z) over the roof of car `slot` (posed at `pose`)? Measured from the
 * player's centre: open ends and sides reach TRAIN_EDGE past the edge (where a rider
 * drops off), coupled ends are bridged over the gap to the next car.
 */
export function onTrainRoof(slot: number, pose: CarPose, x: number, z: number): boolean {
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  const dx = x - pose.x, dz = z - pose.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  if (Math.abs(lx) > pose.halfW + TRAIN_EDGE) return false;
  const i = slot % TRAIN_CARS;
  const coupled = lz > 0 ? i > 0 : i < TRAIN_CARS - 1;
  return Math.abs(lz) <= pose.halfL + (coupled ? TRAIN_BRIDGE : TRAIN_EDGE);
}

/**
 * Seconds until a train next covers track distance `s` (0 while one is on it),
 * used for the crossing barriers, lights and bells.
 */
export function trainEta(s: number, timeMs: number, margin = 6): number {
  let best = Infinity;
  const trainLen = CAR_OFFSETS[TRAIN_CARS - 1] + CAR_LENGTHS[TRAIN_CARS - 1] / 2;
  for (let t = 0; t < TRAIN_COUNT; t++) {
    // how far the nose is past the point `margin` before s (mod the loop)
    let d = (trainHead(t, timeMs) - (s - margin)) % TRACK_LENGTH;
    if (d < 0) d += TRACK_LENGTH;
    // the train covers [s - margin, s + margin] until its tail clears it
    if (d <= trainLen + margin * 2) return 0;
    best = Math.min(best, (TRACK_LENGTH - d) / TRAIN_SPEED);
  }
  return best;
}
