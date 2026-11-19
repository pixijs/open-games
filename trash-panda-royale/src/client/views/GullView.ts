import { Container3D, CubeGeometry, Material3D, Mesh3D, Quaternion, SphereGeometry, Vector3 } from "@pixi/3d";
import { PICKUP_FOOD, PICKUP_ZOOMIES } from "../../shared/constants.js";
import { find, hasModel, instance } from "../assets.js";

/** What a gull is doing this frame. */
export interface GullState {
  x: number; y: number; z: number;
  yaw: number;
  vx: number; vy: number; vz: number;
  /** Shooed: tumbling out of control. */
  dazed: boolean;
  /** The kind of loot in its feet (-1: none). */
  carry: number;
}

type GullEvent = "squawk" | "poop" | "snatch" | "drop" | "hatch" | "shoo";

/** The model's body centre over its feet (m): the step's `y` is the body's middle. */
const BODY_Y = 0.32;
/** Wing beats per second: hovering, climbing, cruising (a burst), and shooed. */
const FLAP_HOVER = 6.5, FLAP_CLIMB = 5.5, FLAP_CRUISE = 3.8, FLAP_PANIC = 10;
/** What a gull carries: the loot's own model, a little bigger than in a raccoon's paw. */
const CARRY_MODELS: Record<number, string> = { 1: "wpn_pistol", 2: "wpn_smg", 3: "wpn_shotgun", 4: "wpn_grenade", [PICKUP_FOOD]: "food_pizza", [PICKUP_ZOOMIES]: "coffee" };

const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0), Z = new Vector3(0, 0, 1);

interface Joint { node: Container3D; base: Quaternion }

/**
 * A seagull: a raccoon out of the round, flying about (see `stepGull`). The model's wings, tail,
 * head and legs are moved here from how it flies: hovering and climbing it beats its wings hard,
 * cruising it glides with a few beats now and then, diving it folds them back; it banks into its
 * turns and pitches with its climb. Shooed, it tumbles, flapping madly. Its loot hangs from its feet.
 */
export class GullView {
  readonly root = new Container3D({ label: "gull" });
  private model: Container3D;
  private tilt = new Container3D({ label: "gull_tilt" });
  private joints = new Map<string, Joint>();
  private socket: Container3D | null;
  private carried: Container3D | null = null;
  private carryKind = -1;
  private phase = Math.random() * 6.28;
  /** 0..1: how hard the wings beat (eased), and 0..1 how far they're folded back (a dive). */
  private beat = 0;
  private fold = 0;
  private bank = 0;
  private pitch = 0;
  private lastYaw = 0;
  /** Cruising, a burst of beats every so often (s left in it, s until the next). */
  private burst = 0;
  private nextBurst = 1;
  private spin = 0;
  private time = Math.random() * 10;
  /** One-off moves (s left): a squawk (head up, beak open), a squat to poop, a grab, a pop out of the tombstone. */
  private squawkT = 0;
  private poopT = 0;
  private grabT = 0;
  private hatchT = 0;
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();

  constructor() {
    this.model = hasModel("gull") ? instance("gull") : fallbackGull();
    this.root.addChild(this.tilt);
    this.tilt.addChild(this.model);
    this.model.position.set(0, -BODY_Y, 0);
    for (const name of ["body", "head", "wing_l", "wing_r", "wingtip_l", "wingtip_r", "tail", "leg_l", "leg_r"]) {
      const node = find(this.model, name);
      if (node) this.joints.set(name, { node, base: new Quaternion().copyFrom(node.quaternion) });
    }
    this.socket = find(this.model, "carry_socket");
  }

  event(e: GullEvent) {
    if (e === "squawk") this.squawkT = 0.6;
    else if (e === "poop") this.poopT = 0.35;
    else if (e === "snatch" || e === "drop") this.grabT = 0.4;
    else if (e === "hatch") this.hatchT = 0.5;
  }

  /** The point under its feet where what it carries hangs (world), for effects. */
  feet(out: Vector3): Vector3 {
    return (this.socket ?? this.model).getGlobalPosition(out);
  }

