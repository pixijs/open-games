import type { CameraState } from '@pmndrs/klipp';
import { hardLookAt } from '@pmndrs/klipp';

import { lookToFrame } from './framing';
import { clamp, lerp, smoothstep } from './MathUtils';
import type { Occluders } from './Occluders';
import type { CourseView } from './race/course';
import type { TruckPose } from './race/truck';
import { angleDelta } from './race/truck';
import { Spring } from './Spring';

/** Where a chase stands on one shape of screen. */
interface ChaseArm {
  /** How far behind the truck the lens stands. */
  readonly back: number;
  /** How high above the road. */
  readonly height: number;
  /** Where the truck's middle sits down the screen, 0 top to 1 bottom. */
  readonly middle: number;
}

/** How a chase frames its truck and how quickly it eases after it. */
export interface ChaseFraming {
  /** On a landscape screen and on a tall phone, blended by how portrait the screen is. */
  readonly wide: ChaseArm;
  readonly tall: ChaseArm;
  /** Where the truck's middle sits on a short landscape phone. */
  readonly shortMiddle: number;
  /** At top speed the lens rises this much; it falls back by itself, trailing the truck. */
  readonly speedRise: number;
  /** How much the lens's bearing follows the road behind the truck, rather than the way the truck itself is going. */
  readonly routeFollow: number;
  /** The most the view leans toward the road ahead, as a share of half the screen's width. */
  readonly maxShift: number;
  /** The bearing the lens swings to is eased over this half-life first, so even its acceleration never jumps. */
  readonly bearingHalfLife: number;
  /**
   * Smoothing times, in seconds, of the lens's bearing round the truck, its lean, its angle up from the truck, and its
   * arm pulling in and easing out. Each runs on a spring, so the lens never jolts when what it follows jumps: a truck
   * knocked sideways in a crash, or the scenery making it change its mind.
   */
  readonly yawTime: number;
  readonly leanTime: number;
  readonly elevationTime: number;
  readonly armInTime: number;
  readonly armOutTime: number;
}

/**
 * The race's chase. A tall phone stands higher, so its height shows the road ahead its narrow frame can't show to the
 * sides; a short landscape phone, where the touch stick and the speed dial fill the bottom third of the screen, sets
 * the truck higher, so the player never loses it among the controls.
 */
const RACE_CHASE: ChaseFraming = {
  wide: { back: 4.5, height: 2.05, middle: 0.68 },
  tall: { back: 4.4, height: 3.3, middle: 0.67 },
  shortMiddle: 0.55,
  speedRise: 0.15,
  routeFollow: 0.7,
  maxShift: 0.36,
  bearingHalfLife: 0.05,
  yawTime: 0.15,
  leanTime: 0.35,
  elevationTime: 0.25,
  armInTime: 0.12,
  armOutTime: 0.6,
};

/**
 * The lens rides on a point that follows the truck on a spring this quick, in seconds, rather than on the truck itself:
 * a crash turns the truck in an instant, and the lens would turn with it. It trails the truck by its speed times this.
 */
const ANCHOR_TIME = 0.06;
/** The point on the truck the lens keeps in sight, above its root. */
const FOCUS_Y = 0.45;
/** The lens never sinks lower than this above the truck's root. */
const MIN_LENS_Y = 1;
/** The road behind is read this far either side of the centreline at most, so a truck on the verge doesn't swing it. */
const TRAIL_LATERAL = 2.6;
/**
 * Through a corner the view leans toward the road this far ahead of the truck, moving the truck across the screen by
 * this share of half the screen's width per radian the road turns, and never more than {@link ChaseFraming.maxShift},
 * so even a tall phone's narrow frame keeps the truck well inside it.
 */
const LOOK_AHEAD = 7;
const SHIFT_PER_TURN = 0.4;
/**
 * Seeing past the scenery: the sight line to the truck stays this far from any tree, pole, beam or the arch, and the
 * lens this far from them. When the line is blocked, the lens tries swinging up or down by these angles, in this order,
 * and takes the first that keeps at least {@link GOOD_ARM} of its arm, or else whichever keeps the most; it never pulls
 * in closer than {@link MIN_ARM}.
 */
const SIGHT_PAD = 0.3;
const LENS_CLEARANCE = 0.6;
/** Nothing stands closer than this to the side of the lens either, where it would fill the edge of the frame. */
const LENS_ROOM = 0.9;
/** The arm pulls in by this much at a time to find that room. */
const ROOM_STEP = 0.4;
const ELEVATIONS: readonly number[] = [0, 0.17, -0.12, 0.35, 0.55, 0.8];
const GOOD_ARM = 0.92;
const MIN_ARM = 2.2;
/** The truck moving further than this in a frame was put somewhere, not driven there; the lens cuts with it. */
const JUMP = 4;
/**
 * A body not run for this many milliseconds starts afresh on the truck. One run every frame carries straight on, even
 * across its camera going live, so a shot that ran it while handing over (the start shot) cuts to it without a jump.
 */
