/**
 * The shared, deterministic player step. The server runs it once per received
 * input; the client reconciler runs it to predict, and again to replay unacked
 * inputs on every reconcile. It must be a pure function of:
 *
 *   (player state, input frame, ctx.dt, ctx.time, the static map, memoised world reads)
 *
 * `ctx.time` is the input's reckon stamp (integer ms), identical on both sides, so
 * trains — which are a pure function of time — are predicted exactly. Moving cars
 * are NOT a function of time: what the step reads about them goes through
 * `world.cars()` which the client freezes per step with `ctx.memo` (what the player
 * saw on screen) and the server answers from the lag-compensated rewind view of
 * that same player (`rewind.lastSeenBy`). Same view, same answer.
 */
import {
  CAR_BRAKE, CAR_BRAKE_FRONT, CAR_COAST, CAR_COUNTER, CAR_COUNTER_FROM, CAR_HANDBRAKE_DRAG, CAR_HANDBRAKE_GRIP, CAR_SPIN_GRIP, CAR_HIT_SPIN, CAR_LOAD_SHIFT, CAR_LONG_SHARE,
  CAR_MU_FRONT, CAR_MU_REAR, CAR_REVERSE_HOLD, CAR_REVERSE_SPEED, CAR_SLIP_PEAK, CAR_SLIP_REF, CAR_STEER_FALL, CAR_STEER_MAX,
  CAR_STEER_MIN, CAR_STEER_RETURN, CAR_STEER_WIND, CAR_SUBSTEPS, CAR_TYRE_TAIL, CAR_TYPES, CAR_YAW_DAMP, CarLight, GRAVITY, JUMP_VELOCITY, Mode,
  PLAYER_RADIUS, RUN_SPEED, TRAIN_ROOF, WALK_SPEED, Weapon, WEAPONS, MAP_HALF, ticks, GRENADE_RADIUS, GRENADE_THROW_UP,
  GRENADE_CHARGE_STEPS, GRENADE_FUSE_MS, GRENADE_MAX_DIST, GRENADE_MIN_DIST,
  ROOF_LAND_EDGE, TRAIN_AIR_REACH, TRAIN_BRIDGE, TRAIN_CARS, TRAIN_COUPLE_HYST, TRAIN_DISMOUNT_PUSH, TRAIN_EDGE, TRAIN_HIT_SPEED,
  BIN_HOP_SPEED, BIN_HOP_UP, CLIMB_PUSH, CLIMB_REACH, CLIMB_SETTLE, PICKUP_ZOOMIES, ZOOMIES_MS, ZOOMIES_SPEED, POLE_KNOCK_LOSS, POLE_KNOCK_SPEED, POLE_R,
  CAR_ENTER_Y, COYOTE_STEPS, NPC_HIT_R, RUN_OVER_CLOSING, RUN_OVER_LOSS, RUN_OVER_SPEED, FALL_DAZE, FALL_DAZE_H, LEDGE_IN, LEDGE_REACH, PLAYER_HEIGHT, STEP_UP,
  WALL_KICK_OUT, WALL_KICK_SETTLE, WALL_KICK_UP, WALL_PUSH, WALL_SPEED, WALL_STICK, WALL_TOP_REACH,
  GULL_ACCEL, GULL_CEIL, GULL_CLEAR, GULL_CLIMB, GULL_DIVE, GULL_POOP_S, GULL_R, GULL_SNATCH_DOWN, GULL_SPEED, MANHOLE_FALL_R, MANHOLE_REACH,
  SEWER_ACCEL, SEWER_AIR_MIN_S, SEWER_AIR_REFILL, SEWER_AIR_S, SEWER_GASP_DAZE, SEWER_POP_SPEED, SEWER_POP_UP, SEWER_SETTLE, SEWER_SPEED, SEWER_Y,
  TICK_RATE,
} from "./constants.js";
import {
  BIN_R, CITY, ceilingAbove, collideBody, collideCircle, circleObb, groundHeight, newContacts, onRamp, type BinSpot, type XZ,
} from "./map.js";
import { lineAt } from "./geom.js";
import { MANHOLES, nextPipe, SEWER, type ManholeSpot } from "./sewer.js";
import { carLocalZ, LOCO_OBSTACLES, onTrainRoof, trackDistance, trainCarPose, trainU, TRAIN_SLOTS, type CarPose } from "./train.js";
import { AIM_Q } from "./hitscan.js";

// ---------------------------------------------------------------- shapes
export interface PlayerSim {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  mode: number;
  veh: number;
  lx: number; ly: number; lz: number;
  /** Facing relative to the platform while riding a roof (world `yaw` is kept in step). */
  lyaw: number;
  steer: number; yawRate: number;
  grounded: boolean;
  weapon: number;
  ammo1: number; ammo2: number; ammo3: number; ammo4: number;
  cd: number;
  timer: number;
  /** Steps of the zoomies left (a coffee): faster on foot, and facing where you run. */
  zoomies: number;
  /** Steps a stink bomb has been wound up (0: not winding up); see `stepWeapon`. */
  charge: number;
  /** Steps left in which a jump still works after walking off an edge (see `stepFoot`). */
  coyote: number;
  /**
   * Sewer air breathed: SEWER_AIR_REFILL a step down there, aired out one a step up top. At
   * `SEWER_AIR` the breath is used up (see `stepSewer`); a dive needs SEWER_AIR_MIN_S of it left.
   */
  stench: number;
}

export interface InputLike {
  mx: number; mz: number; throttle: number; steer: number; aim: number;
  fire: boolean; jump: boolean; sprint: boolean; use: boolean; weapon: number;
  /** G (or LT) held: winding up a stink bomb, whatever you hold. */
  nade?: boolean;
  /** How far up a shot flies (1/AIM_Q rad; see `PlayerInput.pitch`): a Blunderbuss blast kicks back along it. */
  pitch?: number;
}

export interface SimCtx {
  /** Fixed step in seconds. */
  dt: number;
  /** Reckon stamp of this input (room ms): trains are evaluated here. */
  time: number;
  /** Freeze a value per step: live step computes, replays get the frozen value. */
  memo<T>(key: string, compute: () => T): T | undefined;
  /** Out: the key of the loot can this step emptied, or "" (written by `stepPlayer`). */
  picked?: string;
  /**
   * Out: the launch of the stink bomb this step let go of, or null (written by `stepPlayer`).
   * The server throws exactly this; the client predicts exactly this.
   */
  thrown?: GrenadeLike | null;
  /**
   * The round hasn't started for this input (its stamp is before GO): you can look
   * around, but not move, shoot or grab anything. Physics still runs.
   */
  frozen?: boolean;
  /**
   * Out: the lamp posts this step's car knocked over, or null (written by `stepPlayer`). The
   * server lays exactly these down; the driver's client predicts exactly these.
   */
  knocked?: PoleKnock[] | null;
  /**
   * Out: the townsfolk this step's car ran over, or null (written by `stepPlayer`). The server
   * launches exactly these, from where the driver saw them; the driver's client predicts them.
   */
  runOver?: RunOver[] | null;
  /** Out: the manhole this step dove down or climbed out of (index into `MANHOLES`), or -1. */
  hole?: number;
  /** Out: the manholes this step's sewer run passed under or stopped at, in order, or null (they rattle). */
  rattled?: number[] | null;
  /** Out: a gull's dropping let go of this step, or null: where from, how fast. */
  poop?: GrenadeLike | null;
  /** Out: the loot a gull snatched this step (its `pickups` key), or "". */
  snatched?: string;
  /** Out: the loot a gull let go of this step (what `kind`), where from and how fast, or null. */
  dropped?: (GrenadeLike & { kind: number }) | null;
}

/** A lamp post knocked over: which one (index into `CITY.poles`), and which way it falls (`poleFall`). */
export interface PoleKnock { i: number; fall: number }

/**
 * A townsperson a driven car ran over: who (their `npcs` key), where they were, and their launch.
 * `at`: when in the step the car reached them, as a fraction of it (0 < at <= 1). They take off
 * then: `at` of a step after the input's stamp (a car is drawn reaching them then, too).
 */
export interface RunOver { key: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; at: number }

/** A townsperson a car can hit (walking, fleeing or lying KO), where the acting player saw them. */
export interface SeenNpc { key: string; x: number; y: number; z: number }

/** A car as the acting player saw it. */
export interface SeenCar extends CarPose {
  id: number;
  kind: number;
  /** Someone (player or AI) is at the wheel. */
  driven: boolean;
  /** A burnt-out wreck: solid, but nobody gets in or rides it. */
  wreck: boolean;
}

/** A loot can the acting player can empty. */
export interface SeenPickup { id: string; kind: number }

export interface WorldView {
  /** Cars within `r` of (x, z), as the acting player saw them. */
  cars(x: number, z: number, r: number): SeenCar[];
  /** A specific car, or null when it no longer exists. */
  car(id: number): SeenCar | null;
  /** The type index of car `id` (never changes for an id). */
  carKind(id: number): number;
  /** A full loot can within grabbing reach of (x, y, z), if any. */
  pickup(x: number, y: number, z: number): SeenPickup | null;
  /**
   * The trash can (index into `CITY.bins`) a raccoon at (x, y, z) can dive into, or -1: the
   * nearest within reach, if its lid is on and nobody (the acting player knows of) is in it.
   */
  bin(x: number, y: number, z: number): number;
  /** The lamp posts still standing within `r` of (x, z), as the acting player knows of them (indices into `CITY.poles`). */
  poles(x: number, z: number, r: number): number[];
  /**
   * The townsfolk a car can hit within `r` of (x, z), where the acting player saw them at `time`
   * (the input's reckon stamp: the client reckons them forward to it, the server rewinds to it).
   */
  npcs(x: number, z: number, r: number, time: number): SeenNpc[];
  /** The manhole whose cover is nearest (x, z) within `r` (index into `MANHOLES`), and whether its lid is off; or null. */
  manhole(x: number, z: number, r: number): SeenManhole | null;
  /** Loot a gull at (x, y, z) can snatch (in reach of its feet, and nobody carrying it), or null. */
  snatch(x: number, y: number, z: number): SeenPickup | null;
}

/** A manhole near the acting player: which one, and whether its lid is off (then walking onto it drops you in). */
export interface SeenManhole { i: number; open: boolean }

/**
 * The golden dumpster (see `GarbageDay`) is solid and you can stand on it: `WorldView.cars` lists it
 * with this id, as a wreck (nobody drives it or rides it), so the step needs nothing new for it.
 */
export const CRATE_ID = -2;

// ---------------------------------------------------------------- events
export const EV_JUMP = 1;
export const EV_LAND = 2;
export const EV_FIRE = 4;
export const EV_THROW = 8;
export const EV_ENTER = 16;
export const EV_EXIT = 32;
export const EV_TRAIN_HIT = 64;
/** Jumped into the side of a car or a train and climbed up onto its roof. */
export const EV_CLIMB = 128;
export const EV_CRASH = 256;
export const EV_ROOF_LAND = 512;
export const EV_FALL_OFF = 1024;
export const EV_PUNCH = 2048;
export const EV_PICKUP = 4096;
/** A train rider walked or jumped over a coupling onto the next car (`veh` changed). */
export const EV_COUPLE = 8192;
/** Dove into a trash can (`veh` = which one). */
export const EV_HIDE = 16384;
/** Hopped back out of one (on our own: E, Space or a shot). */
export const EV_UNHIDE = 32768;
/** Landed from a fall high enough to daze you (`Mode.Knocked` for FALL_DAZE). */
export const EV_DAZE = 65536;
/** Ran into a wall with the zoomies and stuck to it (`Mode.Wall`). */
export const EV_WALL = 131072;
/** Down a manhole, into the sewer (`ctx.hole`: which one): dove in, or fell into an open one. */
export const EV_SEWER = 1 << 18;
/** Climbed back out of the sewer (`ctx.hole`: where). */
export const EV_UNSEWER = 1 << 19;
/** Stopped under a manhole down in the sewer. */
export const EV_ARRIVE = 1 << 20;
/** A gull let go of a dropping (`ctx.poop`). */
export const EV_POOP = 1 << 21;
/** A gull snatched loot (`ctx.snatched`), or let go of what it carried (`ctx.dropped`). */
export const EV_SNATCH = 1 << 22;
export const EV_DROP = 1 << 23;

// ---------------------------------------------------------------- helpers
export const wrapAngle = (a: number) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Is a loot can at (x, y, z) within grabbing reach of `p`? */
export function inPickupReach(p: { x: number; y: number; z: number }, x: number, y: number, z: number) {
  return (p.x - x) ** 2 + (p.z - z) ** 2 <= 1.5 * 1.5 && Math.abs(p.y - y) <= 1.6;
}

/**
 * Round every float field to float32, the precision it travels at. Done at both ends
 * of the step, so the server continues from exactly the numbers a client adopts on
 * reconcile, and near-ties (`grounded`, `y <= support`) resolve the same way.
 */
function commitFloat32(p: PlayerSim) {
  const f = Math.fround;
  p.x = f(p.x); p.y = f(p.y); p.z = f(p.z);
  p.vx = f(p.vx); p.vy = f(p.vy); p.vz = f(p.vz);
  p.yaw = f(p.yaw); p.lyaw = f(p.lyaw);
  p.lx = f(p.lx); p.ly = f(p.ly); p.lz = f(p.lz);
  p.steer = f(p.steer); p.yawRate = f(p.yawRate);
}

export function getAmmo(p: PlayerSim, w: number): number {
  switch (w) {
    case Weapon.Pistol: return p.ammo1;
    case Weapon.Smg: return p.ammo2;
    case Weapon.Shotgun: return p.ammo3;
    case Weapon.Grenade: return p.ammo4;
    default: return Infinity;
  }
}

