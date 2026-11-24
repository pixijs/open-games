import type { CameraState } from '@kvvasuu/klipp';
import { updateHardLookAt } from '@kvvasuu/klipp';

/** Ease a value toward a target with a half-life, frame-rate independent. */
function damp(value: number, target: number, halfLife: number, dt: number): number {
  return target + (value - target) * Math.pow(2, -dt / Math.max(1e-4, halfLife));
}

/**
 * A smoothed camera rig for a custom body: where the lens wants to be and what it wants to look at, eased toward each
 * frame, snapped on the first frame of a shot.
 *
 * The easing runs in a frame that moves with the shot's subject: each frame both points first ride along by however far
 * the subject moved, then ease toward where they want to be. So a shot keeps up with a truck at speed and only its
 * changes of angle and distance are smoothed, rather than trailing far behind it.
 */
export class Dolly {
  public readonly position: [number, number, number] = [0, 0, 0];
  public readonly look: [number, number, number] = [0, 0, 0];
  public fov = 45;

  private _anchorX = 0;
  private _anchorZ = 0;

  /**
   * Ease toward a wanted pose and write it into a klipp state.
   * @param out - The camera's state.
   * @param x - Wanted lens position, x.
   * @param y - Wanted lens position, y.
   * @param z - Wanted lens position, z.
   * @param lx - Wanted look-at point, x.
   * @param ly - Wanted look-at point, y.
   * @param lz - Wanted look-at point, z.
   * @param ax - Where the subject is, x; the look-at point rides along with it.
   * @param az - Where the subject is, z.
   * @param carry - Whether the lens rides along with the subject too, rather than standing where it is.
   * @param dt - Seconds since the last frame.
   * @param snap - Jump straight there.
   * @param halfLife - Seconds for the lens to cover half the way; the aim takes half as long.
   */
  public write(
    out: CameraState,
    x: number,
    y: number,
    z: number,
    lx: number,
    ly: number,
    lz: number,
    ax: number,
    az: number,
    carry: boolean,
    dt: number,
    snap: boolean,
    halfLife: number,
  ): void {
    const p = this.position;
    const l = this.look;
    const dx = ax - this._anchorX;
    const dz = az - this._anchorZ;

    this._anchorX = ax;
    this._anchorZ = az;

    if (snap) {
      p[0] = x;
      p[1] = y;
      p[2] = z;
      l[0] = lx;
      l[1] = ly;
      l[2] = lz;
    } else {
      if (carry) {
        p[0] += dx;
        p[2] += dz;
      }

      l[0] += dx;
      l[2] += dz;
      p[0] = damp(p[0], x, halfLife, dt);
      p[1] = damp(p[1], y, halfLife, dt);
      p[2] = damp(p[2], z, halfLife, dt);
      l[0] = damp(l[0], lx, halfLife * 0.5, dt);
      l[1] = damp(l[1], ly, halfLife * 0.5, dt);
      l[2] = damp(l[2], lz, halfLife * 0.5, dt);
    }

    out.position[0] = p[0];
    out.position[1] = p[1];
    out.position[2] = p[2];
    out.fov = this.fov;
    updateHardLookAt(out, l);
  }
}
