import type { Container3D } from "@pixi/3d";
import { CAR_TYPES, GRAVITY, LOOSE_KNOCK_SPEED, STEP_UP } from "../../shared/constants.js";
import {
  BIN_H, BIN_R, CITY, circleObb, collideCircle, forBoxesIn, forRampsIn, inRamp, pitFloor, pointInBox, rampHeight, type XZ,
} from "../../shared/map.js";
import type { Fx } from "../Fx.js";
import { sfx } from "../Sfx.js";

export type LooseKind = "hydrant" | "bin" | "bench" | "bags" | "drum";

/**
 * How each kind of street furniture flies: `mass` (heavier goes less far and spins slower),
 * its body as modelled (half sizes, height: what it lies on) and how much of a fall it bounces back.
 */
const KINDS: Record<LooseKind, { mass: number; hx: number; hz: number; h: number; bounce: number }> = {
  hydrant: { mass: 1.5, hx: 0.2, hz: 0.2, h: 0.7, bounce: 0.25 },
  bin: { mass: 0.9, hx: BIN_R, hz: BIN_R, h: BIN_H + 0.17, bounce: 0.35 },
  bench: { mass: 1.3, hx: 0.9, hz: 0.34, h: 0.9, bounce: 0.2 },
  bags: { mass: 0.7, hx: 0.57, hz: 0.43, h: 0.58, bounce: 0.1 },
  drum: { mass: 1.1, hx: 0.35, hz: 0.35, h: 0.95, bounce: 0.3 },
};
const KIND_OF: Record<string, LooseKind> = { hydrant: "hydrant", bench: "bench", trash_bags: "bags", drum: "drum" };

/** Knocked over, it stands back up this long after (s), once it's lying still... */
const RETURN_S = 10;
/** ...or this much later still if it never settles. */
const STUCK_S = 4;
/** Our raccoon walking into its spot brings it back early, but not sooner than this after the knock (s). */
const EARLY_S = 0.6;
/** Going back: it shrinks away where it lies, then grows up out of its spot (s). */
const SHRINK_S = 0.18;
const GROW_S = 0.45;
/** Dust and splinters only this close to the camera (m), a hydrant's geyser closer still. */
const NEAR = 90;
const SPRAY_NEAR = 60;

/** A car as this client draws it this frame. */
export interface DrawnCar { kind: number; x: number; y: number; z: number; yaw: number; vx: number; vz: number; mine: boolean }

interface Item {
  /** Its index (`Box.loose`). */
  i: number;
  kind: LooseKind;
  spec: (typeof KINDS)[LooseKind];
  node: Container3D;
  /** Where it stands: its spot, the floor there, its turn, its scale. */
  x: number; y: number; z: number; rot: number; scale: number;
  /** A trash can: its index (-1: not a can). */
  bin: number;
  /** The circles a car hits: radius, and offsets along its length (a bench is three). */
  r: number; offs: readonly number[];
  state: "home" | "loose" | "shrink" | "grow";
  /** Loose: the middle of its body, its velocity, its turn (a quaternion) and spin (world, rad/s). */
  cx: number; cy: number; cz: number; vx: number; vy: number; vz: number;
  qx: number; qy: number; qz: number; qw: number; wx: number; wy: number; wz: number;
  /** Seconds since it was knocked; how far into shrinking or growing (0..1). */
  t: number; anim: number;
  /** Lying still (nothing to simulate); hit the ground since its last kick. */
  still: boolean; landed: boolean;
  /** A hydrant knocked off its spot: a geyser where it stood. */
  spray: boolean;
}

/**
 * Street furniture cars drive through (`Box.loose`): hydrants, benches, trash bags, oil drums
 * and trash cans. Nothing about it is synced: each client knocks a piece flying the moment a car
 * it draws touches it, lets it tumble against the town's walls and floors, and after a while
 * shrinks it away and grows it back up where it stood. A car crawling into one only nudges it
 * along.
 *
 * Walkers still bump into each piece where it stands (the shared step's colliders don't move),
 * so ours walking into an empty spot brings its piece back early. A trash can we (or whoever we
 * watch) hide in is never knocked here: the server says what happens to it (`Bins.ram`).
 */