export function addAmmo(p: PlayerSim, w: number, n: number) {
  switch (w) {
    case Weapon.Pistol: p.ammo1 = Math.max(0, Math.min(999, p.ammo1 + n)); break;
    case Weapon.Smg: p.ammo2 = Math.max(0, Math.min(999, p.ammo2 + n)); break;
    case Weapon.Shotgun: p.ammo3 = Math.max(0, Math.min(999, p.ammo3 + n)); break;
    case Weapon.Grenade: p.ammo4 = Math.max(0, Math.min(99, p.ammo4 + n)); break;
  }
}

/** Local (platform frame) → world. Local +Z = platform forward, +X = its left. */
export function localToWorld(pl: { x: number; z: number; yaw: number }, lx: number, lz: number, out: XZ): XZ {
  const c = Math.cos(pl.yaw), s = Math.sin(pl.yaw);
  out.x = pl.x + lx * c + lz * s;
  out.z = pl.z - lx * s + lz * c;
  return out;
}

/** World → local (platform frame). */
export function worldToLocal(pl: { x: number; z: number; yaw: number }, x: number, z: number, out: XZ): XZ {
  const c = Math.cos(pl.yaw), s = Math.sin(pl.yaw);
  const dx = x - pl.x, dz = z - pl.z;
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}

const _xz: XZ = { x: 0, z: 0 };
const _n: XZ & { depth: number } = { x: 0, z: 0, depth: 0 };
/** Off the rails by more than this (m), no train car is close enough to matter (a car's centre is within 0.5 m of the line). */
const NEAR_TRACK = 12;
const _train: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };

/** The car whose roof a `Mode.Roof` rider stands on (trains: see `stepTrain`). */
export function platformOf(p: PlayerSim, world: WorldView, out: CarPose): CarPose | null {
  const c = world.car(p.veh);
  if (!c) return null;
  out.x = c.x; out.z = c.z; out.yaw = c.yaw; out.vx = c.vx; out.vz = c.vz;
  out.halfL = c.halfL; out.halfW = c.halfW; out.roof = c.roof;
  return out;
}

const _pl: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };

// ---------------------------------------------------------------- main step
const _frozen: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0, nade: false };

/** The input with everything but looking around (aim, weapon choice) switched off. */
function freezeInput(cmd: InputLike): InputLike {
  _frozen.aim = cmd.aim;
  _frozen.weapon = cmd.weapon;
  return _frozen;
}

/** Advance one player by one input. Returns a bitmask of EV_* events. */
export function stepPlayer(ctx: SimCtx, p: PlayerSim, cmd: InputLike, world: WorldView): number {
  let ev = 0;
  ctx.picked = "";
  ctx.thrown = null;
  ctx.knocked = null;
  ctx.runOver = null;
  ctx.hole = -1;
  ctx.rattled = null;
  ctx.poop = null;
  ctx.snatched = "";
  ctx.dropped = null;
  if (ctx.frozen) cmd = freezeInput(cmd);
  commitFloat32(p);
  // the zoomies wear off (and don't outlive you)
  if (p.zoomies > 0) p.zoomies = p.mode === Mode.Dead || p.mode === Mode.Gull ? 0 : p.zoomies - 1;
  // breath: used up down the sewer, caught again (slowly) up top
  if (p.mode === Mode.Sewer) p.stench = Math.min(SEWER_AIR, p.stench + SEWER_AIR_REFILL);
  else if (p.stench > 0) p.stench = p.mode === Mode.Dead || p.mode === Mode.Gull ? 0 : p.stench - 1;
  switch (p.mode) {
    case Mode.Foot: ev |= stepFoot(ctx, p, cmd, world, true); break;
    case Mode.Knocked:
    case Mode.Dead: ev |= stepFoot(ctx, p, cmd, world, false); break;
    case Mode.Driving: ev |= stepDriving(ctx, p, cmd, world); break;
    case Mode.Roof: ev |= stepRiding(ctx, p, cmd, world); break;
    case Mode.Train: ev |= stepTrain(ctx, p, cmd); break;
    case Mode.Hidden: ev |= stepHidden(ctx, p, cmd); break;
    case Mode.Wall: ev |= stepWall(ctx, p, cmd); break;
    case Mode.Sewer: ev |= stepSewer(ctx, p, cmd); break;
    // (a gull's cooldown is its dropping's: it carries no gun)
    case Mode.Gull: ev |= stepGull(ctx, p, cmd, world); commitFloat32(p); return ev;
  }
  // (in a trash can you can still pick a weapon: a click has already popped you out to use it;
  // on a wall the paws are busy holding on; down the sewer it's all fours)
  if (p.mode !== Mode.Dead && p.mode !== Mode.Knocked && p.mode !== Mode.Wall && p.mode !== Mode.Sewer) ev |= stepWeapon(ctx, p, cmd);
  else {
    if (p.cd > 0) p.cd--;
    // knocked over mid-wind-up: the throw is lost (the stink bomb isn't)
    p.charge = 0;
  }
  // loot cans (weapons, snacks and coffee): grabbed by anyone not dead, behind the wheel, in a
  // trash can or down the sewer. After the weapon step, so the new gun is out this step and the
  // next input already asks for it. A snack changes nothing here: the server heals (hp isn't part
  // of the step). A coffee starts the zoomies here, since they change how you move.
  if (p.mode !== Mode.Dead && p.mode !== Mode.Driving && p.mode !== Mode.Hidden && p.mode !== Mode.Sewer && !ctx.frozen) {
    const pk = ctx.memo("pickup", () => world.pickup(p.x, p.y, p.z));
    if (pk) {
      if (pk.kind <= Weapon.Grenade) {
        addAmmo(p, pk.kind, WEAPONS[pk.kind].pickupAmmo);
        // (not mid-wind-up: putting the stink bomb away would let go of it)
        if (p.charge === 0 && (pk.kind !== Weapon.Grenade || p.weapon === Weapon.Fists)) p.weapon = pk.kind;
      } else if (pk.kind === PICKUP_ZOOMIES) {
        p.zoomies = ticks(ZOOMIES_MS / 1000);
      }
      ctx.picked = pk.id;
      ev |= EV_PICKUP;
    }
  }
  commitFloat32(p);
  return ev;
}

// ---------------------------------------------------------------- weapons
/** Is a wind-up being held: G, or the click with the stink bomb out? */
const windingUp = (p: PlayerSim, cmd: InputLike) => !!cmd.nade || (cmd.fire && p.weapon === Weapon.Grenade);

/**
 * Guns, the slap and the stink bomb. A stink bomb is wound up, not fired: holding G (or the
 * click, with it out) winds it up a step at a time (`charge`, full power at
 * GRENADE_CHARGE_STEPS, where it holds), and letting go throws it as far as it was wound up.
 * Letting go is always the first input that isn't held, so whenever the client and the server
 * both throw, they throw on the same input: the client's predicted throw is keyed by it. While
 * winding up nothing else fires and the weapon doesn't change.
 */
function stepWeapon(ctx: SimCtx, p: PlayerSim, cmd: InputLike): number {
  if (p.cd > 0) p.cd--;
  if (p.charge > 0) {
    // frozen for a new round, ducked into a trash can, out of stink bombs: the wind-up is lost
    if (ctx.frozen || p.mode === Mode.Hidden || p.ammo4 <= 0) { p.charge = 0; return 0; }
    if (windingUp(p, cmd)) {
      if (p.charge < GRENADE_CHARGE_STEPS) p.charge++;
      return 0;
    }
    // let go: throw it
    const power = p.charge / GRENADE_CHARGE_STEPS;
    p.charge = 0;
    addAmmo(p, Weapon.Grenade, -1);
    p.cd = WEAPONS[Weapon.Grenade].cooldown;
    ctx.thrown = grenadeLaunch(p, cmd.aim, power);
    return EV_THROW;
  }
  const want = cmd.weapon;
  if (want !== p.weapon && want <= Weapon.Grenade && getAmmo(p, want) > 0) p.weapon = want;
  if (getAmmo(p, p.weapon) <= 0) {
    // out of ammo: fall back to the best thing we still carry
    p.weapon = p.ammo2 > 0 ? Weapon.Smg : p.ammo3 > 0 ? Weapon.Shotgun : p.ammo1 > 0 ? Weapon.Pistol : Weapon.Fists;
  }
  if (p.cd > 0) return 0;
  // start winding one up (with the stink bomb out, that's all a click does)
  if (windingUp(p, cmd) && p.ammo4 > 0 && p.mode !== Mode.Hidden) {
    p.charge = 1;
    return 0;
  }
  if (!cmd.fire || p.weapon === Weapon.Grenade) return 0;
  if (p.mode === Mode.Driving && p.weapon === Weapon.Fists) return 0;
  p.cd = WEAPONS[p.weapon].cooldown;
  if (p.weapon === Weapon.Fists) return EV_PUNCH;
  addAmmo(p, p.weapon, -1);
  if (p.weapon === Weapon.Shotgun && p.mode === Mode.Foot) blastKick(p, cmd);
  return EV_FIRE;
}

/** The Blunderbuss's kick (m/s): back along the shot, and (fired down, in the air) up, up to BLAST_LIFT. */
export const BLAST_KICK = 11, BLAST_LIFT = 7;

/**
 * A Blunderbuss blast kicks its raccoon back: in the step, so it's predicted and nothing about it
 * is sent. On the ground the feet soon take it (a skid of ~0.3 m); in the air it carries further,
 * and a blast down holds you up a moment: a hop, never more than a jump, so not a way up walls.
 */
function blastKick(p: PlayerSim, cmd: InputLike) {
  const pitch = (cmd.pitch ?? 0) / AIM_Q;
  const back = BLAST_KICK * Math.cos(pitch);
  p.vx -= Math.sin(cmd.aim) * back;
  p.vz -= Math.cos(cmd.aim) * back;
  if (!p.grounded && pitch < 0) p.vy = Math.min(Math.max(p.vy, 0) + BLAST_LIFT * -Math.sin(pitch), BLAST_LIFT);
}

// ---------------------------------------------------------------- on foot
function turnToward(p: PlayerSim, target: number, maxStep: number) {
  const d = wrapAngle(target - p.yaw);
  p.yaw += clamp(d, -maxStep, maxStep);
}

/** Same, for the facing relative to a platform. */
function turnLocalToward(p: PlayerSim, target: number, maxStep: number) {
  const d = wrapAngle(target - p.lyaw);
  p.lyaw += clamp(d, -maxStep, maxStep);
}

