import type { CameraPiece, CameraState } from '@pmndrs/klipp';

import type { TruckPose } from './race/truck';

/** Where the lens stands from the point it looks at: the original racer's high three-quarter angle. */
export const DIORAMA_OFFSET: readonly [number, number, number] = [9.27, 9.18, 9.27];
/** The lens on a landscape screen, in degrees of vertical field of view. */
export const DIORAMA_FOV = 40;
/** Seconds of the truck's velocity the frame leads it by, up to the dead zone's edge. */
const LEAD = 3;
/** How fast the frame eases after the truck, per second. */
const SMOOTHING = 2;
/** How far the truck roams from the frame's centre on the ground, in metres, before it drags the frame along. */
const DEAD_ZONE = 5;
/** The frame looks this far nearer the lens than the truck, so the truck sits a little above the middle. */
const SHIFT_UP = 1;
/** On a narrow screen the dead zone across it keeps the truck inside this share of half the screen's width. */
const DEAD_ZONE_WIDTH = 0.5;
/** A tall phone pulls the lens back by this share and widens it by this many degrees, to see down the road. */
const PORTRAIT_PULL = 0.5;
const PORTRAIT_WIDEN = 16;
/** The truck moving further than this in a frame was put somewhere, not driven there; the frame cuts with it. */
const JUMP = 4;

const HALF_ROOT2 = Math.SQRT1_2;
/** The lens's right and forward on the ground, from {@link DIORAMA_OFFSET}'s diagonal. */
const RIGHT_X = HALF_ROOT2;
const RIGHT_Z = -HALF_ROOT2;
const FORWARD_X = -HALF_ROOT2;
const FORWARD_Z = -HALF_ROOT2;

/**
 * The Diorama camera's body: the original racer's follow camera. The lens holds a fixed high three-quarter angle and
 * slides over the ground after the truck: the frame leads the truck by its velocity, eases toward that point, and lets
 * the truck roam a dead zone before dragging the frame along. On a tall phone the lens pulls back and widens, and the
 * dead zone narrows across the screen so the truck stays well inside the frame.
 */
export class DioramaBody implements CameraPiece {
  /** The truck it follows. */
  public subject: Readonly<TruckPose> | null = null;
  /** 0 on landscape screens, 1 on a tall phone. */
  public portrait = 0;
  /** Screen width over height. */
  public aspect = 16 / 9;

  /** The point the frame eases toward the truck, on the ground. */
  private _x = 0;
  private _y = 0;
  private _z = 0;
  /** Where the truck was last frame, to tell a jump from a drive. */
  private _lastX = 0;
  private _lastZ = 0;
  private _primed = false;

  /** The lens's vertical field of view this frame, in degrees. */
  public get fov(): number {
    return DIORAMA_FOV + this.portrait * PORTRAIT_WIDEN;
  }

  public update(out: CameraState, dt: number, justActivated: boolean): void {
    const pose = this.subject;

    if (!pose) return;

    const fov = this.fov;
    const scale = 1 + this.portrait * PORTRAIT_PULL;
    const distance = Math.hypot(DIORAMA_OFFSET[0], DIORAMA_OFFSET[1], DIORAMA_OFFSET[2]) * scale;
    const halfWidth = distance * Math.tan((fov * Math.PI) / 360) * this.aspect;
    const across = Math.min(DEAD_ZONE, halfWidth * DEAD_ZONE_WIDTH);
    const vx = Math.sin(pose.heading) * pose.speed;
    const vz = Math.cos(pose.heading) * pose.speed;
    let leadX = (vx * RIGHT_X + vz * RIGHT_Z) * LEAD;
    let leadY = (vx * FORWARD_X + vz * FORWARD_Z) * LEAD;
    const leadOut = (leadX / across) ** 2 + (leadY / DEAD_ZONE) ** 2;

    if (leadOut > 1) {
      const k = 1 / Math.sqrt(leadOut);

      leadX *= k;
      leadY *= k;
    }

    const wantX = pose.x + RIGHT_X * leadX + FORWARD_X * leadY;
    const wantZ = pose.z + RIGHT_Z * leadX + FORWARD_Z * leadY;
    const jumped = Math.hypot(pose.x - this._lastX, pose.z - this._lastZ) > JUMP;

    this._lastX = pose.x;
    this._lastZ = pose.z;

    if (!this._primed || justActivated || jumped) {
      this._x = wantX;
      this._y = pose.y;
      this._z = wantZ;
      this._primed = true;
    } else {
      const alpha = 1 - Math.exp(-dt * SMOOTHING);

      this._x += (wantX - this._x) * alpha;
      this._y += (pose.y - this._y) * alpha;
      this._z += (wantZ - this._z) * alpha;
    }

    // The truck past the dead zone's edge drags the frame along with it.
    const dx = pose.x - this._x;
    const dz = pose.z - this._z;
    const offX = dx * RIGHT_X + dz * RIGHT_Z;
    const offY = dx * FORWARD_X + dz * FORWARD_Z;
    const offOut = (offX / across) ** 2 + (offY / DEAD_ZONE) ** 2;

    if (offOut > 1) {
      const k = 1 - 1 / Math.sqrt(offOut);

      this._x += (RIGHT_X * offX + FORWARD_X * offY) * k;
      this._z += (RIGHT_Z * offX + FORWARD_Z * offY) * k;
    }

    const lookX = this._x - FORWARD_X * SHIFT_UP;
    const lookZ = this._z - FORWARD_Z * SHIFT_UP;

    out.position[0] = lookX + DIORAMA_OFFSET[0] * scale;
    out.position[1] = this._y + DIORAMA_OFFSET[1] * scale;
    out.position[2] = lookZ + DIORAMA_OFFSET[2] * scale;
    out.fov = fov;
  }
}
