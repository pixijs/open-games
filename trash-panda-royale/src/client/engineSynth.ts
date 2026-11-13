/**
 * The sound of an engine, built the way an engine makes it: every cylinder's firing pushes a
 * pulse of exhaust down the pipe. No two firings are quite alike (each cylinder is a little
 * different, and each cycle varies), each one carries a burst of combustion noise, and the pipe
 * rings with its own resonances. Under load the pulses are strong and raspy; off the throttle
 * (fuel cut) only the pumping is left, weak and uneven.
 *
 * Plain DSP with no Web Audio in it: the AudioWorklet (engineWorklet.ts) runs it, and so can a test.
 */
export interface SynthSpec {
  /** When each cylinder fires in the four-stroke cycle (0..1 of its 720°), in firing order. */
  fire: number[];
  /** Each cylinder's strength, × 1: no two are quite alike (the low "orders" every engine has). */
  weight: number[];
  /** How much a firing varies from cycle to cycle (σ, × its strength): on the throttle, and off it. */
  jitterOn: number;
  jitterOff: number;
  /** How much a firing's timing varies (σ, × the gap between firings): it smears the high harmonics. */
  wobble: number;
  /** The exhaust pulse: its rise and its decay (ms). */
  rise: number;
  decay: number;
  /** Combustion and flow noise in each pulse (× its strength), and how fast it dies away (ms). */
  rasp: number;
  /**
   * Turbulence in the gas each pulse pushes (× the pulse, low-passed noise): what keeps one
   * cycle from sounding exactly like the last, and gives a loaded engine its roar.
   */
  turb: number;
  raspDecay: number;
  /** A diesel's knock: a sharp click with each firing, loudest off load. */
  knock: number;
  /** The pipe: its round trip (ms), how much comes back (−1..1, open end: negative), damping in it (0..1). */
  pipe: number;
  reflect: number;
  damp: number;
  /** Intake roar, under load. */
  intake: number;
  /** Off the throttle (fuel cut), what's left of a firing: just the pumping. */
  overrun: number;
}