export class KnockView {
  /** By `Box.loose` (null: nothing to draw it with). */
  private items: (Item | null)[] = [];
  /** Off their spots (loose, or going back). */
  private out = new Set<Item>();
  private byBin = new Map<number, Item>();
  private readonly n = { x: 0, z: 0, depth: 0 };
  private readonly xz: XZ = { x: 0, z: 0 };
  private readonly wn: XZ = { x: 0, z: 0 };
  /** Our own car went through something this frame: how hard (camera shake, 0 for nothing). */
  bumped = 0;

  /** `props`: each prop's node (by index into `CITY.props`); `bins`: each trash can's (by index into `CITY.bins`). */
  constructor(props: readonly Container3D[], bins: readonly Container3D[], private fx: Fx) {
    for (const s of CITY.loose) {
      const pr = s.prop !== undefined ? CITY.props[s.prop] : undefined;
      const can = s.bin !== undefined ? CITY.bins[s.bin] : undefined;
      const kind: LooseKind | undefined = can ? "bin" : pr ? KIND_OF[pr.model] : undefined;
      const node = can ? bins[s.bin!] : props[s.prop!];
      if (!kind || !node) { this.items.push(null); continue; }
      const spec = KINDS[kind];
      const long = spec.hx > spec.hz * 1.5;
      const it: Item = {
        i: this.items.length, kind, spec, node,
        x: s.x, y: can ? can.y : pr!.y ?? 0, z: s.z, rot: can ? 0 : pr!.rot, scale: pr?.scale ?? 1,
        bin: s.bin ?? -1,
        r: long ? spec.hz : Math.max(spec.hx, spec.hz), offs: long ? [-(spec.hx - spec.hz), 0, spec.hx - spec.hz] : [0],
        state: "home",
        cx: 0, cy: 0, cz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, wx: 0, wy: 0, wz: 0,
        t: 0, anim: 0, still: false, landed: false, spray: false,
      };
      this.items.push(it);
      if (can) this.byBin.set(s.bin!, it);
    }
  }

  /** Is trash can `i` off its spot here? */
  binOut(i: number) {
    const it = this.byBin.get(i);
    return !!it && it.state !== "home";
  }

  /** Trash can `i` is in use (someone dives in, hops out, rattles it): back on its spot now. */
  standBin(i: number) {
    const it = this.byBin.get(i);
    if (it && (it.state === "loose" || it.state === "shrink")) this.goHome(it, true);
  }

