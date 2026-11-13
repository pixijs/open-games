import type { Container3D } from "@pixi/3d";
import { GRAVITY } from "../../shared/constants.js";
import { CITY } from "../../shared/map.js";
import { poleFallYaw, wrapAngle } from "../../shared/sim.js";
import type { Fx } from "../Fx.js";
import { sfx } from "../Sfx.js";

/** Where a post breaks off its stub: its node's origin, m above the ground (see build_lamp). */
const BREAK = 0.28;
/** Lying, its broken end rests this high (its radius there), kicked this far off the stub. */
const LIE_Y = 0.09;
const SLIDE = 0.45;
/** It topples like a 3.4 m rod about its foot (rad/s² per sin of its lean)... */
const TOPPLE = (3 * GRAVITY) / (2 * 3.4);
/** ...from the kick a car gives it (rad/s), and keeps this much of its swing off each bounce. */
const KICK = 1.5;
const BOUNCE = 0.28;
/** A swing slower than this (rad/s) doesn't bounce: it settles. */
const SETTLE = 0.6;
/** Someone else's knock waits at most this long (s) for their car, as drawn here, to get to the post. */
const MAX_WAIT = 0.3;
/** How fast a fall turns to the server's way, when ours (predicted) differs (s). */
const TURN_S = 0.15;

/**
 * What of a post can touch the ground first as it lies down, relative to its break (model
 * axes, +Z = the way the lamp's head hangs): its top, the arm's bend, the bulb and the rim of
 * the lamp's head.
 */
const HULL: readonly [number, number, number][] = [
  [0, 3.34, 0], [0, 3.86, 0.36], [0, 3.27, 0.7],
  [0.29, 3.48, 0.7], [-0.29, 3.48, 0.7], [0, 3.48, 0.41], [0, 3.48, 0.99],
];

/** Is a car (as drawn) at a post, or on its way to it? */
export type CarAtPole = "touching" | "closing" | null;

interface Fall {
  node: Container3D;
  /** The lamp's own turn (its head hangs along it). */
  rot: number;
  /** Which way it falls (world yaw), turning toward `target` (the server's word). */
  yaw: number;
  target: number;
  /** Lean from upright (rad), its swing (rad/s), and the lean it lies at for `restYaw`. */
  lean: number;
  swing: number;
  rest: number;
  restYaw: number;
  /** Seconds it still waits for the car that knocked it over to reach it (0: falling). */
  wait: number;
  landed: boolean;
}

/**
 * Lamp posts falling over. A post the server says is down falls the way it says (one byte);
 * ours (predicted) falls the moment our car hits it, and others the moment the car that hit it
 * gets there as we draw it. Posts that were down before we came just lie there. Each falls
 * like a rod off its stub, kicked over, and bounces to rest propped on whatever of it reaches
 * the ground first.
 */
export class PolesView {
  private falls = new Map<number, Fall>();

  constructor(private posts: readonly (Container3D | null)[], private fx: Fx) {}

  /**
   * Post `i` is down, falling `fall` (`poleFall`): `now` (our own knock), once the car that
   * knocked it gets to it (`seen`), or already lying there (`lying`). A post already falling
   * only turns to fall that way.
   */
  fall(i: number, fall: number, how: "now" | "seen" | "lying") {
    const yaw = poleFallYaw(fall);
    const f = this.falls.get(i);
    if (f) { f.target = yaw; return; }
    const node = this.posts[i], q = CITY.poles[i];
    if (!node || !q) return;
    const rot = CITY.props[q.prop].rot;
    const nf: Fall = { node, rot, yaw, target: yaw, lean: 0, swing: KICK, rest: restLean(yaw - rot), restYaw: yaw, wait: 0, landed: false };
    this.falls.set(i, nf);
    if (how === "lying") {
      nf.lean = nf.rest; nf.swing = 0; nf.landed = true;
      place(nf);
    } else if (how === "seen") nf.wait = MAX_WAIT;
    else this.snap(i);
  }