/** A small seeded random (xorshift32), so a render can be repeated. */
function rng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class EngineSynth {
  private readonly rand: () => number;
  private readonly gaps: number[];
  private k = 0;
  private toNext: number;
  // the exhaust pulse: the difference of two decays (rise, fall), scaled so a firing peaks at its strength
  private readonly rd: number;
  private readonly rr: number;
  private readonly norm: number;
  private pd = 0;
  private pr = 0;
  private kick = 0;
  // combustion noise, and a diesel's knock
  private raspEnv = 0;
  private readonly raspFall: number;
  private raspHp = 0;
  private raspPrev = 0;
  private turbLp = 0;
  private readonly turbK: number;
  private knockEnv = 0;
  private readonly knockFall: number;
  private knockHp = 0;
  private knockPrev = 0;
  // an afterfire: a bang and a crackle, scheduled a moment ahead
  private popIn: number[] = [];
  private popEnv = 0;
  private readonly popFall: number;
  private popLp = 0;
  // the pipe
  private readonly pipeBuf: Float32Array;
  private pipeAt = 0;
  private pipeLp = 0;
  // intake roar: noise through a band that rises with the revs
  private ib1 = 0;
  private ib2 = 0;
  // the revs wander a little (an idle hunts; under load, much less)
  private wander = 0;
  private wanderTo = 0;
  private wanderIn = 0;
  // DC blocker
  private dcX = 0;
  private dcY = 0;
  private gauss2: number | null = null;
  /** The revs (× 7000 rpm), as of the last render. */
  private rev = 0;

  constructor(readonly spec: SynthSpec, readonly sampleRate: number, seed = 1) {
    this.rand = rng(seed);
    const n = spec.fire.length;
    this.gaps = spec.fire.map((f, i) => {
      const g = spec.fire[(i + 1) % n] - f;
      return g > 0 ? g : g + 1;
    });
    this.toNext = this.rand() * this.gaps[0];
    const ms = sampleRate / 1000;
    this.rd = Math.exp(-1 / (spec.decay * ms));
    this.rr = Math.exp(-1 / (spec.rise * ms));
    // the pulse's peak, for a unit kick
    let d = 1, r = 1, peak = 0;
    for (let i = 0; i < spec.decay * ms * 6; i++) { peak = Math.max(peak, d - r); d *= this.rd; r *= this.rr; }
    this.norm = 1 / (peak || 1);
    this.raspFall = Math.exp(-1 / (spec.raspDecay * ms));
    this.turbK = 1 - Math.exp((-2 * Math.PI * 700) / sampleRate);
    this.knockFall = Math.exp(-1 / (0.25 * ms));
    this.popFall = Math.exp(-1 / (22 * ms));
    this.pipeBuf = new Float32Array(Math.max(2, Math.round(spec.pipe * ms)));
  }

  private gauss() {
    if (this.gauss2 !== null) { const g = this.gauss2; this.gauss2 = null; return g; }
    const u = Math.max(1e-9, this.rand()), v = this.rand();
    const m = Math.sqrt(-2 * Math.log(u));
    this.gauss2 = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  }

  /** An afterfire out of the exhaust, within the next 40 ms. */
  pop() {
    this.popIn.push(Math.floor(this.rand() * 0.04 * this.sampleRate));
  }

  /** One firing of the next cylinder in order, `fuel` (0..1) how much it burns. */
  private fire(fuel: number) {
    const s = this.spec;
    const jitter = s.jitterOff + (s.jitterOn - s.jitterOff) * fuel;
    let a = s.weight[this.k] * Math.max(0, 1 + jitter * this.gauss());
    a *= s.overrun + (1 - s.overrun) * Math.pow(fuel, 0.8);
    // off the throttle some cycles hardly fire at all
    if (fuel < 0.05 && this.rand() < 0.1) a *= 0.25;
    this.kick += a;
    // (the flow noise grows hard with load and revs: dark idling, a roar flat out)
    this.raspEnv = Math.max(this.raspEnv * 0.5, a * s.rasp * (0.1 + 0.9 * fuel) * (0.3 + this.rev));
    this.knockEnv += a * s.knock * (1 - 0.6 * fuel);
    this.k = (this.k + 1) % s.fire.length;
    this.toNext += this.gaps[this.k] * Math.max(0.5, 1 + s.wobble * this.gauss());
  }

  /**
   * Render the engine turning at `rpm` (revolutions a minute), burning `fuel` (0..1: idle needs a
   * little, the throttle more; 0 is the fuel cut of engine braking). Two parts: `tone`, the
   * exhaust pulses as the pipe rings with them (the muffler takes their highs), and `noise`, the
   * flow and combustion noise, the intake's roar and a diesel's knock (mostly highs, and it grows
   * hard with load and revs). Without `noise`, both go into `tone`.
   */
  render(tone: Float32Array, rpm: number, fuel: number, noise?: Float32Array) {
    const s = this.spec, sr = this.sampleRate;
    const n = tone.length;
    // the intake's band (a two-pole resonator around 500 Hz..2.3 kHz)
    const rev = (this.rev = Math.min(1, rpm / 7000));
    const f0 = 500 + 1800 * rev, q = 1.4;
    const w0 = (2 * Math.PI * f0) / sr, alpha = Math.sin(w0) / (2 * q), a0 = 1 + alpha;
    const ib0 = alpha / a0, ia1 = (-2 * Math.cos(w0)) / a0, ia2 = (1 - alpha) / a0;
    const intake = s.intake * fuel * rev;
    // the revs wander: idling it hunts a little, under load it holds
    const wanderAmt = rpm < 1500 ? 0.012 : 0.003;
    for (let i = 0; i < n; i++) {
      if (--this.wanderIn <= 0) { this.wanderTo = this.gauss(); this.wanderIn = Math.floor(sr * (0.15 + 0.3 * this.rand())); }
      this.wander += (this.wanderTo - this.wander) * 0.0002;
      this.toNext -= (rpm / 120 / sr) * (1 + wanderAmt * this.wander);
      while (this.toNext <= 0 && rpm > 1) this.fire(fuel);
      if (this.popIn.length) {
        for (let j = this.popIn.length - 1; j >= 0; j--) {
          if (--this.popIn[j] > 0) continue;
          this.popIn.splice(j, 1);
          this.kick += 1.6 + 0.6 * this.rand();
          this.popEnv = Math.max(this.popEnv, 0.8);
        }
      }

      // the pulse, and the pipe: what went down it comes back, inverted at the open end, a little
      // duller each time
      const x = this.kick;
      this.kick = 0;
      this.pd = this.pd * this.rd + x;
      this.pr = this.pr * this.rr + x;
      let y = (this.pd - this.pr) * this.norm;
      // the gas in the pulse is turbulent: the harder it flows, the more
      this.turbLp += (this.rand() * 2 - 1 - this.turbLp) * this.turbK;
      y += y * this.turbLp * s.turb * (0.3 + 0.7 * fuel) * (0.4 + rev);
      const back = this.pipeBuf[this.pipeAt];
      this.pipeLp += (back - this.pipeLp) * (1 - s.damp);
      y += s.reflect * this.pipeLp;
      this.pipeBuf[this.pipeAt] = y;
      this.pipeAt = (this.pipeAt + 1) % this.pipeBuf.length;
      // (no DC: the pulses all push one way)
      const dc = y - this.dcX + 0.995 * this.dcY;
      this.dcX = y;
      this.dcY = dc;

      // combustion and flow noise (high-passed), a diesel's knock (higher still), an afterfire's crackle
      const w = this.rand() * 2 - 1;
      this.raspEnv *= this.raspFall;
      const rn = w * this.raspEnv;
      this.raspHp = 0.92 * (this.raspHp + rn - this.raspPrev);
      this.raspPrev = rn;
      let z = this.raspHp;
      if (this.knockEnv > 1e-5) {
        this.knockEnv *= this.knockFall;
        const kn = w * this.knockEnv;
        this.knockHp = 0.7 * (this.knockHp + kn - this.knockPrev);
        this.knockPrev = kn;
        z += this.knockHp;
      }
      if (this.popEnv > 1e-4) {
        this.popEnv *= this.popFall;
        this.popLp += (w * this.popEnv - this.popLp) * 0.35;
        z += this.popLp;
      }
      // intake roar
      if (intake > 0) {
        const v = this.rand() * 2 - 1;
        const b = ib0 * v - ia1 * this.ib1 - ia2 * this.ib2;
        this.ib2 = this.ib1;
        this.ib1 = b;
        z += b * intake;
      }

      if (noise) {
        tone[i] = dc * 0.3;
        noise[i] = z * 0.3;
      } else tone[i] = (dc + z) * 0.3;
    }
  }
}
