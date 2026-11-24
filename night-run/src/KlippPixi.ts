import type { CameraState, KlippOptions } from '@kvvasuu/klipp';
import { createCameraState, Klipp, updateHardLookAt } from '@kvvasuu/klipp';
import type { Camera3D } from '@pixi/3d';

/** How long the lens's own motion carries into a blend, as a decay time in seconds. */
const CARRY_SECONDS = 0.35;
/** A blend cranes up over whatever lies between its two shots: this much lift per metre apart, at most this much. */
const ARC_PER_METRE = 0.18;
const MAX_ARC = 5;
/** Motion faster than this was a cut, not a move, and a blend doesn't carry it on. */
const CUT_SPEED = 40;
const CUT_TURN = 6;

/**
 * Klipp for Pixi 3D: puts the shot Klipp picks and blends onto a {@link Camera3D}.
 *
 * Klipp's core never touches a renderer, so the integration is this `write` override plus seeding new virtual cameras
 * from the camera's current pose. Both sides agree on conventions (cameras face -Z, Y up, FOV in degrees), so the state
 * copies across field for field.
 *
 * Klipp blends from a still snapshot of the shot on screen when the blend began, so a lens that was moving stops
 * dead on the blend's first frame. This layer carries the lens's last motion into the blend instead: the snapshot
 * coasts on at the speed and turn it had, slowing over {@link CARRY_SECONDS}, weighted out as the blend completes, so
 * every move eases out of the last one. A long blend also cranes up through its middle, so it flies over the trees and
 * barriers between two shots rather than through them.
 */
export class KlippPixi extends Klipp {
  public readonly camera: Camera3D;

  private _dt = 0;
  private _frame = 0;
  private _writtenFrame = -1;
  /** The pose written last frame, and how fast it was moving and turning then. */
  private readonly _last = createCameraState();
  private readonly _velocity: [number, number, number] = [0, 0, 0];
  /** Turn per second as an axis scaled by its rate, in world space. */
  private readonly _spin: [number, number, number] = [0, 0, 0];
  /** The blend the motion is carrying into, how long it's run, and the motion it carries. */
  private _carryTo: string | null = null;
  private _carryTime = 0;
  private readonly _carryVelocity: [number, number, number] = [0, 0, 0];
  private readonly _carrySpin: [number, number, number] = [0, 0, 0];
  /** How far the blend under way cranes up at its middle. */
  private _arc = 0;
  /** The blend's weight this frame, 0 at its start to 1 at its end. */
  private _weight = 1;
  /** A craned-up lens, re-aimed at what the blend looks at. */
  private readonly _craned = createCameraState();

  constructor(camera: Camera3D, options: Omit<KlippOptions, 'initialCameraState'> = {}) {
    super({ ...options, initialCameraState: readCameraState(camera) });
    this.camera = camera;
  }

  public override update(dt: number): boolean {
    this._dt = dt;
    this._frame++;

    return super.update(dt);
  }

  protected override write(shot: CameraState, transformChanged: boolean, lensChanged: boolean): void {
    const camera = this.camera;

    if (transformChanged) {
      const p = shot.position;
      const keep = this._carry();
      const lift = this._arc * 4 * this._weight * (1 - this._weight);
      const v = this._carryVelocity;
      const s = this._carrySpin;
      const x = p[0] + v[0] * keep;
      const y = p[1] + v[1] * keep + lift;
      const z = p[2] + v[2] * keep;
      let q = shot.quaternion;

      // Craned up, the lens tilts down to keep what it looks at where it was in frame.
      if (lift > 0.01 && shot.hasLookAtTarget) {
        const craned = this._craned;

        craned.position[0] = x;
        craned.position[1] = y;
        craned.position[2] = z;
        updateHardLookAt(craned, shot.lookAtTarget);
        q = craned.quaternion;
      }

      // The carried turn, as a small rotation applied in world space ahead of the shot's own.
      const hx = s[0] * keep * 0.5;
      const hy = s[1] * keep * 0.5;
      const hz = s[2] * keep * 0.5;
      const hw = Math.sqrt(Math.max(0, 1 - hx * hx - hy * hy - hz * hz));
      const qx = hw * q[0] + hx * q[3] + hy * q[2] - hz * q[1];
      const qy = hw * q[1] - hx * q[2] + hy * q[3] + hz * q[0];
      const qz = hw * q[2] + hx * q[1] - hy * q[0] + hz * q[3];
      const qw = hw * q[3] - hx * q[0] - hy * q[1] - hz * q[2];

      camera.position.set(x, y, z);
      camera.quaternion.set(qx, qy, qz, qw);
      this._track(x, y, z, qx, qy, qz, qw);
    }

    if (lensChanged) {
      camera.fov = shot.fov;
      camera.near = shot.near;
      camera.far = shot.far;
    }
  }

