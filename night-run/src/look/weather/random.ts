/**
 * Mixes three integers into one 32-bit seed, so an effect can draw the same numbers for the same moment however
 * the frames that reach it were stepped.
 * @param a - First key, such as an emission tick.
 * @param b - Second key, such as an actor.
 * @param c - Third key, such as a wheel.
 * @returns An unsigned 32-bit seed.
 */
export function hashSeed(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x632be5ab, 0x85ebca77);

  h ^= Math.imul((c | 0) + 0x1b873593, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;

  return h >>> 0;
}

/** A reseedable mulberry32 stream. */
export class SeededRandom {
  private _state = 0;

  /** @param seed - Starting seed. */
  constructor(seed = 0) {
    this._state = seed | 0;
  }

  /**
   * Restart the stream.
   * @param seed - New seed.
   */
  public seed(seed: number): void {
    this._state = seed | 0;
  }

  /** @returns The next number in [0, 1). */
  public next(): number {
    this._state = (this._state + 0x6d2b79f5) | 0;

    let t = Math.imul(this._state ^ (this._state >>> 15), 1 | this._state);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * @param min - Lowest value.
   * @param max - Highest value.
   * @returns The next number in [min, max).
   */
  public range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
