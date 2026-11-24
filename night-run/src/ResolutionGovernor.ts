/**
 * Dynamic resolution: keeps the frame rate at 60 by moving the render scale.
 *
 * Twice a second it looks at the average frame time. Below ~55 fps it steps the scale down, in proportion to how far
 * off it is. Going back up is harder, because under vsync a frame that finishes early still takes 16.7 ms, so headroom
 * doesn't show: after a few seconds steady at 60 the governor tries one small step up, and if that costs frames it
 * steps back and waits twice as long before trying again. On displays faster than 60 Hz, real headroom shows, and it
 * climbs straight away.
 */
export class ResolutionGovernor {
  /** The scale it last applied, or the one it started at. */
  public scale: number;

  private readonly _min: number;
  private readonly _max: number;
  private readonly _apply: (scale: number) => void;
  private _time = 0;
  private _frames = 0;
  private _steady = 0;
  /** The scale a step up left, while that step is on trial; 0 otherwise. */
  private _probeFrom = 0;
  private _probeAge = 0;
  /** Seconds steady at 60 before the next step up. */
  private _backoff = 6;

  /**
   * @param min - The lowest scale it steps down to.
   * @param max - The highest scale it climbs to.
   * @param start - The scale the renderer is at now.
   * @param apply - Sets the renderer to a new scale; called only when the scale changes.
   */
  constructor(min: number, max: number, start: number, apply: (scale: number) => void) {
    this._min = min;
    this._max = max;
    this._apply = apply;
    this.scale = start;
  }

  /**
   * Counts a frame.
   * @param dt - Seconds the frame took.
   * @returns The average frame time in ms at the end of each window, else 0.
   */
  public frame(dt: number): number {
    this._time += dt;
    this._frames++;

    if (this._time < 0.5) return 0;

    const ms = (this._time / this._frames) * 1000;
    const span = this._time;

    this._time = this._frames = 0;
    this._step(ms, span);

    return ms;
  }

  private _step(ms: number, span: number): void {
    if (this._probeFrom) {
      this._probeAge += span;

      if (ms > 18) {
        // The step up cost frames: go back, and wait longer before the next try.
        this._set(this._probeFrom);
        this._probeFrom = 0;
        this._backoff = Math.min(this._backoff * 2, 60);
        this._steady = 0;

        return;
      }

      if (this._probeAge >= 1.5) this._probeFrom = 0;
    }

    if (ms > 18) {
      this._set(this.scale * Math.min(0.97, Math.max(0.8, Math.sqrt(16 / ms))));
      this._steady = 0;
    } else if (ms < 11 && this.scale < this._max) {
      this._set(this.scale * 1.06);
    } else if (ms < 17.4 && this.scale < this._max) {
      this._steady += span;

      if (this._steady >= this._backoff && !this._probeFrom) {
        this._probeFrom = this.scale;
        this._probeAge = 0;
        this._steady = 0;
        this._set(this.scale * 1.08);
      }
    } else {
      this._steady = 0;
    }
  }

  /** Clamps to the range and rounds to a twentieth, so tiny moves don't resize the buffer for nothing. */
  private _set(scale: number): void {
    const next = Math.round(Math.min(this._max, Math.max(this._min, scale)) * 20) / 20;

    if (next === this.scale) return;

    this.scale = next;
    this._apply(next);
  }
}