const STALE_MS = 150;

const _spot = { s: 0, lateral: 0, heading: 0 };
const _point = { x: 0, y: 0, z: 0 };
const _look: [number, number, number] = [0, 0, 0];
const _truck: [number, number, number] = [0, 0, 0];

/**
 * The chase camera's body, a klipp piece: a lens on an arm behind and above the truck that swings round it rather than
 * cutting across, so a spin or a reverse never brings the lens into the truck.
 *
 * Its bearing follows the road behind the truck more than the truck's own heading, so through a corner the lens trails
 * along the tarmac the truck just drove instead of swinging wide over the barriers into the trees, and the view leans
 * toward the road ahead. When scenery would block the truck, the arm swings up or down, or pulls in, and eases back out
 * once the way is clear. It aims itself, putting the truck in the lower part of the frame.
 */
export class ChaseBody {
  /** The truck to chase; the rig sets it every frame. */
  public subject: Readonly<TruckPose> | null = null;
  /** 0 on a landscape screen, 1 on a tall phone. */
  public portrait = 0;
  /** 0 on a screen tall enough for the truck to sit below the middle, 1 on a short landscape phone. */
  public short = 0;
  /** The truck's speed, 0 at rest to 1 at top speed. */
  public speed = 0;
  /** The lens's vertical field of view in degrees, for placing the truck on screen. */
  public fov = 56;
  /** The screen's width over its height. */
  public aspect = 16 / 9;
  /** Where the truck sits across the screen on a straight, 0 left to 1 right. */
  public across = 0.5;
  /** Radians the arm turns round the truck from where the road puts it; positive swings the lens to the driver's right. */
  public swing = 0;

  private readonly _occluders: Occluders;
  private readonly _course: CourseView;
  private readonly _framing: ChaseFraming;
  /** The bearing the lens swings to, eased, and the lens's bearing round the truck. */
  private _bearing = 0;
  private readonly _yaw = new Spring();
  /** The point the lens rides on. */
  private readonly _anchor: readonly Spring[] = [new Spring(), new Spring(), new Spring()];
  private readonly _anchorAt: [number, number, number] = [0, 0, 0];
  private readonly _lean = new Spring();
  /** Which of {@link ELEVATIONS} the lens is swinging to. */
  private _choice = 0;
  private readonly _elevation = new Spring();
  private readonly _arm = new Spring();
  private _lastX = 0;
  private _lastZ = 0;
  private _ranAt = -Infinity;

  /**
   * @param occluders - The scenery the lens sees past.
   * @param course - The track, whose road the lens follows.
   * @param framing - How it frames its truck; the race's chase by default.
   */
  constructor(occluders: Occluders, course: CourseView, framing: ChaseFraming = RACE_CHASE) {
    this._occluders = occluders;
    this._course = course;
    this._framing = framing;
  }

  /**
   * How much of its arm the lens keeps swung to an elevation: up to where the sight line from the truck first meets
   * the scenery, less the lens's clearance, and short of anything standing beside the lens. -1 when it would sink too
   * low. The arm hangs off the anchor, which trails the truck by a little.
   */
  private _kept(
    elevation: number,
    truck: readonly number[],
    anchor: readonly number[],
    bx: number,
    bz: number,
    reach: number,
  ): number {
    const ce = Math.cos(elevation);
    const se = Math.sin(elevation);

    if (se * reach + FOCUS_Y < MIN_LENS_Y) return -1;

    const length = reach + LENS_CLEARANCE;
    const ax = anchor[0];
    const ay = anchor[1] + FOCUS_Y;
    const az = anchor[2];
    const t = this._occluders.segmentHit(
      truck[0],
      truck[1] + FOCUS_Y,
      truck[2],
      ax + bx * ce * length,
      ay + se * length,
      az + bz * ce * length,
      SIGHT_PAD,
    );
    let kept = t >= 1 ? reach : Math.max(0, t * length - LENS_CLEARANCE);

    while (
      kept > MIN_ARM &&
      this._occluders.contains(ax + bx * ce * kept, ay + se * kept, az + bz * ce * kept, LENS_ROOM)
    ) {
      kept -= ROOM_STEP;
    }

    return kept;
  }

