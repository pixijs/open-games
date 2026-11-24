import type { DestroyOptions } from 'pixi.js';
import { Graphics } from 'pixi.js';

import type { Pt } from '../art/svg';
import { Motion } from './Motion';

const RING_DASH = 7;
const RING_GAP = 4;

/**
 * The ring keys and a gamepad focus with: a dashed outline round a control that crawls 8 px a second while it shows
 * Buttons and the name field draw it.
 */
export class FocusRing extends Graphics {
  private readonly _motion = new Motion();
  private _path: readonly Pt[] = [];
  private _offset = 0;
  private _stop: (() => void) | null = null;

  constructor() {
    super();
    this.visible = false;
    this.eventMode = 'none';
  }

  /** Shows the ring along the closed outline `path`. */
  public show(path: readonly Pt[]): void {
    this._path = path;
    this.visible = true;
    this._draw();
    if (this._stop || this._motion.reduced) return;
    this._stop = this._motion.tick((_t, dt) => {
      this._offset = (this._offset + (dt / 1000) * 8) % (RING_DASH + RING_GAP);
      this._draw();
    });
  }

  public hide(): void {
    this._stop?.();
    this._stop = null;
    this.visible = false;
  }

  public override destroy(options?: DestroyOptions): void {
    this._motion.destroy();
    this._stop = null;
    super.destroy(options);
  }

  private _draw(): void {
    this.clear();
    dashPoly(this, this._path, this._offset);
    this.stroke({ width: 2.5, color: 0xf4f7ff, join: 'miter' });
  }
}

/**
 * Strokes a closed polygon as dashes, the pattern shifted along the perimeter by `offset`. It walks dash by dash, so
 * the work is bounded by the perimeter whatever rounding does.
 */
function dashPoly(g: Graphics, pts: readonly Pt[], offset: number): void {
  const period = RING_DASH + RING_GAP;
  const n = pts.length;
  let perimeter = 0;

  for (let i = 0; i < n; i++) perimeter += Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y);
  for (let s = (offset % period) - period; s < perimeter; s += period) {
    const from = Math.max(0, s);
    const to = Math.min(perimeter, s + RING_DASH);

    if (to > from) dashSpan(g, pts, from, to);
  }
}

/** Draws the stretch of the polygon's outline between two distances along it, through any corners between. */
function dashSpan(g: Graphics, pts: readonly Pt[], from: number, to: number): void {
  const n = pts.length;
  let at = 0;
  let started = false;

  for (let i = 0; i < n && at < to; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const end = at + len;

    if (end > from && len > 0) {
      const t0 = Math.max(0, from - at) / len;
      const t1 = Math.min(len, to - at) / len;

      if (!started) {
        g.moveTo(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0);
        started = true;
      }
      g.lineTo(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1);
    }
    at = end;
  }
}
