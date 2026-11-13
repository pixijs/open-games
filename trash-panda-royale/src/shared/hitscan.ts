/**
 * Hitscan, shared by the server's verdict (`Combat.fire`) and the shooter's own prediction
 * (`Game.localShot`), so the two can't drift apart.
 *
 * A shot is a straight line in 3D (from `shotHeight` over the shooter), aimed by a yaw and a
 * pitch: at whatever is under the crosshair (see `Game.updateAim`). The first thing along it takes it: a raccoon or a
 * townsperson (an upright cylinder), a car (an upright box), a trash can, or the static world (a
 * wall, a roof's edge, the street). So a shot down from a roof hits the street where you aimed,
 * and standing on a car you only hit it by aiming down at it.
 *
 * Where the view can't aim up or down (overhead, or a stick), `autoPitch` helps: it pitches the
 * shot onto the first target along the yaw that the shooter can actually see.
 */
import { GULL_R, WEAPONS } from "./constants.js";
import { binOnRay, rayCircle, rayCylinder, rayObb, rayPrism, rayStatic, segmentClear, type Obb } from "./map.js";

/** Something a shot can hit: an upright cylinder (players, townsfolk) or, with `hw`/`hl`, a car's box. */
export interface ShotTarget {
  x: number; z: number;
  /** Its bottom and its top (m). */
  y0: number; y1: number;
  /** The height `autoPitch` aims at (a chest, the middle of a car). */
  y: number;
  /** Cylinder radius (unused for a box). */
  r: number;
  /** A car: its yaw and half width / half length. */
  yaw?: number; hw?: number; hl?: number;
}

/** How tall a shot finds a raccoon (ears and all) and a townsperson, from their feet (m). */
export const RACCOON_TOP = 1.45;
export const TOWNSFOLK_TOP = 1.7;

/** A gull at (x, y, z) as a shot finds it: a squat cylinder round its body, wings and all (a bit generous: it's small and quick). */
export function gullTarget(x: number, y: number, z: number): ShotTarget {
  return { x, z, y0: y - 0.25, y1: y + 0.4, y: y + 0.1, r: GULL_R + 0.15 };
}

/** The gun over the feet, on foot and at the wheel (m). */
export const GUN_Y = 1.0, DRIVE_GUN_Y = 1.1;
/** Over the raccoon's back, the line the crosshair is on passes this high over the feet: the behind camera's pivot (m). */
export const EYE_Y = 1.75, DRIVE_EYE_Y = 2.3;

/**
 * How high a shot from someone standing (or driving) at (x, y, z) leaves from. Overhead, from the
 * gun. Over the raccoon's back (`eye`), from the crosshair's own line over its head: the gun is
 * lower, and a shot from there would hit a roof's edge or a car the camera looks over, short of
 * where the crosshair is (the tracer is still drawn from the gun). Under a low ceiling, the gun.
 */
export function shotHeight(x: number, y: number, z: number, driving: boolean, eye: boolean): number {
  const gun = y + (driving ? DRIVE_GUN_Y : GUN_Y);
  if (!eye) return gun;
  const top = y + (driving ? DRIVE_EYE_Y : EYE_Y);
  return segmentClear(x, gun, z, x, top, z) ? top : gun;
}

/** Where one pellet went: its end (x, y, z) at distance `t`, and what it hit (indices, -1: nothing). */
export interface Pellet { t: number; x: number; y: number; z: number; target: number; bin: number }

export const newPellet = (): Pellet => ({ t: 0, x: 0, y: 0, z: 0, target: -1, bin: -1 });

/**
 * Aim angles on the wire, in 1/AIM_Q rad (int16): `PlayerInput.pitch` and the `shot` message's
 * yaw and pitch. The shooter's prediction reads the very same rounded value the server does.
 */
export const AIM_Q = 10000;

/** The yaw a shot aimed at `aim` flies along: a machine gun wobbles by the step (so prediction and server agree). */
export function shotYaw(aim: number, weapon: number, tick: number): number {
  const w = WEAPONS[weapon];
  return w.pellets === 1 && w.spread ? aim + ((tick % 3) - 1) * w.spread : aim;
}

/**
 * A blast's pellets (the Blunderbuss's): one down the middle of the shot, the rest in a ring
 * this far round it (rad), the same pattern every time, up, down or level. Fixed, so nothing
 * about it has to be sent: the server, the shooter and everyone watching all trace the same
 * pellets from the same aim. All 7 find a raccoon out to about 4.5 m, 3 to about 8.5 m.
 */
export const BLAST_CONE = 0.12;
/** A blast's pellets do full damage out to BLAST_FULL m, then less, down to BLAST_FAR of it at the gun's range. */
export const BLAST_FULL = 6, BLAST_FAR = 0.5;
/** This many of a blast's pellets in one raccoon knock it off its feet. */
export const BLAST_KNOCKDOWN = 4;

