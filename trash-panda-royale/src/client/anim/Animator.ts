import { JUMP_VELOCITY, Weapon } from "../../shared/constants.js";
import type { Role, Species } from "../views/looks.js";
import { Springs } from "./Springs.js";

/**
 * Procedural character animation. Every joint channel is a spring chasing a target; the
 * targets are rebuilt from scratch each frame in layers (base pose of the state → upper-body
 * actions → secondary motion → idle fidgets), so poses switch instantly and the springs do
 * all the blending. One-shot moves (a slap, a throw, a landing, getting flattened) are short
 * clips or velocity kicks on top.
 *
 * A raccoon's walk, run and gallop are not springs: a spring rounds a fast cycle off and
 * makes it late (the quicker the steps, the smaller and later the swing). They are curves
 * of the gait's phase (`gait()`), added on top of the springs and keyed the way an animator
 * keys a run: contact, down (squash), passing, up (stretch), with the stance foot held on
 * the ground and the swing foot lifted clear. Everything that hangs off the body (ears,
 * tail, head, arms) is pushed about by how the body accelerates (`inertia()`), so it trails,
 * overshoots and settles by itself: follow-through and overlapping action. In the air the
 * pose is keyed on the way up, at the top and on the way down, eased so it hangs at the top.
 *
 * Signs (rig contract, Euler XYZ): rotX > 0 swings a hanging limb back, tips the torso and
 * head forward and tips an upright ear forward; rotZ > 0 swings the left limbs out (the right
 * ones with rotZ < 0) and tips an upright ear toward the right; rotY > 0 turns left. Tail:
 * rotX > 0 lifts it, rotY > 0 swings it to the right. A foot's rotX > 0 points its toes down.
 */
export const Ch = {
  bodyY: 0, bodySY: 1, bodySXZ: 2, bodyRX: 3, bodyRZ: 4, bodyRY: 5,
  hipsRY: 6, hipsRZ: 7,
  torsoRX: 8, torsoRY: 9, torsoRZ: 10,
  headRX: 11, headRY: 12, headRZ: 13,
  earLRX: 14, earLRZ: 15, earRRX: 16, earRRZ: 17,
  armLRX: 18, armLRY: 19, armLRZ: 20, armRRX: 21, armRRY: 22, armRRZ: 23,
  foreL: 24, foreR: 25,
  legsRY: 26,
  legLRX: 27, legLRZ: 28, legRRX: 29, legRRZ: 30,
  footL: 31, footR: 32,
  tail0X: 33, tail0Y: 34, tail1X: 35, tail1Y: 36, tail2X: 37, tail2Y: 38,
  /** A leg sliding up into the hips (m): a stubby chibi leg's knee bend; < 0 reaches down. */
  legLY: 39, legRY: 40,
  /** Blend weights, not joints: on its feet (the gait's cycle), and galloping on all fours. */
  gait: 41, gallop: 42,
  /** The speed the gait steps at (m/s): the body's, eased, so a standing start winds up. */
  pace: 43,
  /**
   * On a wall (a blend weight, 0..1): the whole body tipped back onto it, belly to the wall, so
   * the gallop's floor is the wall (see CharacterView); and which way it heads up there (rad, 0:
   * head up, > 0 turned toward its left).
   */
  wall: 44, wallTurn: 45,
} as const;
export const N_CH = 46;

/** Face expressions: cells of the character's face atlas row. */
export const Expr = { Neutral: 0, Blink: 1, Happy: 2, Ouch: 3, KO: 4, Panic: 5, Determined: 6, Mischief: 7 } as const;
export type Expr = (typeof Expr)[keyof typeof Expr];

export type Pose = "move" | "air" | "sit" | "ragdoll" | "lying" | "hidden" | "wall";

/** What the game tells a character each frame. */
export interface AnimInput {
  x: number; y: number; z: number; yaw: number;
  /** Horizontal speed (m/s). */
  speed: number;
  vy: number;
  pose: Pose;
  aiming: boolean;
  /** World velocity (for leaning into turns and strafing). */
  vx?: number; vz?: number;
  /** Standing on a moving roof (a car or a train): surf. */
  ride?: boolean;
  /** That platform's acceleration (world, m/s²), and its speed (m/s). */
  platAx?: number; platAz?: number; platSpeed?: number;
  /** Driving: steering −1..1 (+ = left), and the car's forward/lateral acceleration. */
  steer?: number; accF?: number; accL?: number;
  /** A townsperson running for their life. */
  panic?: boolean;
  /** Victory lap: dance. */
  dance?: boolean;
  /** Has the zoomies (a coffee): the only time a raccoon drops onto all fours to gallop. */
  zoomies?: boolean;
  /** Winding up a stink bomb: 0 (not) .. 1 (full power). Set it with `aiming`. */
  windup?: number;
  /** On a wall (pose "wall"): how fast it crawls up it, and along it to its right (m/s). */
  wallUp?: number; wallSide?: number;
}

export type AnimEvent = "jump" | "land" | "fire" | "slap" | "throw" | "hop" | "flatten" | "hurt" | "pickup" | "taunt" | "honk";

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const frac = (a: number) => a - Math.floor(a);

/** Ease `st` ([value, speed]) toward `to`: a critically damped spring of `omega`, so what it
 * smooths can't jump from one frame to the next. Returns the new value. */
function ease(st: number[], to: number, dt: number, omega: number) {
  const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
  for (let k = 0; k < n; k++) {
    st[1] += (omega * omega * (to - st[0]) - 2 * omega * st[1]) * h;
    st[0] += st[1] * h;
  }
  return st[0];
}
/**
 * A leg's angle forward of straight down (rad) through one cycle (`q` 0..1, the stance the
 * first `duty` of it), for a hip (or shoulder) `h` m up that travels `2·half` m over its
 * planted foot each stance. Through the stance the leg points at the planted foot, so it
 * stays put; through the swing a smooth curve carries it forward again, past the next
 * foothold and back onto it, arriving moving back as fast as the ground goes by (it doesn't
 * skid), and leaving the same way: the leg never stops dead at either end of its swing.
 */
function legAngle(q: number, duty: number, half: number, h: number, match = 1) {
  if (q < duty) return Math.atan((half * (1 - (2 * q) / duty)) / h);
  const th = Math.atan(half / h);
  // the stance's own angular speed at its two ends, per unit of swing (`match` < 1 takes a
  // share of it: a shorter swing, which then reaches less far past the foothold)
  const m = ((-2 * half) / h) * Math.cos(th) ** 2 * ((1 - duty) / duty) * match;
  const u = (q - duty) / (1 - duty), u2 = u * u, u3 = u2 * u;
  return -th * (2 * u3 - 3 * u2 + 1) + m * (u3 - 2 * u2 + u) + th * (3 * u2 - 2 * u3) + m * (u3 - u2);
}
/** A foot's (or paw's) lift through one cycle: none through the stance, a smooth hump through the swing. */
const footLift = (q: number, duty: number) => {
  if (q < duty) return 0;
  const u = (q - duty) / (1 - duty);
  return smooth(0, 0.3, u) * smooth(0, 0.3, 1 - u);
};
/** How far into its swing a leg is, as a hump: 0 at lift-off and touchdown, 1 mid-swing. */
const midSwing = (q: number, duty: number) => (q < duty ? 0 : 4 * ((q - duty) / (1 - duty)) * (1 - (q - duty) / (1 - duty)));
/** A smooth hump of half-width `r` round `c`, repeating every `period`. */
function hump(p: number, c: number, r: number, period = 1) {
  let d = Math.abs(frac((p - c) / period)) * period;
  d = Math.min(d, period - d);
  return d >= r ? 0 : Math.cos((d / r) * (Math.PI / 2)) ** 2;
}
/** A foot rolling through a step: heel up, onto its toes, leaving the ground; toes up to land. */
const footRoll = (q: number, duty: number) => 0.28 * hump(q, duty, 0.14) - 0.14 * hump(q, 0.955, 0.07);

/** How far a leg may slide into the hips, or reach out of them (m). */
const LEG_IN = 0.1, LEG_OUT = -0.08;
/**
 * The height the stance's planted-foot geometry assumes for the hip (m). A raccoon's legs are
 * stubs that swing 0.26 m from hip to ankle: keeping the foot exactly still at a run would
 * take swings of 60°+, so this is a little long, and the foot gives way a little instead.
 */
const LEG_PIVOT = 0.28;
/** How quickly a raccoon's legs turn toward where it's going (rad/s). */
const LEGS_OMEGA = 30;
/** Half a raccoon foot's width (m). */
const FOOT_HALF_WIDTH = 0.07;

/**
 * A raccoon's legs and arms as measured off its model (`CharacterView`), so the gait can put
 * its feet, and on all fours its front paws, exactly on the ground. Side view: forward, up.
 */
export interface RigShape {
  /** The hip pivot's height and how far out it sits (m), and the ankle from it. */
  hip: number; hipX: number; ankleZ: number; ankleY: number;
  /** The torso's pivot height (m), the shoulder above it, and the elbow below the shoulder. */
  hips: number; shoulder: number; elbow: number;
  /** The lowest point of a foot below its ankle and of a forearm (with its paw) below its
   * elbow, tipped by an angle: sampled every `RIG_STEP` rad from −π. */
  foot: Float32Array; paw: Float32Array;
}
export const RIG_STEP = 0.05;
/** A shape table's value at angle `a`. */
function lowAt(table: Float32Array, a: number) {
  const f = (wrap(a) + Math.PI) / RIG_STEP, i = Math.floor(f), t = f - i;
  const n = table.length;
  return table[i % n] * (1 - t) + table[(i + 1) % n] * t;
}
/** max(0, x) with the corner rounded off over ±`k` (nothing at all below −k). */
const softPos = (x: number, k = 0.01) => (x <= -k ? 0 : x >= k ? x : ((x + k) * (x + k)) / (4 * k));
/** min(x, m), rounded off the same way: a soft stop instead of a hard one. */
const softMin = (x: number, m: number, k: number) => m - softPos(m - x, k);

