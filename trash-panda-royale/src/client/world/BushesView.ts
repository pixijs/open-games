import { Quaternion, type Container3D } from "@pixi/3d";
import { CAR_TYPES } from "../../shared/constants.js";
import { lookAt, pickAt } from "../../shared/districts.js";
import { CITY, circleObb, type XZ } from "../../shared/map.js";
import { Springs } from "../anim/Springs.js";
import type { Fx } from "../Fx.js";
import { sfx } from "../Sfx.js";
import type { DrawnCar } from "./KnockView.js";

/** A bush's reach and height at scale 1 (its blobs' outline: build_bush), m. */
const BUSH_R = 0.7;
const BUSH_H = 0.95;
/** Its own colour when its district has none (the model's "Bush"). */
const BUSH_LEAF = 0x5fc46a;
/** A body on foot, brushing a bush. */
const BODY_R = 0.35;
/** The most a bush leans (rad) and squashes (of its height). */
const MAX_LEAN = 0.4;
const MAX_SQUASH = 0.5;
/** Leaves fly only this close to the camera (m); a bush rustles at most this often (s). */
const NEAR = 60;
const RUSTLE_GAP = 0.3;

/** Someone on foot as this client draws them this frame; `vx`, `vz` 0 when unknown. */
export interface Walker { x: number; y: number; z: number; vx: number; vz: number }

interface Bush {
  node: Container3D;
  x: number; y: number; z: number; rot: number; scale: number;
  /** Its reach (scaled) and the colour of its leaves. */
  r: number; leaf: number;
  /** Lean (x, z: where its top goes, rad) and squash: chasing what's in it, wobbling back once it's left. */
  s: Springs;
  /** Something was in it last frame; seconds since it last rustled; settled (nothing to write). */
  in: boolean; quiet: number; rest: boolean;
}

/**
 * The bushes, which have no colliders: raccoons, townsfolk and cars go right through them. A
 * bush leans away from whoever's in it and along the way they go, flattens under a car, and
 * wobbles back upright after; brushing into one rustles and flicks a few leaves up. Nothing
 * about it is synced: each client shakes the bushes it draws someone in.
 */
export class BushesView {
  private bushes: Bush[] = [];
  private readonly n = { x: 0, z: 0, depth: 0 };
  private readonly q = new Quaternion();
  private readonly lean = new Quaternion();
  private readonly axis = { x: 0, y: 0, z: 0 };
  private static readonly UP = { x: 0, y: 1, z: 0 };

  /** `props`: each prop's node (by index into `CITY.props`). */
  constructor(props: readonly Container3D[], private fx: Fx) {
    CITY.props.forEach((pr, i) => {
      const node = props[i];
      if (pr.model !== "bush" || !node) return;
      const scale = pr.scale ?? 1, look = lookAt(pr.x, pr.z);
      const s = new Springs(3);
      s.tune(0, 9, 0.22);
      s.tune(1, 9, 0.22);
      s.tune(2, 13, 0.3);
      this.bushes.push({
        node, x: pr.x, y: pr.y ?? 0, z: pr.z, rot: pr.rot, scale,
        r: BUSH_R * scale, leaf: look ? pickAt(look.leaves, pr.x, pr.z, 7) : BUSH_LEAF,
        s, in: false, quiet: RUSTLE_GAP, rest: true,
      });
    });
  }