/** Pellet `k`'s way (yaw, pitch) out of a shot along (yaw, pitch): a blast's cone, else straight along it. */
export function pelletDir(yaw: number, pitch: number, weapon: number, k: number, out: { yaw: number; pitch: number }) {
  const n = WEAPONS[weapon].pellets;
  if (n === 1 || k === 0) { out.yaw = yaw; out.pitch = pitch; return out; }
  // the shot's way (f), and two ways square to it: level across it (r) and up from it (u)
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const phi = ((k - 1) * 2 * Math.PI) / (n - 1);
  const c = Math.cos(BLAST_CONE), a = Math.cos(phi) * Math.sin(BLAST_CONE), b = Math.sin(phi) * Math.sin(BLAST_CONE);
  const dx = sy * cp * c + cy * a - sp * sy * b;
  const dy = sp * c + cp * b;
  const dz = cy * cp * c - sy * a - sp * cy * b;
  out.yaw = Math.atan2(dx, dz);
  out.pitch = Math.asin(Math.max(-1, Math.min(1, dy)));
  return out;
}

/** What a pellet of `weapon` that flew `t` m does: a blast's fall off past BLAST_FULL m. */
export function pelletDamage(weapon: number, t: number): number {
  const w = WEAPONS[weapon];
  if (w.pellets === 1 || t <= BLAST_FULL) return w.damage;
  return w.damage * (1 - (1 - BLAST_FAR) * Math.min(1, (t - BLAST_FULL) / (w.range - BLAST_FULL)));
}

const _obb: Obb = { cx: 0, cz: 0, hx: 0, hz: 0, c: 1, s: 0 };

/** Fly one pellet from the muzzle (ox, oy, oz) along yaw `a`, pitched up by `pitch` (rad), at most `range` m. */
export function tracePellet(ox: number, oy: number, oz: number, a: number, pitch: number, range: number, targets: readonly ShotTarget[], out: Pellet): Pellet {
  const cp = Math.cos(pitch);
  const dx = Math.sin(a) * cp, dy = Math.sin(pitch), dz = Math.cos(a) * cp;
  let endT = rayStatic(ox, oy, oz, dx, dy, dz, range);
  out.target = -1;
  out.bin = -1;
  for (let i = 0; i < targets.length; i++) {
    const q = targets[i];
    let t: number;
    if (q.hw !== undefined) {
      const yaw = q.yaw ?? 0;
      _obb.cx = q.x; _obb.cz = q.z; _obb.hx = q.hw; _obb.hz = q.hl ?? 0; _obb.c = Math.cos(yaw); _obb.s = Math.sin(yaw);
      t = rayPrism(ox, oy, oz, dx, dy, dz, endT, _obb, q.y0, q.y1);
    } else t = rayCylinder(ox, oy, oz, dx, dy, dz, endT, q.x, q.z, q.r, q.y0, q.y1);
    if (t >= 0 && t < endT) { endT = t; out.target = i; }
  }
  // a trash can in the way
  const bin = binOnRay(ox, oy, oz, dx, dy, dz, endT);
  if (bin.i >= 0) {
    out.bin = bin.i;
    out.target = -1;
    endT = bin.t;
  }
  out.t = endT;
  out.x = ox + dx * endT;
  out.y = oy + dy * endT;
  out.z = oz + dz * endT;
  return out;
}

/**
 * The pitch that takes a shot along `yaw` onto the first target there the shooter can see (a
 * clear straight line from the muzzle to its chest, `segmentClear`), or null: nobody. So from a
 * roof's edge it pitches down to someone on the street, and a raccoon standing back from its
 * roof's edge is hidden by the roof itself. Never onto one the muzzle is over (the car you stand on).
 */
export function autoPitch(ox: number, oy: number, oz: number, yaw: number, range: number, targets: readonly ShotTarget[]): number | null {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  let bestT = Infinity, pitch: number | null = null;
  for (let i = 0; i < targets.length; i++) {
    const q = targets[i];
    const t = q.hw !== undefined ? rayObb(ox, oz, dx, dz, q.x, q.z, q.yaw ?? 0, q.hw, q.hl ?? 0) : rayCircle(ox, oz, dx, dz, q.x, q.z, q.r);
    if (t <= 1e-6 || t >= bestT || Math.hypot(t, q.y - oy) > range) continue;
    if (!segmentClear(ox, oy, oz, ox + dx * t, q.y, oz + dz * t)) continue;
    bestT = t;
    pitch = Math.atan2(q.y - oy, t);
  }
  return pitch;
}
