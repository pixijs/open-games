import type { VirtualCamera } from '@pmndrs/klipp';
import { CameraManager } from '@pmndrs/klipp';

/**
 * Crane cams as a klipp group: cuts to the best scoring crane once it has led for {@link activateAfter} and the live
 * one has held for {@link minDuration}.
 */
export class TrackSideCameras extends CameraManager {
  /** Seconds a crane has to lead before the group cuts to it. */
  public activateAfter = 0.2;
  /** Seconds the live crane holds before another can take over. */
  public minDuration = 1.4;
  /** How good a crane's view is; the highest wins. */
  public score: (camera: VirtualCamera) => number = () => 0;

  private _shots: VirtualCamera[] = [];
  private _live: string | null = null;
  private _pending: string | null = null;
  private _pendingTime = 0;
  private _liveTime = 0;

  /**
   * Replace the cranes; the next frame cuts straight to the best of them.
   * @param shots - The new cranes.
   */
  public setShots(shots: readonly VirtualCamera[]): void {
    for (const camera of this._shots) this.children.remove(camera);

    this._shots = [...shots];

    for (const camera of this._shots) this.children.add(camera);

    this._live = null;
    this._pending = null;
    this._pendingTime = 0;
    this._liveTime = 0;
  }

  protected override chooseCamera(dt: number): string | null {
    const best = this._best();

    if (best === null || best === this._live) {
      this._pending = null;
      this._pendingTime = 0;
    } else if (this._live === null) {
      this._cut(best);
    } else {
      if (best === this._pending) {
        this._pendingTime += dt;
      } else {
        this._pending = best;
        this._pendingTime = 0;
      }

      if (this._pendingTime >= this.activateAfter && this._liveTime >= this.minDuration) this._cut(best);
    }

    this._liveTime += dt;

    return this._live;
  }

  private _best(): string | null {
    let best: string | null = null;
    let bestScore = -Infinity;

    for (const camera of this._shots) {
      const score = this.score(camera);

      if (score > bestScore) {
        best = camera.name;
        bestScore = score;
      }
    }

    return best;
  }

  private _cut(name: string): void {
    this._live = name;
    this._liveTime = 0;
    this._pending = null;
    this._pendingTime = 0;
  }
}
