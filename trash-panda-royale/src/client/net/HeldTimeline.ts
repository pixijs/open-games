/**
 * Discrete state (a player's mode, who drives a car) on the same timeline as the
 * interpolated positions. `Predict`'s lerp draws remote entities at
 * `serverNow() - delay - smoothedRtt()/2`; a flag read raw from the state would
 * flip that much earlier than the body it belongs to (a player vanishing before
 * their body reaches the car door). Record each change at the server time of the
 * patch that carried it, then sample with step semantics at the render time.
 */
export class HeldTimeline<T> {
  private times: number[] = [];
  private values: T[] = [];

  constructor(private readonly capacity = 24) {}

  /** Record `value` as the state from server time `t` on. */
  push(t: number, value: T) {
    const n = this.times.length;
    if (n && t < this.times[n - 1]) t = this.times[n - 1];
    this.times.push(t);
    this.values.push(value);
    if (this.times.length > this.capacity) { this.times.shift(); this.values.shift(); }
  }

  /** The value in effect at server time `t` (the oldest one before the first sample). */
  at(t: number): T | undefined {
    for (let i = this.times.length - 1; i >= 0; i--) if (this.times[i] <= t) return this.values[i];
    return this.values[0];
  }

  latest(): T | undefined {
    return this.values[this.values.length - 1];
  }
}
