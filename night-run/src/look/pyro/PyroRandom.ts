import type { Vector3 } from '@pixi/3d';

/**
 * A mulberry32 generator that is re-seeded from integers rather than run as one long stream, so each burst and
 * each emission tick draws the same numbers however the take got to it.
 */
export class PyroRandom {
  private _state = 0;

  /**
   * Restart the sequence.
   * @param stream - Which effect is drawing.
   * @param index - Which burst or tick of it.
   */
  public seed(stream: number, index: number): this {
    let h = Math.imul(stream ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 0x632be59b, 0xc2b2ae35);

    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    this._state = h | 0;

    return this;
  }

  /** A number in [0, 1). */
  public next(): number {
    const a = (this._state = (this._state + 0x6d2b79f5) | 0);
    let t = Math.imul(a ^ (a >>> 15), a | 1);

    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A number in [lo, hi). */
  public range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** A number in [-1, 1). */
  public signed(): number {
    return this.next() * 2 - 1;
  }

  /**
   * A random unit vector.
   * @param out - Receives it.
   */
  public sphere(out: Vector3): Vector3 {
    const z = this.signed();
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);

    return out.set(r * Math.cos(a), z, r * Math.sin(a));
  }
}
