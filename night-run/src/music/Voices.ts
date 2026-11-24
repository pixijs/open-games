import { hz } from './score';

/** Notes remembered for the live node count; older ones have long since ended. */
const RING = 1024;
/** Seconds of white noise every drum and riser reads from. */
const NOISE_SECONDS = 2;
/** The lowest a bass's sub-octave goes, Hz; under it the sub doubles the note instead. */
const SUB_FLOOR = 40;

/**
 * The instruments, each a handful of one-shot nodes built for one note and let go by the graph when it stops:
 * detuned saw pads, a bass with a filter envelope, plucks, a gliding lead, and drums from oscillators and one shared
 * noise buffer. Each call plays into the channel it's given.
 */
export class Voices {
  /** Nodes made since the start, for the scheduler's numbers. */
  public created = 0;

  private readonly _ctx: BaseAudioContext;
  private readonly _noise: AudioBuffer;
  private readonly _ends = new Float64Array(RING);
  private readonly _counts = new Uint8Array(RING);
  private _head = 0;
  private _seed = 0x2545f491;

  constructor(ctx: BaseAudioContext) {
    this._ctx = ctx;

    const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);

    this._noise = ctx.createBuffer(1, length, ctx.sampleRate);

    const data = this._noise.getChannelData(0);

    for (let i = 0; i < length; i++) data[i] = this.random() * 2 - 1;
  }

  /** A repeatable random number, 0 to 1, so an offline render matches the live one. */
  public random(): number {
    this._seed = (Math.imul(this._seed, 1664525) + 1013904223) >>> 0;

    return this._seed / 4294967296;
  }

  /**
   * Nodes still sounding.
   * @param now - Context time.
   * @returns How many of the notes' nodes haven't stopped.
   */
  public active(now: number): number {
    let total = 0;

    for (let i = 0; i < RING; i++) if (this._ends[i] > now) total += this._counts[i];

    return total;
  }

  /**
   * A kick: a sine that drops from a click to a thump.
   * @param t - Start time.
   * @param vel - Level.
   * @param out - Channel.
   */
  public kick(t: number, vel: number, out: AudioNode): void {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(64, t + 0.032);
    osc.frequency.exponentialRampToValueAtTime(43, t + 0.28);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.002);
    amp.gain.setTargetAtTime(0, t + 0.06, 0.07);
    osc.connect(amp).connect(out);
    osc.start(t);
    osc.stop(t + 0.6);
    this._note(t + 0.6, 2);
  }

  /**
   * A sub boom under a countdown light.
   * @param t - Start time.
   * @param vel - Level.
   * @param out - Channel.
   */
  public boom(t: number, vel: number, out: AudioNode): void {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    osc.frequency.exponentialRampToValueAtTime(41, t + 0.8);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.004);
    amp.gain.setTargetAtTime(0, t + 0.1, 0.22);
    osc.connect(amp).connect(out);
    osc.start(t);
    osc.stop(t + 1.5);
    this._note(t + 1.5, 2);
  }

  /**
   * A gated snare: a flat burst of noise cut off hard, over a pitched body.
   * @param t - Start time.
   * @param vel - Level.
   * @param gate - Seconds the noise holds before the gate shuts.
   * @param out - Channel.
   */
  public snare(t: number, vel: number, gate: number, out: AudioNode): void {
    const ctx = this._ctx;
    const noise = this._noiseSource(t, gate + 0.03);
    const hiss = ctx.createGain();
    const body = ctx.createOscillator();
    const thump = ctx.createGain();

    hiss.gain.setValueAtTime(0, t);
    hiss.gain.linearRampToValueAtTime(vel, t + 0.0015);
    hiss.gain.linearRampToValueAtTime(vel * 0.5, t + gate);
    hiss.gain.linearRampToValueAtTime(0, t + gate + 0.014);
    noise.connect(hiss).connect(out);

    body.type = 'triangle';
    body.frequency.setValueAtTime(230, t);
    body.frequency.exponentialRampToValueAtTime(170, t + 0.08);
    thump.gain.setValueAtTime(0, t);
    thump.gain.linearRampToValueAtTime(vel * 0.9, t + 0.002);
    thump.gain.setTargetAtTime(0, t + 0.01, 0.035);
    body.connect(thump).connect(out);
    body.start(t);
    body.stop(t + 0.3);
    this._note(t + 0.3, 4);
  }

  /**
   * A hi-hat: a tick of noise through the channel's highpass.
   * @param t - Start time.
   * @param vel - Level.
   * @param open - Whether it rings.
   * @param out - Channel.
   */
  public hat(t: number, vel: number, open: boolean, out: AudioNode): void {
    const length = open ? 0.42 : 0.07;
    const noise = this._noiseSource(t, length);
    const amp = this._ctx.createGain();

    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.001);
    amp.gain.setTargetAtTime(0, t + 0.002, open ? 0.075 : 0.011);
    noise.connect(amp).connect(out);
    this._note(t + length, 2);
  }

  /**
   * A crash cymbal.
   * @param t - Start time.
   * @param vel - Level.
   * @param out - Channel.
   */
  public crash(t: number, vel: number, out: AudioNode): void {
    const ctx = this._ctx;
    const noise = this._noiseSource(t, 3.2);
    const air = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    air.type = 'highpass';
    air.frequency.value = 4200;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.003);
    amp.gain.setTargetAtTime(0, t + 0.02, 0.6);
    noise.connect(air).connect(amp).connect(out);
    this._note(t + 3.2, 3);
  }

  /**
   * A tom in a fill.
   * @param t - Start time.
   * @param midi - Its pitch.
   * @param vel - Level.
   * @param out - Channel.
   */
  public tom(t: number, midi: number, vel: number, out: AudioNode): void {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const f = hz(midi);

    osc.frequency.setValueAtTime(f * 1.7, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.09);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.003);
    amp.gain.setTargetAtTime(0, t + 0.02, 0.11);
    osc.connect(amp).connect(out);
    osc.start(t);
    osc.stop(t + 0.7);
    this._note(t + 0.7, 2);
  }

  /**
   * A bass note: a saw and a triangle an octave under it (in unison on the lowest notes), through a resonant lowpass
   * that snaps shut.
   * @param t - Start time.
   * @param midi - Its pitch.
   * @param dur - Seconds it holds.
   * @param vel - Level.
   * @param cutoff - Where the filter settles, Hz.
   * @param out - Channel.
   * @param release - Seconds it takes to die away once let go.
   */
  public bass(t: number, midi: number, dur: number, vel: number, cutoff: number, out: AudioNode, release = 0.1): void {
    const ctx = this._ctx;
    const saw = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    const f = hz(midi);
    const end = t + dur + release * 1.3 + 0.01;

    saw.type = 'sawtooth';
    saw.frequency.value = f;
    sub.type = 'triangle';
    sub.frequency.value = f / 2 >= SUB_FLOOR ? f / 2 : f;
    lp.type = 'lowpass';
    lp.Q.value = 5;
    lp.frequency.setValueAtTime(cutoff * 5, t);
    lp.frequency.setTargetAtTime(cutoff, t + 0.002, 0.055);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel * 0.5, t + 0.004);
    amp.gain.setTargetAtTime(0, t + dur, release / 4.5);
    saw.connect(lp);
    sub.connect(lp);
    lp.connect(amp).connect(out);
    saw.start(t);
    sub.start(t);
    saw.stop(end);
    sub.stop(end);
    this._note(end, 4);
  }

  /**
   * A pad chord: two saws a note, detuned apart and split left and right, through one swelling lowpass.
   * @param t - Start time.
   * @param notes - The voicing, as MIDI.
   * @param dur - Seconds it holds before it releases.
   * @param vel - Level.
   * @param cutoff - The filter's open cutoff, Hz.
   * @param attack - Seconds it swells in over.
   * @param release - Seconds it fades out over.
   * @param out - Channel.
   */
  public pad(
    t: number,
    notes: readonly number[],
    dur: number,
    vel: number,
    cutoff: number,
    attack: number,
    release: number,
    out: AudioNode,
  ): void {
    const ctx = this._ctx;
    const merger = ctx.createChannelMerger(2);
    const lp = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    const end = t + dur + release * 1.4;

    for (let i = 0; i < notes.length; i++) {
      const f = hz(notes[i]);

      for (let side = 0; side < 2; side++) {
        const osc = ctx.createOscillator();

        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = (side === 0 ? -1 : 1) * (6 + i * 2.5 + this.random() * 3);
        osc.connect(merger, 0, side);
        osc.start(t);
        osc.stop(end);
      }
    }

    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(cutoff * 0.45, t);
    lp.frequency.setTargetAtTime(cutoff, t, attack * 0.6);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel / notes.length, t + attack);
    amp.gain.setTargetAtTime(0, t + dur, release / 4);
    merger.connect(lp).connect(amp).connect(out);
    this._note(end, notes.length * 2 + 3);
  }

  /**
   * A pluck: one oscillator through a lowpass that closes as it decays.
   * @param t - Start time.
   * @param midi - Its pitch.
   * @param vel - Level.
   * @param cutoff - Where the filter settles, Hz.
   * @param decay - Seconds it rings for.
   * @param wave - Its waveform.
   * @param out - Channel.
   */
  public pluck(
    t: number,
    midi: number,
    vel: number,
    cutoff: number,
    decay: number,
    wave: OscillatorType,
    out: AudioNode,
  ): void {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    const end = t + decay * 1.3 + 0.02;

    osc.type = wave;
    osc.frequency.value = hz(midi);
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(Math.min(cutoff * 4, 16000), t);
    lp.frequency.setTargetAtTime(cutoff, t, decay * 0.18);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.002);
    amp.gain.setTargetAtTime(0, t + 0.004, decay / 4.5);
    osc.connect(lp).connect(amp).connect(out);
    osc.start(t);
    osc.stop(end);
    this._note(end, 3);
  }

  /**
   * A lead note: two detuned saws that glide in from the last note, a vibrato that grows as it holds, and a filter
   * that settles after the attack.
   * @param t - Start time.
   * @param midi - Its pitch.
   * @param dur - Seconds it holds.
   * @param vel - Level.
   * @param from - The note it glides from, or -1 to start on pitch.
   * @param out - Channel.
   * @param release - Seconds it takes to die away once let go.
   */
  public lead(t: number, midi: number, dur: number, vel: number, from: number, out: AudioNode, release = 0.25): void {
    const ctx = this._ctx;
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    const f = hz(midi);
    const end = t + dur + release * 1.3 + 0.01;

    this._glide(a, f, from, t, -7, lp);
    this._glide(b, f, from, t, 7, lp);
    lfo.frequency.value = 5.4;
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(0, t + Math.min(0.22, dur * 0.5));
    depth.gain.linearRampToValueAtTime(14, t + Math.min(0.6, dur));
    lfo.connect(depth);
    depth.connect(a.detune);
    depth.connect(b.detune);
    lp.type = 'lowpass';
    lp.Q.value = 1.4;
    lp.frequency.setValueAtTime(5600, t);
    lp.frequency.setTargetAtTime(2900, t + 0.01, 0.12);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel * 0.5, t + 0.012);
    amp.gain.setTargetAtTime(0, t + dur, release / 4.5);
    lp.connect(amp).connect(out);
    a.start(t);
    b.start(t);
    lfo.start(t);
    a.stop(end);
    b.stop(end);
    lfo.stop(end);
    this._note(end, 6);
  }

  /**
   * Noise swept up through a bandpass, swelling into `t1`, where it stops dead.
   * @param t0 - Start time.
   * @param t1 - The moment it rises into.
   * @param vel - Level at the top.
   * @param out - Channel.
   */
  public riser(t0: number, t1: number, vel: number, out: AudioNode): void {
    const ctx = this._ctx;
    const noise = this._noiseSource(t0, t1 - t0 + 0.02);
    const band = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    band.type = 'bandpass';
    band.Q.value = 1.3;
    band.frequency.setValueAtTime(320, t0);
    band.frequency.exponentialRampToValueAtTime(7800, t1);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(vel, t1 - 0.012);
    amp.gain.linearRampToValueAtTime(0, t1);
    noise.connect(band).connect(amp).connect(out);
    this._note(t1 + 0.02, 3);
  }

  /**
   * Two saws a fifth apart climbing an octave into `t1`, through a lowpass that opens with them.
   * @param t0 - Start time.
   * @param t1 - The moment it climbs into.
   * @param midi - The lower saw's starting note.
   * @param vel - Level at the top.
   * @param out - Channel.
   */
  public climb(t0: number, t1: number, midi: number, vel: number, out: AudioNode): void {
    const ctx = this._ctx;
    const lp = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      const f = hz(midi + i * 7);

      osc.type = 'sawtooth';
      osc.detune.value = i === 0 ? -5 : 5;
      osc.frequency.setValueAtTime(f, t0);
      osc.frequency.exponentialRampToValueAtTime(f * 2, t1);
      osc.connect(lp);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }

    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(260, t0);
    lp.frequency.exponentialRampToValueAtTime(4200, t1);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(vel, t1 - 0.012);
    amp.gain.linearRampToValueAtTime(0, t1);
    lp.connect(amp).connect(out);
    this._note(t1 + 0.02, 4);
  }

  /** A lead saw onto its pitch, gliding from the last note when there was one. */
  private _glide(osc: OscillatorNode, f: number, from: number, t: number, detune: number, out: AudioNode): void {
    osc.type = 'sawtooth';
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(from >= 0 ? hz(from) : f, t);
    if (from >= 0) osc.frequency.exponentialRampToValueAtTime(f, t + 0.045);
    osc.connect(out);
  }

  /** A source on the shared noise buffer, from a different point each time so repeated hits don't sound identical. */
  private _noiseSource(t: number, length: number): AudioBufferSourceNode {
    const source = this._ctx.createBufferSource();

    source.buffer = this._noise;
    source.loop = length > NOISE_SECONDS * 0.5;
    source.start(t, this.random() * (NOISE_SECONDS * 0.5));
    source.stop(t + length);

    return source;
  }

  private _note(end: number, nodes: number): void {
    this._ends[this._head] = end;
    this._counts[this._head] = nodes;
    this._head = (this._head + 1) % RING;
    this.created += nodes;
  }
}
