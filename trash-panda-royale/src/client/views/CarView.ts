import { Container3D, CubeGeometry, Material3D, Mesh3D, Quaternion, Vector3 } from "@pixi/3d";
import { CAR_FUSE_MS, CAR_GARBAGE, CAR_SLIP_PEAK, CAR_SLIP_REF, CAR_TYPES, CarLight } from "../../shared/constants.js";
import { steerLock, wheelAngle } from "../../shared/sim.js";
import { Springs } from "../anim/Springs.js";
import { destroyInstance, find, forEachMesh, instance, materialName, recolorMeshes } from "../assets.js";
import { CharacterView } from "./CharacterView.js";
import type { Look } from "./looks.js";

const _q1 = new Quaternion(), _q2 = new Quaternion();
const _up = new Vector3(0, 1, 0), _x = new Vector3(1, 0, 0), _z = new Vector3(0, 0, 1), _v = new Vector3();

export interface CarRender {
  x: number; y: number; z: number; yaw: number;
  vx: number; vz: number; steer: number;
  state: number; hp: number; siren: boolean;
  /** CarLight bits: brake and reversing lights, a locked rear (skids). */
  lights?: number;
  /** How fast it turns (rad/s), when known (the car we drive); otherwise it's worked out from the yaw. */
  yawRate?: number;
  /**
   * Steered by the traffic AI, which turns a car about its middle with its velocity along its nose:
   * no tyre slides there unless it moves sideways.
   */
  kinematic?: boolean;
}

/**
 * The tail lights of each model (CAR_TYPES order): x of the right one, height, rear face (z), and
 * the size of the lens (from assets-src/blender/build_vehicles_buildings.py). Braking or
 * reversing, a glowing lens goes over each.
 */
const TAIL_LIGHTS = [
  { x: 0.66, y: 0.74, z: -1.88, w: 0.26, h: 0.16 },
  { x: 0.68, y: 0.76, z: -2.07, w: 0.28, h: 0.16 },
  { x: 0.68, y: 0.76, z: -2.07, w: 0.28, h: 0.16 },
  { x: 0.86, y: 0.9, z: -2.33, w: 0.2, h: 0.32 },
  { x: 0.98, y: 0.5, z: -3.3, w: 0.26, h: 0.2 },
];
/** Each model's wheel radius (m): how fast they spin. */
const WHEEL_R = [0.38, 0.38, 0.38, 0.4, 0.5];
/** The garbage truck's side-loader, lowered all the way (rad about its own Z: + swings it out and down, to the right). */
const LIFT_DOWN = 0.42;
const BRAKE_RED = 0xff2a22, REVERSE_WHITE = 0xfff1d6;
let lensGeo: CubeGeometry | null = null;
/** The lit lenses, shared by every car: braking and reversing. */
let lensMats: { brake: Material3D; reverse: Material3D } | null = null;
/** The lenses glow like the tracers do (their material recipe: no new shader program). */
const lensMat = (color: number, strength: number) => new Material3D({ baseColor: color, emissive: { color, strength }, alphaMode: "blend", alpha: 1 });
/** Wheels' track: their distance from the middle, × the car's half width. */
export const WHEEL_TRACK = 0.79;
/** The front wheels are drawn turned this much (rad) at full lock, whatever the speed. */
const WHEEL_TURN = 0.5;

/** Accessories a driver leaves in the trunk. */
const DRIVER_HIDES = ["acc_balloon", "acc_sack", "acc_backpack", "acc_tank", "acc_handbag", "acc_briefcase", "acc_sprayer"];
/** Squash-and-stretch channels: vertical stretch (volume kept: + tall and thin, − flat and wide), and an all-round swell. */
const SQ = 0, PUFF = 1;
const FUSE = CAR_FUSE_MS / 1000;

/** Thickness of a car's roof (its top is `CarType.roof`). */
const ROOF_SHELL = 0.06;
/** Gap kept between a driver's head (or hat) and the roof. */
const HEAD_CLEARANCE = 0.04;