function stepFoot(ctx: SimCtx, p: PlayerSim, cmd: InputLike, world: WorldView, control: boolean): number {
  let ev = 0;
  const dt = ctx.dt;

  if (control) {
    let mx = cmd.mx / 100, mz = cmd.mz / 100;
    // just climbed a ledge (`timer`: steps left finding our feet): the stick doesn't move us yet,
    // and the jump that got us up there (still held, or buffered) doesn't hop us straight off
    const settling = p.timer > 0;
    if (settling) { p.timer--; mx = 0; mz = 0; }
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const speed = p.zoomies > 0 ? ZOOMIES_SPEED : cmd.sprint ? RUN_SPEED : WALK_SPEED;
    const k = Math.min(1, (p.grounded ? 16 : 5) * dt);
    p.vx += (mx * speed - p.vx) * k;
    p.vz += (mz * speed - p.vz) * k;

    // holding a gun, you face the mouse; with the zoomies you face where you gallop, until you
    // shoot. Winding up a stink bomb (and letting go: `charge` is still up), you face the mouse.
    if (cmd.fire || cmd.nade || p.charge > 0 || (p.weapon !== Weapon.Fists && !(p.zoomies > 0))) turnToward(p, cmd.aim, 20 * dt);
    else if (ml > 0.1) turnToward(p, Math.atan2(mx, mz), 14 * dt);

    // on the ground, or a moment after walking off an edge (not on the way up: no double jump)
    if (cmd.jump && !settling && (p.grounded || (p.coyote > 0 && p.vy <= 0))) {
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      p.coyote = 0;
      ev |= EV_JUMP;
    }
  } else {
    // ragdoll: friction on the ground, tumble in the air
    if (p.grounded) {
      const f = Math.max(0, 1 - 6 * dt);
      p.vx *= f; p.vz *= f;
    }
    p.yaw += (Math.abs(p.vx) + Math.abs(p.vz)) * 0.15 * dt;
    if (p.mode === Mode.Knocked) {
      if (p.timer > 0) p.timer--;
      if (p.timer === 0 && p.grounded) p.mode = Mode.Foot;
    }
  }

  p.vy -= GRAVITY * dt;
  const prevY = p.y;
  p.x += p.vx * dt;
  p.z += p.vz * dt;
  p.y += p.vy * dt;
  // The higher of where the feet were and are: falling fast past a roof's edge in one step, a
  // body is over the roof, not inside the building (else it would tunnel down through it).
  const yq = Math.max(prevY, p.y);

  // static walls (in the air, remember them: one might be a ledge to climb; with the zoomies, on
  // the ground too: one might be a wall to crawl up, so how fast we ran at it counts)
  const ledges = control && (!p.grounded || p.zoomies > 0) ? _contacts : undefined;
  const runVx = p.vx, runVz = p.vz;
  if (collideBody(p, p.y, yq, PLAYER_RADIUS, PLAYER_HEIGHT, _xz, ledges)) {
    const nl = Math.hypot(_xz.x, _xz.z);
    if (nl > 0) {
      const nx = _xz.x / nl, nz = _xz.z / nl;
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) {
        const bounce = control ? 1 : 1.5;
        p.vx -= vn * nx * bounce; p.vz -= vn * nz * bounce;
      }
    }
  }

  // jumping up into a floating slab (a landing, a plank): bonk
  if (p.vy > 0) {
    const ceil = ceilingAbove(p.x, p.z, prevY + PLAYER_HEIGHT - 0.05);
    if (p.y + PLAYER_HEIGHT > ceil) { p.y = ceil - PLAYER_HEIGHT; p.vy = 0; }
  }

  // cars: solid bodies with walkable roofs (as seen by this player). A roof only holds
  // you while your centre is over it, short of the edge a rider drops off at: landing
  // and falling off can't then undo each other step after step.
  let support = groundHeight(p.x, p.z, yq);
  let landedOn: SeenCar | null = null;
  // In the air, pushing into a side whose roof is within reach: grab it and climb up (there's
  // no button for it). _n points from the side toward us.
  const grabs = (roof: number) => control && !p.grounded && roof - p.y <= CLIMB_REACH
    && (cmd.mx * _n.x + cmd.mz * _n.z) / 100 < -CLIMB_PUSH;
  let grabCar: SeenCar | null = null;
  const cars = ctx.memo("cars", () => world.cars(p.x, p.z, 5)) ?? [];
  for (const c of cars) {
    if (!circleObb(p.x, p.z, PLAYER_RADIUS, c.x, c.z, c.yaw, c.halfW, c.halfL, _n)) continue;
    if (yq >= c.roof - 0.25) {
      // above the roof: it's a floor (and a ride, unless it's a wreck)
      if (c.roof > support && overRoof(c, p.x, p.z, ROOF_LAND_EDGE)) { support = c.roof; landedOn = c.wreck ? null : c; }
    } else {
      if (!grabCar && !c.wreck && grabs(c.roof)) grabCar = c;
      p.x += _n.x * _n.depth;
      p.z += _n.z * _n.depth;
      const vn = p.vx * _n.x + p.vz * _n.z;
      if (vn < 0) { p.vx -= vn * _n.x; p.vz -= vn * _n.z; }
    }
  }

  // trains: deterministic, evaluated at this input's timestamp. Their roofs are floors
  // like car roofs; their sides shove you aside, and only a car moving into you runs you over.
  let trainSlot = -1, grabSlot = -1;
  const nearTrack = Math.abs(trackDistance(p.x, p.z)) < NEAR_TRACK;
  for (let slot = 0; nearTrack && slot < TRAIN_SLOTS; slot++) {
    const t = trainCarPose(slot, ctx.time, _train);
    const dx = p.x - t.x, dz = p.z - t.z;
    if (dx * dx + dz * dz > 60) continue;
    if (!circleObb(p.x, p.z, PLAYER_RADIUS, t.x, t.z, t.yaw, t.halfW, t.halfL, _n)) continue;
    if (yq >= t.roof - 0.3) {
      if (control && t.roof > support && onTrainRoof(slot, t, p.x, p.z)) { support = t.roof; trainSlot = slot; landedOn = null; }
    } else if (p.mode !== Mode.Dead) {
      // _n points from the car toward us: how fast is it coming at us? (Getting away from it
      // counts; running or jumping into its side doesn't: that's how you climb aboard.)
      const closing = t.vx * _n.x + t.vz * _n.z - Math.max(0, p.vx * _n.x + p.vz * _n.z);
      if (closing > TRAIN_HIT_SPEED) {
        // run over by a train
        p.mode = Mode.Knocked;
        p.timer = ticks(1.6);
        p.vx = t.vx * 1.2 + _n.x * 7;
        p.vz = t.vz * 1.2 + _n.z * 7;
        p.vy = 10;
        p.grounded = false;
        p.y = Math.max(p.y, 0.2);
        return ev | EV_TRAIN_HIT;
      }
      if (grabSlot < 0 && grabs(t.roof)) grabSlot = slot;
      // brushed by its side: pushed out, and no slower than the car along its normal
      p.x += _n.x * _n.depth;
      p.z += _n.z * _n.depth;
      const vn = (p.vx - t.vx) * _n.x + (p.vz - t.vz) * _n.z;
      if (vn < 0) { p.vx -= vn * _n.x; p.vz -= vn * _n.z; }
    }
  }

  // jumped into a side and grabbed the roof: up onto it, a little way in from the rim
  if (grabCar) {
    worldToLocal(grabCar, p.x, p.z, _xz);
    enterRide(p, Mode.Roof, grabCar.id, clamp(_xz.x, -grabCar.halfW * 0.6, grabCar.halfW * 0.6), grabCar.roof,
      clamp(_xz.z, -grabCar.halfL * 0.5, grabCar.halfL * 0.5), grabCar.yaw);
    p.timer = ticks(CLIMB_SETTLE);
    return ev | EV_CLIMB;
  }
  if (grabSlot >= 0) {
    const t = trainCarPose(grabSlot, ctx.time, _train);
    worldToLocal(t, p.x, p.z, _xz);
    enterRide(p, Mode.Train, grabSlot, clamp(_xz.x, -0.8, 0.8), t.roof, trainU(grabSlot, clamp(_xz.z, -t.halfL + 0.6, t.halfL - 0.6)), t.yaw);
    p.timer = ticks(CLIMB_SETTLE);
    return ev | EV_CLIMB;
  }
  // ...or a ledge: a wall, a roof's edge, a stair's side
  if (ledges && !p.grounded && ledges.n > 0 && p.y > support && ledgeGrab(p, cmd)) return ev | EV_CLIMB;
  // ...or, with the zoomies, a wall to crawl up
  if (ledges && ledges.n > 0 && p.zoomies > 0 && p.timer === 0 && p.charge === 0 && wallGrab(p, cmd, runVx, runVz)) {
    if (p.y < support) p.y = support;
    return ev | EV_WALL;
  }

  if (p.y <= support) {
    if (!p.grounded && prevY > support + 0.25) ev |= EV_LAND;
    const impact = -p.vy;
    p.y = support;
    // a hard landing on the ground (not a car's or a train's roof): dazed for a moment
    if (control && !landedOn && trainSlot < 0 && impact >= FALL_DAZE_VY) {
      p.mode = Mode.Knocked;
      p.timer = ticks(FALL_DAZE);
      p.vy = 0;
      p.vx *= 0.3; p.vz *= 0.3;
      p.grounded = true;
      p.coyote = 0;
      return ev | EV_DAZE;
    }
    if (p.vy < 0) p.vy = control ? 0 : -p.vy * 0.35;
    if (Math.abs(p.vy) < 1.5) { p.vy = 0; p.grounded = true; } else p.grounded = false;
    if (landedOn && control) {
      worldToLocal(landedOn, p.x, p.z, _xz);
      enterRide(p, Mode.Roof, landedOn.id, _xz.x, landedOn.roof, _xz.z, landedOn.yaw);
      return ev | EV_ROOF_LAND;
    }
    if (trainSlot >= 0) {
      // landed on a train roof: ride it, in train coordinates
      const t = trainCarPose(trainSlot, ctx.time, _train);
      worldToLocal(t, p.x, p.z, _xz);
      enterRide(p, Mode.Train, trainSlot, _xz.x, t.roof, trainU(trainSlot, _xz.z), t.yaw);
      return ev | EV_ROOF_LAND;
    }
  } else if (p.grounded && p.y - support < 0.3 && p.vy <= 0) {
    // stick to slopes and small steps down
    p.y = support;
    p.vy = 0;
  } else {
    p.grounded = false;
  }
  p.coyote = p.grounded ? COYOTE_STEPS : Math.max(0, p.coyote - 1);

  if (!control) return ev;

  // walked onto a manhole whose lid is off: down you go (out of breath, you step over it)
  if (p.grounded && p.y < 0.3 && !ctx.frozen && canDive(p)) {
    const hole = ctx.memo("hole", () => world.manhole(p.x, p.z, MANHOLE_FALL_R));
    if (hole?.open) return ev | intoSewer(ctx, p, hole.i);
  }

  // enter / steal a car (roofs take no button: a jump gets you up there); only from about
  // street level, not from a roof's edge over it
  if (cmd.use) {
    const target = p.y < CAR_ENTER_Y ? ctx.memo("useCar", () => nearestCar(world, p.x, p.z, 1.4)) : null;
    // …or dive into a trash can, if it's nearer than the car (not with a stink bomb wound up:
    // still held, it would hop you straight back out)
    const i = ctx.memo("bin", () => world.bin(p.x, p.y, p.z)) ?? -1;
    const b = CITY.bins[i];
    // …or down a manhole (from the street, with the breath for it), if that's nearer still
    const mh = p.y < 0.6 && canDive(p) ? ctx.memo("manhole", () => world.manhole(p.x, p.z, MANHOLE_REACH)) : null;
    const carGap = target ? obbGap(target, p.x, p.z) : Infinity;
    const binGap = b ? Math.hypot(p.x - b.x, p.z - b.z) - BIN_R : Infinity;
    const holeGap = mh ? Math.hypot(p.x - MANHOLES[mh.i].x, p.z - MANHOLES[mh.i].z) : Infinity;
    if (mh && p.charge === 0 && holeGap < binGap && holeGap < carGap) return ev | intoSewer(ctx, p, mh.i);
    if (b && p.charge === 0 && !(target && carGap < binGap)) {
      p.mode = Mode.Hidden;
      p.veh = i;
      p.x = b.x; p.z = b.z; p.y = b.y;
      p.vx = 0; p.vy = 0; p.vz = 0;
      p.grounded = true;
      p.coyote = 0;
      return ev | EV_HIDE;
    }
    if (target) {
      p.mode = Mode.Driving;
      p.veh = target.id;
      p.x = target.x; p.z = target.z; p.y = 0;
      p.vx = target.vx; p.vz = target.vz; p.vy = 0;
      p.yaw = p.yaw + wrapAngle(target.yaw - p.yaw);
      p.steer = 0; p.yawRate = 0; p.timer = 0;
      p.grounded = true;
      p.coyote = 0;
      return ev | EV_ENTER;
    }
  }
  return ev;
}

const FALL_DAZE_VY = Math.sqrt(2 * GRAVITY * FALL_DAZE_H);
const _contacts = newContacts();
const _q: XZ = { x: 0, z: 0 };

/**
 * In the air, pushing into a wall whose top is within reach (LEDGE_REACH over the feet, and
 * more than a step): grab it and climb up, onto a real floor just inside its edge with room to
 * stand. The walls are the ones this step's `collideBody` touched (`_contacts`). Crawling up a
 * wall (`stepWall`) climbs over its top the same way, from nearer it and pushing up less hard.
 */
function ledgeGrab(p: PlayerSim, cmd: InputLike, reach = LEDGE_REACH, push = CLIMB_PUSH): boolean {
  for (let k = 0; k < _contacts.n; k++) {
    if (!_contacts.grab[k]) continue;
    const top = _contacts.top[k], rise = top - p.y;
    if (rise <= STEP_UP || rise > reach) continue;
    // the way out points at us: pushing into the wall is against it
    const nx = _contacts.nx[k], nz = _contacts.nz[k];
    if ((cmd.mx * nx + cmd.mz * nz) / 100 >= -push) continue;
    // where we'd stand: our circle's width in from the edge we touch
    const qx = p.x - nx * (PLAYER_RADIUS + LEDGE_IN), qz = p.z - nz * (PLAYER_RADIUS + LEDGE_IN);
    const floor = groundHeight(qx, qz, top + 0.2);
    if (Math.abs(floor - top) > 0.25) continue; // a wall's thin top, a sign: nothing to stand on
    _q.x = qx; _q.z = qz;
    if (collideBody(_q, floor, floor, PLAYER_RADIUS, PLAYER_HEIGHT)) continue; // no room up there
    if (ceilingAbove(qx, qz, floor) < floor + PLAYER_HEIGHT) continue;
    p.mode = Mode.Foot;
    p.veh = -1;
    p.x = qx; p.z = qz; p.y = floor;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.grounded = true;
    p.coyote = 0;
    p.timer = ticks(CLIMB_SETTLE);
    return true;
  }
  return false;
}

/** Steps after sticking to a wall that Space doesn't kick off it yet (a tap buffered on the way in). */
const WALL_GRIP_STEPS = ticks(0.15);

/**
 * With the zoomies, running squarely into a wall (one this step's `collideBody` touched, pushing
 * into it at least WALL_PUSH): stick to it. The run carries on up it (`runVx/Vz`: our velocity
 * before the wall stopped us), and along it.
 */
function wallGrab(p: PlayerSim, cmd: InputLike, runVx: number, runVz: number): boolean {
  const mx = cmd.mx / 100, mz = cmd.mz / 100;
  let best = -1, push = -WALL_PUSH;
  for (let k = 0; k < _contacts.n; k++) {
    if (!_contacts.grab[k]) continue;
    const d = mx * _contacts.nx[k] + mz * _contacts.nz[k];
    if (d < push) { push = d; best = k; }
  }
  if (best < 0) return false;
  const nx = _contacts.nx[best], nz = _contacts.nz[best];
  const tx = nz, tz = -nx;
  const vt = clamp(runVx * tx + runVz * tz, -WALL_SPEED, WALL_SPEED);
  p.mode = Mode.Wall;
  p.veh = -1;
  p.lyaw = p.lx = Math.atan2(nx, nz);
  p.yaw += wrapAngle(Math.atan2(-nx, -nz) - p.yaw);
  p.vx = tx * vt; p.vz = tz * vt;
  p.vy = clamp(Math.max(p.vy, -(runVx * nx + runVz * nz)), 0, WALL_SPEED);
  p.grounded = false;
  p.coyote = 0;
  p.timer = WALL_GRIP_STEPS;
  return true;
}

/**
 * Crawling up a wall into the floating slab over us (an awning, a landing): onto it, if it's thin
 * and there's room to stand on it (on foot: pushing on into the wall sticks us to it again).
 */