  /** Per frame, after the cars are posed. `focus`: what the camera looks at. */
  update(dt: number, walkers: readonly Walker[], cars: readonly DrawnCar[], focus: XZ) {
    dt = Math.min(dt, 0.05);
    for (const b of this.bushes) {
      b.quiet += dt;
      const top = b.y + BUSH_H * b.scale;
      let lx = 0, lz = 0, sq = 0, touched = false, hit = 0, hvx = 0, hvz = 0;
      for (const w of walkers) {
        // (a hop clears it)
        if (w.y > top - 0.15 || w.y < b.y - 0.5) continue;
        const R = b.r + BODY_R, dx = b.x - w.x, dz = b.z - w.z;
        if (dx > R || dx < -R || dz > R || dz < -R) continue;
        const d = Math.hypot(dx, dz);
        if (d >= R) continue;
        // pushed away from them most halfway in (none dead centre: no flip as they cross it), dragged along their way
        const u = d / R, push = d > 1e-4 ? (0.28 * Math.sin(Math.PI * u)) / d : 0, drag = 0.035 * (1 - u);
        lx += dx * push + w.vx * drag;
        lz += dz * push + w.vz * drag;
        sq += 0.14 * (1 - u);
        touched = true;
        const sp = Math.hypot(w.vx, w.vz);
        if (sp >= hit) { hit = sp; hvx = w.vx; hvz = w.vz; }
      }
      for (const c of cars) {
        const t = CAR_TYPES[c.kind] ?? CAR_TYPES[0], reach = t.halfL + b.r;
        if (c.y > top || c.y + t.roof < b.y || Math.abs(b.x - c.x) > reach || Math.abs(b.z - c.z) > reach) continue;
        if (!circleObb(b.x, b.z, b.r, c.x, c.z, c.yaw, t.halfW, t.halfL, this.n)) continue;
        // flattened under it, shoved off its side and along its way
        const k = Math.min(1, this.n.depth / b.r);
        lx += this.n.x * 0.3 * k + c.vx * 0.02 * k;
        lz += this.n.z * 0.3 * k + c.vz * 0.02 * k;
        sq += 0.6 * k;
        touched = true;
        const sp = Math.hypot(c.vx, c.vz);
        if (sp >= hit) { hit = sp; hvx = c.vx; hvz = c.vz; }
      }
      if (touched && !b.in && b.quiet >= RUSTLE_GAP) this.brush(b, hit, hvx, hvz, focus);
      b.in = touched;
      if (!touched && b.rest) continue;

      const l = Math.hypot(lx, lz);
      if (l > MAX_LEAN) { lx *= MAX_LEAN / l; lz *= MAX_LEAN / l; }
      const s = b.s;
      s.t[0] = lx; s.t[1] = lz; s.t[2] = Math.min(sq, MAX_SQUASH);
      s.step(dt);
      const ax = s.x[0], az = s.x[1], k = Math.max(-0.3, Math.min(s.x[2], MAX_SQUASH));
      b.rest = !touched && ax === 0 && az === 0 && s.x[2] === 0;

      this.q.setFromAxisAngle(BushesView.UP, b.rot);
      const a = Math.hypot(ax, az);
      if (a > 1e-5) {
        // (about the horizontal axis square to the lean, through its foot: the top goes that way)
        this.axis.x = az / a; this.axis.z = -ax / a;
        this.q.premultiply(this.lean.setFromAxisAngle(this.axis, a));
      }
      b.node.quaternion = this.q;
      b.node.scale.set(b.scale * (1 + k * 0.5), b.scale * (1 - k), b.scale * (1 + k * 0.5));
    }
  }

  /** Something just went into it at `speed` (vx, vz): a jolt, a rustle, a few leaves. */
  private brush(b: Bush, speed: number, vx: number, vz: number, focus: XZ) {
    b.quiet = 0;
    b.rest = false;
    const k = Math.min(1, 0.25 + speed / 8);
    b.s.kick(0, vx * 0.25);
    b.s.kick(1, vz * 0.25);
    b.s.kick(2, 1.5 * k);
    sfx.rustle(b.x, b.z, k);
    if ((b.x - focus.x) ** 2 + (b.z - focus.z) ** 2 < NEAR * NEAR) {
      this.fx.leaves(b.x, b.y + BUSH_H * b.scale * 0.7, b.z, b.leaf, vx, vz, Math.round(2 + 8 * k));
    }
  }
}