export class Animator {
  readonly s = new Springs(N_CH);
  /** What's drawn: the springs plus the gait's cycle. */
  readonly out = new Float32Array(N_CH);
  /** The gait's cycle this frame (added to the springs). */
  private readonly cyc = new Float32Array(N_CH);
  expr: Expr = Expr.Neutral;
  /** Show this face whatever happens (the dev gallery). */
  exprOverride: Expr | null = null;
  /** 0 full, 1 no secondary motion or fidgets (half-rate springs), 2 nothing (far away). */
  lod = 0;
  /** Body tumble angle (ragdoll), read by the view to spin the body about the belly. */
  tumble = 0;
  weapon: number = Weapon.Fists;
  /** Wearing a loot sack: the tail keeps to the side of it (and the head, galloping, off it). */
  sack = false;
  /** Wearing a bandana or a bow tie: galloping, the head stays down, clear of it. */
  collar = false;
  /** The legs and arms measured off the model (raccoons): where the feet and paws reach. */
  rig: RigShape | null = null;

  private time = Math.random() * 10;
  private phase = 0;
  /** A raccoon's gait phase (0..1: one cycle is two steps, or one bound) and its direction. */
  private gp = 0.55;
  private gdir = 1;
  private airT = 0;
  private wasAir = false;
  private fallV = 0;
  private prevPose: Pose = "move";
  private idleT = 0;
  private nextBlink = 1 + Math.random() * 3;
  private blinkT = 0;
  private nextTwitch = 2 + Math.random() * 4;
  private nextLook = 3 + Math.random() * 5;
  private lookT = 0;
  private lookYaw = 0;
  private nextFidget = 8 + Math.random() * 7;
  private fidgetT = 0;
  /** One-shot clip: kind and time left. */
  private clip: AnimEvent | null = null;
  private clipT = 0;
  /** How hard the last stink bomb was thrown (0..1): the follow-through's size. */
  private throwK = 1;
  private flatT = 0;
  private exprT = 0;
  private exprHold: Expr = Expr.Neutral;
  private danceT = 0;
  private lastSlowHalf = false;
  // motion estimates, in the character's frame
  private pvF = 0; private pvL = 0; private pYaw = 0;
  private aF = 0; private aL = 0; private yawRate = 0;
  private hadMotion = false;
  // a raccoon's body going up and down (the jump, the bounce of its steps), for inertia
  private pvUp = 0; private aUp = 0; private bob = 0; private bobV = 0;
  /** Which leg leads a running leap: 1 the left, −1 the right. */
  private lead = 1;
  private galloping = false;
  /** Just shot, slapped or threw (s left): up on the hind legs for it, zoomies or not. */
  private shootHold = 0;
  private started = false;
  /** How firmly the feet are held to the ground: on it at once when grounded, off in the air. */
  private plantW = 1;
  /** How much each front paw bears weight now (galloping): 1 planted, 0 swinging forward. */
  private readonly pawStance = [1, 1];
  /** How far through its swing each front paw is (0 on the ground). */
  private readonly pawSwing = [0, 0];
  /** The chest held up off planted front paws, and each swinging paw's extra tuck: eased
   * (value, speed) so they never jump from one frame to the next. */
  private readonly chest = [0, 0];
  private readonly tuckL = [0, 0];
  private readonly tuckR = [0, 0];
  /** How much of a run (vs a walk) the gait is, eased: its shape changes smoothly at a start. */
  private readonly runS = [0, 0];
  /** How ready the feet are for landing (flat, under the body), from the air pose. */
  private fallReady = 0;
  /** The legs' turn toward where the body's going, last frame (for leading the spring). */
  private legsWas = 0;
  /** How hard a surfer has to balance on its roof this frame: 0 (parked) .. 1 (thrown about). */
  private surfW = 0;
  /** How flat the feet are held: at once on the ground, letting go gently after take-off. */
  private levelW = 1;
  /** Arms free to swing with the gait (not aiming, slapping or throwing): left, right. */
  private armFree = [true, true];
  /** Each leg's lift and foot roll from the gait, this frame. */
  private readonly lift = [0, 0];
  /** How far through its swing each leg is (0 planted, 1 mid-swing). */
  private readonly swingW = [0, 0];
  private readonly roll = [0, 0];
  /** The gait's squash (multiplies bodySY), this frame. */
  private squash = 0;

  constructor(readonly species: Species, readonly role: Role | null) {
    const s = this.s;
    const lag = species === "raccoon" ? 0.045 : 0;
    for (let i = 0; i < N_CH; i++) s.tune(i, 18, 1, lag);
    for (const c of [Ch.torsoRX, Ch.torsoRY, Ch.torsoRZ, Ch.hipsRY, Ch.hipsRZ, Ch.legsRY]) s.tune(c, 12, 1);
    for (const c of [Ch.headRX, Ch.headRY, Ch.headRZ]) s.tune(c, 9, 1);
    for (const c of [Ch.bodySY, Ch.bodySXZ, Ch.bodyY]) s.tune(c, 14, 0.45, 0);
    s.tune(Ch.bodyRX, 9, 0.85);
    s.tune(Ch.bodyRY, 10, 1);
    s.tune(Ch.bodyRZ, 10, 0.7);
    if (species === "raccoon") {
      // floppier, slower ears and a heavier tail that swing on the body's motion and settle
      // after one or two swings (not a buzz)
      for (const c of [Ch.earLRX, Ch.earLRZ, Ch.earRRX, Ch.earRRZ]) s.tune(c, 15, 0.42, 0);
      s.tune(Ch.tail0X, 9, 0.45, 0); s.tune(Ch.tail0Y, 9, 0.45, 0);
      s.tune(Ch.tail1X, 7.5, 0.45, 0); s.tune(Ch.tail1Y, 7.5, 0.45, 0);
      s.tune(Ch.tail2X, 6, 0.45, 0); s.tune(Ch.tail2Y, 6, 0.45, 0);
      for (const c of [Ch.bodySY, Ch.bodySXZ]) s.tune(c, 13, 0.6, 0);
    } else {
      for (const c of [Ch.earLRX, Ch.earLRZ, Ch.earRRX, Ch.earRRZ]) s.tune(c, 22, 0.25);
      s.tune(Ch.tail0X, 11, 0.35); s.tune(Ch.tail0Y, 11, 0.35);
      s.tune(Ch.tail1X, 8, 0.35); s.tune(Ch.tail1Y, 8, 0.35);
      s.tune(Ch.tail2X, 6, 0.35); s.tune(Ch.tail2Y, 6, 0.35);
    }
    s.tune(Ch.gait, 12, 1, 0);
    s.tune(Ch.gallop, 15, 1, 0.03);
    if (species === "raccoon") s.tune(Ch.legsRY, LEGS_OMEGA, 1, 0);
    s.tune(Ch.pace, 20, 1, 0);
    s.tune(Ch.wall, 13, 1, 0);
    s.tune(Ch.wallTurn, 10, 1, 0);
    s.snap(Ch.bodySY, 1);
    s.snap(Ch.bodySXZ, 1);
  }

  private get raccoon() { return this.species === "raccoon"; }

  /** Something happened to this character this frame. `k`: strength (e.g. impact speed). */
  event(kind: AnimEvent, k = 1) {
    const s = this.s;
    switch (kind) {
      case "jump":
        // a raccoon's take-off is read off its own pose (remote players send no event)
        if (this.raccoon) break;
        s.kick(Ch.bodySY, 2.2);
        s.kick(Ch.earLRX, 6); s.kick(Ch.earRRX, 6);
        break;
      case "land": {
        if (this.raccoon) { this.land(k); break; }
        const hit = clamp(k, 0, 16);
        s.kick(Ch.bodySY, -hit * 0.25);
        s.kick(Ch.bodySXZ, hit * 0.12);
        s.kick(Ch.earLRX, hit * 1.2); s.kick(Ch.earRRX, hit * 1.2);
        s.kick(Ch.tail0X, -hit * 0.6);
        break;
      }
      case "fire":
        s.kick(Ch.armRRX, 7);
        s.kick(Ch.torsoRX, -2);
        this.setExpr(Expr.Determined, 0.5);
        this.shootHold = 0.45;
        break;
      case "slap":
      case "throw":
        this.shootHold = 0.45;
        this.clip = kind;
        this.clipT = kind === "slap" ? 0.28 : 0.38;
        if (kind === "throw") {
          // out of the wind-up (`k`: how hard): the arm whips over from behind the head, the
          // body stretches up off its crouch with a little hop, and the tail flicks
          const p = clamp(k, 0, 1);
          this.throwK = p;
          s.snap(Ch.armRRX, Math.min(s.x[Ch.armRRX], -3.1));
          s.kick(Ch.bodySY, 0.8 + 1.4 * p);
          s.kick(Ch.bodyY, 0.3 + 0.7 * p);
          s.kick(Ch.tail0X, -2 - 3 * p);
        }
        this.setExpr(Expr.Mischief, 0.5);
        break;
      case "hop":
        s.kick(Ch.bodyY, 2);
        s.kick(Ch.bodySY, 1.5);
        break;
      case "flatten":
        this.flatT = 1.1;
        this.setExpr(Expr.KO, 1.2);
        break;
      case "hurt":
        s.kick(Ch.torsoRX, -4);
        s.kick(Ch.headRX, -5);
        s.kick(Ch.bodySXZ, 0.8);
        this.setExpr(Expr.Ouch, 0.6);
        break;
      case "pickup":
        s.kick(Ch.bodyY, 1.2);
        this.setExpr(Expr.Happy, 0.8);
        break;
      case "taunt":
        this.clip = "taunt";
        this.clipT = 1.6;
        this.setExpr(Expr.Mischief, 1.6);
        break;
      case "honk":
        s.kick(Ch.armRRX, -5);
        break;
    }
  }