function slabHop(p: PlayerSim): boolean {
  // (from the middle of the body up: a sloping one's underside may be lower here than where it stopped us)
  const under = ceilingAbove(p.x, p.z, p.y + PLAYER_HEIGHT / 2);
  // its top: a floor over our head, not much above its underside
  const floor = groundHeight(p.x, p.z, under + 1);
  if (under === Infinity || floor <= under) return false;
  _q.x = p.x; _q.z = p.z;
  // (the wall we're on is just out of reach of a slightly thinner body)
  if (collideBody(_q, floor, floor, PLAYER_RADIUS - 0.02, PLAYER_HEIGHT)) return false;
  if (ceilingAbove(p.x, p.z, floor) < floor + PLAYER_HEIGHT) return false;
  p.mode = Mode.Foot;
  p.veh = -1;
  p.y = floor;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.grounded = true;
  p.coyote = 0;
  p.timer = ticks(CLIMB_SETTLE);
  return true;
}

/** Let go of a wall: on foot, in the air, moving at (vx, vy, vz). */
function offWall(p: PlayerSim, vx: number, vy: number, vz: number) {
  p.mode = Mode.Foot;
  p.veh = -1;
  p.vx = vx; p.vy = vy; p.vz = vz;
  p.grounded = false;
  p.coyote = 0;
  p.timer = 0;
}

// ---------------------------------------------------------------- crawling on a wall
/**
 * On a wall, with the zoomies (`lyaw`: the way out of it). The stick is read against the wall:
 * pushing into it climbs, pulling away goes down, along it goes along it, at WALL_SPEED. (Against
 * the wall we were on when it was pushed, `lx`, until it's let go: held one way round a corner,
 * it still means along, not, against the next face, away from it: down.) No gravity: the claws
 * hold. Every step presses WALL_STICK into the wall and lets `collideBody`
 * push us back out, `PLAYER_RADIUS` off its face: that keeps us on it, and round its outer
 * corners (pushed off a corner, the way out turns as we go round it). Near the top, pushing up
 * climbs over onto the roof; down at the floor, pulling away steps off. Space kicks off. When
 * the zoomies wear off we let go and fall (a long way down dazes, like any fall). Only the
 * static map is read: replays re-derive it bit for bit.
 */
function stepWall(ctx: SimCtx, p: PlayerSim, cmd: InputLike): number {
  const dt = ctx.dt;
  let nx = Math.sin(p.lyaw), nz = Math.cos(p.lyaw);
  if (p.zoomies === 0) {
    offWall(p, nx, Math.min(p.vy, 0), nz);
    return EV_FALL_OFF;
  }
  let mx = cmd.mx / 100, mz = cmd.mz / 100;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  if (ml < 0.2) p.lx = p.lyaw;
  const fx = Math.sin(p.lx), fz = Math.cos(p.lx);
  const up = -(mx * fx + mz * fz), side = mx * fz - mz * fx;
  // along the wall: to the right, facing it
  const tx = nz, tz = -nx;
  // just grabbed on (`timer`): a jump tapped on the way in doesn't kick straight back off
  const gripping = p.timer > 0;
  if (gripping) p.timer--;
  if (cmd.jump && !gripping) {
    // kick off: out and up, on along it the way the stick goes, and no steering straight back
    // onto it for a moment (`timer`, as after a climb)
    offWall(p, nx * WALL_KICK_OUT + tx * side * WALL_SPEED, WALL_KICK_UP, nz * WALL_KICK_OUT + tz * side * WALL_SPEED);
    p.timer = ticks(WALL_KICK_SETTLE);
    return EV_JUMP;
  }

  // crawl: ease toward the stick's speed along the wall and up it, as on the ground
  const k = Math.min(1, 16 * dt);
  let vt = p.vx * tx + p.vz * tz;
  vt += (side * WALL_SPEED - vt) * k;
  p.vy += (up * WALL_SPEED - p.vy) * k;
  p.vx = tx * vt; p.vz = tz * vt;
  const prevX = p.x, prevY = p.y, prevZ = p.z;
  p.x += p.vx * dt - nx * WALL_STICK;
  p.z += p.vz * dt - nz * WALL_STICK;
  p.y += p.vy * dt;
  // up into a floating slab (an awning, a landing): bonk
  let bonked = false;
  if (p.vy > 0) {
    const ceil = ceilingAbove(p.x, p.z, prevY + PLAYER_HEIGHT - 0.05);
    if (p.y + PLAYER_HEIGHT > ceil) { p.y = ceil - PLAYER_HEIGHT; p.vy = 0; bonked = true; }
  }

  // back out of the wall, and which wall that is: the one facing most the way ours did (a
  // corner's way out turns a little each step; in an inner corner we stay on ours). Walls as
  // they were at the lower of the two heights: still the one we were on, climbing near its top.
  // Any wall will do to hold on to (a cornice, a sign): only one to get on, or climb over the
  // top of, has to be a ledge.
  collideBody(p, p.y, Math.min(prevY, p.y), PLAYER_RADIUS, PLAYER_HEIGHT, _xz, _contacts);
  let best = -1, facing = 0.2;
  for (let c = 0; c < _contacts.n; c++) {
    const d = _contacts.nx[c] * nx + _contacts.nz[c] * nz;
    if (d > facing) { facing = d; best = c; }
  }
  if (best < 0) {
    // nothing to hold on to: on foot, carrying on as we were
    offWall(p, p.vx, p.vy, p.vz);
    return EV_FALL_OFF;
  }
  // (stopped along it by something in the way, or slowed going round a corner: no faster than we went)
  const went = ((p.x - prevX) * tx + (p.z - prevZ) * tz) / dt;
  if (Math.abs(went) < Math.abs(vt)) { vt = went; p.vx = tx * vt; p.vz = tz * vt; }
  nx = _contacts.nx[best]; nz = _contacts.nz[best];
  const top = _contacts.top[best];
  p.lyaw = Math.atan2(nx, nz);
  p.yaw += wrapAngle(Math.atan2(-nx, -nz) - p.yaw);

  // under an awning (a landing), pushing up: up onto it, and on up the wall from there
  if (bonked && up > 0.2 && slabHop(p)) return EV_CLIMB;

  // never so high that it stops being a wall (we'd lose it, and drop down the outside)
  const highest = top - STEP_UP - 0.01;
  if (p.y > highest) { p.y = highest; if (p.vy > 0) p.vy = 0; }
  if (up > 0.2 && top - p.y <= WALL_TOP_REACH) {
    // near the top, pushing up: over it, onto the roof (pushing up is pushing into it, whatever
    // way the stick points now)
    if (ledgeGrab(p, cmd, WALL_TOP_REACH, -Infinity)) return EV_CLIMB;
    // nothing to stand on up there (a wall's thin top, a sign): at the very top, vault it
    if (p.y >= highest - 1e-4) {
      offWall(p, -nx * 3, WALL_KICK_UP, -nz * 3);
      return EV_JUMP;
    }
  }

  // the floor: crawled back down to it, and pulling away steps off onto it
  const floor = groundHeight(p.x, p.z, Math.max(prevY, p.y));
  if (p.y <= floor) {
    p.y = floor;
    if (p.vy < 0) p.vy = 0;
    if (up < -0.2) {
      p.mode = Mode.Foot;
      p.veh = -1;
      p.vy = 0;
      p.grounded = true;
      p.coyote = COYOTE_STEPS;
      p.timer = 0;
      return 0;
    }
  }
  p.grounded = false;
  p.coyote = 0;
  return 0;
}

/** How far (x, z) is from a car's body (0 touching or inside it). */
function obbGap(c: CarPose, x: number, z: number): number {
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const dx = x - c.x, dz = z - c.z;
  const ex = Math.abs(dx * cs - dz * sn) - c.halfW, ez = Math.abs(dx * sn + dz * cs) - c.halfL;
  return Math.hypot(Math.max(0, ex), Math.max(0, ez));
}

