import type { Pose } from './schema';

/** A truck's pose: what `Session.sample` fills in, as `Seat.pose` describes each field */
export interface TruckPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  steer: number;
  drift: number;
  charge: number;
  boosting: boolean;
}

/** How far past its newest pose a remote truck carries on when updates stall, before it waits */
const EXTRAPOLATE_MS = 150;
/**
 * A truck that moved further between two poses than its reported speed could take it, by this factor plus
 * {@link SNAP_SLACK} metres, or further than {@link SNAP_DISTANCE} however fast, was placed, not driven: it jumps there
 * rather than gliding across the track, as it does when it's put back on the road
 */
const SNAP_SPEED_FACTOR = 2;
const SNAP_SLACK = 1.5;
const SNAP_DISTANCE = 12;

const wrapAngle = (angle: number): number => angle - Math.PI * 2 * Math.round(angle / (Math.PI * 2));

/** Field offsets of one pose in a {@link PoseTrack}'s buffer */
const T = 0;
const X = 1;
const Y = 2;
const Z = 3;
const YAW = 4;
const PITCH = 5;
const ROLL = 6;
const SPEED = 7;
const STEER = 8;
const DRIFT = 9;
const CHARGE = 10;
const BOOSTING = 11;
const FIELDS = 12;
const HISTORY = 16;

/** The last poses of one truck, by the room time they were taken, for drawing it a little in the past */
export class PoseTrack {
  private readonly _data = new Float64Array(HISTORY * FIELDS);
  private _head = 0;
  private _count = 0;

  public push(pose: Pose): void {
    const data = this._data;

    if (pose.t === 0) return;
    if (this._count > 0) {
      const head = this._head * FIELDS;

      if (pose.t <= data[head + T]) return;
      const dx = pose.x - data[head + X];
      const dy = pose.y - data[head + Y];
      const dz = pose.z - data[head + Z];
      const speed = Math.max(Math.abs(pose.speed), Math.abs(data[head + SPEED]));
      const reach = Math.min(
        SNAP_DISTANCE,
        SNAP_SLACK + (speed * SNAP_SPEED_FACTOR * (pose.t - data[head + T])) / 1000,
      );

      if (dx * dx + dy * dy + dz * dz > reach * reach) this._count = 0;
    }
    this._head = (this._head + 1) % HISTORY;
    const at = this._head * FIELDS;

    data[at + T] = pose.t;
    data[at + X] = pose.x;
    data[at + Y] = pose.y;
    data[at + Z] = pose.z;
    data[at + YAW] = pose.yaw;
    data[at + PITCH] = pose.pitch;
    data[at + ROLL] = pose.roll;
    data[at + SPEED] = pose.speed;
    data[at + STEER] = pose.steer;
    data[at + DRIFT] = pose.drift;
    data[at + CHARGE] = pose.charge;
    data[at + BOOSTING] = pose.boosting ? 1 : 0;
    this._count = Math.min(HISTORY, this._count + 1);
  }

  /** Forgets every pose: a new race starts from the grid, and must never glide there from where the last one ended */
  public reset(): void {
    this._count = 0;
  }

  /** The pose at room time `t`: between the two poses round it, or carried on past the newest for a moment */
  public sample(t: number, out: TruckPose): boolean {
    if (this._count === 0) return false;
    const data = this._data;
    let newer = this._head;

    if (t >= data[newer * FIELDS + T]) {
      if (this._count === 1) {
        this._write(newer, newer, 0, out);

        return true;
      }
      const older = (newer + HISTORY - 1) % HISTORY;
      const span = data[newer * FIELDS + T] - data[older * FIELDS + T];
      const ahead = Math.min(t - data[newer * FIELDS + T], EXTRAPOLATE_MS);

      this._write(older, newer, 1 + ahead / span, out);

      return true;
    }
    for (let i = 1; i < this._count; i++) {
      const older = (this._head + HISTORY - i) % HISTORY;
      const olderT = data[older * FIELDS + T];

      if (olderT <= t) {
        this._write(older, newer, (t - olderT) / (data[newer * FIELDS + T] - olderT), out);

        return true;
      }
      newer = older;
    }
    this._write(newer, newer, 0, out);

    return true;
  }

  /** Writes the pose `k` of the way from slot `a` to slot `b`; past 1 it carries on along the same line */
  private _write(a: number, b: number, k: number, out: TruckPose): void {
    const data = this._data;
    const pa = a * FIELDS;
    const pb = b * FIELDS;
    const late = k < 0.5 ? pa : pb;

    out.x = this._lerp(pa, pb, X, k);
    out.y = this._lerp(pa, pb, Y, k);
    out.z = this._lerp(pa, pb, Z, k);
    out.yaw = wrapAngle(data[pa + YAW] + wrapAngle(data[pb + YAW] - data[pa + YAW]) * k);
    out.pitch = this._lerp(pa, pb, PITCH, k);
    out.roll = this._lerp(pa, pb, ROLL, k);
    out.speed = this._lerp(pa, pb, SPEED, k);
    out.steer = this._lerp(pa, pb, STEER, k);
    out.drift = this._lerp(pa, pb, DRIFT, k);
    out.charge = data[late + CHARGE];
    out.boosting = data[late + BOOSTING] === 1;
  }

  private _lerp(pa: number, pb: number, field: number, k: number): number {
    return this._data[pa + field] + (this._data[pb + field] - this._data[pa + field]) * k;
  }
}