  private setExpr(e: Expr, seconds: number) {
    this.exprHold = e;
    this.exprT = seconds;
  }

  /**
   * A raccoon leaving the ground (the game launches a jump at once, so there's no crouch to
   * show first): it springs up stretched, the legs flicking back off the ground and the arms
   * swinging back before they swing up. The leg that was swinging forward leads the leap.
   */
  private takeoff() {
    const s = this.s, o = this.out;
    s.kick(Ch.bodySY, 1.5);
    s.kick(Ch.bodySXZ, -0.6);
    s.kick(Ch.legLRX, 4); s.kick(Ch.legRRX, 4);
    if (this.armFree[0]) s.kick(Ch.armLRX, 12);
    if (this.armFree[1]) s.kick(Ch.armRRX, 12);
    this.lead = o[Ch.legLRX] < o[Ch.legRRX] ? 1 : -1;
  }

  /**
   * A raccoon touching down at `k` m/s: it squashes as hard as it fell (the legs fold into
   * the hips and the feet stay planted), the head nods, the arms carry on down, then it all
   * springs back with one small overshoot.
   */
  private land(k: number) {
    const s = this.s;
    const hit = clamp(k, 0, 13);
    s.kick(Ch.bodySY, -hit * 0.55);
    s.kick(Ch.bodySXZ, hit * 0.2);
    s.kick(Ch.headRX, hit * 0.3);
    s.kick(Ch.torsoRX, hit * 0.18);
    if (this.armFree[0]) s.kick(Ch.armLRX, hit * 0.45);
    if (this.armFree[1]) s.kick(Ch.armRRX, hit * 0.45);
    if (hit > 11) this.setExpr(Expr.Ouch, 0.45);
  }

  /**
   * Winding up a stink bomb (`w` 0..1), the throw's anticipation: the bottle cocked back
   * behind the head, the throwing shoulder turned away, the other paw out at the target, a
   * crouch to spring out of, tail up and ears back. At full power it trembles with it. The
   * throw (`event("throw")`) whips out of this pose.
   */
  private windupPose(w: number) {
    const T = this.s.t;
    const shake = w >= 1 ? Math.sin(this.time * 47) * 0.05 : 0;
    T[Ch.armRRX] = -2.7 - 0.75 * w + shake;
    T[Ch.armRRY] = 0; T[Ch.armRRZ] = -0.15 * w;
    T[Ch.foreR] = -0.2 - 0.9 * w;
    T[Ch.torsoRY] = -0.5 * w;
    T[Ch.torsoRX] -= 0.15 * w;
    T[Ch.torsoRZ] += shake * 0.6;
    T[Ch.armLRX] = -1.35 * w; T[Ch.armLRZ] = 0.1;
    T[Ch.foreL] = -0.1;
    T[Ch.bodySY] *= 1 - 0.07 * w;
    T[Ch.bodySXZ] *= 1 + 0.035 * w;
    T[Ch.tail0X] += 0.35 * w;
    T[Ch.earLRX] -= 0.35 * w; T[Ch.earRRX] -= 0.35 * w;
  }