  /** Post `i` stands again (a new round, or a knock of ours the server never made). */
  stand(i: number) {
    const f = this.falls.get(i);
    if (!f) return;
    this.falls.delete(i);
    f.node.quaternion.set(0, 0, 0, 1);
    f.node.position.set(0, BREAK, 0);
  }

  isDown(i: number) {
    return this.falls.has(i);
  }

  /** `car(x, z)`: whether a car we draw is at (or closing on) a post there. */
  update(dt: number, car: (x: number, z: number) => CarAtPole) {
    for (const [i, f] of this.falls) {
      if (f.wait > 0) {
        f.wait -= dt;
        const q = CITY.poles[i];
        if (f.wait > 0 && car(q.x, q.z) === "closing") continue;
        f.wait = 0;
        this.snap(i);
      }
      if (f.landed && f.swing === 0 && f.yaw === f.target) continue;
      if (f.yaw !== f.target) {
        const d = wrapAngle(f.target - f.yaw);
        f.yaw = Math.abs(d) < 1e-3 ? f.target : f.yaw + d * (1 - Math.exp(-dt / TURN_S));
      }
      if (Math.abs(wrapAngle(f.yaw - f.restYaw)) > 0.01) { f.rest = restLean(f.yaw - f.rot); f.restYaw = f.yaw; }
      // (turned after landing, toward a way it lies on less of a lean)
      if (f.swing === 0 && f.lean > f.rest) f.lean = f.rest;
      if (f.swing !== 0 || f.lean < f.rest) {
        f.swing += TOPPLE * Math.sin(Math.max(f.lean, 0.02)) * dt;
        f.lean += f.swing * dt;
        if (f.lean >= f.rest) {
          f.lean = f.rest;
          if (!f.landed) this.land(i, f);
          f.swing = f.swing > SETTLE ? -f.swing * BOUNCE : 0;
        }
      }
      place(f);
    }
  }

  /** It breaks off its stub. */
  private snap(i: number) {
    const q = CITY.poles[i];
    sfx.poleSnap(q.x, q.z);
    this.fx.impact(q.x, 0.5, q.z, 10);
  }

  /** It hits the ground (the first time). */
  private land(i: number, f: Fall) {
    f.landed = true;
    const q = CITY.poles[i];
    const reach = SLIDE + 3.3 * Math.sin(f.rest);
    const hx = q.x + Math.sin(f.yaw) * reach, hz = q.z + Math.cos(f.yaw) * reach;
    sfx.poleClang(hx, hz);
    for (const k of [0.35, 0.7, 1]) this.fx.dustPuff(q.x + (hx - q.x) * k, 0, q.z + (hz - q.z) * k, 4);
  }
}

/** Put a falling post where it is now: leaning `lean` toward `yaw`, sliding off its stub as it goes. */
function place(f: Fall) {
  const a = f.yaw - f.rot; // the way it falls, in the lamp's own axes
  const dx = Math.sin(a), dz = Math.cos(a);
  // turning up toward (dx, dz) is a turn about (dz, 0, -dx)
  const s = Math.sin(f.lean / 2);
  f.node.quaternion.set(dz * s, 0, -dx * s, Math.cos(f.lean / 2));
  const t = Math.min(1, Math.max(0, f.lean / f.rest));
  const k = t * t * (3 - 2 * t);
  f.node.position.set(dx * SLIDE * k, BREAK + (LIE_Y - BREAK) * k, dz * SLIDE * k);
}

/** How far a post falling `a` (in the lamp's own axes) leans once it's down: until some of it meets the ground. */
function restLean(a: number): number {
  const dx = Math.sin(a), dz = Math.cos(a);
  for (let lean = 1; lean < 1.8; lean += 0.005) {
    const c = Math.cos(lean), s = Math.sin(lean);
    for (const [x, y, z] of HULL) if (LIE_Y + y * c - (x * dx + z * dz) * s <= 0.05) return lean;
  }
  return 1.8;
}