  update(dt: number, s: GullState) {
    this.time += dt;
    this.root.position.set(s.x, s.y, s.z);
    const h = Math.hypot(s.vx, s.vz);
    // how fast it turns (from how its heading moved): it banks into it
    let dyaw = s.yaw - this.lastYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.lastYaw = s.yaw;
    const turn = dyaw / Math.max(dt, 1e-3);

    // the wings: how hard they beat, and how fast
    let rate: number, beat: number, fold = 0;
    if (s.dazed) { rate = FLAP_PANIC; beat = 1; }
    else if (s.vy < -4) { rate = FLAP_CRUISE; beat = 0; fold = Math.min(1, (-s.vy - 4) / 4); }
    else if (h < 3) { rate = FLAP_HOVER; beat = 0.85; }
    else if (s.vy > 2) { rate = FLAP_CLIMB; beat = 1; }
    else {
      // cruising: gliding, with a few beats now and then
      rate = FLAP_CRUISE;
      this.nextBurst -= dt;
      if (this.nextBurst <= 0) { this.burst = 0.55 + Math.random() * 0.4; this.nextBurst = 1.4 + Math.random() * 1.6; }
      beat = this.burst > 0 ? 0.7 : 0.08;
    }
    this.burst = Math.max(0, this.burst - dt);
    if (this.grabT > 0 || this.hatchT > 0) beat = 1;
    this.beat += (beat - this.beat) * Math.min(1, dt * 8);
    this.fold += (fold - this.fold) * Math.min(1, dt * 6);
    this.phase += dt * rate * Math.PI * 2 * (0.4 + 0.6 * this.beat);

    const wave = Math.sin(this.phase), lag = Math.sin(this.phase - 0.9);
    // spread wings sit a little up (a gull's glide); a beat swings them through ±0.9 rad
    const dihedral = 0.12 + 0.04 * Math.sin(this.time * 1.7);
    const sweep = this.fold * 1.1;
    const wing = (dihedral + this.beat * 0.85 * wave) * (1 - this.fold) - this.fold * 0.25;
    const tip = this.beat * 0.55 * lag * (1 - this.fold) + this.fold * 0.6;
    this.rot("wing_l", Z, wing, Y, -sweep);
    this.rot("wing_r", Z, -wing, Y, sweep);
    this.rot("wingtip_l", Z, tip, Y, -sweep * 0.4);
    this.rot("wingtip_r", Z, -tip, Y, sweep * 0.4);

    // the body: banking into turns, nose down to dive and up to climb; bobbing with the beats
    const bank = s.dazed ? 0 : Math.max(-0.7, Math.min(0.7, -turn * Math.max(1, h) * 0.06));
    this.bank += (bank - this.bank) * Math.min(1, dt * 5);
    const pitch = s.dazed ? 0 : Math.max(-0.6, Math.min(0.45, -s.vy * 0.05 - (h > 3 ? 0.08 : -0.1)));
    this.pitch += (pitch - this.pitch) * Math.min(1, dt * 5);
    if (s.dazed) this.spin += dt * 11; else this.spin *= Math.max(0, 1 - dt * 6);
    const bob = this.beat * 0.05 * Math.sin(this.phase + 1.4);
    this.tilt.position.set(0, bob, 0);
    this.q.setFromAxisAngle(Y, s.yaw);
    this.q2.setFromAxisAngle(X, this.pitch);
    this.q.multiply(this.q2);
    this.q2.setFromAxisAngle(Z, this.bank + Math.sin(this.spin) * (s.dazed ? 1.2 : 0));
    this.q.multiply(this.q2);
    if (this.spin) { this.q2.setFromAxisAngle(X, this.spin * 0.6); this.q.multiply(this.q2); }
    this.tilt.quaternion = this.q;
    // popping out of a tombstone: a little squash and stretch
    this.hatchT = Math.max(0, this.hatchT - dt);
    const pop = this.hatchT > 0 ? Math.sin((1 - this.hatchT / 0.5) * Math.PI) : 0;
    this.model.scale.set(1 - 0.15 * pop, 1 + 0.3 * pop, 1 - 0.15 * pop);

    // the head: up for a squawk, looking about while it hovers
    this.squawkT = Math.max(0, this.squawkT - dt);
    const sq = this.squawkT > 0 ? Math.sin((1 - this.squawkT / 0.6) * Math.PI) : 0;
    const look = h < 3 && !s.dazed ? Math.sin(this.time * 0.9) * 0.6 : 0;
    this.rot("head", X, -this.pitch * 0.6 - sq * 0.55 + Math.sin(this.time * 9) * sq * 0.1, Y, look);
    // the tail: with the climb, and a flick to let one go
    this.poopT = Math.max(0, this.poopT - dt);
    const flick = this.poopT > 0 ? Math.sin((1 - this.poopT / 0.35) * Math.PI) : 0;
    this.rot("tail", X, -this.pitch * 0.5 + flick * 0.7 + this.beat * 0.08 * Math.sin(this.phase * 0.5), Y, this.bank * 0.3);
    // the legs: tucked back in flight, down to hover low, to grab, and to carry
    this.grabT = Math.max(0, this.grabT - dt);
    const down = s.carry >= 0 || this.grabT > 0 || (h < 2 && !s.dazed) ? 1 : 0;
    const legs = 1.3 * (1 - down) + (this.grabT > 0 ? -0.3 * Math.sin((1 - this.grabT / 0.4) * Math.PI) : 0);
    this.rot("leg_l", X, legs + (s.dazed ? Math.sin(this.time * 17) * 0.6 : 0));
    this.rot("leg_r", X, legs + (s.dazed ? Math.sin(this.time * 17 + 2) * 0.6 : 0));

    this.setCarry(s.carry);
    if (this.carried) {
      // swinging a little under its feet
      this.carried.rotation.set(Math.sin(this.time * 3.1) * 0.25 - this.pitch, this.time * 0.8, Math.sin(this.time * 2.3) * 0.2);
    }
  }