function nearestCar(world: WorldView, x: number, z: number, reach: number): SeenCar | null {
  let best: SeenCar | null = null, bestD = Infinity;
  for (const c of world.cars(x, z, 6)) {
    if (c.wreck) continue;
    if (!circleObb(x, z, PLAYER_RADIUS + reach, c.x, c.z, c.yaw, c.halfW, c.halfL)) continue;
    const d = (c.x - x) ** 2 + (c.z - z) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function enterRide(p: PlayerSim, mode: number, veh: number, lx: number, ly: number, lz: number, platYaw: number) {
  p.mode = mode;
  p.veh = veh;
  p.lx = lx; p.ly = ly; p.lz = lz;
  p.vx = 0; p.vy = 0; p.vz = 0;
  // facing on the platform; the world `yaw` carries on from where it was
  p.lyaw = wrapAngle(p.yaw - platYaw);
  p.grounded = true;
  p.timer = 0;
  p.coyote = 0;
}

// ---------------------------------------------------------------- riding a roof
/** Is (x, z) over car `c`'s roof, at most `edge` past its rim? (The player's centre, not their circle.) */
function overRoof(c: CarPose, x: number, z: number, edge: number): boolean {
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const dx = x - c.x, dz = z - c.z;
  return Math.abs(dx * cs - dz * sn) <= c.halfW + edge && Math.abs(dx * sn + dz * cs) <= c.halfL + edge;
}

/**
 * Walking, facing and jumping on a moving platform, in its frame (yaw `plYaw`): the stick
 * steers the velocity relative to the roof, and the facing is kept relative to it too.
 */
function rideControl(p: PlayerSim, cmd: InputLike, plYaw: number, dt: number): number {
  let mx = cmd.mx / 100, mz = cmd.mz / 100;
  // just climbed up (`timer`: steps left finding our feet): the stick doesn't move us yet, and
  // the jump that got us up here (still held, or buffered) doesn't hop us straight off again
  const settling = p.timer > 0;
  if (settling) { p.timer--; mx = 0; mz = 0; }
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  const c = Math.cos(plYaw), s = Math.sin(plYaw);
  const lmx = mx * c - mz * s, lmz = mx * s + mz * c;
  const speed = (cmd.sprint ? RUN_SPEED : WALK_SPEED) * 0.8;
  const k = Math.min(1, (p.grounded ? 16 : 5) * dt);
  p.vx += (lmx * speed - p.vx) * k;
  p.vz += (lmz * speed - p.vz) * k;

  if (cmd.fire || cmd.nade || p.charge > 0 || p.weapon !== Weapon.Fists) turnLocalToward(p, cmd.aim - plYaw, 20 * dt);
  else if (ml > 0.1) turnLocalToward(p, Math.atan2(lmx, lmz), 14 * dt);

  if (cmd.jump && p.grounded && !settling) {
    p.vy = JUMP_VELOCITY;
    p.grounded = false;
    return EV_JUMP;
  }
  return 0;
}

/** Leave a platform posed at `pl` (yaw cos `c`, sin `s`): back to world space with its velocity added. */
function dismount(p: PlayerSim, pl: CarPose, c: number, s: number, hop: boolean): number {
  const wvx = pl.vx + p.vx * c + p.vz * s;
  const wvz = pl.vz - p.vx * s + p.vz * c;
  p.mode = Mode.Foot;
  p.veh = -1;
  p.vx = wvx; p.vz = wvz;
  p.grounded = false;
  p.timer = 0;
  p.coyote = 0;
  if (hop) {
    // hop off sideways
    p.vy = JUMP_VELOCITY * 0.6;
    const side = p.lx >= 0 ? 1 : -1;
    p.vx += c * side * 4; p.vz -= s * side * 4;
  }
  return EV_FALL_OFF;
}

function stepRiding(ctx: SimCtx, p: PlayerSim, cmd: InputLike, world: WorldView): number {
  const dt = ctx.dt;
  // A replay can reach this step in a mode the live step wasn't in (no memo): for a car
  // the current view is the best guess.
  const pl = ctx.memo("platform", () => {
    const r = platformOf(p, world, { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 });
    return r ? { ...r } : null;
  }) ?? platformOf(p, world, _pl);

  if (!pl) {
    // the car under us is gone: drop where we were
    p.mode = Mode.Foot;
    p.veh = -1;
    p.grounded = false;
    return EV_FALL_OFF;
  }

  let ev = rideControl(p, cmd, pl.yaw, dt);
  const c = Math.cos(pl.yaw), s = Math.sin(pl.yaw);
  p.vy -= GRAVITY * dt;
  p.lx += p.vx * dt;
  p.lz += p.vz * dt;
  p.ly += p.vy * dt;

  if (p.ly <= pl.roof) {
    if (!p.grounded) ev |= EV_LAND;
    p.ly = pl.roof;
    p.vy = 0;
    p.grounded = true;
  }

  // world position and facing (kept fresh for the camera and server-side queries);
  // the world yaw moves along the shortest arc so it never jumps by a full turn
  localToWorld(pl, p.lx, p.lz, _xz);
  p.x = _xz.x; p.z = _xz.z; p.y = p.ly;
  p.yaw += wrapAngle(pl.yaw + p.lyaw - p.yaw);

  // off the edge (or jumping off): back to world space, inheriting the platform's velocity
  const offX = Math.abs(p.lx) > pl.halfW + 0.15, offZ = Math.abs(p.lz) > pl.halfL + 0.15;
  if (offX || offZ || cmd.use) return ev | dismount(p, pl, c, s, cmd.use && !offX && !offZ);
  return ev;
}

// ---------------------------------------------------------------- riding a train
const _tA: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
const _tB: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
const _w: XZ = { x: 0, z: 0 };
const _l: XZ = { x: 0, z: 0 };

/**
 * Standing on a train. The whole train is one walkable deck: a rider (walking, running
 * or jumping) who crosses a coupling continues in the next car's frame, velocity and
 * facing carried over unchanged in world space, and only drops off over a side or the
 * train's open ends. Every car pose is a pure function of `ctx.time`, so nothing here is
 * memoised: replays re-derive it bit for bit.
 *
 * `p.lz` holds the TRAIN coordinate U (see train.ts); `lx`, `ly` and `lyaw` are relative
 * to the car in `p.veh`.
 */
function stepTrain(ctx: SimCtx, p: PlayerSim, cmd: InputLike): number {
  const dt = ctx.dt;
  if (p.veh < 0 || p.veh >= TRAIN_SLOTS) {
    p.mode = Mode.Foot;
    p.veh = -1;
    p.grounded = false;
    return EV_FALL_OFF;
  }
  let slot = p.veh, i = slot % TRAIN_CARS;
  let pl = trainCarPose(slot, ctx.time, _tA);
  let lz = carLocalZ(slot, p.lz);

  let ev = rideControl(p, cmd, pl.yaw, dt);
  p.vy -= GRAVITY * dt;
  p.lx += p.vx * dt;
  lz += p.vz * dt;
  p.ly += p.vy * dt;

  // Over a coupling: hand over to the next car once we're past the plane halfway between
  // the two end faces (it turns with the cars in a curve) by a hysteresis margin.
  const dir = lz > pl.halfL ? -1 : lz < -pl.halfL ? 1 : 0; // -1: the car ahead (i - 1)
  if (dir !== 0 && i + dir >= 0 && i + dir < TRAIN_CARS) {
    const npl = trainCarPose(slot + dir, ctx.time, _tB);
    localToWorld(pl, p.lx, lz, _w);
    worldToLocal(npl, _w.x, _w.z, _l);
    const overHere = Math.abs(lz) - pl.halfL;
    const overThere = (dir < 0 ? -_l.z : _l.z) - npl.halfL;
    if (overHere - overThere > TRAIN_COUPLE_HYST) {
      // same world velocity and facing, expressed in the next car's frame
      const d = wrapAngle(pl.yaw - npl.yaw), cd = Math.cos(d), sd = Math.sin(d);
      const vx = p.vx * cd + p.vz * sd;
      p.vz = -p.vx * sd + p.vz * cd;
      p.vx = vx;
      p.lyaw = wrapAngle(p.lyaw + d);
      p.lx = _l.x;
      lz = _l.z;
      slot += dir;
      i += dir;
      p.veh = slot;
      pl = trainCarPose(slot, ctx.time, _tA);
      ev |= EV_COUPLE;
    }
  }

  // The loco's chimney and dome stand up through its deck: walk round them (or over them).
  if (i === 0) {
    for (const o of LOCO_OBSTACLES) {
      if (p.ly >= o.top) continue;
      const dx = p.lx - o.x, dz = lz - o.z, rr = o.r + PLAYER_RADIUS, d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      // head-on, slide off to one side (the loco's left): a straight run goes round
      const bx = Math.abs(dx) < 0.1 ? (dx < 0 ? -0.1 : 0.1) : dx;
      const d = Math.sqrt(bx * bx + dz * dz);
      const nx = bx / d, nz = dz / d;
      p.lx = o.x + nx * rr;
      lz = o.z + nz * rr;
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) { p.vx -= vn * nx; p.vz -= vn * nz; }
    }
  }

  // What's under us: our roof (couplings bridged), or in the wedge between two cars in a
  // curve, the neighbour's roof.
  const sx = Math.abs(p.lx) - pl.halfW, ez = Math.abs(lz) - pl.halfL;
  const coupled = lz > 0 ? i > 0 : i < TRAIN_CARS - 1;
  let under = sx <= TRAIN_EDGE && ez <= (coupled ? TRAIN_BRIDGE : TRAIN_EDGE);
  if (!under && coupled && ez > 0 && ez <= TRAIN_BRIDGE) {
    const npl = trainCarPose(slot + (lz > 0 ? -1 : 1), ctx.time, _tB);
    localToWorld(pl, p.lx, lz, _w);
    worldToLocal(npl, _w.x, _w.z, _l);
    under = Math.abs(_l.x) - npl.halfW <= TRAIN_EDGE;
  }
  if (p.ly <= pl.roof && under) {
    if (!p.grounded) ev |= EV_LAND;
    p.ly = pl.roof;
    p.vy = 0;
    p.grounded = true;
  }

  // world position and facing (camera, server-side queries)
  localToWorld(pl, p.lx, lz, _w);
  p.x = _w.x; p.z = _w.z; p.y = p.ly;
  p.yaw += wrapAngle(pl.yaw + p.lyaw - p.yaw);

  // Off the train: walked off at roof height, or jumped far wide of it. A short hop past
  // the edge stays in the car's frame and can land back on the roof.
  const lost = (p.ly <= pl.roof && !under) || sx > TRAIN_AIR_REACH || (!coupled && ez > TRAIN_AIR_REACH);
  if (lost || cmd.use) {
    if (!cmd.use) {
      // walking off: make sure we clear the side (or the open end) instead of scraping it
      if (sx > 0 && sx < PLAYER_RADIUS + 0.05) {
        const sg = p.lx >= 0 ? 1 : -1;
        p.vx = sg * Math.max(sg * p.vx, TRAIN_DISMOUNT_PUSH);
      }
      if (!coupled && ez > 0 && ez < PLAYER_RADIUS + 0.05) {
        const sg = lz >= 0 ? 1 : -1;
        p.vz = sg * Math.max(sg * p.vz, TRAIN_DISMOUNT_PUSH);
      }
    }
    p.lz = trainU(slot, lz);
    return ev | dismount(p, pl, Math.cos(pl.yaw), Math.sin(pl.yaw), cmd.use && !lost);
  }
  p.lz = trainU(slot, lz);
  return ev;
}

// ---------------------------------------------------------------- hiding in a trash can
/**
 * Inside trash can `veh`: out of sight, going nowhere. The facing follows the aim (it's
 * where the eyes under the lid look). E, Space or a click hops back out: along the stick if
 * it's pushed, else toward the aim (a click then fires the same step: an ambush). G, with a
 * stink bomb, hops out too and starts winding it up. Being hit pops you out too, but that is
 * the server's doing (`Bins.hit`).
 */
function stepHidden(ctx: SimCtx, p: PlayerSim, cmd: InputLike): number {
  const b = CITY.bins[p.veh];
  if (!b) {
    p.mode = Mode.Foot;
    p.veh = -1;
    p.grounded = false;
    return EV_UNHIDE;
  }
  p.x = b.x; p.z = b.z; p.y = b.y;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.grounded = true;
  turnToward(p, cmd.aim, 20 * ctx.dt);
  if (!cmd.use && !cmd.jump && !cmd.fire && !(cmd.nade && p.ammo4 > 0)) return 0;
  const toward = Math.hypot(cmd.mx, cmd.mz) > 10 ? Math.atan2(cmd.mx, cmd.mz) : cmd.aim;
  // from the rim on that side: hops clear of the can even with no stick to carry you
  leaveBin(p, b, Math.sin(toward), Math.cos(toward), BIN_HOP_SPEED, BIN_HOP_UP, BIN_R + 0.05);
  return EV_UNHIDE;
}

/**
 * Out of trash can `b` over its rim, `edge` m from its middle along (dx, dz), flung that way
 * at `speed` (m/s) and up at `vy`. On foot (the server makes a pop a knock-down after).
 */
export function leaveBin(p: PlayerSim, b: BinSpot, dx: number, dz: number, speed: number, vy: number, edge = 0) {
  p.mode = Mode.Foot;
  p.veh = -1;
  p.x = b.x + dx * edge; p.z = b.z + dz * edge; p.y = b.top;
  p.vx = dx * speed; p.vz = dz * speed; p.vy = vy;
  p.grounded = false;
  p.coyote = 0;
}

// ---------------------------------------------------------------- down the sewer
const _pipe = { x: 0, z: 0, dx: 0, dz: 0 };

/** The `stench` at which a breath is used up. */
export const SEWER_AIR = ticks(SEWER_AIR_S) * SEWER_AIR_REFILL;
/** Seconds of breath left (SEWER_AIR_S: a full one). */
export const airLeft = (p: { stench: number }) => (SEWER_AIR - p.stench) / (SEWER_AIR_REFILL * TICK_RATE);
/** Breath enough for a dive. */
export const canDive = (p: { stench: number }) => p.stench <= SEWER_AIR - ticks(SEWER_AIR_MIN_S) * SEWER_AIR_REFILL;

/** Down manhole `i`: under it, stopped, finding our feet for a moment (`timer`). */
function intoSewer(ctx: SimCtx, p: PlayerSim, i: number): number {
  const m = MANHOLES[i];
  p.mode = Mode.Sewer;
  p.veh = m.edge;
  p.lx = m.s;
  p.lz = i;
  p.ly = 0;
  p.x = m.x; p.z = m.z; p.y = SEWER_Y;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.grounded = true;
  p.coyote = 0;
  p.charge = 0;
  p.timer = ticks(SEWER_SETTLE);
  ctx.hole = i;
  return EV_SEWER;
}

/** Up out of manhole `m`, hopping along the stick (or the way we face). */
function climbOut(ctx: SimCtx, p: PlayerSim, m: ManholeSpot, i: number, mx: number, mz: number): number {
  const toward = mx * mx + mz * mz > 0.09 ? Math.atan2(mx, mz) : p.yaw;
  p.mode = Mode.Foot;
  p.veh = -1;
  p.x = m.x; p.z = m.z; p.y = 0.05;
  p.vx = Math.sin(toward) * SEWER_POP_SPEED;
  p.vz = Math.cos(toward) * SEWER_POP_SPEED;
  p.vy = SEWER_POP_UP;
  p.lx = 0; p.ly = 0; p.lz = 0;
  p.grounded = false;
  p.coyote = 0;
  p.timer = 0;
  ctx.hole = i;
  // out of breath: up gasping, dazed a moment
  if (p.stench >= SEWER_AIR) { p.mode = Mode.Knocked; p.timer = ticks(SEWER_GASP_DAZE); }
  return EV_UNSEWER;
}

/**
 * Down the sewer: in the pipe under street `veh`, `lx` m along it, at `vx` m/s (+ toward its `b`
 * end). Stopped under a manhole (`lz`), the stick picks which way along the pipe to scurry, and
 * Space or E climbs out. On the move, holding the stick any way keeps us going and pulling it
 * straight back turns us round; let go and we stop under the next manhole, and Space or E on the
 * way (`ly` = 1 remembers it) climbs straight out of it when we get there. At a junction the stick
 * picks the next street (none: the straightest on), and a dead end turns us round. Every manhole we pass under rattles
 * (`ctx.rattled`). Out of breath (`stench`), it's as if Space was pressed, and we come up gasping.
 * Only the static town is read: replays re-derive it bit for bit.
 */
function stepSewer(ctx: SimCtx, p: PlayerSim, cmd: InputLike): number {
  const dt = ctx.dt;
  const roads = CITY.roads.edges;
  let e = roads[p.veh];
  const here = MANHOLES[p.lz] ?? MANHOLES[0];
  if (!e || !SEWER.piped[p.veh] || !here) {
    // (lost down there: a dev-mode reload, a bad state) back up the nearest manhole
    return climbOut(ctx, p, here ?? { x: p.x, z: p.z, edge: 0, s: 0, yaw: 0 }, p.lz, 0, 0);
  }
  let mx = cmd.mx / 100, mz = cmd.mz / 100;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  const settling = p.timer > 0;
  if (settling) p.timer--;
  // out of breath: up this manhole, or the next one we get to
  const gasping = p.stench >= SEWER_AIR;
  if (gasping) p.ly = 1;
  const stick = ml > 0.3 && !settling;
  lineAt(e, p.lx, _pipe);
  // how much the stick points along the pipe (+: toward its `b` end)
  let along = stick ? (mx * _pipe.dx + mz * _pipe.dz) / Math.min(1, ml) : 0;
  let v = p.vx;
  let ev = 0;

  if (v === 0) {
    // under a manhole: out, or off along the pipe the stick points down
    if (gasping || ((cmd.use || cmd.jump) && !settling)) return climbOut(ctx, p, here, p.lz, mx, mz);
    if (stick && Math.abs(along) > 0.15) v = Math.sign(along) * 2;
  }
  if (v !== 0) {
    let dir = v > 0 ? 1 : -1;
    // Space or E on the way: out at the next manhole
    if (cmd.use || cmd.jump) p.ly = 1;
    // pulled (almost straight) back the way we came: a quick turnaround
    if (stick && along * dir < -0.8) { v = -v * 0.5; dir = -dir; }
    // any other way the stick is held keeps us going (it steers at the junctions), unless we're getting out
    const keepOn = stick && p.ly === 0;
    let target = dir * SEWER_SPEED;
    if (!keepOn) {
      // easing in under the next manhole on this pipe (past the junction we just stop at the first one)
      const next = nextManhole(p.veh, p.lx, dir);
      if (next >= 0) target = dir * Math.min(SEWER_SPEED, 1.5 + Math.sqrt(SEWER_ACCEL * Math.abs(MANHOLES[next].s - p.lx)));
    }
    v += clamp(target - v, -SEWER_ACCEL * dt, SEWER_ACCEL * dt);

    // along the pipes: past manholes (each rattles; letting go, we stop at the first), through junctions
    let s = p.lx, step = v * dt;
    for (let guard = 0; guard < 8; guard++) {
      const s1 = s + step;
      let stopped = false;
      const on = SEWER.onEdge[p.veh];
      for (let j = 0; j < on.length; j++) {
        const k = on[dir > 0 ? j : on.length - 1 - j], ms = MANHOLES[k].s;
        // (not the one we're leaving from)
        if (dir > 0 ? ms > s + 1e-3 && ms <= s1 : ms < s - 1e-3 && ms >= s1) {
          (ctx.rattled ??= []).push(k);
          p.lz = k;
          if (!keepOn) { s = ms; stopped = true; break; }
        }
      }
      if (stopped) {
        // (asked to get out on the way: up it goes, now)
        if (p.ly === 1) { p.lx = s; return ev | climbOut(ctx, p, MANHOLES[p.lz], p.lz, mx, mz); }
        v = 0; p.timer = ticks(SEWER_SETTLE); ev |= EV_ARRIVE;
        break;
      }
      if (s1 >= 0 && s1 <= e.len) { s = s1; break; }
      // a junction: on along the street the stick points down (or the straightest), or back at a dead end
      const node = s1 > e.len ? e.b : e.a;
      const over = s1 > e.len ? s1 - e.len : -s1;
      lineAt(e, s1 > e.len ? e.len : 0, _pipe);
      const ne = nextPipe(node, p.veh, _pipe.dx * dir, _pipe.dz * dir, stick ? mx : 0, stick ? mz : 0);
      if (ne === p.veh) {
        v = -v; dir = -dir;
        s = s1 > e.len ? e.len - over : over;
        break;
      }
      p.veh = ne;
      e = roads[ne];
      const fromA = e.a === node;
      dir = fromA ? 1 : -1;
      v = dir * Math.abs(v);
      s = fromA ? 0 : e.len;
      step = dir * over;
      // (the stick, read against the new pipe)
      if (stick) { lineAt(e, s, _pipe); along = (mx * _pipe.dx + mz * _pipe.dz) / Math.min(1, ml); }
    }
    p.lx = clamp(s, 0, e.len);
    p.vx = v;
  }

  // the street over us (for the camera, the fumes, who's sent where), facing the way we go
  lineAt(e, p.lx, _pipe);
  p.x = _pipe.x; p.z = _pipe.z; p.y = SEWER_Y;
  p.vy = 0; p.vz = 0;
  p.grounded = true;
  if (p.vx !== 0) turnToward(p, Math.atan2(_pipe.dx * Math.sign(p.vx), _pipe.dz * Math.sign(p.vx)), 12 * dt);
  return ev;
}

/** The next manhole along street `edge` from `s` going `dir` (index into `MANHOLES`), or -1. */
function nextManhole(edge: number, s: number, dir: number): number {
  const on = SEWER.onEdge[edge];
  if (dir > 0) { for (const k of on) if (MANHOLES[k].s > s + 1e-3) return k; }
  else for (let j = on.length - 1; j >= 0; j--) if (MANHOLES[on[j]].s < s - 1e-3) return on[j];
  return -1;
}

// ---------------------------------------------------------------- a seagull
const GULL_POOP = ticks(GULL_POOP_S);

/**
 * A seagull (out of the round, see `Mode.Gull`). The stick flies it about (camera-relative, easing
 * toward GULL_SPEED), Space climbs and Shift dives, else it holds its height; never lower than
 * GULL_CLEAR over whatever is under it, and a wall in its way it flutters up and over. The click
 * lets go of a dropping (`ctx.poop`, every GULL_POOP_S), and E snatches the loot under its feet
 * (`ctx.snatched`) or lets go of what it carries (`ctx.dropped`). Shooed (`timer`), it tumbles out of
 * control for a moment. Nobody else is read but the loot: it flies through cars and trains.
 */
function stepGull(ctx: SimCtx, p: PlayerSim, cmd: InputLike, world: WorldView): number {
  const dt = ctx.dt;
  let ev = 0;
  if (p.cd > 0) p.cd--;
  const dazed = p.timer > 0;
  if (dazed) {
    // shooed: tumbling, flapping madly
    p.timer--;
    p.vy -= 12 * dt;
    const f = Math.max(0, 1 - 1.5 * dt);
    p.vx *= f; p.vz *= f;
    p.yaw += 9 * dt;
  } else {
    let mx = cmd.mx / 100, mz = cmd.mz / 100;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const k = Math.min(1, GULL_ACCEL * dt);
    p.vx += (mx * GULL_SPEED - p.vx) * k;
    p.vz += (mz * GULL_SPEED - p.vz) * k;
    const up = cmd.jump ? GULL_CLIMB : cmd.sprint ? -GULL_DIVE : 0;
    p.vy += (up - p.vy) * Math.min(1, 5 * dt);
    // facing where it flies; hovering, where you look
    if (Math.hypot(p.vx, p.vz) > 1.5) turnToward(p, Math.atan2(p.vx, p.vz), 5 * dt);
    else turnToward(p, cmd.aim, 3 * dt);
  }
  const prevY = p.y;
  p.x += p.vx * dt;
  p.z += p.vz * dt;
  p.y += p.vy * dt;
  // the edge of the map
  const lim = MAP_HALF - 3;
  if (Math.abs(p.x) > lim) { p.x = clamp(p.x, -lim, lim); p.vx = 0; }
  if (Math.abs(p.z) > lim) { p.z = clamp(p.z, -lim, lim); p.vz = 0; }
  // a wall (a building's side) in the way: pushed out of it, and fluttering up it
  if (collideBody(p, p.y - 0.25, Math.max(prevY, p.y) - 0.25, GULL_R, 0.5, _xz)) {
    const nl = Math.hypot(_xz.x, _xz.z);
    if (nl > 0) {
      const nx = _xz.x / nl, nz = _xz.z / nl, vn = p.vx * nx + p.vz * nz;
      if (vn < 0) { p.vx -= vn * nx; p.vz -= vn * nz; }
    }
    if (!dazed) p.vy = Math.max(p.vy, GULL_CLIMB);
  }
  // up into a floating slab (an awning, a landing): bonk
  if (p.vy > 0) {
    const ceil = ceilingAbove(p.x, p.z, prevY + 0.3);
    if (p.y + 0.3 > ceil) { p.y = ceil - 0.3; p.vy = 0; }
  }
  // never too close over the street (or the roof) under it, nor up in the clouds
  const floor = groundHeight(p.x, p.z, Math.max(prevY, p.y) - 0.25);
  const low = floor + (dazed ? 0.25 : GULL_CLEAR);
  if (p.y < low) {
    // diving at the street: it pulls up GULL_CLEAR over it; a roof's edge flown over rises under it:
    // it lifts up over that quickly, not in one jump
    if (p.vy < 0 || p.y < floor + 0.25) p.y = low;
    else p.y += (low - p.y) * Math.min(1, 10 * dt);
    if (p.vy < 0) p.vy = dazed ? -p.vy * 0.3 : 0;
  }
  if (p.y > GULL_CEIL) { p.y = GULL_CEIL; if (p.vy > 0) p.vy = 0; }
  p.grounded = false;
  if (dazed) return ev;

  // a dropping, from under its tail
  if (cmd.fire && p.cd === 0) {
    p.cd = GULL_POOP;
    ctx.poop = { x: p.x, y: p.y - 0.25, z: p.z, vx: p.vx * 0.8, vy: Math.min(p.vy, 0) - 1.5, vz: p.vz * 0.8 };
    ev |= EV_POOP;
  }
  // E: let go of what's in its feet, or snatch what's under them
  if (cmd.use) {
    if (p.veh >= 0) {
      ctx.dropped = { x: p.x, y: p.y - 0.35, z: p.z, vx: p.vx * 0.8, vy: Math.min(p.vy, 0), vz: p.vz * 0.8, kind: p.veh };
      p.veh = -1;
      ev |= EV_DROP;
    } else {
      const pk = ctx.memo("snatch", () => world.snatch(p.x, p.y, p.z));
      if (pk) {
        p.veh = pk.kind;
        ctx.snatched = pk.id;
        ev |= EV_SNATCH;
      }
    }
  }
  return ev;
}

/** Can loot at (x, y, z) be snatched by a gull at (gx, gy, gz)? (Under its feet, not above it.) */
export function inSnatchReach(gx: number, gy: number, gz: number, x: number, y: number, z: number, r: number) {
  return (gx - x) ** 2 + (gz - z) ** 2 <= r * r && gy - y <= GULL_SNATCH_DOWN && gy - y >= -0.5;
}

// ---------------------------------------------------------------- droppings, dropped loot
/** A dropping falls in steps of this many seconds (it's fast: no tunnelling through a roof). */
export const DROP_SUBSTEP = 1 / 60;

/**
 * One step of something a gull let go of, falling: a dropping, or loot. Against the static town
 * only. Returns 1 once it lands on a floor, 2 if it hit a wall (it slides down it from then on, its
 * sideways speed gone), 0 still falling. Shared by the server and every client watching, so they
 * all see it land in the same place.
 */
export function stepDrop(d: GrenadeLike, dt: number): number {
  const prevY = d.y;
  d.vy -= GRAVITY * dt;
  d.x += d.vx * dt;
  d.y += d.vy * dt;
  d.z += d.vz * dt;
  const yq = Math.max(prevY, d.y);
  _g.x = d.x; _g.z = d.z;
  let hit = 0;
  if (collideBody(_g, d.y, yq, 0.1, 0.2)) {
    d.x = _g.x; d.z = _g.z;
    d.vx = 0; d.vz = 0;
    hit = 2;
  }
  const floor = groundHeight(d.x, d.z, yq);
  if (d.y <= floor) { d.y = floor; d.vy = 0; return 1; }
  return hit;
}

/** Where something let go of at `d` lands (and after how many seconds), stepping `stepDrop` to the floor (at most 6 s). */
export function dropLanding(d: GrenadeLike): { x: number; y: number; z: number; t: number } {
  const s = { ...d };
  let t = 0;
  while (t < 6) {
    t += DROP_SUBSTEP;
    if (stepDrop(s, DROP_SUBSTEP) === 1) break;
  }
  return { x: s.x, y: s.y, z: s.z, t };
}

// ---------------------------------------------------------------- driving
const _circ: XZ = { x: 0, z: 0 };

/** How far the front wheels turn at full lock (rad), rolling at `vF` (m/s): less, the faster. */
export function steerLock(vF: number): number {
  return Math.max(CAR_STEER_MIN, CAR_STEER_MAX / (1 + (vF / CAR_STEER_FALL) ** 2));
}

/**
 * How far the front wheels are turned (rad, + = left) with the steering at `steer` (−1..1, eased
 * from the stick), rolling at `vF` and sliding sideways at `vL` (m/s, + = left), turning at
 * `yawRate`, axles `axle` m from the middle. The lock shrinks with speed, and going forward the
 * wheels also turn toward where the tail slides (CAR_COUNTER). The step drives with this; the
 * wheels are drawn with it.
 */
export function wheelAngle(steer: number, vF: number, vL: number, yawRate: number, axle: number): number {
  let d = steer * steerLock(vF);
  if (vF > 1) {
    const tail = Math.atan2(vL - yawRate * axle, vF);
    const past = Math.max(0, Math.abs(tail) - CAR_COUNTER_FROM) * Math.sign(tail);
    d += CAR_COUNTER * past * Math.min(1, (vF - 1) / 4);
  }
  return clamp(d, -CAR_STEER_MAX, CAR_STEER_MAX);
}

/**
 * The sideways push (m/s², + = toward the tyre's left) of a tyre sliding sideways at `w` while
 * rolling at `u`, that grips up to `limit`: it rises to `limit` at CAR_SLIP_PEAK, then falls off
 * toward CAR_TYRE_TAIL of it.
 */
function tyre(w: number, u: number, limit: number): number {
  const s = Math.abs(w) / (Math.max(Math.abs(u), CAR_SLIP_REF) * CAR_SLIP_PEAK);
  const c = (2 * s) / (1 + s * s);
  return (w > 0 ? -limit : limit) * (s <= 1 ? c : CAR_TYRE_TAIL + (1 - CAR_TYRE_TAIL) * c);
}

/**
 * Driving: the car is two axles `type.axle` m ahead of and behind its middle. The front tyres
 * steer, the rear ones drive; each pushes up to its grip (which the weight moving under braking
 * and power changes), and what it pushes along the car takes from what it can push across. Past
 * the limit a tyre slides with a little less grip than it held, so a slide carries on until it's
 * caught: that's a drift. Space locks the rear wheels (they slide); S brakes, then backs up.
 * Forces are per unit mass; the yaw inertia is `axle²` (the two axles then push independently).
 */
function stepDriving(ctx: SimCtx, p: PlayerSim, cmd: InputLike, world: WorldView): number {
  let ev = 0;
  const type = CAR_TYPES[world.carKind(p.veh)] ?? CAR_TYPES[0];

  if (cmd.use) return exitCar(p, type.halfW);

  const sub = CAR_SUBSTEPS;
  const dt = ctx.dt / sub;
  const throttle = clamp(cmd.throttle / 100, -1, 1);
  const steerIn = clamp(-cmd.steer / 100, -1, 1); // + = left = yaw increases
  const handbrake = cmd.jump;
  const airborne = p.y > 0.01 || p.vy > 0;
  const obstacles = ctx.memo("cars", () => world.cars(p.x, p.z, 9)) ?? [];
  // the lamp posts standing within this step's reach, as this driver knew of them then
  const poles = ctx.memo("poles", () => {
    const up = world.poles(p.x, p.z, type.halfL + POLE_R + Math.hypot(p.vx, p.vz) * ctx.dt + 1);
    return up.length ? up : undefined;
  }) ?? NO_POLES;
  // the townsfolk within this step's reach, where this driver saw them
  const peds = ctx.memo("peds", () => {
    const near = world.npcs(p.x, p.z, type.halfL + NPC_HIT_R + Math.hypot(p.vx, p.vz) * ctx.dt + 1, ctx.time);
    // (in one order on both sides: two hit in one sub-step slow the car in that order)
    return near.length ? near.sort((u, v) => (u.key < v.key ? -1 : u.key > v.key ? 1 : 0)) : undefined;
  }) ?? NO_PEDS;
  const a = type.axle, k2 = a * a;

  // The pedals: W drives and S brakes, rolling forward. Braked to a halt, S holds the car for
  // CAR_REVERSE_HOLD steps (`timer` counts them down), then backs up. Rolling backward, W brakes.
  const vF0 = p.vx * Math.sin(p.yaw) + p.vz * Math.cos(p.yaw);
  let drive = 0, brake = 0;
  if (throttle > 0) {
    if (vF0 < -0.5) brake = throttle;
    else drive = throttle;
    p.timer = 0;
  } else if (throttle < 0) {
    if (vF0 > 0.5) { brake = -throttle; p.timer = CAR_REVERSE_HOLD; }
    else if (p.timer > 0) { brake = -throttle; p.timer--; }
    else drive = throttle;
  } else p.timer = 0;

  for (let i = 0; i < sub; i++) {
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const lxv = Math.cos(p.yaw), lzv = -Math.sin(p.yaw);
    const vF = p.vx * fx + p.vz * fz;
    const vL = p.vx * lxv + p.vz * lzv;

    if (!airborne) {
      // the steering eases toward the stick, quicker back through the middle
      const winding = steerIn * p.steer >= 0 && Math.abs(steerIn) > Math.abs(p.steer);
      const rate = (winding ? CAR_STEER_WIND : CAR_STEER_RETURN) * dt;
      p.steer += clamp(steerIn - p.steer, -rate, rate);
      const delta = wheelAngle(p.steer, vF, vL, p.yawRate, a);
      const cd = Math.cos(delta), sd = Math.sin(delta);

      // what the pedals ask of each axle, along its wheels: the engine (on the rear), or the
      // brakes or the engine braking (never past a standstill)
      let wantF = 0, wantR = 0;
      if (drive > 0) wantR = type.accel * drive * Math.max(0, 1 - (vF / type.maxSpeed) ** 2);
      else if (drive < 0) wantR = type.accel * 0.6 * drive * Math.max(0, 1 - (vF / CAR_REVERSE_SPEED) ** 2);
      else {
        const stop = Math.min(brake > 0 ? CAR_BRAKE * brake : CAR_COAST, Math.abs(vF) / dt) * (vF > 0 ? -1 : 1);
        const front = brake > 0 ? CAR_BRAKE_FRONT : 0;
        wantF = stop * front;
        wantR = stop * (1 - front);
      }
      // the weight moves forward under braking, back under power: front and rear grip
      const shift = clamp(wantF + wantR, -CAR_BRAKE, CAR_BRAKE) * CAR_LOAD_SHIFT;
      const limF = CAR_MU_FRONT * type.grip * (0.5 * GRAVITY - shift);
      const limR = CAR_MU_REAR * type.grip * (0.5 * GRAVITY + shift) * (handbrake ? CAR_HANDBRAKE_GRIP : 1);

      // Front tyres, in their own frame. Each axle carries half the car against a sideways
      // push (the inertia makes it so), and no push may overshoot its slide in a sub-step.
      const vLf = vL + p.yawRate * a;
      const uF = vF * cd + vLf * sd, wF = vLf * cd - vF * sd;
      const capF = (0.5 * Math.abs(wF)) / dt;
      let latF = clamp(tyre(wF, uF, limF), -capF, capF);
      let lonF = wantF;
      const eF = Math.hypot(lonF * CAR_LONG_SHARE, latF) / limF;
      if (eF > 1) { lonF /= eF; latF /= eF; }

      // rear tyres: locked by the handbrake they slide, pushing against how they move
      const vLr = vL - p.yawRate * a;
      let lonR: number, latR: number;
      if (handbrake) {
        // (gripping harder along them than across: they still slow the car down)
        const sp = Math.hypot(vF, vLr);
        const push = sp > 1e-6 ? Math.min(1, (0.5 * sp) / dt / limR) / sp : 0;
        lonR = -vF * push * limR * (CAR_HANDBRAKE_DRAG / CAR_HANDBRAKE_GRIP);
        latR = -vLr * push * limR;
      } else {
        // power on a tyre that's sliding spins it up: less grip across it
        const slide = Math.abs(vLr) / (Math.max(Math.abs(vF), CAR_SLIP_REF) * CAR_SLIP_PEAK) - 1;
        const lim = drive > 0 && slide > 0 ? limR * (1 - CAR_SPIN_GRIP * drive * Math.min(1, slide)) : limR;
        const capR = (0.5 * Math.abs(vLr)) / dt;
        latR = clamp(tyre(vLr, vF, lim), -capR, capR);
        lonR = wantR;
        if (Math.hypot(lonR * CAR_LONG_SHARE, latR) > lim) {
          if (drive > 0) {
            // spinning: the engine still pushes, and what grip is left holds it sideways
            lonR = Math.min(lonR, lim / CAR_LONG_SHARE);
            const room = Math.sqrt(Math.max(0, lim * lim - (lonR * CAR_LONG_SHARE) ** 2));
            latR = clamp(latR, -room, room);
          } else {
            const eR = Math.hypot(lonR * CAR_LONG_SHARE, latR) / lim;
            lonR /= eR; latR /= eR;
          }
        }
      }

      const accF = lonF * cd - latF * sd + lonR;
      const accL = lonF * sd + latF * cd + latR;
      p.vx += (fx * accF + lxv * accL) * dt;
      p.vz += (fz * accF + lzv * accL) * dt;
      p.yawRate += ((a * (lonF * sd + latF * cd) - a * latR) / k2 - CAR_YAW_DAMP * p.yawRate) * dt;
    } else {
      p.yawRate *= Math.max(0, 1 - 0.5 * dt);
    }

    p.yaw += p.yawRate * dt;
    if (airborne) p.vy -= GRAVITY * dt;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.y += p.vy * dt;
    if (p.y <= 0) {
      if (p.vy < -4) ev |= EV_LAND;
      p.y = 0;
      p.vy = p.vy < -6 ? -p.vy * 0.3 : 0;
    }

    // collide as two circles along the body
    const r = type.halfW;
    const off = type.halfL - r;
    let crashed = false;
    for (const sgn of [1, -1]) {
      const cx = p.x + Math.sin(p.yaw) * off * sgn, cz = p.z + Math.cos(p.yaw) * off * sgn;
      _circ.x = cx; _circ.z = cz;
      let hit = p.y < 1 && collideCircle(_circ, 0, r, true, _xz);
      if (!hit && p.y < 1 && onRamp(cx, cz)) { hit = true; _xz.x = -p.vx; _xz.z = -p.vz; _circ.x = cx - p.vx * dt; _circ.z = cz - p.vz * dt; }
      if (hit) {
        p.x += _circ.x - cx;
        p.z += _circ.z - cz;
        crashed = bounce(p, _xz.x, _xz.z, 0.25, off * sgn, k2) || crashed;
      }
      // lamp posts: closing on one fast enough knocks it over (and costs a little speed); a
      // gentler bump stops at it
      for (const i of poles) {
        if (p.y >= 1 || !poleContact(cx, cz, r, i, p.vx, p.vz, _pn) || ctx.knocked?.some((k) => k.i === i)) continue;
        const vn = p.vx * _pn.x + p.vz * _pn.z;
        if (vn <= -POLE_KNOCK_SPEED) {
          (ctx.knocked ??= []).push({ i, fall: poleFall(p.vx, p.vz, _pn.x, _pn.z) });
          const loss = Math.min(-vn, POLE_KNOCK_LOSS);
          p.vx += _pn.x * loss;
          p.vz += _pn.z * loss;
          // (clipped off the middle of the nose, it turns the car a little)
          p.yawRate += (CAR_HIT_SPIN * off * sgn * loss * (_pn.x * Math.cos(p.yaw) - _pn.z * Math.sin(p.yaw))) / k2;
        } else {
          p.x += _pn.x * _pn.depth;
          p.z += _pn.z * _pn.depth;
          bounce(p, _pn.x, _pn.z, 0.25, off * sgn, k2);
        }
      }
      // other cars, as seen by the driver
      for (const o of obstacles) {
        if (o.id === p.veh || p.y > o.roof) continue;
        if (!circleObb(cx, cz, r, o.x, o.z, o.yaw, o.halfW, o.halfL, _n)) continue;
        p.x += _n.x * _n.depth;
        p.z += _n.z * _n.depth;
        crashed = bounce(p, _n.x, _n.z, 0.3, off * sgn, k2) || crashed;
      }
    }
    if (crashed) ev |= EV_CRASH;

    // townsfolk: closing on one fast enough sends them flying, and costs the car a little speed
    if (p.y <= 1.2) {
      for (const n of peds) {
        if (Math.abs(n.y - p.y) > 1.2 || ctx.runOver?.some((h) => h.key === n.key)) continue;
        // (_n: from the car toward them)
        if (!circleObb(n.x, n.z, NPC_HIT_R, p.x, p.z, p.yaw, type.halfW, type.halfL, _n)) continue;
        const speed = Math.hypot(p.vx, p.vz);
        const vn = p.vx * _n.x + p.vz * _n.z;
        if (speed < RUN_OVER_SPEED || vn < RUN_OVER_CLOSING) continue;
        (ctx.runOver ??= []).push({
          key: n.key, x: n.x, y: n.y, z: n.z,
          vx: p.vx * 1.1 + _n.x * 4, vy: 6 + speed * 0.3, vz: p.vz * 1.1 + _n.z * 4, at: (i + 1) / sub,
        });
        const loss = Math.min(vn, RUN_OVER_LOSS);
        p.vx -= _n.x * loss;
        p.vz -= _n.z * loss;
        // (hit off the middle of the nose, it turns the car a little)
        const arm = (n.x - p.x) * Math.sin(p.yaw) + (n.z - p.z) * Math.cos(p.yaw);
        p.yawRate -= (CAR_HIT_SPIN * arm * loss * (_n.x * Math.cos(p.yaw) - _n.z * Math.sin(p.yaw))) / k2;
      }
    }
  }

  // trains (deterministic)
  const nearTrack = Math.abs(trackDistance(p.x, p.z)) < NEAR_TRACK;
  for (let slot = 0; nearTrack && slot < TRAIN_SLOTS; slot++) {
    const t = trainCarPose(slot, ctx.time, _train);
    const dx = p.x - t.x, dz = p.z - t.z;
    if (dx * dx + dz * dz > 100) continue;
    if (p.y > TRAIN_ROOF) continue;
    if (!circleObb(p.x, p.z, type.halfW + 0.4, t.x, t.z, t.yaw, t.halfW, t.halfL, _n)) continue;
    p.vx = t.vx * 1.4 + _n.x * 10;
    p.vz = t.vz * 1.4 + _n.z * 10;
    p.vy = 9;
    p.y = Math.max(p.y, 0.3);
    p.yawRate = (_n.x * t.vz - _n.z * t.vx) > 0 ? 7 : -7;
    ev |= EV_TRAIN_HIT;
    break;
  }

  // keep inside the map
  const lim = MAP_HALF - 2;
  p.x = clamp(p.x, -lim, lim);
  p.z = clamp(p.z, -lim, lim);
  p.grounded = p.y <= 0.01;
  return ev;
}

/**
 * A driven car hit something (`n` points away from it) with its circle `arm` m ahead of its
 * middle (behind: negative). Returns whether it was a crash worth a bang.
 */
function bounce(p: PlayerSim, nx: number, nz: number, restitution: number, arm: number, k2: number): boolean {
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-6) return false;
  nx /= nl; nz /= nl;
  const vn = p.vx * nx + p.vz * nz;
  if (vn >= 0) return false;
  const jx = -(1 + restitution) * vn * nx, jz = -(1 + restitution) * vn * nz;
  p.vx += jx;
  p.vz += jz;
  // scrub some speed and spin on impact; a hit off the middle turns the car (the nose of a
  // car clipping a corner swings away from it)
  p.vx *= 0.85; p.vz *= 0.85;
  p.yawRate = p.yawRate * 0.5 + (CAR_HIT_SPIN * arm * (jx * Math.cos(p.yaw) - jz * Math.sin(p.yaw))) / k2;
  return vn < -4;
}