export class CarView {
  readonly root = new Container3D({ label: "car" });
  private model: Container3D;
  private wheels: { node: Container3D; front: boolean; base: Quaternion }[] = [];
  private spin = 0;
  private roll = 0;
  private pitch = 0;
  private prevSpeed = 0;
  /**
   * The cartoon body: it swells and throbs on a burning fuse, balloons when it blows, stretches
   * along the way it flies and squashes flat where it lands. Scale only: it never tumbles.
   */
  private sq = new Springs(2);
  private lastState = -1;
  /** How long it has burned (s), as seen here; and the throb's phase. */
  private fuse = 0;
  private throb = 0;
  private lastY = 0;
  /** Vertical speed of the drawn car (m/s), low-passed; and the fastest it fell this flight. */
  private vy = 0;
  private fall = 0;
  private air = false;
  /** How hard it landed this frame (m/s), 0 if it didn't: for a puff of dust. */
  thud = 0;
  private sirenMats: { mat: Material3D; color: number }[] = [];
  /** The garbage truck: its side-loader arm (and the socket the golden dumpster rides in), its tailgate. */
  private lift: Container3D | null = null;
  private liftBase: Quaternion | null = null;
  private socketNode: Container3D | null = null;
  private liftK = 0;
  private wrecked = false;
  readonly halfL: number;
  readonly halfW: number;
  readonly kind: number;
  /** Character sitting at the wheel (AI or a player). */
  driver: CharacterView | null = null;
  private driverKey = "";
  private time = Math.random() * 10;
  /**
   * How hard each wheel skids this frame (0..1: rear left, rear right, front left, front right):
   * sliding sideways past its grip, locked by the handbrake or the brakes, or spinning up. For
   * the marks, the smoke and the screech.
   */
  readonly skid = new Float32Array(4);
  /** The tail-light lenses, lit braking (red) or reversing (white); hidden otherwise. */
  private lenses: Mesh3D[] = [];
  private lensColor = 0;
  private yawRate = 0;

  constructor(kind: number, paint: number) {
    this.kind = kind;
    const type = CAR_TYPES[kind];
    this.halfL = type.halfL;
    this.halfW = type.halfW;
    this.model = instance(type.model, { recolor: { Paint: paint }, unique: kind === 2 || kind === CAR_GARBAGE });
    this.sq.tune(SQ, 16, 0.32);
    this.sq.tune(PUFF, 16, 0.55);
    this.root.addChild(this.model);
    for (const name of ["wheel_fl", "wheel_fr", "wheel_bl", "wheel_br"]) {
      const node = find(this.model, name);
      if (node) this.wheels.push({ node, front: name.includes("_f"), base: new Quaternion().copyFrom(node.quaternion) });
    }
    lensGeo ??= new CubeGeometry({ width: 1, height: 1, depth: 1 });
    lensMats ??= { brake: lensMat(BRAKE_RED, 5), reverse: lensMat(REVERSE_WHITE, 3) };
    const tl = TAIL_LIGHTS[kind] ?? TAIL_LIGHTS[0];
    for (const side of [1, -1]) {
      const lens = new Mesh3D({ geometry: lensGeo, material: lensMats.brake, castShadow: false, receiveShadow: false });
      // standing a little proud of the tail, so the high camera sees its top glow too
      lens.position.set(side * tl.x, tl.y, tl.z - 0.03);
      lens.scale.set(tl.w + 0.04, tl.h + 0.04, 0.12);
      lens.visible = false;
      this.model.addChild(lens);
      this.lenses.push(lens);
    }
    this.seat = find(this.model, "seat");
    this.wheel = find(this.model, "steer_wheel");
    if (this.wheel) this.wheelBase.copyFrom(this.wheel.quaternion);
    if (kind === 2 || kind === CAR_GARBAGE) {
      forEachMesh(this.model, (m) => {
        const n = materialName(m.material);
        if ((n === "SirenBlue" || n === "SirenRed" || n === "Beacon") && m.material instanceof Material3D && m.material.emissive) {
          this.sirenMats.push({ mat: m.material, color: n === "SirenBlue" ? 0x3d6bff : n === "Beacon" ? 0xffa21f : 0xff2d3d });
        }
      });
    }
    if (kind === CAR_GARBAGE) {
      this.lift = find(this.model, "lift");
      this.liftBase = this.lift ? new Quaternion().copyFrom(this.lift.quaternion) : null;
      this.socketNode = find(this.model, "bin_socket");
    }
  }