  /** Joint `name` at its rest pose turned `a` about `ax` (then `b` about `bx`). */
  private rot(name: string, ax: Vector3, a: number, bx?: Vector3, b = 0) {
    const j = this.joints.get(name);
    if (!j) return;
    this.q.copyFrom(j.base);
    this.q2.setFromAxisAngle(ax, a);
    this.q.multiply(this.q2);
    if (bx && b) { this.q2.setFromAxisAngle(bx, b); this.q.multiply(this.q2); }
    j.node.quaternion = this.q;
  }

  private setCarry(kind: number) {
    if (kind === this.carryKind) return;
    this.carryKind = kind;
    this.carried?.destroy({ children: true });
    this.carried = null;
    const name = CARRY_MODELS[kind];
    if (!name) return;
    const item = instance(name, { castShadow: true });
    item.scale.set(kind === PICKUP_FOOD || kind === PICKUP_ZOOMIES ? 1.3 : 1.8);
    // (just under the claws)
    item.position.set(0, -0.12, 0);
    (this.socket ?? this.model).addChild(item);
    this.carried = item;
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

/** If the gull's model didn't load: a gull-ish stand-in with the same joints. */
function fallbackGull(): Container3D {
  const root = new Container3D({ label: "gull-fallback" });
  const white = new Material3D({ baseColor: 0xffffff, roughness: 0.8, metallic: 0 });
  const grey = new Material3D({ baseColor: 0xb7c0cc, roughness: 0.8, metallic: 0 });
  const yellow = new Material3D({ baseColor: 0xffc93c, roughness: 0.6, metallic: 0 });
  const sphere = new SphereGeometry({ radius: 0.5, widthSegments: 12, heightSegments: 8 });
  const cube = new CubeGeometry({ width: 1, height: 1, depth: 1 });
  const node = (label: string, parent: Container3D, x: number, y: number, z: number) => {
    const n = new Container3D({ label });
    n.position.set(x, y, z);
    parent.addChild(n);
    return n;
  };
  const mesh = (parent: Container3D, geo: SphereGeometry | CubeGeometry, mat: Material3D, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const m = new Mesh3D({ geometry: geo, material: mat });
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    parent.addChild(m);
  };
  const body = node("body", root, 0, BODY_Y, 0);
  mesh(body, sphere, white, 0, 0, 0, 0.36, 0.3, 0.6);
  const head = node("head", body, 0, 0.12, 0.2);
  mesh(head, sphere, white, 0, 0.05, 0.06, 0.26, 0.26, 0.26);
  mesh(head, cube, yellow, 0, 0.02, 0.24, 0.07, 0.06, 0.16);
  for (const side of [1, -1]) {
    const w = node(side > 0 ? "wing_l" : "wing_r", body, side * 0.13, 0.06, 0.02);
    mesh(w, cube, grey, side * 0.2, 0, 0, 0.4, 0.03, 0.28);
    const t = node(side > 0 ? "wingtip_l" : "wingtip_r", w, side * 0.4, 0, 0);
    mesh(t, cube, grey, side * 0.18, 0, -0.02, 0.36, 0.025, 0.2);
    const leg = node(side > 0 ? "leg_l" : "leg_r", body, side * 0.07, -0.12, 0);
    mesh(leg, cube, yellow, 0, -0.1, 0, 0.03, 0.2, 0.03);
  }
  const tail = node("tail", body, 0, 0.01, -0.24);
  mesh(tail, cube, white, 0, 0, -0.1, 0.18, 0.03, 0.2);
  node("carry_socket", root, 0, 0, 0.05);
  return root;
}