/**
 * The CarLight bits of a car its driver just stepped with `cmd` (the pedals as `stepDriving`
 * reads them, including S holding the car at a halt): the server sends them with the car, and
 * the driver's own client works them out from its prediction.
 */
export function carLights(p: PlayerSim, cmd: InputLike): number {
  if (p.mode !== Mode.Driving) return 0;
  const vF = p.vx * Math.sin(p.yaw) + p.vz * Math.cos(p.yaw);
  const brake = (cmd.throttle < 0 && (vF > 0.3 || p.timer > 0)) || (cmd.throttle > 0 && vF < -0.3);
  return (brake ? CarLight.Brake : 0) | (cmd.throttle < 0 && !brake ? CarLight.Reverse : 0) | (cmd.jump ? CarLight.Handbrake : 0);
}

function exitCar(p: PlayerSim, halfW: number): number {
  const lx = Math.cos(p.yaw), lz = -Math.sin(p.yaw);
  p.mode = Mode.Foot;
  p.veh = -1;
  // step out on the driver's (left) side
  p.x += lx * (halfW + PLAYER_RADIUS + 0.25);
  p.z += lz * (halfW + PLAYER_RADIUS + 0.25);
  p.vx *= 0.35; p.vz *= 0.35;
  p.vy = 0;
  p.y = Math.max(p.y, 0);
  p.steer = 0; p.yawRate = 0; p.timer = 0;
  p.grounded = p.y <= 0.01;
  p.coyote = 0;
  return EV_EXIT;
}