  /**
   * How much of the carried motion to add this frame: the distance coasted so far, faded out as the blend completes.
   * A new blend picks up the motion the lens had on the frame before it.
   * @returns Seconds of the carried velocity to add.
   */
  private _carry(): number {
    const transition = this.state.blend.transition;
    const definition = transition.definition;

    if (!transition.active || !definition) {
      this._carryTo = null;
      this._weight = 1;

      return 0;
    }

    if (transition.toId !== this._carryTo) {
      const moving = this._writtenFrame === this._frame - 1;
      const to = transition.toId === null ? undefined : this.state.cameras.get(transition.toId)?.state.position;
      const from = transition.from.position;

      this._carryTo = transition.toId;
      this._carryTime = 0;
      this._arc = to ? Math.min(MAX_ARC, Math.hypot(to[0] - from[0], to[2] - from[2]) * ARC_PER_METRE) : 0;
      carryInto(this._carryVelocity, this._velocity, moving ? CUT_SPEED : 0);
      carryInto(this._carrySpin, this._spin, moving ? CUT_TURN : 0);
    }

    this._carryTime += this._dt;

    const t =
      definition.damping !== undefined
        ? transition.progress
        : definition.time <= 0
          ? 1
          : definition.curve(Math.min(1, transition.elapsed / definition.time));

    this._weight = t;

    return CARRY_SECONDS * (1 - Math.exp(-this._carryTime / CARRY_SECONDS)) * (1 - t);
  }

  /** Remember this frame's pose, and how fast it moved and turned since the last one. */
  private _track(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    const last = this._last;
    const dt = this._dt;

    if (this._writtenFrame === this._frame - 1 && dt > 0) {
      const lp = last.position;
      const lq = last.quaternion;
      // The turn from last frame's rotation to this one's, in world space: q * conjugate(last).
      const rx = qw * -lq[0] + qx * lq[3] + qy * -lq[2] - qz * -lq[1];
      const ry = qw * -lq[1] - qx * -lq[2] + qy * lq[3] + qz * -lq[0];
      const rz = qw * -lq[2] + qx * -lq[1] - qy * -lq[0] + qz * lq[3];
      const rw = qw * lq[3] - qx * -lq[0] - qy * -lq[1] - qz * -lq[2];
      const sign = rw < 0 ? -1 : 1;
      const scale = (2 * sign) / dt;

      this._velocity[0] = (x - lp[0]) / dt;
      this._velocity[1] = (y - lp[1]) / dt;
      this._velocity[2] = (z - lp[2]) / dt;
      // For a small turn, twice the vector part over the time is the axis times the rate.
      this._spin[0] = rx * scale;
      this._spin[1] = ry * scale;
      this._spin[2] = rz * scale;
    } else {
      this._velocity.fill(0);
      this._spin.fill(0);
    }

    last.position[0] = x;
    last.position[1] = y;
    last.position[2] = z;
    last.quaternion[0] = qx;
    last.quaternion[1] = qy;
    last.quaternion[2] = qz;
    last.quaternion[3] = qw;
    this._writtenFrame = this._frame;
  }
}

/** Copy a motion to carry on, or nothing when it's as fast as a cut. */
function carryInto(out: [number, number, number], from: readonly number[], cut: number): void {
  const k = Math.hypot(from[0], from[1], from[2]) < cut ? 1 : 0;

  out[0] = from[0] * k;
  out[1] = from[1] * k;
  out[2] = from[2] * k;
}

function readCameraState(camera: Camera3D): CameraState {
  const state = createCameraState();
  const p = camera.position;
  const q = camera.quaternion;

  state.position[0] = p.x;
  state.position[1] = p.y;
  state.position[2] = p.z;
  state.quaternion[0] = q.x;
  state.quaternion[1] = q.y;
  state.quaternion[2] = q.z;
  state.quaternion[3] = q.w;
  state.fov = camera.fov;
  state.near = camera.near;
  state.far = camera.far;

  return state;
}
