import { Plane, Ray, Vector3, type Camera3D, type View3D } from "@pixi/3d";
import { DRIVE_EYE_Y, EYE_Y } from "../shared/hitscan.js";
import { raycastStatic } from "../shared/map.js";
import { wrapAngle } from "../shared/sim.js";

/** The diorama overhead ("top"), or over the raccoon's back ("behind"); C switches. */
export type CamMode = "top" | "behind";

/** Who the behind-the-back camera follows, this frame. */
export interface Behind {
  /** The height they stand (or drive) at, m. */
  y: number;
  /** Which way they face (or their car points), rad: the camera starts out behind that, and in a car swings back behind it. */
  heading: number;
  /** In a car: a longer, higher boom. */
  car: boolean;
  /** Left alone a moment, it swings back behind them as they go (in a car, or someone you watch). */
  swing: boolean;
  /** How fast they go, m/s. */
  speed: number;
  /**
   * On a wall (crawling, facing it): lower, and left alone a moment it tips up to look up the
   * wall; with `swing` (the stick let go: turning would change what a held one means), it turns
   * to face the wall too.
   */
  wall?: boolean;
  /** A gull: further back and looking down on the street (what it's after is down there). */
  gull?: boolean;
}

const TOP_FOV = 36, BEHIND_FOV = 58;
const TOP_NEAR = 6, BEHIND_NEAR = 0.2;
/** Behind: how far up (negative) and down it can look, rad; in a car or on a wall, only this far up. */
const PITCH_MIN = -0.75, PITCH_MAX = 1.15, RIDE_PITCH_MIN = -0.3;
/** Behind: how close over the street the camera comes, looking up (m). */
const CAM_CLEAR = 0.35;
/**
 * Behind, on foot / in a car: boom length (m), pivot over the feet (m), resting pitch (rad). The
 * crosshair's line passes through the pivot, so shots leave from there too (`shotHeight`).
 */
const FOOT = { boom: 4.6, lift: EYE_Y, pitch: 0.2 };
const CAR = { boom: 8, lift: DRIVE_EYE_Y, pitch: 0.17 };
/** …and on a wall: lower, looking up it. */
const WALL = { boom: 4.6, lift: 1.2, pitch: -0.25 };
/** …and a gull: its body's the pivot, the boom longer, looking down on the street. */
const GULL = { boom: 6.5, lift: 0.4, pitch: 0.55 };
/** Switching takes this long (s). */
const SWITCH_S = 0.6;

/**
 * Diorama camera: fixed yaw (north up), high pitch, follows the player with a
 * little look-ahead, zooms out with speed, and shakes on impacts.
 *
 * Or (`mode` "behind") a chase camera over the raccoon's back, turned by the mouse or the right
 * stick (`look`); in a car (or watching someone) it swings back behind them once you stop
 * turning it. A wall behind the raccoon pulls it in. Switching swings from one to the other.
 */
export class CameraRig {
  /** Camera looks along (sin yaw, -, cos yaw); π = looking toward -Z. */
  yaw = Math.PI;
  pitch = 0.88;
  distance = 25;
  /** Distance when standing still (zooming out with speed adds to it). */
  base = 25;
  private targetDistance = 25;
  readonly focus = new Vector3();
  private initialized = false;
  private trauma = 0;
  private t = 0;
  /** Where the camera leans to (winding up a stink bomb: toward where it'll land), eased. */
  private peekX = 0;
  private peekZ = 0;
  private readonly plane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly ray = new Ray();
  private readonly tmp = new Vector3();

  mode: CamMode = "top";
  /** Behind: where it looks (the same convention as `yaw`) and how far down (rad). */
  lookYaw = Math.PI;
  lookPitch = FOOT.pitch;
  /** 0: overhead … 1: behind (eased while switching). */
  private blend = 0;
  /** Behind: the boom's length now (a wall pulls it in at once; it eases back out). */
  private boom = FOOT.boom;
  /** Behind: how far (m) it rises over the pivot while a wall holds the boom in. */
  private rise = 0;
  /** Behind: the pivot it looks at (over the head), and whether it has one yet. */
  private readonly pivot = new Vector3();
  private placed = false;
  /** Behind: seconds since the mouse or stick last turned it (a car's chase cam swings back after a while). */
  private idle = 99;
  /** The lens is set for the behind view (put back once it's all the way overhead again). */
  private lens = false;

  constructor(private view: View3D, private camera: Camera3D) {
    camera.fov = TOP_FOV;
    camera.near = TOP_NEAR;
    camera.far = 600;
  }

  /** How far it is into the behind view (0..1, eased): the tilt-shift and the fog follow it. */
  get behindness() { const b = this.blend; return b * b * (3 - 2 * b); }