// ---------------------------------------------------------------- lamp posts
const NO_POLES: number[] = [];
const NO_PEDS: SeenNpc[] = [];
const _pn: XZ & { depth: number } = { x: 0, z: 0, depth: 0 };

/**
 * Does a car's circle at (cx, cz), radius `r`, moving at (vx, vz), touch lamp post `i`? If so,
 * `out` is the way out of it (a unit vector from the post) and how deep it's in.
 */
export function poleContact(cx: number, cz: number, r: number, i: number, vx: number, vz: number, out: XZ & { depth: number }): boolean {
  const q = CITY.poles[i];
  const dx = cx - q.x, dz = cz - q.z, rr = r + POLE_R;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return false;
  const d = Math.sqrt(d2);
  if (d > 1e-6) { out.x = dx / d; out.z = dz / d; }
  else {
    // dead centre: back the way it came
    const s = Math.hypot(vx, vz) || 1;
    out.x = -vx / s; out.z = -vz / s;
  }
  out.depth = rr - d;
  return true;
}

/**
 * Which way a post a car hit falls, as one byte (256ths of a turn, world yaw): along the car's
 * travel, leaning away from the side it was hit on (`nx, nz`: from the post toward the car).
 * Everyone draws it falling exactly this way.
 */
export function poleFall(vx: number, vz: number, nx: number, nz: number): number {
  const s = Math.hypot(vx, vz) || 1;
  return Math.round((Math.atan2(vx / s - nx, vz / s - nz) / (Math.PI * 2)) * 256) & 255;
}

