/**
 * What every module knows about a truck without drawing one: its paint jobs, its size, where its wheels sit, and the
 * pose snapshot that describes one frame of it. A local or bot truck writes its pose from physics; a remote truck is
 * posed from one received over the network. Pure and renderer-free.
 */

/** The four paint jobs, by colour index. */
export const TRUCK_COLORS = [
  { name: 'YELLOW', asset: 'vehicle-truck-yellow', paint: 0xffc93c, label: 'YEL' },
  { name: 'GREEN', asset: 'vehicle-truck-green', paint: 0x5ad06a, label: 'GRN' },
  { name: 'PURPLE', asset: 'vehicle-truck-purple', paint: 0xb05cff, label: 'PUR' },
  { name: 'RED', asset: 'vehicle-truck-red', paint: 0xff4d4d, label: 'RED' },
] as const;

/** How many trucks race at once, one per colour. */
export const MAX_RACERS = TRUCK_COLORS.length;

/** Wheel centres in the root's frame (+z forward, +x to the truck's left): front-left, front-right, back-left, back-right. */
export const WHEEL_LOCAL: readonly (readonly [number, number, number])[] = [
  [0.275, 0.15, 0.4285],
  [-0.275, 0.15, 0.4285],
  [0.275, 0.15, -0.3285],
  [-0.275, 0.15, -0.3285],
];

export const WHEEL_RADIUS = 0.15;

/** Where boost flames leave the truck, in the root's frame. */
export const EXHAUST_LOCAL: readonly [number, number, number] = [0, 0.32, -0.95];

/** Height of the point the body pitches and rolls about, above the root. */
export const BODY_PIVOT = 0.15;

/**
 * One frame of a truck: everything needed to draw it and its effects, and nothing about how it was driven. This is
 * what the netcode sends about each truck, about 20 times a second.
 */
export interface TruckPose {
  /** Root position: on the ground under the body's centre. */
  x: number;
  y: number;
  z: number;
  /** Body facing: forward is `(sin yaw, 0, cos yaw)`. */
  yaw: number;
  /** Body pitch, nose down positive, in radians. */
  pitch: number;
  /** Body roll, in radians. */
  roll: number;
  /** Ground speed, world units per second. */
  speed: number;
  /** Direction of travel, as a yaw; differs from `yaw` in a drift. */
  heading: number;
  /** Front-wheel steer, -1 full left to 1 full right. */
  steer: number;
  /** Throttle, -1 full reverse to 1 full ahead. */
  throttle: number;
  /** How hard it is sliding; above about 0.7 the tyres smoke and leave marks. */
  drift: number;
  /** The drift charge's stage: 0 none, 1 and 2 building (blue sparks), 3 the ultra boost ready (purple). */
  charge: number;
  /** Whether a boost is firing. */
  boosting: boolean;
}

/**
 * A pose at rest at the origin.
 * @returns New pose.
 */
export function createTruckPose(): TruckPose {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    heading: 0,
    steer: 0,
    throttle: 0,
    drift: 0,
    charge: 0,
    boosting: false,
  };
}

/**
 * Copy every field of a pose.
 * @param from - Source.
 * @param out - Receives the copy.
 * @returns `out`.
 */
export function copyTruckPose(from: Readonly<TruckPose>, out: TruckPose): TruckPose {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  out.yaw = from.yaw;
  out.pitch = from.pitch;
  out.roll = from.roll;
  out.speed = from.speed;
  out.heading = from.heading;
  out.steer = from.steer;
  out.throttle = from.throttle;
  out.drift = from.drift;
  out.charge = from.charge;
  out.boosting = from.boosting;

  return out;
}

/**
 * The signed shortest turn from angle `a` to angle `b`.
 * @param a - From, radians.
 * @param b - To, radians.
 * @returns `b - a` wrapped into -PI to PI.
 */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);

  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;

  return d;
}

/**
 * A point on a truck in world space, from a position in its root's frame (+z forward, +x to its left, y up), turned by
 * its pitch and roll about {@link BODY_PIVOT} and then its yaw.
 * @param pose - The truck's pose.
 * @param lx - Local x.
 * @param ly - Local y, from the ground.
 * @param lz - Local z.
 * @param out - Receives the world point.
 * @returns `out`.
 */
export function truckPoint<T extends { x: number; y: number; z: number }>(
  pose: Readonly<TruckPose>,
  lx: number,
  ly: number,
  lz: number,
  out: T,
): T {
  const cr = Math.cos(pose.roll);
  const sr = Math.sin(pose.roll);
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  const y0 = ly - BODY_PIVOT;
  // Roll about z, then pitch about x (nose down positive), then yaw about y.
  const x1 = lx * cr - y0 * sr;
  const y1 = lx * sr + y0 * cr;
  const y2 = y1 * cp - lz * sp;
  const z2 = lz * cp + y1 * sp;

  out.x = pose.x + x1 * cy + z2 * sy;
  out.y = pose.y + BODY_PIVOT + y2;
  out.z = pose.z - x1 * sy + z2 * cy;

  return out;
}