  /** Show `look` (or nobody) in the driver's seat (at the model's `seat` node when it has one). */
  setDriver(key: string, look: Look | null) {
    if (key === this.driverKey) return;
    this.driverKey = key;
    if (this.driver) { this.driver.destroy(); this.driver = null; }
    if (!look) return;
    const human = look.species === "human";
    const d = (this.driver = new CharacterView(look));
    // what's on their back or in their hands stays out of the seat back, the dash and
    // the roof (a balloon would float up through it)
    for (const acc of DRIVER_HIDES) d.hide(acc);
    // the seat node is the top of the cushion: the hip joints go just above it (thighs on the seat)
    const hip = human ? 0.62 : 0.34, thigh = human ? 0.09 : 0.07;
    // people hunch, raccoons sit on a booster seat, and either shrinks a little more if
    // their head (or hat) would poke through the roof (glass on top: you'd see it)
    const headroom = CAR_TYPES[this.kind].roof - ROOF_SHELL - (this.seat?.position.y ?? 0);
    const fit = (headroom - HEAD_CLEARANCE) / (d.restTop() - hip + thigh);
    const scale = Math.min(d.root.scale.x * (human ? 0.82 : 0.92), fit);
    d.root.scale.set(scale);
    this.driverY = -(hip - thigh) * scale;
    (this.seat ?? this.model).addChild(d.root);
  }

  private seat: Container3D | null = null;
  /** Where the driver's feet go below the seat cushion so they sit on it. */
  private driverY = 0;
  private wheel: Container3D | null = null;
  /** The steering wheel's rest turn (the column's tilt is its parent's). */
  private readonly wheelBase = new Quaternion();
  private lastVF = 0;
  private lastYaw = 0;
  /** Low-passed acceleration of the drawn car along its nose (m/s²): how hard a remote driver is on the gas. */
  accF = 0;
  private accL = 0;

  /** The yaw it was last drawn at. */
  private yaw = 0;