  public update(out: CameraState, dt: number): void {
    const pose = this.subject;

    if (!pose) return;

    const now = performance.now();
    const snap =
      now - this._ranAt > STALE_MS || Math.hypot(pose.x - this._lastX, pose.z - this._lastZ) > JUMP || dt <= 0;

    this._ranAt = now;

    this._lastX = pose.x;
    this._lastZ = pose.z;

    const framing = this._framing;
    const portrait = this.portrait;
    const back = lerp(framing.wide.back, framing.tall.back, portrait);
    const height = lerp(framing.wide.height, framing.tall.height, portrait) + this.speed * framing.speedRise;

    // The way the truck is going once it's moving forward, else the way it faces, so reversing keeps the lens behind.
    const moving = smoothstep(Math.cos(pose.heading - pose.yaw) / 0.5) * smoothstep((pose.speed - 0.5) / 2.5);
    const travel = pose.yaw + angleDelta(pose.yaw, pose.heading) * moving;

    const route = this._course.route;

    route.project(pose.x, pose.z, _spot);

    // How much the road's direction counts: not at all for a truck facing back down the track.
    const along = smoothstep((Math.cos(angleDelta(_spot.heading, travel)) - 0.2) / 0.5);

    route.point(_spot.s - back, clamp(_spot.lateral, -TRAIL_LATERAL, TRAIL_LATERAL), _point);

    const trail = Math.atan2(pose.x - _point.x, pose.z - _point.z);
    const ahead = route.point(_spot.s + LOOK_AHEAD, 0, _point);
    const yaw = travel + angleDelta(travel, trail) * framing.routeFollow * along + this.swing;
    const shift = clamp(angleDelta(yaw, ahead) * SHIFT_PER_TURN, -framing.maxShift, framing.maxShift) * along;
    const offset = 2 * this.across - 1;
    const lean = Math.atan((shift + offset) * this.aspect * Math.tan((this.fov * Math.PI) / 360));

    const [anchorX, anchorY, anchorZ] = this._anchor;
    const anchor = this._anchorAt;

    if (snap) {
      this._bearing = yaw;
      this._yaw.reset(yaw);
      this._lean.reset(lean);
      anchorX.reset(pose.x);
      anchorY.reset(pose.y);
      anchorZ.reset(pose.z);
    } else {
      const yawNow = this._yaw.value;

      this._bearing += angleDelta(this._bearing, yaw) * (1 - Math.pow(2, -dt / framing.bearingHalfLife));
      this._yaw.update(yawNow + angleDelta(yawNow, this._bearing), framing.yawTime, dt);
      this._lean.update(lean, framing.leanTime, dt);
      anchorX.update(pose.x, ANCHOR_TIME, dt);
      anchorY.update(pose.y, ANCHOR_TIME, dt);
      anchorZ.update(pose.z, ANCHOR_TIME, dt);
    }

    anchor[0] = anchorX.value;
    anchor[1] = anchorY.value;
    anchor[2] = anchorZ.value;

    const fx = pose.x;
    const fy = pose.y + FOCUS_Y;
    const fz = pose.z;

    _truck[0] = pose.x;
    _truck[1] = pose.y;
    _truck[2] = pose.z;

    const ax = anchor[0];
    const ay = anchor[1] + FOCUS_Y;
    const az = anchor[2];
    const bx = -Math.sin(this._yaw.value);
    const bz = -Math.cos(this._yaw.value);
    const rise = height - FOCUS_Y;
    const reach = Math.hypot(back, rise);
    const base = Math.atan2(rise, back);
    const good = reach * GOOD_ARM;
    // Back to the plain arm whenever it's clear; else hold the swing already chosen while it still works, so the lens
    // doesn't flip between two that both do; else the first that works, or whichever keeps the most arm.
    let choice = 0;
    let arm = this._kept(base, _truck, anchor, bx, bz, reach);

    if (arm < good && this._choice > 0) {
      choice = this._choice;
      arm = this._kept(base + ELEVATIONS[choice], _truck, anchor, bx, bz, reach);
    }

    for (let i = 1; i < ELEVATIONS.length && arm < good; i++) {
      const kept = this._kept(base + ELEVATIONS[i], _truck, anchor, bx, bz, reach);

      if (kept >= good || kept > arm + 0.05) {
        choice = i;
        arm = kept;
      }
    }

    this._choice = choice;

    const elevation = base + ELEVATIONS[choice];

    arm = Math.min(reach, Math.max(MIN_ARM, arm));

    if (snap) {
      this._elevation.reset(elevation);
      this._arm.reset(arm);
    } else {
      this._elevation.update(elevation, framing.elevationTime, dt);
      this._arm.update(arm, arm < this._arm.value ? framing.armInTime : framing.armOutTime, dt);
    }

    const ce = Math.cos(this._elevation.value);
    const length = this._arm.value;
    const lx = ax + bx * ce * length;
    const ly = Math.max(pose.y + MIN_LENS_Y, ay + Math.sin(this._elevation.value) * length);
    const lz = az + bz * ce * length;

    out.position[0] = lx;
    out.position[1] = ly;
    out.position[2] = lz;
    hardLookAt.update(out, lookToFrame(_look, lx, ly, lz, fx, fy, fz, this._middle(), this.fov, this._lean.value));
  }

  /** Where the truck's middle sits down the screen, 0 top to 1 bottom. */
  private _middle(): number {
    const framing = this._framing;

    return lerp(lerp(framing.wide.middle, framing.tall.middle, this.portrait), framing.shortMiddle, this.short);
  }
}