  /** The yaw WASD and the stick move along: the view's own. */
  private get moveYaw() { return this.mode === "behind" ? this.lookYaw : this.yaw; }
  /** Screen right / screen up (behind: ahead), as world XZ directions. */
  get right() { const y = this.moveYaw; return { x: -Math.cos(y), z: Math.sin(y) }; }
  get up() { const y = this.moveYaw; return { x: Math.sin(y), z: Math.cos(y) }; }

  /** Switch views (`instant`: no swing, e.g. picking up where the last game left it). */
  setMode(mode: CamMode, instant = false) {
    if (mode === "behind" && this.mode !== "behind") this.placed = false;
    this.mode = mode;
    if (instant) this.blend = mode === "behind" ? 1 : 0;
  }

  /** Behind: turn it (rad; positive `dPitch` looks further down). */
  look(dYaw: number, dPitch: number) {
    if (!dYaw && !dPitch) return;
    this.lookYaw = wrapAngle(this.lookYaw + dYaw);
    this.lookPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.lookPitch + dPitch));
    this.idle = 0;
  }

  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Jump straight to the next focus instead of gliding there (respawns, switching who you watch). */
  cut() {
    this.initialized = false;
    this.placed = false;
    this.peekX = this.peekZ = 0;
  }

  /**
   * `peekX/Z`: an offset (m) to lean the view by on top of the follow, eased in and out (winding
   * up a stink bomb leans toward where it'll land, so a long throw stays on screen).
   * `behind`: who the behind view follows (needed while it's on, or switching).
   */
  update(dt: number, tx: number, ty: number, tz: number, vx: number, vz: number, zoomOut: number, peekX = 0, peekZ = 0, zoomRate = 1.5, behind?: Behind) {
    this.t += dt;
    this.targetDistance = this.base + zoomOut * 15;
    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-zoomRate * dt));
    const pk = 1 - Math.exp(-3.5 * dt);
    this.peekX += (peekX - this.peekX) * pk;
    this.peekZ += (peekZ - this.peekZ) * pk;
    const lead = 0.35;
    const gx = tx + vx * lead + this.peekX, gy = ty, gz = tz + vz * lead + this.peekZ;
    if (!this.initialized) { this.focus.set(gx, gy, gz); this.initialized = true; }
    // exponential follow: the same feel at any frame rate
    const k = 1 - Math.exp(-6 * dt);
    this.focus.x += (gx - this.focus.x) * k;
    this.focus.y += (gy - this.focus.y) * (1 - Math.exp(-3 * dt));
    this.focus.z += (gz - this.focus.z) * k;

    // overhead: (yaw, pitch, distance) around the focus
    let yaw = this.yaw, pitch = this.pitch, dist = this.distance;
    let px = this.focus.x, py = this.focus.y, pz = this.focus.z;

    // behind: around a pivot over the raccoon's head, swung toward while switching
    this.blend = Math.max(0, Math.min(1, this.blend + (this.mode === "behind" ? dt : -dt) / SWITCH_S));
    const s = this.behindness;
    if (behind && (s > 0 || this.mode === "behind")) {
      const b = this.chase(dt, tx, tz, behind);
      yaw += wrapAngle(this.lookYaw - yaw) * s;
      pitch += (this.lookPitch - pitch) * s;
      dist = Math.exp(Math.log(dist) + (Math.log(b) - Math.log(dist)) * s);
      px += (this.pivot.x - px) * s;
      py += (this.pivot.y + this.rise - py) * s;
      pz += (this.pivot.z - pz) * s;
    }
    if (s > 0) {
      this.camera.fov = TOP_FOV + (BEHIND_FOV - TOP_FOV) * s;
      this.camera.near = BEHIND_NEAR;
      this.lens = true;
    } else if (this.lens) {
      this.camera.fov = TOP_FOV;
      this.camera.near = TOP_NEAR;
      this.lens = false;
    }

    const cp = Math.cos(pitch);
    let cx = px - Math.sin(yaw) * cp * dist, cy = py + Math.sin(pitch) * dist, cz = pz - Math.cos(yaw) * cp * dist;
    // behind, it never dips under the street (looking up from low down)
    if (behind && s > 0) cy = Math.max(cy, behind.y + CAM_CLEAR);

    // trauma shake (squared for a nice falloff); a camera 5 m away shakes less far than one 25 m up
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const tr = this.trauma * this.trauma * (1 - 0.8 * s);
    let ox = 0, oz = 0;
    if (tr > 0) {
      const n = (o: number) => Math.sin(this.t * 37 + o) * 0.6 + Math.sin(this.t * 59 + o * 2.3) * 0.4;
      ox = n(1) * tr * 1.2;
      cy += n(2) * tr * 0.8;
      oz = n(3) * tr * 1.2;
    }
    this.camera.position.set(cx + ox, cy, cz + oz);
    this.camera.lookAt(this.tmp.set(px + ox, py, pz + oz));
  }

  /** Behind: move the pivot and the boom for this frame; returns the boom's length. */
  private chase(dt: number, tx: number, tz: number, b: Behind): number {
    const rig = b.car ? CAR : b.wall ? WALL : b.gull ? GULL : FOOT;
    const py = b.y + rig.lift;
    this.idle += dt;
    if (!this.placed) {
      // a fresh start (switching, a respawn, someone else to watch): right behind them
      this.placed = true;
      this.pivot.set(tx, py, tz);
      this.lookYaw = wrapAngle(b.heading);
      this.lookPitch = rig.pitch;
      this.boom = rig.boom;
      this.idle = 99;
    }
    // no lag across the street (the aim runs from the raccoon along the view), a little up and down (hops)
    this.pivot.x = tx;
    this.pivot.z = tz;
    this.pivot.y += (py - this.pivot.y) * (1 - Math.exp(-10 * dt));
    // in a car (or watching someone), left alone for a moment, it swings back behind them (only
    // while they move; on a wall, whenever it may)
    if (b.swing && this.idle > 1) {
      const k = 1 - Math.exp(-2.5 * (b.wall ? 1 : Math.min(1, b.speed / 4)) * dt);
      this.lookYaw = wrapAngle(this.lookYaw + wrapAngle(b.heading - this.lookYaw) * k);
      this.lookPitch += (rig.pitch - this.lookPitch) * k;
    }
    // (on a wall, the stick held, it doesn't turn, but it does look up the wall)
    else if (b.wall && this.idle > 1) this.lookPitch += (rig.pitch - this.lookPitch) * (1 - Math.exp(-2.5 * dt));
    // the boom: longer with speed, pulled in front of a wall that's taller than the pivot
    if ((b.car || b.wall) && this.lookPitch < RIDE_PITCH_MIN) this.lookPitch = RIDE_PITCH_MIN;
    let want = rig.boom + (b.car ? Math.min(2.5, b.speed * 0.1) : 0);
    // on foot, looking up (at a roof), it comes in along its line rather than down into the street
    if (!b.car && !b.wall && !b.gull && this.lookPitch < 0) want = Math.min(want, Math.max(0.8, (rig.lift - CAM_CLEAR) / Math.sin(-this.lookPitch)));
    const cp = Math.max(0.2, Math.cos(this.lookPitch));
    const flat = want * cp;
    // (a slab overhead clear of the whole boom, a billboard's panel or a landing, isn't in the way)
    const over = this.pivot.y + Math.max(0, Math.sin(this.lookPitch)) * want + 0.3;
    const hit = raycastStatic(tx, tz, -Math.sin(this.lookYaw), -Math.cos(this.lookYaw), flat + 0.5, this.pivot.y - 0.2, over);
    const room = hit < flat + 0.5 ? Math.max(0.6, (hit - 0.45) / cp) : want;
    this.boom = room < this.boom ? room : this.boom + (room - this.boom) * (1 - Math.exp(-3 * dt));
    // pulled in close, it rises a little to look over the head (not into the back of it; any
    // higher and the raccoon would drop out of the bottom of the screen)
    this.rise = 0.15 * Math.max(0, 1 - this.boom / want);
    return this.boom;
  }

  /** The ray from the camera through a screen point (shared: read it before the next call). */
  rayAt(screenX: number, screenY: number): Ray {
    return this.view.screenToRay({ x: screenX, y: screenY }, this.ray);
  }

  /** Where the mouse ray meets the horizontal plane at height `y`. */
  pick(screenX: number, screenY: number, y: number, out: Vector3): Vector3 | null {
    this.plane.constant = -y;
    return this.view.screenToWorld({ x: screenX, y: screenY }, this.plane, out);
  }

  /**
   * Where the ray through a screen point meets the street, but at most `maxR` m out from the
   * camera (a ray over the horizon: `maxR` out that way). Only x and z are set.
   */
  reach(screenX: number, screenY: number, maxR: number, out: Vector3): Vector3 {
    const r = this.view.screenToRay({ x: screenX, y: screenY }, this.ray);
    const o = r.origin, d = r.direction, flat = Math.hypot(d.x, d.z) || 1e-6;
    let t = maxR / flat;
    if (d.y < -1e-6) t = Math.min(t, -o.y / d.y);
    return out.set(o.x + d.x * t, 0, o.z + d.z * t);
  }
}