  update(dt: number, c: CarRender) {
    this.time += dt;
    this.yaw = c.yaw;
    this.root.position.set(c.x, c.y, c.z);
    this.root.quaternion.setFromAxisAngle(_up, c.yaw);

    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    const lx = Math.cos(c.yaw), lz = -Math.sin(c.yaw);
    const vF = c.vx * fx + c.vz * fz;
    const vL = c.vx * lx + c.vz * lz;
    const accel = (vF - this.prevSpeed) / Math.max(dt, 1e-3);
    this.prevSpeed = vF;
    const lp = 1 - Math.exp(-dt / 0.12);
    this.accF += ((vF - this.lastVF) / Math.max(dt, 1e-3) - this.accF) * lp;
    this.lastVF = vF;
    // how fast it turns: given, or from how its yaw moved; lateral acceleration = speed × that
    let dyaw = c.yaw - this.lastYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.lastYaw = c.yaw;
    this.yawRate += ((c.yawRate ?? dyaw / Math.max(dt, 1e-3)) - this.yawRate) * (1 - Math.exp(-dt / 0.06));
    this.accL += ((vF * dyaw) / Math.max(dt, 1e-3) - this.accL) * lp;

    // the front wheels: as the step turns them (counter-steering into a slide, too), drawn on
    // the scale of the lock at this speed, so full lock always looks like full lock
    const type = CAR_TYPES[this.kind];
    const delta = c.kinematic ? wheelAngle(c.steer, vF, 0, 0, type.axle) : wheelAngle(c.steer, vF, vL, this.yawRate, type.axle);
    const turn = Math.max(-1, Math.min(1, delta / steerLock(vF)));
    this.updateSkid(c, type.axle, type.accel, vF, vL, delta);

    // body roll / pitch from the forces, smoothed. A left turn (yaw rate +) leans the body out
    // of the turn (+Z roll lifts the left side), and so does a sideways slide.
    const targetRoll = Math.max(-0.12, Math.min(0.12, this.yawRate * Math.abs(vF) * 0.0045 - vL * 0.01));
    const targetPitch = Math.max(-0.08, Math.min(0.08, -accel * 0.004));
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 8);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 6);

    const rattle = this.squash(dt, c);
    const bounce = c.state === 0 && Math.abs(vF) > 1 ? Math.sin(this.time * 17) * 0.008 * Math.min(1, Math.abs(vF) / 10) : 0;
    this.model.rotation.set(this.pitch, 0, this.roll);
    this.model.position.set(Math.sin(this.time * 63) * rattle, bounce, Math.sin(this.time * 51) * rattle * 0.5);

    // wheels: spin about X, steer the front pair about Y (+ steer = left = toward +X)
    this.spin += (vF * dt) / (WHEEL_R[this.kind] ?? 0.38);
    for (const w of this.wheels) {
      _q1.setFromAxisAngle(_up, w.front ? turn * WHEEL_TURN : 0);
      _q2.setFromAxisAngle(_x, this.spin);
      _q1.multiply(_q2);
      w.node.quaternion.copyFrom(w.base);
      w.node.quaternion.multiply(_q1);
    }

    // police lights (the garbage truck's amber beacons go round, slower)
    if (this.sirenMats.length) {
      const phase = Math.floor(this.time * (this.kind === CAR_GARBAGE ? 3 : 6)) % 2;
      this.sirenMats.forEach((s, i) => {
        if (!s.mat.emissive) return;
        const on = c.siren && (i % 2 === phase);
        s.mat.emissive.strength = on ? 6 : 0.3;
      });
    }
    if (this.lift && this.liftBase) {
      _q1.setFromAxisAngle(_z, LIFT_DOWN * this.liftK);
      this.lift.quaternion.copyFrom(this.liftBase);
      this.lift.quaternion.multiply(_q1);
    }

    if (c.state === 2 && !this.wrecked) {
      // charred: every material goes soot-black
      this.wrecked = true;
      const names = new Set<string>();
      forEachMesh(this.model, (m) => names.add(materialName(m.material)));
      const soot: Record<string, number> = {};
      for (const n of names) if (n) soot[n] = /glass|window/i.test(n) ? 0x15161a : n === "Paint" ? 0x2b2b30 : 0x3a3a40;
      // (lights out first: the soot doesn't touch their glow)
      for (const s of this.sirenMats) if (s.mat.emissive) s.mat.emissive.strength = 0;
      this.sirenMats = [];
      recolorMeshes(this.model, soot);
      if (this.driver) this.setDriver("", null);
    }

    // braking: the tail lights glow red; backing up, white
    const lights = c.state === 2 ? 0 : c.lights ?? 0;
    const lens = lights & CarLight.Brake ? BRAKE_RED : lights & CarLight.Reverse ? REVERSE_WHITE : 0;
    if (lens !== this.lensColor) {
      this.lensColor = lens;
      for (const l of this.lenses) {
        l.visible = lens !== 0;
        if (lens) l.material = lens === BRAKE_RED ? lensMats!.brake : lensMats!.reverse;
      }
    }

    // the steering wheel (and the driver's paws) turn with the front wheels: they counter-steer
    if (this.wheel) this.wheel.quaternion.copyFrom(this.wheelBase).multiply(_q1.setFromAxisAngle(_z, -turn * 1.6));
    if (this.driver) {
      // sat on the seat node
      this.driver.update(dt, {
        x: 0, y: this.driverY, z: 0, yaw: 0, speed: 0, vy: 0, pose: "sit", aiming: false,
        steer: turn, accF: this.accF, accL: this.accL,
      });
    }
  }

  /**
   * Scales the model for the cartoon body (see `sq`) and sets `thud`. Returns how far it rattles
   * side to side (m): a fuse about to go.
   */
  private squash(dt: number, c: CarRender): number {
    this.vy += ((c.y - this.lastY) / Math.max(dt, 1e-3) - this.vy) * (1 - Math.exp(-dt / 0.05));
    this.lastY = c.y;
    // (cars only leave the ground when something throws them)
    const air = c.y > 0.02;
    this.thud = 0;
    if (air) this.fall = Math.max(this.fall, -this.vy);
    else {
      if (this.air && this.fall > 2) {
        // pancaked on landing: whatever stretch it had goes at once
        this.sq.x[SQ] = Math.min(this.sq.x[SQ], 0);
        this.sq.v[SQ] = Math.min(this.sq.v[SQ], 0) - this.fall;
        this.thud = this.fall;
      }
      this.fall = 0;
    }
    this.air = air;

    let stretch = air ? Math.min(0.3, Math.abs(this.vy) * 0.035) : 0, swell = 0, throb = 0, rattle = 0;
    if (c.state === 1) {
      // the fuse: it swells, throbs faster and faster, and crouches for the pop
      this.fuse += dt;
      const k = Math.min(1, this.fuse / FUSE);
      this.throb += dt * (8 + 28 * k);
      swell = 0.14 * k * k;
      throb = Math.sin(this.throb) * (0.01 + 0.02 * k);
      rattle = 0.015 * k * k;
      const t = Math.max(0, Math.min(1, (this.fuse - FUSE + 0.35) / 0.35));
      stretch -= 0.2 * t * t * (3 - 2 * t);
    }
    // blown (not a wreck that came into view): it balloons and shoots up tall, then wobbles back
    if (c.state === 2 && (this.lastState === 0 || this.lastState === 1)) {
      this.sq.kick(PUFF, 20);
      this.sq.kick(SQ, 8);
    }
    this.lastState = c.state;

    this.sq.t[SQ] = stretch;
    this.sq.t[PUFF] = swell;
    this.sq.step(dt);
    const d = Math.max(-0.45, Math.min(0.7, this.sq.x[SQ]));
    const p = 1 + this.sq.x[PUFF] + throb;
    this.model.scale.set(p / Math.sqrt(1 + d), p * (1 + d), p / Math.sqrt(1 + d));
    return rattle;
  }

  /** How hard each wheel skids (see `skid`), from how the car moves and what its driver does. */
  private updateSkid(c: CarRender, axle: number, accel: number, vF: number, vL: number, delta: number) {
    let rear = 0, front = 0;
    if (c.state !== 2 && c.y < 0.05) {
      const lights = c.lights ?? 0;
      const sp = Math.abs(vF);
      // sliding sideways: past the tyre's peak slip (tyre frames, as in the step)
      const ref = (u: number) => Math.max(Math.abs(u), CAR_SLIP_REF) * CAR_SLIP_PEAK;
      const spin = c.kinematic ? 0 : this.yawRate * axle;
      const vLr = vL - spin, vLf = vL + spin;
      const cd = Math.cos(delta), sd = Math.sin(delta);
      const wF = vLf * cd - vF * sd, uF = vF * cd + vLf * sd;
      rear = Math.max(0, Math.min(1, (Math.abs(vLr) / ref(vF) - 1.3) / 2.5));
      front = Math.max(0, Math.min(1, (Math.abs(wF) / ref(uF) - 1.6) / 3));
      // locked by the handbrake, or braking as hard as the tyres go
      if (lights & CarLight.Handbrake && sp > 1.5) rear = Math.max(rear, 0.75);
      // (not the traffic AI's stops: they're tidy)
      if (lights & CarLight.Brake && !c.kinematic && sp > 5 && this.accF < -14) { rear = Math.max(rear, 0.4); front = Math.max(front, 0.55); }
      // pulling away flat out: a little wheelspin
      if (this.accF > 0.75 * accel && vF > 0.3 && vF < 8) rear = Math.max(rear, 0.55 * (1 - vF / 8));
      const rolling = Math.min(1, Math.hypot(c.vx, c.vz) / 3);
      rear *= rolling; front *= rolling;
    }
    this.skid[0] = this.skid[1] = rear;
    this.skid[2] = this.skid[3] = front;
  }

  /** The garbage truck's side-loader: 0 up (carrying), 1 down at the kerb. */
  setLift(k: number) { this.liftK = Math.max(0, Math.min(1, k)); }

  /**
   * Where the golden dumpster rides on the garbage truck as drawn (its lift's socket, world), or
   * by its right flank if the model has none. Null for any other car.
   */
  socket(): { x: number; y: number; z: number; yaw: number } | null {
    if (this.kind !== CAR_GARBAGE) return null;
    if (this.socketNode) {
      const p = this.socketNode.getGlobalPosition(_v);
      // (lying along the truck, facing out to its right: the way it's put down)
      return { x: p.x, y: p.y, z: p.z, yaw: this.yaw + Math.PI / 2 };
    }
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);
    const p = this.root.position;
    return { x: p.x + rx * 1.75 - fx * 0.8, y: p.y + 0.9 - this.liftK * 0.9, z: p.z + rz * 1.75 - fz * 0.8, yaw: this.yaw + Math.PI / 2 };
  }

  /** Honk: the driver slaps the horn. */
  honk() { this.driver?.event("honk"); }

  destroy() {
    this.driver?.destroy();
    destroyInstance(this.root);
  }
}