/** The world yaw a post falls toward (see `poleFall`). */
export const poleFallYaw = (fall: number) => (fall / 256) * Math.PI * 2;

/** The lamp posts as the server keeps them, for the cars nobody's driving. */
export interface PoleWorld {
  /** The ones standing within `r` of (x, z). */
  poles(x: number, z: number, r: number): number[];
  /** Knock post `i` over, falling `fall` (see `poleFall`). */
  knock(i: number, fall: number): void;
}

// ---------------------------------------------------------------- driverless cars
/** The pose of a car nobody drives. */
export interface CoastPose { x: number; y: number; z: number; vx: number; vz: number; yaw: number }
/** Its vertical speed and spin (server-side body data). */
export interface CoastSpin { vy: number; yawRate: number }

const _cp: XZ = { x: 0, z: 0 };
const _cn: XZ = { x: 0, z: 0 };

/**
 * A car nobody drives: it coasts, slides, flies and lands. The server runs it for
 * free bodies; the client runs the same code on the car it just stepped out of, so
 * that car keeps rolling forward until the network stream catches up.
 */
export function coastCar(car: CoastPose, kind: number, body: CoastSpin, dt: number, poles?: PoleWorld) {
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  const lx = Math.cos(car.yaw), lz = -Math.sin(car.yaw);
  let vF = car.vx * fx + car.vz * fz;
  let vL = car.vx * lx + car.vz * lz;
  const airborne = car.y > 0.01 || body.vy > 0;
  if (!airborne) {
    const drag = 4 * dt;
    vF = Math.abs(vF) <= drag ? 0 : vF - Math.sign(vF) * drag;
    vL *= Math.max(0, 1 - 5 * dt);
    body.yawRate *= Math.max(0, 1 - 4 * dt);
  } else {
    body.vy -= GRAVITY * dt;
  }
  car.vx = fx * vF + lx * vL;
  car.vz = fz * vF + lz * vL;
  car.yaw += body.yawRate * dt;
  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.y += body.vy * dt;
  if (car.y <= 0) {
    car.y = 0;
    body.vy = body.vy < -5 ? -body.vy * 0.3 : 0;
  }
  collideCarStatic(car, kind, body, poles);
}

/**
 * Push a car (two circles along its body) out of the static world; bounce off walls. With
 * `poles`, it knocks lamp posts over like a driven car does (without, it drives through them).
 */
export function collideCarStatic(car: CoastPose, kind: number, body: CoastSpin | null, poles?: PoleWorld) {
  if (car.y > 1) return;
  const type = CAR_TYPES[kind] ?? CAR_TYPES[0];
  const off = type.halfL - type.halfW;
  const near = poles ? poles.poles(car.x, car.z, type.halfL + POLE_R) : NO_POLES;
  for (const sgn of [1, -1]) {
    const cx = car.x + Math.sin(car.yaw) * off * sgn, cz = car.z + Math.cos(car.yaw) * off * sgn;
    _cp.x = cx; _cp.z = cz;
    if (collideCircle(_cp, 0, type.halfW, true, _cn)) {
      car.x += _cp.x - cx;
      car.z += _cp.z - cz;
      wallBounce(car, body, _cn.x, _cn.z);
    }
    for (let k = 0; k < near.length; k++) {
      const i = near[k];
      if (i < 0 || !poleContact(cx, cz, type.halfW, i, car.vx, car.vz, _pn)) continue;
      const vn = car.vx * _pn.x + car.vz * _pn.z;
      if (vn <= -POLE_KNOCK_SPEED) {
        poles!.knock(i, poleFall(car.vx, car.vz, _pn.x, _pn.z));
        near[k] = -1;
        const loss = Math.min(-vn, POLE_KNOCK_LOSS);
        car.vx += _pn.x * loss;
        car.vz += _pn.z * loss;
      } else {
        car.x += _pn.x * _pn.depth;
        car.z += _pn.z * _pn.depth;
        wallBounce(car, body, _pn.x, _pn.z);
      }
    }
  }
}

/** A driverless car hit a wall (`nx, nz` points away from it): it bounces off. */
function wallBounce(car: CoastPose, body: CoastSpin | null, nx: number, nz: number) {
  const nl = Math.hypot(nx, nz) || 1;
  nx /= nl; nz /= nl;
  const vn = car.vx * nx + car.vz * nz;
  if (vn < 0) {
    car.vx -= 1.3 * vn * nx; car.vz -= 1.3 * vn * nz;
    if (body) body.yawRate *= 0.5;
  }
}

// ---------------------------------------------------------------- grenades
export interface GrenadeLike { x: number; y: number; z: number; vx: number; vy: number; vz: number }

/** A stink bomb flies in sub-steps of this many seconds (the server's step makes two). */
export const GRENADE_SUBSTEP = 1 / 60;
/** Sub-steps from the throw until it goes off. */
export const GRENADE_FUSE_SUBSTEPS = Math.round(GRENADE_FUSE_MS / 1000 / GRENADE_SUBSTEP);
/** Release height above the thrower's feet (m), and how far ahead of them. */
const RELEASE_UP = 1.3, RELEASE_AHEAD = 0.6;
/** On open ground the bounces carry it about this much further than its first landing. */
const BOUNCE_CARRY = 1.4;

/**
 * Launch state of a stink bomb thrown toward `aim`, wound up to `power` (0..1): lobbed to
 * come to rest, on open ground, about GRENADE_MIN_DIST (a tap) to GRENADE_MAX_DIST (full
 * power) metres away, the harder ones arcing higher. Computed inside the shared step
 * (`ctx.thrown`), so the server's grenade and the thrower's predicted one start from the
 * same numbers.
 */
export function grenadeLaunch(p: { x: number; y: number; z: number; vx: number; vz: number; mode: number }, aim: number, power: number): GrenadeLike {
  const dx = Math.sin(aim), dz = Math.cos(aim);
  const k = clamp(power, 0, 1);
  const d = GRENADE_MIN_DIST + (GRENADE_MAX_DIST - GRENADE_MIN_DIST) * k;
  const vy = GRENADE_THROW_UP * (0.8 + 0.4 * k);
  const flight = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * RELEASE_UP)) / GRAVITY;
  const speed = Math.max(0, d - RELEASE_AHEAD) / BOUNCE_CARRY / flight;
  const bvx = p.mode === Mode.Driving ? p.vx : 0, bvz = p.mode === Mode.Driving ? p.vz : 0;
  return {
    x: p.x + dx * RELEASE_AHEAD, y: p.y + RELEASE_UP, z: p.z + dz * RELEASE_AHEAD,
    vx: dx * speed + bvx, vy, vz: dz * speed + bvz,
  };
}

const _g: XZ = { x: 0, z: 0 };

/**
 * Ballistic stink bomb with bounces, against the static map only (cars and people don't stop
 * it). Shared by the server, the thrower's predicted one and `grenadePath`. Returns how hard
 * it hit the ground or a wall this step (m/s into it), 0 for nothing.
 */
export function stepGrenade(g: GrenadeLike, dt: number): number {
  const sub = dt > 0.02 ? 2 : 1;
  const h = dt / sub;
  let hit = 0;
  for (let i = 0; i < sub; i++) {
    g.vy -= GRAVITY * h;
    const prevY = g.y;
    g.x += g.vx * h;
    g.y += g.vy * h;
    g.z += g.vz * h;
    // (falling fast past a roof's edge, it's over the roof: see `stepFoot`)
    const yq = Math.max(prevY, g.y);
    _g.x = g.x; _g.z = g.z;
    if (collideBody(_g, g.y, yq, GRENADE_RADIUS, 2 * GRENADE_RADIUS, _xz)) {
      g.x = _g.x; g.z = _g.z;
      const nl = Math.hypot(_xz.x, _xz.z) || 1;
      const nx = _xz.x / nl, nz = _xz.z / nl;
      const vn = g.vx * nx + g.vz * nz;
      if (vn < 0) {
        g.vx -= 1.6 * vn * nx; g.vz -= 1.6 * vn * nz;
        if (-vn > hit) hit = -vn;
      }
    }
    // up into a floating slab: it bounces back down
    if (g.vy > 0) {
      const ceil = ceilingAbove(g.x, g.z, prevY) - GRENADE_RADIUS;
      if (g.y > ceil) { g.y = ceil; g.vy = -g.vy * 0.3; }
    }
    const floor = groundHeight(g.x, g.z, yq) + GRENADE_RADIUS;
    if (g.y < floor) {
      g.y = floor;
      if (g.vy < 0) {
        if (-g.vy > hit) hit = -g.vy;
        g.vy = -g.vy * 0.42;
      }
      if (g.vy < 1) g.vy = 0;
      g.vx *= 0.72; g.vz *= 0.72;
    }
  }
  return hit;
}

/** A stink bomb's whole flight: see `grenadePath`. */
export interface GrenadePath {
  /** Its position (x, y, z) after each sub-step, from the launch (index 0) on. */
  xyz: Float32Array;
  /** How many positions `xyz` holds (the launch plus one per sub-step). */
  n: number;
  /** The bounces worth a sound and a squash, in pairs: sub-step index, impact speed (m/s). */
  bounces: number[];
  /** The sub-step from which it lies still (`n - 1` if it never does). */
  still: number;
}

export function newGrenadePath(): GrenadePath {
  return { xyz: new Float32Array((GRENADE_FUSE_SUBSTEPS + 1) * 3), n: 0, bounces: [], still: 0 };
}

const _gp: GrenadeLike = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

/**
 * Where a stink bomb launched with `g` (left as it is) will be, sub-step by sub-step, for
 * `steps` sub-steps (by default until its fuse runs out): exactly the server's integration,
 * two sub-steps per fixed step. It only ever meets the static map, so this is its future: the
 * last point is where it goes off. The aim preview, the danger ring and the bounce sounds all
 * read it.
 */
export function grenadePath(g: GrenadeLike, out: GrenadePath = newGrenadePath(), steps = GRENADE_FUSE_SUBSTEPS): GrenadePath {
  const s = _gp;
  s.x = g.x; s.y = g.y; s.z = g.z; s.vx = g.vx; s.vy = g.vy; s.vz = g.vz;
  const n = Math.max(0, Math.min(GRENADE_FUSE_SUBSTEPS, Math.floor(steps)));
  const xyz = out.xyz;
  xyz[0] = s.x; xyz[1] = s.y; xyz[2] = s.z;
  out.bounces.length = 0;
  out.still = n;
  for (let i = 1; i <= n; i++) {
    const hit = stepGrenade(s, GRENADE_SUBSTEP);
    xyz[i * 3] = s.x; xyz[i * 3 + 1] = s.y; xyz[i * 3 + 2] = s.z;
    if (hit > 1.5) out.bounces.push(i, hit);
    if (out.still === n && s.vy === 0 && s.vx * s.vx + s.vz * s.vz < 1e-4) out.still = i;
  }
  out.n = n + 1;
  return out;
}

type NpcBody = { x: number; y: number; z: number; vx: number; vy: number; vz: number };
const _fp: XZ = { x: 0, z: 0 };
const _fn: XZ = { x: 0, z: 0 };

/**
 * One step of a townsperson's flight (a car, a slap or a blast sent them flying): off walls,
 * bouncing off the ground. The server flies them with it and every client reckons them (and its
 * own run-overs) with it, so they all fly the same path, whatever their step. Returns true once
 * they've come to rest.
 */
export function stepNpcFlight(n: NpcBody, dt: number): boolean {
  const vy0 = n.vy, prevY = n.y;
  n.vy -= GRAVITY * dt;
  n.x += n.vx * dt;
  // (exact under gravity whatever the step, so a 16 ms reckon follows a 1/30 s server)
  n.y += (vy0 + n.vy) * 0.5 * dt;
  n.z += n.vz * dt;
  // (over a roof's edge it was over a moment ago, it lands on the roof)
  const yq = Math.max(prevY, n.y);
  _fp.x = n.x; _fp.z = n.z;
  if (collideBody(_fp, n.y, yq, 0.35, 1.7, _fn)) {
    n.x = _fp.x; n.z = _fp.z;
    const nl = Math.hypot(_fn.x, _fn.z) || 1;
    const vn = (n.vx * _fn.x + n.vz * _fn.z) / nl;
    if (vn < 0) { n.vx -= (1.5 * vn * _fn.x) / nl; n.vz -= (1.5 * vn * _fn.z) / nl; }
  }
  const floor = groundHeight(n.x, n.z, yq);
  if (n.y > floor) return false;
  n.y = floor;
  if (n.vy < -5) {
    n.vy = -n.vy * 0.35;
    n.vx *= 0.6; n.vz *= 0.6;
    return false;
  }
  n.vy = 0; n.vx = 0; n.vz = 0;
  return true;
}

/** Client-side dead reckoning for server-driven pedestrians (`Predict` reckon mode). */
export function stepNpcReckon(n: NpcBody, dt: number) {
  if (n.y > 0.01 || n.vy !== 0) stepNpcFlight(n, dt);
  else { n.x += n.vx * dt; n.z += n.vz * dt; }
}