  /**
   * Per frame, after the cars are posed. `me`: our raccoon on foot (null otherwise); `hiding`:
   * the can we, or whoever we watch, hide in (-1); `focus`: what the camera looks at.
   */
  update(dt: number, cars: readonly DrawnCar[], me: { x: number; y: number; z: number } | null, hiding: number, focus: XZ) {
    this.bumped = 0;
    dt = Math.min(dt, 0.05);

    // cars against what stands (the static grid finds it) and what lies about
    for (const c of cars) {
      if (c.vx * c.vx + c.vz * c.vz < 0.09 || c.y > 1.5) continue;
      const t = CAR_TYPES[c.kind] ?? CAR_TYPES[0];
      const reach = t.halfL + 1;
      forBoxesIn(c.x - reach, c.z - reach, c.x + reach, c.z + reach, (b) => {
        const it = b.loose === undefined ? null : this.items[b.loose];
        if (it && it.state === "home" && (it.bin < 0 || it.bin !== hiding)) this.touch(it, c, focus);
      });
      for (const it of this.out) if (it.state === "loose") this.touch(it, c, focus);
    }

    let hiss = 0;
    for (const it of this.out) {
      const near = (it.x - focus.x) ** 2 + (it.z - focus.z) ** 2 < NEAR * NEAR;
      it.t += dt;
      if (it.state === "loose") {
        if (it.bin >= 0 && it.bin === hiding) { this.goHome(it, true); continue; }
        if (!it.still) this.step(it, dt, near);
        const due = it.t >= RETURN_S && (it.still || it.t >= RETURN_S + STUCK_S);
        const early = !!me && it.t >= EARLY_S && (me.x - it.x) ** 2 + (me.z - it.z) ** 2 < (it.r + 0.9) ** 2 && Math.abs(me.y - it.y) < 1.5;
        if ((due || early) && this.clear(it, cars)) {
          if (near) this.fx.dustPuff(it.cx, it.cy - it.spec.h / 2, it.cz, 5);
          it.state = "shrink"; it.anim = 0;
        }
      } else if (it.state === "shrink") {
        it.anim += dt / SHRINK_S;
        if (it.anim >= 1) this.goHome(it, near);
      } else if (it.state === "grow") {
        it.anim += dt / GROW_S;
        if (it.anim >= 1) { it.state = "home"; this.out.delete(it); }
      }
      this.place(it);
      if (it.spray && (it.state === "loose" || it.state === "shrink")) {
        const d2 = (it.x - focus.x) ** 2 + (it.z - focus.z) ** 2;
        if (d2 < SPRAY_NEAR * SPRAY_NEAR) this.fx.spray(it.x, it.y, it.z, dt);
        hiss = Math.max(hiss, sfx.att(it.x, it.z, 45));
      }
    }
    sfx.setHiss(hiss);
  }

