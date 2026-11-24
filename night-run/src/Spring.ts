/**
 * A number that follows a target on a critically damped spring. Unlike a plain ease, its speed never jumps when the
 * target does, so a camera riding on it never jolts from one frame to the next.
 */
export class Spring {
  public value = 0;
  /** How fast the value is changing, per second. */
  public velocity = 0;

  /** @param value - Where it starts, at rest. */
  constructor(value = 0) {
    this.value = value;
  }

  /**
   * Move toward a target.
   * @param target - Where to head.
   * @param time - Roughly how long getting there takes, in seconds.
   * @param dt - Seconds since the last frame.
   * @returns The new value.
   */
  public update(target: number, time: number, dt: number): number {
    const omega = 2 / time;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.value - target;
    const temp = (this.velocity + omega * change) * dt;

    this.velocity = (this.velocity - omega * temp) * decay;
    this.value = target + (change + temp) * decay;

    return this.value;
  }

  /** Jump to a value, at rest. */
  public reset(value: number): void {
    this.value = value;
    this.velocity = 0;
  }
}
