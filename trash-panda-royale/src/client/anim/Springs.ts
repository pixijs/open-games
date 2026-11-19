/**
 * A bank of damped springs, one per animation channel, integrated together. Targets may
 * jump from frame to frame (a new pose, a new state): the springs do the blending, with
 * overshoot where a channel is tuned under-damped (ears, tails, squash).
 *
 * A spring chasing a target that jumps starts moving at full acceleration at once: a snap,
 * not an ease. So a channel can also follow its target through a short lag first (`tune`'s
 * `lag`, seconds): the target it chases then glides instead of jumping, and every pose
 * change eases in as well as out. Impacts are kicks (velocity) and stay sudden.
 *
 * Semi-implicit Euler, substepped to ≤ 1/120 s so stiff channels stay stable even at the
 * game's 0.1 s frame clamp. A channel that has arrived snaps exactly onto its target, so
 * the node it drives is written the same value again (a no-op for the scene graph).
 */
export class Springs {
  /** Current value. */
  readonly x: Float32Array;
  /** Velocity. */
  readonly v: Float32Array;
  /** Target. */
  readonly t: Float32Array;
  /** The target after the lag: what the spring actually chases. */
  private readonly tf: Float32Array;
  /** Stiffness (angular frequency, rad/s). */
  private readonly w: Float32Array;
  /** Damping ratio (1 = critical: no overshoot). */
  private readonly z: Float32Array;
  /** Target lag (s); 0 = none. */
  private readonly lag: Float32Array;

  constructor(readonly n: number) {
    this.x = new Float32Array(n);
    this.v = new Float32Array(n);
    this.t = new Float32Array(n);
    this.tf = new Float32Array(n);
    this.w = new Float32Array(n).fill(14);
    this.z = new Float32Array(n).fill(1);
    this.lag = new Float32Array(n);
  }

  tune(ch: number, omega: number, zeta = 1, lag?: number) {
    this.w[ch] = omega;
    this.z[ch] = zeta;
    if (lag !== undefined) this.lag[ch] = lag;
  }

  /** Teleport a channel (no blend). */
  snap(ch: number, value: number) {
    this.x[ch] = value;
    this.t[ch] = value;
    this.tf[ch] = value;
    this.v[ch] = 0;
  }

  /** An impulse: adds velocity (recoil, landing squash, a flinch). */
  kick(ch: number, dv: number) {
    this.v[ch] += dv;
  }

  step(dt: number) {
    if (dt <= 0) return;
    const sub = Math.max(1, Math.ceil(dt * 120));
    const h = dt / sub;
    const { x, v, t, tf, w, z, lag, n } = this;
    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < n; i++) {
        const L = lag[i];
        const goal = L > 0 ? (tf[i] += (t[i] - tf[i]) * Math.min(1, h / L)) : (tf[i] = t[i]);
        const wi = w[i];
        v[i] += (-wi * wi * (x[i] - goal) - 2 * z[i] * wi * v[i]) * h;
        x[i] += v[i] * h;
      }
    }
    for (let i = 0; i < n; i++) {
      if (Math.abs(x[i] - t[i]) < 1e-4 && Math.abs(v[i]) < 1e-3 && Math.abs(tf[i] - t[i]) < 1e-4) { x[i] = t[i]; tf[i] = t[i]; v[i] = 0; }
    }
  }
}