  /** Does car `c` touch `it` (where it stands, or where it lies)? Then it's knocked along. */
  private touch(it: Item, c: DrawnCar, focus: XZ) {
    const t = CAR_TYPES[c.kind] ?? CAR_TYPES[0], k = it.spec;
    const home = it.state === "home";
    const base = home ? it.y : it.cy - k.h / 2;
    if (base > c.y + t.roof || base + k.h < c.y) return;
    // its long axis, flat (a bench lying on its end has none: one circle)
    let ax = 0, az = 0, cx = it.x, cz = it.z;
    if (home) { ax = Math.cos(it.rot); az = -Math.sin(it.rot); }
    else {
      cx = it.cx; cz = it.cz;
      ax = 1 - 2 * (it.qy * it.qy + it.qz * it.qz); az = 2 * (it.qx * it.qz - it.qw * it.qy);
      const l = Math.hypot(ax, az);
      if (l < 0.5) { ax = 0; az = 0; } else { ax /= l; az /= l; }
    }
    let hx = NaN, hz = NaN;
    for (const o of it.offs) {
      if (circleObb(cx + ax * o, cz + az * o, it.r, c.x, c.z, c.yaw, t.halfW, t.halfL, this.n)) { hx = cx + ax * o; hz = cz + az * o; break; }
    }
    if (Number.isNaN(hx)) return;
    const n = this.n, m = k.mass, s = Math.hypot(c.vx, c.vz);
    // (n: from the car toward it.) Found right inside the car (a long frame, a stream that
    // jumps), it came in through the car's front (its back, reversing): out it goes that way
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), ahead = c.vx * fx + c.vz * fz;
    const lx = (hx - c.x) * fz - (hz - c.z) * fx, lz = (hx - c.x) * fx + (hz - c.z) * fz;
    if (Math.abs(lx) <= t.halfW && Math.abs(lz) <= t.halfL && Math.abs(ahead) > 0.5 * s) {
      const sg = Math.sign(ahead);
      n.x = fx * sg; n.z = fz * sg; n.depth = t.halfL - sg * lz + it.r;
    }
    const closing = (c.vx - (home ? 0 : it.vx)) * n.x + (c.vz - (home ? 0 : it.vz)) * n.z;
    if (closing < 0.3 && !home) return;
    if (home) this.lift(it);
    it.cx += n.x * n.depth; it.cz += n.z * n.depth;
    if (closing < 0.3) {
      // scraped by the car's side: shoved off it, and dragged along a little
      it.vx = n.x + c.vx * 0.3; it.vz = n.z + c.vz * 0.3; it.vy = 0.6;
      this.spin(it, n.x, n.z, 1.5 / m, 0.6);
    } else if (s < LOOSE_KNOCK_SPEED) {
      // nudged: shoved along ahead of the car, tipping over
      const push = closing + 0.4;
      it.vx += n.x * push; it.vz += n.z * push;
      it.vy = Math.max(it.vy, 0.8);
      this.spin(it, n.x, n.z, 2.2 / m, 0.6);
    } else {
      // knocked flying: up, at the car's speed (it can't be left inside the car), and off to
      // the side it was hit on, out of the car's way (hit square on: either side)
      const rx = c.vz / s, rz = -c.vx / s;
      let side = n.x * rx + n.z * rz;
      // (square on: a side of its own, the same on every screen)
      if (Math.abs(side) < 0.25) side = it.i % 2 ? -0.25 : 0.25;
      const lat = (Math.sign(side) * (2 + 0.25 * s) * (0.6 + Math.abs(side))) / m;
      it.vx = c.vx + n.x / m + rx * lat; it.vz = c.vz + n.z / m + rz * lat;
      it.vy = Math.min(10, (3.5 + 0.35 * s) / m);
      const l = Math.hypot(it.vx, it.vz) || 1;
      this.spin(it, it.vx / l, it.vz / l, (2.5 + 0.45 * s) / m, 4);
    }
    it.t = 0; it.still = false; it.landed = false;
    if (!home) return;
    // off its spot: a clonk (a can's clang, a bench's clatter...), dust, trash, a geyser
    const hard = Math.min(1, s / 12);
    sfx.furniture(it.kind, it.x, it.z, 0.35 + 0.65 * hard);
    if ((it.x - focus.x) ** 2 + (it.z - focus.z) ** 2 < NEAR * NEAR) {
      this.fx.dustPuff(it.x, it.y, it.z, 6);
      if (it.kind === "bin" || it.kind === "bags") this.fx.rummage(it.x, it.y + k.h * 0.4 - 0.7, it.z);
      else if (it.kind === "bench") this.fx.splinters(it.x, it.y + 0.4, it.z, c.vx, c.vz);
    }
    if (it.kind === "hydrant") it.spray = true;
    if (c.mine) this.bumped = Math.max(this.bumped, (0.1 + 0.25 * hard) * Math.min(1, m));
  }

  /** Off its spot: its body free, as it stood. */
  private lift(it: Item) {
    it.state = "loose";
    it.cx = it.x; it.cy = it.y + it.spec.h / 2; it.cz = it.z;
    it.vx = 0; it.vy = 0; it.vz = 0; it.wx = 0; it.wy = 0; it.wz = 0;
    it.qx = 0; it.qy = Math.sin(it.rot / 2); it.qz = 0; it.qw = Math.cos(it.rot / 2);
    this.out.add(it);
  }

  /** Tumbling top first toward (dx, dz) at `w` rad/s, with a random twist (`jitter`). */
  private spin(it: Item, dx: number, dz: number, w: number, jitter: number) {
    it.wx = dz * w + (Math.random() - 0.5) * jitter * 0.4;
    it.wy = (Math.random() - 0.5) * jitter;
    it.wz = -dx * w + (Math.random() - 0.5) * jitter * 0.4;
  }

  /** Back on its spot: growing up out of it (`effects`: with a puff and a pop). */
  private goHome(it: Item, effects: boolean) {
    it.state = "grow"; it.anim = 0; it.spray = false;
    if (effects) {
      this.fx.dustPuff(it.x, it.y, it.z, 6);
      sfx.popBack(it.x, it.z);
    }
  }

  /** Is its spot clear of cars (no growing back up inside one)? */
  private clear(it: Item, cars: readonly DrawnCar[]) {
    for (const c of cars) {
      const t = CAR_TYPES[c.kind] ?? CAR_TYPES[0];
      if (c.y > it.y + it.spec.h || (c.x - it.x) ** 2 + (c.z - it.z) ** 2 > (t.halfL + 2) ** 2) continue;
      if (circleObb(it.x, it.z, it.r + 0.4, c.x, c.z, c.yaw, t.halfW, t.halfL)) return false;
    }
    return true;
  }

  /** One frame of flight: gravity, spin, walls, the floor; lying down on a face once it's slow. */
  private step(it: Item, dt: number, near: boolean) {
    const k = it.spec;
    it.vy -= GRAVITY * dt;
    it.cx += it.vx * dt; it.cy += it.vy * dt; it.cz += it.vz * dt;
    // turn by the spin: q += ½ (w, 0) q dt
    const { qx, qy, qz, qw, wx, wy, wz } = it, h = dt / 2;
    it.qx += h * (wx * qw + wy * qz - wz * qy);
    it.qy += h * (wy * qw + wz * qx - wx * qz);
    it.qz += h * (wz * qw + wx * qy - wy * qx);
    it.qw -= h * (wx * qx + wy * qy + wz * qz);
    normalize(it);

    // walls (as a car meets them: no lamp posts, no other street furniture), bounced off
    this.xz.x = it.cx; this.xz.z = it.cz;
    if (collideCircle(this.xz, 0, Math.min(k.hx, k.hz), true, this.wn)) {
      it.cx = this.xz.x; it.cz = this.xz.z;
      const l = Math.hypot(this.wn.x, this.wn.z) || 1, nx = this.wn.x / l, nz = this.wn.z / l;
      const vn = it.vx * nx + it.vz * nz;
      if (vn < 0) { it.vx -= 1.5 * vn * nx; it.vz -= 1.5 * vn * nz; it.wy += (Math.random() - 0.5) * 3; }
    }

    // the floor: its lowest corner on it
    const { qx: x, qy: y, qz: z, qw: w } = it;
    const m10 = 2 * (x * y + w * z), m11 = 1 - 2 * (x * x + z * z), m12 = 2 * (y * z - w * x);
    const low = k.hx * Math.abs(m10) + (k.h / 2) * Math.abs(m11) + k.hz * Math.abs(m12);
    const bottom = it.cy - low;
    const pen = floorAt(it.cx, it.cz, bottom) - bottom;
    if (pen < -0.02) return;
    if (pen > 0) it.cy += pen;
    if (it.vy < 0) {
      const fall = -it.vy;
      it.vy = fall > 1.5 ? fall * k.bounce : 0;
      if (fall > 2.5) {
        it.wx *= 0.6; it.wz *= 0.6; it.wy += (Math.random() - 0.5) * 2;
        if (!it.landed || fall > 5) {
          sfx.furniture(it.kind, it.cx, it.cz, Math.min(0.5, fall / 16));
          if (near) this.fx.dustPuff(it.cx, bottom + pen, it.cz, 4);
        }
        it.landed = true;
      }
    }
    // on the ground: friction, and the spin dies
    const f = Math.max(0, 1 - 5 * dt), g = Math.max(0, 1 - 4 * dt);
    it.vx *= f; it.vz *= f; it.wx *= g; it.wy *= g; it.wz *= g;
    if (it.vx * it.vx + it.vz * it.vz > 0.25 || it.wx * it.wx + it.wy * it.wy + it.wz * it.wz > 1.5 || Math.abs(it.vy) > 0.5) return;

    // slow: it lies down on the face it's nearest (weighted by how big: a bench won't stand on its end)
    const ax = [m10, m11, m12];
    const area = [2 * k.hz * k.h, 4 * k.hx * k.hz, 2 * k.hx * k.h];
    let best = 0, score = -1;
    for (let i = 0; i < 3; i++) {
      const s = Math.abs(ax[i]) * Math.sqrt(area[i]);
      if (s > score) { score = s; best = i; }
    }
    // that axis, in the world (a column of the turn), and the turn that stands it straight up or down
    const col = [
      [1 - 2 * (y * y + z * z), m10, 2 * (x * z - w * y)],
      [2 * (x * y - w * z), m11, 2 * (y * z + w * x)],
      [2 * (x * z + w * y), m12, 1 - 2 * (x * x + y * y)],
    ][best];
    const sgn = col[1] >= 0 ? 1 : -1;
    // (col × (0, sgn, 0)), and the angle between them
    let rx = -col[2] * sgn, rz = col[0] * sgn;
    const rl = Math.hypot(rx, rz), angle = Math.acos(Math.min(1, Math.abs(col[1])));
    if (angle < 0.01 || rl < 1e-6) {
      it.vx = it.vy = it.vz = it.wx = it.wy = it.wz = 0;
      it.still = true;
      return;
    }
    rx /= rl; rz /= rl;
    const a = angle * Math.min(1, dt * 8) / 2, s = Math.sin(a), c = Math.cos(a);
    // (rx, 0, rz) by `a`, before the turn it has
    it.qx = c * x + s * (rx * w + 0 * z - rz * y) + 0;
    it.qy = c * y + s * (0 * w + rz * x - rx * z);
    it.qz = c * z + s * (rz * w + rx * y - 0 * x);
    it.qw = c * w - s * (rx * x + rz * z);
    normalize(it);
  }

  /** Its node where it is now. */
  private place(it: Item) {
    const nd = it.node, k = it.spec;
    if (it.state === "home" || it.state === "grow") {
      nd.position.set(it.x, it.y, it.z);
      nd.quaternion.set(0, Math.sin(it.rot / 2), 0, Math.cos(it.rot / 2));
      if (it.state === "home") { nd.scale.set(it.scale, it.scale, it.scale); return; }
      // up out of the ground with an overshoot, stretching tall as it comes
      const t = Math.min(1, it.anim), u = t - 1, b = 1 + 3.2 * u * u * u + 2.2 * u * u;
      const tall = 1 + 0.25 * Math.sin(Math.PI * t) * (1 - t);
      nd.scale.set(it.scale * b / Math.sqrt(tall), it.scale * b * tall, it.scale * b / Math.sqrt(tall));
      return;
    }
    // the node's origin is its base's middle: from the body's middle, down its own up
    const { qx: x, qy: y, qz: z, qw: w } = it, hh = k.h / 2;
    nd.position.set(it.cx - hh * 2 * (x * y - w * z), it.cy - hh * (1 - 2 * (x * x + z * z)), it.cz - hh * 2 * (y * z + w * x));
    nd.quaternion.set(x, y, z, w);
    const sc = it.state === "shrink" ? it.scale * Math.max(0, 1 - it.anim * it.anim) : it.scale;
    nd.scale.set(sc, sc, sc);
  }
}

function normalize(it: Item) {
  const l = Math.hypot(it.qx, it.qy, it.qz, it.qw) || 1;
  it.qx /= l; it.qy /= l; it.qz /= l; it.qw /= l;
}

/** The floor under (x, z) that something at height `y` lands on: like `groundHeight`, but street furniture's own boxes are no floor. */
function floorAt(x: number, z: number, y: number): number {
  let h = pitFloor(x, z);
  const lim = y + STEP_UP;
  forBoxesIn(x, z, x, z, (b) => {
    if (b.loose === undefined && b.top <= lim && b.top > h && pointInBox(b, x, z)) h = b.top;
  });
  forRampsIn(x, z, x, z, (r) => {
    if (!inRamp(r, x, z)) return;
    const rh = rampHeight(r, x, z);
    if (rh <= lim && rh > h) h = rh;
  });
  return h;
}