  update(dt: number, i: AnimInput) {
    if (i.pose === "hidden") return;
    // On a wall: galloping, with the wall for a floor (the body is tipped onto it whole, so
    // everything below runs as on the ground: the gait, the planted paws, the follow-through),
    // at the crawl's pace, heading the way it crawls (head first, down too: raccoons do).
    const onWall = i.pose === "wall" && this.raccoon;
    let wallTurn = 0;
    if (onWall) {
      const up = i.wallUp ?? 0, side = i.wallSide ?? 0, crawl = Math.hypot(up, side);
      const was = this.s.x[Ch.wallTurn];
      wallTurn = crawl > 0.5 ? was + wrap(Math.atan2(-side, up) - was) : this.s.t[Ch.wallTurn];
      i = { ...i, pose: "move", speed: crawl, vx: undefined, vz: undefined, vy: 0, ride: false, aiming: false, zoomies: true, windup: 0, dance: false };
    } else if (i.pose === "wall") i = { ...i, pose: "move" };
    this.time += dt;
    // a shot with the zoomies: up off all fours, gun out, for a moment (another player's
    // shots only reach us as events, and our own click may be shorter than a frame or two)
    this.shootHold = Math.max(0, this.shootHold - dt);
    if (this.shootHold > 0 && i.zoomies && !i.aiming && this.weapon !== Weapon.Fists) i = { ...i, aiming: true };
    const s = this.s, T = s.t;
    const lod = this.lod;
    const raccoon = this.raccoon;
    this.gdir = 1;
    if (i.pose !== "air") this.fallReady *= Math.exp(-dt / 0.1);

    // ---- motion in the character's own frame (forward/left), and how it changes
    const fx = Math.sin(i.yaw), fz = Math.cos(i.yaw);
    const vx = i.vx ?? fx * i.speed, vz = i.vz ?? fz * i.speed;
    const vF = vx * fx + vz * fz, vL = vx * fz - vz * fx;
    if (!this.hadMotion) { this.pvF = vF; this.pvL = vL; this.pYaw = i.yaw; this.pvUp = i.vy; this.hadMotion = true; }
    const k = 1 - Math.exp(-dt / (this.raccoon ? 0.05 : 0.08)), kr = 1 - Math.exp(-dt / 0.1);
    this.aF += ((vF - this.pvF) / Math.max(dt, 1e-3) - this.aF) * k;
    this.aL += ((vL - this.pvL) / Math.max(dt, 1e-3) - this.aL) * k;
    this.yawRate += (wrap(i.yaw - this.pYaw) / Math.max(dt, 1e-3) - this.yawRate) * kr;
    this.pvF = vF; this.pvL = vL; this.pYaw = i.yaw;
    // up and down: the body's own vertical speed plus the bounce of its steps (a frame late)
    const vUp = i.vy + this.bobV;
    this.aUp += (clamp((vUp - this.pvUp) / Math.max(dt, 1e-3), -400, 400) - this.aUp) * (1 - Math.exp(-dt / 0.04));
    this.pvUp = vUp;

    // ---- base pose
    T.fill(0);
    T[Ch.bodySY] = 1; T[Ch.bodySXZ] = 1;
    T[Ch.foreL] = T[Ch.foreR] = -0.25;
    T[Ch.armLRZ] = 0.1; T[Ch.armRRZ] = -0.1;
    if (raccoon) {
      T[Ch.tail0X] = 0.5; T[Ch.tail1X] = 0.3; T[Ch.tail2X] = 0.2;
      T[Ch.earLRZ] = 0.15; T[Ch.earRRZ] = -0.15;
    }
    if (this.role === "granny") T[Ch.torsoRX] = 0.3;

    const pose = i.pose;
    const fromDown = (this.prevPose === "lying" || this.prevPose === "ragdoll") && pose !== "lying" && pose !== "ragdoll";
    if (fromDown) {
      // getting back up: un-tumble the short way round, then a little hop and wobble
      s.snap(Ch.bodyRX, wrap(s.x[Ch.bodyRX]));
      this.event("hop");
      this.setExpr(Expr.Ouch, 0.5);
    }
    if (pose !== "ragdoll" && this.prevPose === "ragdoll") s.snap(Ch.bodyRX, wrap(this.tumble));
    this.prevPose = pose;

    // arms the gait may swing: not one holding a gun up, or slapping or throwing, nor the paw
    // pointing out a stink bomb's target
    const twoHanded = this.weapon === Weapon.Smg || this.weapon === Weapon.Shotgun;
    const armClip = this.clip === "slap" || this.clip === "throw";
    const windup = (pose === "move" || pose === "air") && !i.panic ? clamp(i.windup ?? 0, 0, 1) : 0;
    this.armFree[0] = !(i.aiming && twoHanded) && !i.panic && windup === 0 && this.clip !== "throw";
    this.armFree[1] = !i.aiming && !armClip && !i.panic;

    const air = pose === "air";
    if (air) { this.airT += dt; this.fallV = Math.min(this.fallV, i.vy); } else this.airT = 0;
    if (raccoon && air && !this.wasAir && i.vy > 2) this.takeoff();
    // landed: squash as hard as we were falling (the fastest fall in the air: the current vy
    // is already 0, and another player's last airborne one may be part-way to it)
    if (!air && this.wasAir && pose === "move") this.event("land", Math.max(0, -this.fallV));
    if (!air) this.fallV = 0;
    this.wasAir = air;

    // galloping on all fours: only with the zoomies (a coffee), at speed, and not while
    // shooting, slapping or throwing; smoothed
    const onFeet = pose === "move" || air;
    const gallops = raccoon && onFeet && !i.ride && !!i.zoomies && !i.aiming && this.shootHold <= 0;
    T[Ch.gallop] = onWall ? 1 : gallops ? smooth(5.4, 6.6, i.speed) : 0;
    T[Ch.wall] = onWall ? 1 : 0;
    T[Ch.wallTurn] = wallTurn;
    T[Ch.gait] = raccoon && pose === "move" ? 1 : 0;
    T[Ch.pace] = raccoon ? i.speed : 0;
    // a new character starts in its state, not blending in from standing (a driver, say)
    const first = !this.started;
    if (first) {
      this.started = true;
      for (const c of [Ch.gait, Ch.gallop, Ch.pace]) s.snap(c, T[c]);
      this.plantW = this.levelW = T[Ch.gait];
      this.runS[0] = smooth(1.5, 4.5, i.speed);
    }
    const g = raccoon ? clamp(s.x[Ch.gallop], 0, 1) : 0;
    if (raccoon && (g > 0.5) !== this.galloping) {
      // dropping onto all fours, or popping back up: a little hop into it
      this.galloping = g > 0.5;
      s.kick(Ch.bodyY, this.galloping ? 0.7 : 0.6);
      // and a crouch into it: squash, then the spring back up
      s.kick(Ch.bodySY, -1.6);
      if (this.galloping) this.setExpr(Expr.Determined, 0.8);
    }
    let expr: Expr = Expr.Neutral;

    switch (pose) {
      case "move": {
        if (i.ride) this.surf(dt, i, g);
        else if (raccoon) this.runPose(dt, i, g);
        else this.walk(dt, i);
        if (i.panic) {
          // arms up and out (clear of a big head and its hat), flailing, running for it
          T[Ch.armLRX] = -2.5 + Math.sin(this.time * 18) * 0.35;
          T[Ch.armRRX] = -2.5 - Math.sin(this.time * 18) * 0.35;
          T[Ch.armLRZ] = 0.85; T[Ch.armRRZ] = -0.85;
          T[Ch.foreL] = T[Ch.foreR] = -0.3;
          T[Ch.headRY] = Math.sin(this.time * 2.2) > 0.6 ? 1.1 : 0; // glancing back
          expr = Expr.Panic;
        }
        if (raccoon && (g > 0.5 || onWall)) expr = Expr.Determined;
        break;
      }
      case "air": {
        if (raccoon) {
          expr = this.airPose(i, g);
        } else if (i.vy > 0) {
          T[Ch.bodySY] = 1.12; T[Ch.bodySXZ] = 0.94;
          T[Ch.armLRX] = -2.4; T[Ch.armRRX] = -2.6; T[Ch.armLRZ] = 0.3; T[Ch.armRRZ] = -0.3;
          T[Ch.legLRX] = -0.5; T[Ch.legRRX] = 0.3;
          T[Ch.tail0X] = -0.2;
        } else if (this.airT > 0.8) {
          // a long fall: flail
          T[Ch.armLRX] = -2 + Math.sin(this.time * 14) * 0.8;
          T[Ch.armRRX] = -2 - Math.sin(this.time * 14) * 0.8;
          T[Ch.armLRZ] = 0.8; T[Ch.armRRZ] = -0.8;
          T[Ch.legLRX] = Math.sin(this.time * 12) * 0.9; T[Ch.legRRX] = -T[Ch.legLRX];
          T[Ch.tail0X] = 0.3; T[Ch.earLRX] = -0.8; T[Ch.earRRX] = -0.8;
          expr = Expr.Panic;
        } else {
          T[Ch.legLRX] = -0.4; T[Ch.legRRX] = -0.2; T[Ch.armLRZ] = 0.5; T[Ch.armRRZ] = -0.5;
        }
        break;
      }
      case "sit": {
        const st = i.steer ?? 0;
        T[Ch.legLRX] = T[Ch.legRRX] = -1.45;
        T[Ch.footL] = T[Ch.footR] = 1.3;
        // paws out on the wheel, at ten to two, one going up and the other down as it turns
        // (a raccoon's short arms reach out straight; people bend their elbows)
        const reach = raccoon ? -1.42 : -1.25;
        T[Ch.armLRX] = reach - 0.3 * st; T[Ch.armRRX] = reach + 0.3 * st;
        T[Ch.armLRZ] = -0.12; T[Ch.armRRZ] = 0.12;
        T[Ch.foreL] = T[Ch.foreR] = raccoon ? -0.1 : -0.2;
        T[Ch.headRY] = 0.35 * st;
        T[Ch.torsoRZ] = clamp(-(i.accL ?? 0) * 0.03, -0.3, 0.3);
        T[Ch.torsoRX] = 0.08 + clamp(-(i.accF ?? 0) * 0.015, -0.25, 0.25);
        // tucked in on the booster seat: ears tipped forward under the roof, tail out to the
        // side (toward the middle of the car), not through the seat back
        T[Ch.earLRX] = 0.4; T[Ch.earRRX] = 0.4;
        T[Ch.tail0Y] = 1.3; T[Ch.tail1Y] = 0.5;
        if (Math.abs(st) > 0.5) expr = Expr.Determined;
        break;
      }
      case "ragdoll": {
        this.tumble += dt * (6 + i.speed * 0.8);
        T[Ch.legLRX] = Math.sin(this.time * 17) * 0.9; T[Ch.legRRX] = -T[Ch.legLRX];
        T[Ch.armLRX] = -1.5 + Math.sin(this.time * 19) * 1.2; T[Ch.armRRX] = -1.5 - Math.sin(this.time * 21) * 1.2;
        T[Ch.armLRZ] = 1.1; T[Ch.armRRZ] = -1.1;
        T[Ch.tail0Y] = Math.sin(this.time * 15) * 0.8; T[Ch.earLRZ] = 0.8; T[Ch.earRRZ] = -0.8;
        T[Ch.bodyY] = 0.15;
        s.snap(Ch.bodyRX, this.tumble);
        T[Ch.bodyRY] = this.tumble * 0.6;
        expr = Expr.Panic;
        break;
      }
      case "lying": {
        this.tumble = 0;
        T[Ch.bodyRX] = -Math.PI / 2;
        T[Ch.legLRZ] = 0.2; T[Ch.legRRZ] = -0.2;
        T[Ch.armLRZ] = 1.2; T[Ch.armRRZ] = -1.2;
        T[Ch.bodyY] = raccoon ? 0.16 : 0.2;
        // chin toward the chest, or the big head sinks into the ground
        T[Ch.headRX] = raccoon ? 0.35 : 0.45;
        // flat on its back the tail would point into the ground: out to the side, lifted a little
        T[Ch.tail0X] = 0.3; T[Ch.tail1X] = 0; T[Ch.tail2X] = 0;
        T[Ch.tail0Y] = -1.45; T[Ch.tail1Y] = 0; T[Ch.tail2Y] = Math.sin(this.time * 3) * 0.15;
        expr = Expr.KO;
        break;
      }
    }

    // ---- upper body: aiming, winding up, slapping, throwing (not while down or driving-bent)
    if ((pose === "move" || pose === "air") && !i.panic) {
      if (windup > 0 && this.clip !== "throw") {
        this.windupPose(windup);
        expr = windup >= 1 ? Expr.Mischief : Expr.Determined;
      } else if (i.aiming) {
        const w = this.weapon;
        T[Ch.armRRX] = -1.57; T[Ch.armRRZ] = 0; T[Ch.armRRY] = 0;
        if (w === Weapon.Smg || w === Weapon.Shotgun) {
          T[Ch.armRRX] = -1.45; T[Ch.armRRY] = 0.15;
          T[Ch.armLRX] = -1.35; T[Ch.armLRZ] = -0.55; T[Ch.foreL] = -0.6;
        }
        if (w === Weapon.Grenade) T[Ch.armRRX] = -2.6;
        T[Ch.foreR] = -0.15;
      }
    }
    if (this.clip) {
      this.clipT -= dt;
      const c = this.clip;
      if (c === "slap") {
        // wind up, then swipe across
        const p = 1 - this.clipT / 0.28;
        const strike = p > 0.4;
        T[Ch.armRRX] = -1.3;
        T[Ch.armRRY] = strike ? 0.9 : -1.1;
        T[Ch.foreR] = strike ? -0.3 : -1.4;
        T[Ch.torsoRY] = strike ? 0.4 : -0.35;
      } else if (c === "throw") {
        // the follow-through: the arm all the way over and down past the hip, the torso pitched
        // forward and turned back the other way, the other paw swung back, eyes after it
        const k = this.throwK;
        T[Ch.armRRX] = 0.15 + 0.35 * k;
        T[Ch.armRRY] = 0; T[Ch.armRRZ] = 0;
        T[Ch.foreR] = -0.1;
        T[Ch.torsoRX] += 0.2 + 0.25 * k;
        T[Ch.torsoRY] = 0.3 * k;
        T[Ch.armLRX] = 0.5 * k;
        T[Ch.headRX] -= 0.15 * k;
      } else if (c === "taunt") {
        // turn round, bend over, wiggle
        T[Ch.bodyRY] = Math.PI;
        T[Ch.torsoRX] = 0.6;
        T[Ch.headRY] = (Math.sin(this.time * 3) > 0 ? 1 : -1) * (this.sack ? 0.7 : 1.2);
        T[Ch.tail0Y] = Math.sin(this.time * 22) * 0.8;
        T[Ch.hipsRZ] = Math.sin(this.time * 22) * 0.2;
      }
      if (this.clipT <= 0) this.clip = null;
    }
    // a slap or a throw snaps (no lag on the arm's target)
    for (const c of [Ch.armRRX, Ch.armRRY, Ch.foreR, Ch.torsoRY]) {
      const quick = this.clip === "slap" || this.clip === "throw";
      s.tune(c, quick ? 30 : c === Ch.torsoRY ? 12 : 18, 1, quick || !raccoon ? 0 : 0.045);
    }

    // ---- dancing (the winner)
    if (i.dance && pose === "move" && i.speed < 1) {
      this.danceT += dt;
      const beat = this.danceT * Math.PI * 2 * 1.25;
      T[Ch.hipsRZ] = Math.sin(beat) * 0.25;
      T[Ch.armLRX] = -2.6 + Math.max(0, Math.sin(beat)) * 0.6;
      T[Ch.armRRX] = -2.6 + Math.max(0, -Math.sin(beat)) * 0.6;
      T[Ch.armLRZ] = 0.5; T[Ch.armRRZ] = -0.5;
      T[Ch.bodyRY] = Math.floor(this.danceT / 1.6) % 2 ? Math.PI * 2 * ((this.danceT % 1.6) / 1.6) : 0;
      T[Ch.tail0Y] = Math.sin(this.danceT * 8 * TAU) * 0.6;
      if (Math.sin(beat) > 0.95 && Math.abs(s.v[Ch.bodyY]) < 0.5) s.kick(Ch.bodyY, 1.6);
      expr = Expr.Happy;
    } else this.danceT = 0;

    // ---- secondary motion (near the camera only)
    if (lod === 0 && pose !== "ragdoll" && pose !== "lying") {
      if (raccoon && onFeet) this.inertia(dt, i, g);
      else {
        T[Ch.torsoRX] += clamp(this.aF * 0.012, -0.2, 0.2);
        const earBack = clamp(0.03 * this.aF + 0.03 * i.speed, 0, 0.9);
        T[Ch.earLRX] += earBack; T[Ch.earRRX] += earBack;
        T[Ch.earLRZ] -= this.yawRate * 0.05; T[Ch.earRRZ] -= this.yawRate * 0.05;
        if (pose !== "sit") T[Ch.tail0Y] += clamp(-this.yawRate * 0.18, -0.6, 0.6);
        T[Ch.tail0X] += clamp(-this.aF * 0.02 + i.vy * 0.04, -0.5, 0.5);
        T[Ch.headRZ] -= T[Ch.hipsRZ] * 0.6;
        T[Ch.headRX] -= T[Ch.torsoRX] * 0.4;
      }
    }

    // ---- idle: breathing, blinks, looking around, fidgets
    // (on a roof that's barely moving: standing there like anywhere else)
    const idle = pose === "move" && !onWall && i.speed < 0.3 && !i.aiming && !(i.ride && this.surfW > 0.15) && !i.dance && !this.clip;
    this.idleT = idle ? this.idleT + dt : 0;
    if (lod === 0) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) { this.blinkT = 0.12; this.nextBlink = Math.random() < 0.2 ? 0.25 : 2 + Math.random() * 4; }
      this.nextTwitch -= dt;
      if (this.nextTwitch <= 0 && raccoon) {
        this.nextTwitch = 3 + Math.random() * 4;
        s.kick(Math.random() < 0.5 ? Ch.earLRZ : Ch.earRRZ, (Math.random() - 0.5) * 18);
      }
    }
    if (this.idleT > 1.5 && lod === 0) {
      T[Ch.bodySY] += Math.sin(this.time * TAU * 0.35) * 0.012;
      T[Ch.tail0Y] += Math.sin(this.time * 1.3) * 0.25;
      this.nextLook -= dt;
      if (this.nextLook <= 0) { this.lookT = 1.1; this.lookYaw = (Math.random() < 0.5 ? -1 : 1) * 0.7; this.nextLook = 4 + Math.random() * 4; }
      if (this.lookT > 0) { this.lookT -= dt; T[Ch.headRY] += this.lookYaw; }
      this.nextFidget -= dt;
      if (this.nextFidget <= 0) { this.fidgetT = 1.2; this.nextFidget = 8 + Math.random() * 7; }
      if (this.fidgetT > 0) {
        this.fidgetT -= dt;
        if (raccoon) {
          // the raccoon paw-rub: scheming
          T[Ch.armLRX] = T[Ch.armRRX] = -0.9;
          T[Ch.foreL] = T[Ch.foreR] = -1.9;
          T[Ch.armLRY] = Math.sin(this.time * 8 * TAU) * 0.25;
          T[Ch.armRRY] = -T[Ch.armLRY];
          T[Ch.armLRZ] = -0.25; T[Ch.armRRZ] = 0.25;
          expr = Expr.Mischief;
        } else {
          // check the time / wipe hands / shake a fist, depending on who they are
          if (this.role === "granny") { T[Ch.armRRX] = -2.6 + Math.sin(this.time * 10) * 0.3; }
          else { T[Ch.armLRX] = -1.2; T[Ch.foreL] = -1.5; T[Ch.headRX] = 0.3; }
        }
      }
    } else { this.fidgetT = 0; this.lookT = 0; }

    // ---- flattened like a pancake (hit by a car): squash, hold, then boing back
    if (this.flatT > 0) {
      this.flatT -= dt;
      const rest = raccoon ? 13 : 14, restZ = raccoon ? 0.6 : 0.45;
      if (this.flatT > 0.45) {
        s.tune(Ch.bodySY, 30, 1); s.tune(Ch.bodySXZ, 30, 1);
        T[Ch.bodySY] = 0.12; T[Ch.bodySXZ] = 1.45;
        T[Ch.bodyRX] = 0; T[Ch.bodyY] = 0;
      } else {
        s.tune(Ch.bodySY, 14, 0.3); s.tune(Ch.bodySXZ, 14, 0.3);
      }
      if (this.flatT <= 0) { s.tune(Ch.bodySY, rest, restZ); s.tune(Ch.bodySXZ, rest, restZ); }
    }

    // ---- a loot sack on the back: the tail keeps to its left, clear of it
    if (this.sack && pose !== "lying") T[Ch.tail0Y] = -1.05 + 0.4 * T[Ch.tail0Y];

    // ---- the face
    if (this.exprT > 0) { this.exprT -= dt; expr = this.exprHold; }
    if (this.blinkT > 0) {
      this.blinkT -= dt;
      if (expr === Expr.Neutral || expr === Expr.Determined) expr = Expr.Blink;
    }
    this.expr = this.exprOverride ?? expr;

    // (and on its very first frame, it's simply in that pose: nothing springs in from zero)
    if (first) for (let c = 0; c < N_CH; c++) s.snap(c, T[c]);

    // ---- integrate (half rate further out)
    if (lod === 1) {
      this.lastSlowHalf = !this.lastSlowHalf;
      if (this.lastSlowHalf) s.step(dt * 2);
    } else if (lod === 0) s.step(dt);
    else {
      // far away: no blending at all, just hold the pose
      for (let c = 0; c < N_CH; c++) { s.x[c] = T[c]; s.v[c] = 0; }
    }

    // ---- what's drawn: the springs, plus the gait's cycle on top
    const o = this.out, C = this.cyc, x = s.x;
    C.fill(0);
    this.squash = 0;
    if (raccoon) this.gait(dt, i);
    for (let c = 0; c < N_CH; c++) o[c] = x[c] + C[c];
    if (raccoon) this.settle(dt);
  }

  /**
   * A raccoon on its feet, the pose under the cycle: leaning into the run, arms out a
   * little, ears swept back and tail streaming; or down on all fours for the gallop.
   */
  private runPose(dt: number, i: AnimInput, g: number) {
    const T = this.s.t;
    const run = smooth(1.5, 4.5, i.speed);
    T[Ch.torsoRX] += 0.12 * run;
    T[Ch.armLRZ] += 0.12 * run; T[Ch.armRRZ] -= 0.12 * run;
    T[Ch.foreL] -= 0.25 * run; T[Ch.foreR] -= 0.25 * run;
    T[Ch.earLRX] -= 0.3 * run; T[Ch.earRRX] -= 0.3 * run;
    T[Ch.tail0X] -= 0.2 * run;
    // the legs step the way the body is going: strafing while it faces its aim, or swinging
    // round to a new heading (backpedalling runs the cycle backwards)
    if (i.speed > (i.aiming ? 0.5 : 1.5) && i.vx !== undefined && i.vz !== undefined) {
      let d = wrap(Math.atan2(i.vx, i.vz) - i.yaw);
      if (i.aiming) {
        // going the other way, aiming: it backpedals
        if (Math.abs(d) > 2) { d = wrap(d + Math.PI); this.gdir = -1; }
      } else {
        // about to turn right round: the legs wait for the body, easing in as it comes round
        d *= smooth(2.6, 1.8, Math.abs(d));
      }
      T[Ch.legsRY] = clamp(d, -1.5, 1.5);
      T[Ch.hipsRY] = T[Ch.legsRY] * 0.4;
    }
    // the legs keep up with a quick turn: aim the spring a little ahead of where they're going
    const legs = T[Ch.legsRY], turning = clamp((legs - this.legsWas) / Math.max(dt, 1e-3), -15, 15);
    this.legsWas = legs;
    T[Ch.legsRY] += (2 / LEGS_OMEGA) * turning;
    if (g > 0) {
      this.allFours(g, 1.25);
      // the front legs hold the ground, pointing straight down whatever the torso does: so
      // standing back up, the paws stay planted until the body is nearly upright over the feet
      const s = this.s;
      const hold = s.v[Ch.gallop] < -0.05 ? smooth(0.1, 0.5, g) : g;
      const down = -T[Ch.torsoRX] - 0.05;
      const mixT = (c: number, v: number) => { T[c] = T[c] * (1 - hold) + v * hold; };
      mixT(Ch.armLRX, down); mixT(Ch.armRRX, down);
      mixT(Ch.armLRZ, 0.08); mixT(Ch.armRRZ, -0.08);
      mixT(Ch.foreL, -0.2); mixT(Ch.foreR, -0.2);
    }
  }

  /** Down on all fours (`g` of the way): torso pitched `pitch` forward, head up to look ahead
   * (unless that would knock it into a sack or bandana), ears back, tail streaming. */
  private allFours(g: number, pitch: number) {
    const T = this.s.t;
    const mixT = (c: number, v: number) => { T[c] = T[c] * (1 - g) + v * g; };
    T[Ch.torsoRX] += pitch * g;
    T[Ch.headRX] -= (this.sack || this.collar ? 0.3 : 0.95) * g;
    T[Ch.earLRX] -= 0.35 * g; T[Ch.earRRX] -= 0.35 * g;
    mixT(Ch.tail0X, 0.1); mixT(Ch.tail1X, 0); mixT(Ch.tail2X, 0.1);
  }

  /**
   * A raccoon in the air, keyed three times: rising (pushed off, stretched, arms flung up),
   * at the top (tucked, arms spread: it hangs there a moment), and falling (stretched,
   * legs reaching down for the ground, arms up). On the run the legs split into a leap; on
   * all fours it flies like a squirrel.
   */
  private airPose(i: AnimInput, g: number): Expr {
    const T = this.s.t;
    const u = clamp(i.vy / JUMP_VELOCITY, -1.3, 1);
    const up = smooth(0, 1, u), down = smooth(0, 1, -u), top = 1 - up - down;
    const key = (rise: number, apex: number, fall: number) => rise * up + apex * top + fall * down;
    const leap = smooth(1.5, 4, i.speed) * (1 - g), still = 1 - leap - g;
    const lead = this.lead;
    // legs: standing jump (tuck), running leap (split), or the squirrel (hind legs back)
    const legStill = [key(0.3, -0.95, -0.15), key(0.45, -0.8, -0.05)];
    const legLead = key(-0.75, -0.7, -0.45), legTrail = key(0.55, 0.35, 0.05);
    const legSq = [key(0.7, 0.55, 0.15), key(0.6, 0.5, 0.2)];
    for (const [side, ch, chY] of [[0, Ch.legLRX, Ch.legLY], [1, Ch.legRRX, Ch.legRY]] as const) {
      const leading = (side === 0) === (lead === 1);
      T[ch] = legStill[side] * still + (leading ? legLead : legTrail) * leap + legSq[side] * g;
      T[chY] = key(-0.02, 0.09, -0.04) * (still + leap) + key(-0.02, 0.0, -0.02) * g;
    }
    // arms: flung up, spread at the top, up and out falling; a leap swings them opposite
    // the legs; the squirrel reaches ahead (from a torso pitched forward)
    if (this.armFree[0] || this.armFree[1]) {
      const armUp = key(-2.7, -1.4, -2.6), armOut = key(0.35, 1.4, 0.95);
      const armLead = key(0.45, 0.3, 0.1), armTrail = key(-2.2, -1.9, -1.6);
      const armSq = key(-2.1, -2.1, -1.75);
      for (const [side, ch, chZ, fore] of [[0, Ch.armLRX, Ch.armLRZ, Ch.foreL], [1, Ch.armRRX, Ch.armRRZ, Ch.foreR]] as const) {
        if (!this.armFree[side]) continue;
        const leading = (side === 0) === (lead === 1);
        T[ch] = armUp * still + (leading ? armLead : armTrail) * leap + armSq * g;
        T[chZ] = (side === 0 ? 1 : -1) * (armOut * (still + leap * 0.5) + key(0.5, 0.8, 0.55) * g);
        T[fore] = key(-0.25, -0.6, -0.3);
      }
    }
    // arched back going up, curled at the top, the head looking up, then down at the landing;
    // on all fours it stays stretched out flat (a flying squirrel, arms reaching ahead)
    T[Ch.torsoRX] += key(-0.15, 0.15, 0) * (1 - g);
    if (g > 0) this.allFours(g, key(1.3, 1.05, 1.2));
    T[Ch.headRX] += key(-0.2, -0.05, 0.22);
    T[Ch.bodyRX] += key(-0.15, -0.05, 0.12) * g;
    T[Ch.bodySY] = key(1.22, 0.94, 1.1);
    T[Ch.bodySXZ] = 1 / Math.sqrt(T[Ch.bodySY]);
    T[Ch.tail0X] = key(0.2, 0.45, 0.5) * (1 - g) + key(0.0, 0.2, 0.3) * g;
    // a long way down: arms windmill, legs pedal
    const flail = smooth(0.7, 1.0, this.airT) * smooth(-1.05, -1.25, u);
    if (flail > 0) {
      const t = this.time;
      const mixT = (c: number, v: number) => { T[c] = T[c] * (1 - flail) + v * flail; };
      if (this.armFree[0]) { mixT(Ch.armLRX, -2 + Math.sin(t * 11) * 0.6); mixT(Ch.armLRZ, 0.8); }
      if (this.armFree[1]) { mixT(Ch.armRRX, -2 - Math.sin(t * 11) * 0.6); mixT(Ch.armRRZ, -0.8); }
      mixT(Ch.legLRX, Math.sin(t * 10) * 0.6); mixT(Ch.legRRX, -Math.sin(t * 10) * 0.6);
      return flail > 0.5 ? Expr.Panic : Expr.Happy;
    }
    this.fallReady = down;
    return this.airT > 0.1 ? Expr.Happy : Expr.Neutral;
  }

  /**
   * The cycle on top of the springs: the run on two legs or the bound on four, by the gait
   * phase. Every curve is a smooth function of the phase (cosines and smooth humps), so each
   * swing eases into its extremes and nothing snaps.
   */
  private gait(dt: number, i: AnimInput) {
    const C = this.cyc, x = this.s.x;
    const w = clamp(x[Ch.gait], 0, 1), g = clamp(x[Ch.gallop], 0, 1);
    this.lift[0] = this.lift[1] = this.roll[0] = this.roll[1] = this.swingW[0] = this.swingW[1] = 0;
    const prevBob = this.bob;
    this.bob = 0;
    this.pawStance[0] = this.pawStance[1] = 1;
    this.pawSwing[0] = this.pawSwing[1] = 0;
    // the speed the legs step at: the body's, eased (a start winds up over a few frames)
    const v = Math.max(0, x[Ch.pace]);
    const amp = smooth(0.15, 2.6, v);
    // cadence: cycles a second (two steps on two legs, one bound on four)
    const fRun = 1.2 + 0.34 * v, fGal = 0.9 + 0.25 * v;
    if (amp < 0.02) {
      // standing: the next start begins with the left foot leaving the ground
      this.gp = 0.3;
    } else {
      this.gp = frac(this.gp + dt * mix(fRun, fGal, g) * this.gdir);
    }
    if (w > 1e-3 && amp > 0) {
      const p = this.gp;
      const run = ease(this.runS, smooth(1.5, 4.5, v), dt, 12);
      // ---- on two legs
      const wb = w * (1 - g) * amp;
      if (wb > 1e-3) {
        // a quick, bouncy run: short stances (a little hop each step), long sweeps of the leg
        // centred a bit behind the hip (it lands under the body and pushes off far back)
        const D = mix(0.5, 0.24, run);             // stance: the foot's share of the cycle on the ground
        const half = (v * D) / (2 * fRun);         // how far the hip passes the planted foot, each way
        const H = 0.025 + 0.022 * run;             // swing foot lift (m)
        const B = 0.01 + 0.018 * run;              // bounce (m)
        // the body is lowest mid-stance (squashed: the leg folds) and highest mid-flight
        const pUp = mix(0.25, 0.375, run), pDown = pUp - 0.25;
        for (const [side, q0, ch] of [[0, 0, Ch.legLRX], [1, 0.5, Ch.legRRX]] as const) {
          const q = frac(p + q0);
          C[ch] -= w * (1 - g) * legAngle(q, D, half, LEG_PIVOT);
          this.lift[side] += wb * H * footLift(q, D);
          this.swingW[side] += w * (1 - g) * midSwing(q, D);
          this.roll[side] += wb * footRoll(q, D);
        }
        // down after each contact, up at the push-off; squashed at the bottom, stretched off it
        // (gently: the squash scales the big head as well)
        this.bob += wb * B * Math.cos(2 * TAU * (p - pUp));
        this.squash += wb * (-(0.025 + 0.035 * run) * hump(p, pDown, 0.13, 0.5) + (0.015 + 0.025 * run) * hump(p, pUp - 0.04, 0.12, 0.5));
        // the ears flop out and back on each landing, a beat after it
        const flop = wb * Math.cos(2 * TAU * (p - pDown - 0.07));
        C[Ch.earLRZ] -= 0.14 * flop; C[Ch.earRRZ] += 0.14 * flop;
        C[Ch.earLRX] -= 0.08 * flop; C[Ch.earRRX] -= 0.08 * flop;
        // weight over the stance leg (a waddle), the head kept level
        const waddle = wb * (0.1 - 0.05 * run) * Math.cos(TAU * (p - D / 2));
        C[Ch.hipsRZ] -= waddle;
        C[Ch.headRZ] += 0.6 * waddle;
        // hips turn with the legs, shoulders against them, the head looking ahead
        const legL = Math.cos(TAU * (p - 0.02));
        C[Ch.hipsRY] -= wb * 0.12 * legL;
        C[Ch.torsoRY] += wb * 0.19 * legL;
        C[Ch.headRY] -= wb * 0.07 * legL;
        // arms swing against the legs (a beat behind them), elbows bending as they come forward
        const Aa = 0.3 + 0.45 * run, arm = Math.cos(TAU * (p - 0.05));
        if (this.armFree[0]) {
          C[Ch.armLRX] += wb * Aa * arm;
          C[Ch.foreL] -= wb * 0.55 * run * (0.5 - 0.5 * Math.cos(TAU * (p - 0.1)));
          C[Ch.armLRZ] += wb * 0.06 * Math.cos(2 * TAU * (p - pUp - 0.06));
        }
        if (this.armFree[1]) {
          C[Ch.armRRX] -= wb * Aa * arm;
          C[Ch.foreR] -= wb * 0.55 * run * (0.5 - 0.5 * Math.cos(TAU * (p - 0.6)));
          C[Ch.armRRZ] -= wb * 0.06 * Math.cos(2 * TAU * (p - pUp - 0.06));
        }
        // the torso nods into each step; the head less
        const nod = wb * 0.04 * Math.cos(2 * TAU * (p - pDown - 0.03));
        C[Ch.torsoRX] += nod;
        C[Ch.headRX] -= 0.5 * nod;
        // the tail swings with the hips, the wave running down it (less beside a sack)
        const sway = wb * (this.sack ? 0.35 : 1);
        C[Ch.tail0Y] += sway * 0.2 * Math.sin(TAU * (p - 0.08));
        C[Ch.tail1Y] += sway * 0.16 * Math.sin(TAU * (p - 0.15));
        C[Ch.tail2Y] += sway * 0.14 * Math.sin(TAU * (p - 0.22));
      }
      // ---- on all fours: a bound (hind legs nearly together, then the front paws)
      const wg = w * g * amp;
      if (wg > 1e-3) {
        // hind legs: planted like the run's, from a crouched hip
        const half = (v * 0.15) / (2 * fGal);
        for (const [side, q0, ch] of [[0, 0, Ch.legLRX], [1, 0.06, Ch.legRRX]] as const) {
          const q = frac(p + q0);
          C[ch] -= w * g * legAngle(q, 0.15, half, LEG_PIVOT);
          this.lift[side] += wg * 0.06 * footLift(q, 0.15);
          this.roll[side] += wg * footRoll(q, 0.15);
          this.swingW[side] += w * g * midSwing(q, 0.15);
        }
        // front legs the same way, from the shoulder (the base pose points them straight down)
        const halfF = (v * 0.14) / (2 * fGal);
        // standing back up, the front legs stop striding at once and just hold the ground
        const rising = this.s.v[Ch.gallop] < -0.05;
        const wf = wg * (rising ? smooth(0.6, 0.95, g) : 1);
        for (const [side, q0, ch, fore] of [[0, 0.47, Ch.armLRX, Ch.foreL], [1, 0.54, Ch.armRRX, Ch.foreR]] as const) {
          const q = frac(p + q0);
          C[ch] -= wf * legAngle(q, 0.14, halfF, 0.45, 0.2);
          // the paw tucks up as it comes forward, and bears no weight till it's down again
          // the paw folds up off the ground as the leg starts forward, then reaches down again;
          // the chest stays held up on it until it's clear
          const u = q < 0.14 ? 0 : (q - 0.14) / 0.86;
          const up = q < 0.14 ? 0 : smooth(0, 0.16, u) * smooth(0, 0.3, 1 - u);
          C[fore] -= wf * 0.75 * up;
          this.pawStance[side] = rising || q < 0.14 ? 1 : 1 - smooth(0.1, 0.35, u);
          this.pawSwing[side] = u;
        }
        // the back gathers (curls) before the hind feet land and stretches out after the
        // push-off; the body rocks nose-down onto the front paws; the head stays level
        const flex = wg * 0.2 * Math.cos(TAU * (p - 0.93));
        const rock = wg * 0.09 * Math.cos(TAU * (p - 0.6));
        C[Ch.torsoRX] += flex;
        C[Ch.bodyRX] += rock;
        C[Ch.headRX] -= 0.7 * (flex + rock);
        this.bob += wg * (0.045 * Math.cos(TAU * (p - 0.4)) + 0.012 * Math.cos(2 * TAU * (p - 0.4)));
        this.squash += wg * (-0.05 * hump(p, 0.52, 0.12) + 0.03 * hump(p, 0.36, 0.1));
        // the tail waves behind, the wave running down it
        C[Ch.tail0X] += wg * 0.22 * Math.cos(TAU * (p - 0.5));
        C[Ch.tail1X] += wg * 0.2 * Math.cos(TAU * (p - 0.62));
        C[Ch.tail2X] += wg * 0.18 * Math.cos(TAU * (p - 0.74));
      }
    }
    // down on all fours the chest sinks so the front paws reach the ground (the hind legs fold)
    this.bob -= 0.04 * w * g;
    C[Ch.bodyY] += this.bob;
    this.bobV = dt > 0 ? (this.bob - prevBob) / dt : 0;
  }

  /**
   * After the cycle: squash keeps the volume, the stance foot stays planted (the leg slides
   * into the hips or reaches out of them for the bounce and the swing of the hip) with its
   * sole flat on the ground, the swing foot lifts and rolls. And the clearances: the tail
   * left of a sack, the head off a sack or bandana while galloping.
   */
  private settle(dt: number) {
    const o = this.out, x = this.s.x;
    const w = clamp(x[Ch.gait], 0, 1);
    if (this.squash !== 0) {
      o[Ch.bodySY] = x[Ch.bodySY] * (1 + this.squash);
      o[Ch.bodySXZ] = x[Ch.bodySXZ] / Math.sqrt(1 + this.squash);
    }
    const rig = this.rig;
    // feet go down on the ground the moment it's touched (the cycle's weight takes longer)
    const onGround = this.s.t[Ch.gait] > 0.5;
    this.plantW += ((onGround ? 1 : 0) - this.plantW) * (1 - Math.exp(-dt / 0.02));
    this.levelW = onGround ? 1 : this.levelW * Math.exp(-dt / 0.1);
    const pw = this.plantW;
    if ((w > 1e-3 || pw > 1e-3) && rig) {
      const sy = Math.max(0.3, o[Ch.bodySY]), sxz = o[Ch.bodySXZ];
      const b = o[Ch.bodyRX], cb = Math.cos(b), sb = Math.sin(b);
      const g = clamp(x[Ch.gallop], 0, 1);
      // Side-view forward kinematics, relative to the ground under the character: a point
      // (forward z, up y) of the body's own frame lands at bodyY + rotated(scaled(point)).
      const worldY = (z: number, y: number) => sy * y * cb - sxz * z * sb;
      if (g > 0) {
        // on all fours: the front paws hold the chest up (it rises rather than push them into
        // the ground; the hind legs then reach down to keep their feet planted)
        const t = o[Ch.torsoRX];
        const pawLow = (arm: number, fore: number) => {
          const a = t + o[arm];
          const ez = rig.shoulder * Math.sin(t) + rig.elbow * Math.sin(a);
          const ey = rig.hips + rig.shoulder * Math.cos(t) + rig.elbow * Math.cos(a);
          return worldY(ez, ey) + sy * lowAt(rig.paw, a + o[fore] + b);
        };
        // only a paw that's down bears weight (a swinging one must not drag along the ground)
        const paws = [[Ch.armLRX, Ch.foreL], [Ch.armRRX, Ch.foreR]] as const;
        let lift = 0;
        paws.forEach(([arm, fore], k) => {
          lift = Math.max(lift, softPos(x[Ch.bodyY] - (o[Ch.bodyY] + pawLow(arm, fore))) * this.pawStance[k]);
        });
        // eased (it mustn't jump), but never letting a planted paw sink more than a centimetre
        const want = lift * w * g;
        lift = ease(this.chest, want, dt, 30);
        lift += softPos(want - lift - 0.01, 0.01);
        o[Ch.bodyY] += lift;
        this.bob += lift;
        // and a swinging paw tucks up further rather than scrape the ground (only early in the
        // swing, while it's still low: later it's up by the chin)
        paws.forEach(([arm, fore], k) => {
          const swing = 1 - this.pawStance[k];
          const gap = o[Ch.bodyY] + pawLow(arm, fore) - x[Ch.bodyY];
          const early = 1 - smooth(0.3, 0.6, this.pawSwing[k]);
          const want = swing > 0 ? clamp((0.04 * swing - gap) / 0.2, 0, 0.4) * w * g * early : 0;
          o[fore] -= ease(k === 0 ? this.tuckL : this.tuckR, want, dt, 30);
        });
      }
      // (a roll of the whole body, leaning into a turn, lifts one foot and lowers the other)
      const roll = Math.sin(o[Ch.bodyRZ]) * sxz;
      const legSin = Math.sin(o[Ch.legsRY]), legCos = Math.cos(o[Ch.legsRY]);
      for (const [side, rx, rz, ly, foot] of [[0, Ch.legLRX, Ch.legLRZ, Ch.legLY, Ch.footL], [1, Ch.legRRX, Ch.legRRZ, Ch.legRY, Ch.footR]] as const) {
        // the sole flat on the ground (the body's pitch too) or rolling through the step
        const level = Math.max(this.levelW, this.fallReady);
        o[foot] = x[foot] * (1 - level) - level * (o[rx] + b) + w * this.roll[side];
        // where the foot's lowest point is with the leg where it is: slide the leg so it's on
        // the ground (bodyY's own springs, a hop say, still lift the feet), then add the lift
        const th = o[rx], down = rig.ankleY * Math.cos(o[rz]);
        const az = down * Math.sin(th) + rig.ankleZ * Math.cos(th), ay = down * Math.cos(th) - rig.ankleZ * Math.sin(th);
        // (the legs may be turned toward where the body's going: the ankle's forward and
        // sideways place in the body's frame, for its pitch and its roll)
        const hx = side === 0 ? rig.hipX : -rig.hipX;
        const fwd = -hx * legSin + az * legCos, out = hx * legCos + az * legSin;
        // (and a foot tipped sideways with the body's roll dips its outer edge, half its width)
        const low = o[Ch.bodyY] + worldY(fwd, rig.hip + ay) + sy * lowAt(rig.foot, th + o[foot] + b * legCos) + out * roll - FOOT_HALF_WIDTH * Math.abs(roll);
        const plant = (x[Ch.bodyY] - low) / (sy * cb);
        // in the swing the leg needn't reach down to the ground: it only ever shortens (tucks)
        let slide = x[ly] * (1 - pw) + pw * plant + w * this.lift[side];
        slide += this.swingW[side] * softPos(-slide, 0.02);
        // and the hips let a leg in or out only so far, easing to a stop
        o[ly] = softMin(LEG_OUT + softPos(slide - LEG_OUT, 0.02), LEG_IN, 0.02);
      }
    }
    // the tail: softly clear of a sack, and never curled up into the back or the head (the
    // further it's swung round to the side, the lower it has to stay)
    if (this.sack) {
      // (the sack turns with the torso; a tail hanging low has to swing further out round it)
      const clear = -0.82 + o[Ch.torsoRY] - 0.3 * (1 - smooth(0.1, 0.5, o[Ch.tail0X]));
      o[Ch.tail0Y] = softMin(o[Ch.tail0Y], clear, 0.06);
      o[Ch.tail1Y] = softMin(o[Ch.tail1Y], -0.05, 0.1);
    }
    o[Ch.tail0Y] = -softMin(-softMin(o[Ch.tail0Y], 1.25, 0.2), 1.25, 0.2);
    const sideways = smooth(0.4, 1.2, Math.abs(o[Ch.tail0Y]));
    const c1 = softMin(o[Ch.tail0X], 0.85 - 0.3 * sideways, 0.18);
    const c2 = softMin(c1 + o[Ch.tail1X], 1.2 - 0.35 * sideways, 0.18);
    const c3 = softMin(c2 + o[Ch.tail2X], 1.45 - 0.4 * sideways, 0.18);
    o[Ch.tail0X] = c1; o[Ch.tail1X] = c2 - c1; o[Ch.tail2X] = c3 - c2;
    // galloping in a sack or bandana, the head never tips back past where it's held, into it
    const g = clamp(x[Ch.gallop], 0, 1);
    if (g > 0 && (this.sack || this.collar)) o[Ch.headRX] = Math.max(o[Ch.headRX], o[Ch.headRX] * (1 - g) - 0.28 * g);
  }

  /**
   * What hangs off a raccoon trails its body: ears, tail, head and free arms are pushed the
   * other way whenever the body speeds up, slows down, turns or bounces (landing presses them
   * down, falling lets them float up), then spring back. Plus leaning into turns, head first.
   */
  private inertia(dt: number, i: AnimInput, g: number) {
    const s = this.s, T = s.t;
    // the platform under a surfer shoves it about too
    let platF = 0, platL = 0;
    if (i.ride) {
      const fx = Math.sin(i.yaw), fz = Math.cos(i.yaw), ax = i.platAx ?? 0, az = i.platAz ?? 0;
      platF = ax * fx + az * fz; platL = ax * fz - az * fx;
    }
    const aF = clamp(this.aF + platF, -60, 60), aL = clamp(this.aL + platL, -40, 40);
    // > 0: pressed down (landing, launching, the bottom of a bounce); < 0: floating (falling)
    const load = clamp(this.aUp, -40, 40);
    const k = (ch: number, a: number) => s.kick(ch, a * dt);
    k(Ch.earLRX, -1.6 * load - 1.2 * aF); k(Ch.earRRX, -1.6 * load - 1.2 * aF);
    k(Ch.earLRZ, -2 * load + 1.5 * aL); k(Ch.earRRZ, 2 * load + 1.5 * aL);
    k(Ch.tail0X, -0.8 * load - 0.8 * aF); k(Ch.tail1X, -0.6 * load - 0.6 * aF); k(Ch.tail2X, -0.5 * load - 0.5 * aF);
    k(Ch.tail0Y, 1.2 * aL); k(Ch.tail1Y, 0.9 * aL);
    k(Ch.headRX, 0.35 * load - 0.25 * aF);
    const loose = 1 - smooth(0, 0.3, g);
    if (this.armFree[0]) { k(Ch.armLRX, 0.6 * aF * loose); k(Ch.armLRZ, -0.8 * load * loose); }
    if (this.armFree[1]) { k(Ch.armRRX, 0.6 * aF * loose); k(Ch.armRRZ, 0.8 * load * loose); }
    // lean into speeding up, back to brake; into turns, the head leading
    T[Ch.torsoRX] += clamp(this.aF * 0.012, -0.2, 0.2);
    T[Ch.bodyRZ] += clamp(-0.003 * i.speed * this.yawRate, -0.2, 0.2);
    T[Ch.headRY] += clamp(0.035 * this.yawRate, -0.35, 0.35);
    T[Ch.headRZ] -= T[Ch.hipsRZ] * 0.6;
    T[Ch.headRX] -= T[Ch.torsoRX] * 0.4 * (1 - g);
  }

  /** Walking and running (people). */
  private walk(dt: number, i: AnimInput) {
    const T = this.s.t;
    const speed = i.speed;
    const amp = clamp(speed / 5, 0, 1);
    const role = this.role;
    const f = (1.2 + 0.25 * speed) * (role === "kid" ? 1.3 : role === "granny" ? 0.8 : 1) * (i.panic ? 1.3 : 1);
    this.phase += dt * TAU * f;
    const sn = Math.sin(this.phase), cs = Math.cos(this.phase);
    const bob = role === "jogger" ? 0.07 : 0.035;
    // the walk
    T[Ch.legLRX] = -0.55 * sn * amp;
    T[Ch.legRRX] = 0.55 * sn * amp;
    T[Ch.footL] = -0.6 * T[Ch.legLRX] + 0.25 * Math.max(0, cs) * amp;
    T[Ch.footR] = -0.6 * T[Ch.legRRX] + 0.25 * Math.max(0, -cs) * amp;
    T[Ch.hipsRZ] = 0.05 * sn * amp; // the waddle
    T[Ch.bodyY] = bob * Math.abs(cs) * amp;
    T[Ch.armLRX] = 0.4 * sn * amp;
    T[Ch.armRRX] = -0.4 * sn * amp;
    T[Ch.foreL] = T[Ch.foreR] = -0.35 - 0.25 * amp;
    T[Ch.torsoRX] += 0.1 * Math.min(1, speed / 8);
    T[Ch.torsoRY] = 0.15 * sn * amp;
    T[Ch.tail0Y] = -0.25 * sn * amp;
    // strafing: the legs follow the velocity when the body faces the aim
    if (i.aiming && speed > 0.5 && i.vx !== undefined && i.vz !== undefined) {
      let d = wrap(Math.atan2(i.vx, i.vz) - i.yaw);
      if (Math.abs(d) > 2) { d = wrap(d + Math.PI); this.phase -= 2 * dt * TAU * f; } // backpedal
      T[Ch.legsRY] = clamp(d, -1, 1);
      T[Ch.hipsRY] = T[Ch.legsRY] * 0.5;
    }
  }

  /**
   * On a roof (a car or a train): standing or walking about as on the ground, then surfing it
   * as hard as the ride makes it. Parked, nothing; cruising, feet a little apart and arms out
   * for balance; thrown about (braking, speeding up, a corner), legs wide and arms right out,
   * swaying with it, and flailing when it's rough.
   */
  private surf(dt: number, i: AnimInput, g: number) {
    const T = this.s.t;
    if (this.raccoon) this.runPose(dt, i, g); else this.walk(dt, i);
    // the platform's acceleration in the character's frame
    const fx = Math.sin(i.yaw), fz = Math.cos(i.yaw);
    const ax = i.platAx ?? 0, az = i.platAz ?? 0, acc = Math.hypot(ax, az);
    const aF = ax * fx + az * fz, aL = ax * fz - az * fx;
    const w = Math.max(0.43 * smooth(0.5, 6, i.platSpeed ?? 0), smooth(2.5, 7, acc));
    this.surfW = w;
    T[Ch.legLRZ] += 0.35 * w; T[Ch.legRRZ] -= 0.35 * w;
    T[Ch.armLRZ] = mix(T[Ch.armLRZ], 1.2, w); T[Ch.armRRZ] = mix(T[Ch.armRRZ], -1.2, w);
    T[Ch.bodyY] -= 0.01 * w;
    T[Ch.torsoRZ] += clamp(-aL * 0.04, -0.5, 0.5);
    T[Ch.torsoRX] += clamp(aF * 0.03, -0.35, 0.35);
    T[Ch.tail0Y] += clamp(-aL * 0.06, -0.8, 0.8);
    if (acc > 7) {
      // hold on!
      T[Ch.armLRX] = Math.sin(this.time * 16) * 1.4;
      T[Ch.armRRX] = -Math.sin(this.time * 16) * 1.4;
    }
  }
}
