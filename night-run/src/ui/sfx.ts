import type { UiCue, UiSound } from './contract';

const MUTE_KEY = 'nightrun.muted';
/** Cues that may play during a race; the rest wait for the menus */
const RACE_CUES: ReadonlySet<UiCue> = new Set<UiCue>([
  'whooshUp',
  'whooshDown',
  'lowBeep',
  'highBeep',
  'launch',
  'chargeTick',
  'chargeReady',
  'ultraBoost',
  'bump',
  'confirm',
  'back',
  'bell',
  'record',
  'respawn',
  'pluck',
  'tick',
  'finishStab',
  'warn',
]);
const WINDOW_S = 0.05;

type Wave = OscillatorType;

interface Buzzer {
  readonly osc: OscillatorNode;
  readonly lfo: OscillatorNode;
  readonly out: GainNode;
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * NIGHT RUN's 28 UI sounds and the wrong-way buzzer, synthesised in WebAudio. Every cue
 * goes through one `ui` gain (0.5) into the game's output, so UI sits under the engine. At most two cues start in any
 * 50 ms (later ones drop), and during a race only race cues play, with button ticks at 0.03. Mute is remembered in
 * `localStorage`.
 */
export class UiSfx implements UiSound {
  private _ctx: AudioContext | null = null;
  private _ui: GainNode | null = null;
  private _noise: AudioBuffer | null = null;
  private _pink: AudioBuffer | null = null;
  private _buzzer: Buzzer | null = null;
  private _muted = readMuted();
  private _racing = false;
  private _lastA = -1;
  private _lastB = -1;

  public get muted(): boolean {
    return this._muted;
  }

  /** Connects the cues to the game's audio graph; the `ui` gain feeds `output`. */
  public setAudio(context: AudioContext, output: AudioNode): void {
    this._release();
    this._ctx = context;
    this._ui = context.createGain();
    this._ui.gain.value = this._muted ? 0 : 0.5;
    this._ui.connect(output);
    const n = Math.floor(context.sampleRate);

    this._noise = context.createBuffer(1, n, context.sampleRate);
    this._pink = context.createBuffer(1, n * 2, context.sampleRate);
    const white = this._noise.getChannelData(0);

    for (let i = 0; i < n; i++) white[i] = Math.random() * 2 - 1;
    const pink = this._pink.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;

    for (let i = 0; i < pink.length; i++) {
      const w = Math.random() * 2 - 1;

      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      pink[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }

  public setMuted(muted: boolean): void {
    this._muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      /* private mode: the choice lasts this tab */
    }
    if (this._ui && this._ctx) this._ui.gain.setTargetAtTime(muted ? 0 : 0.5, this._ctx.currentTime, 0.02);
  }

  /** In a race only race cues play, and menu ticks drop to 0.03. */
  public setRacing(racing: boolean): void {
    this._racing = racing;
  }

  public play(cue: UiCue, amount = 1): void {
    const ctx = this._ctx;

    if (!ctx || !this._ui || this._muted || ctx.state !== 'running') return;
    if (this._racing && !RACE_CUES.has(cue)) return;
    const t = ctx.currentTime;

    if (t - this._lastB < WINDOW_S) return;
    this._lastB = this._lastA;
    this._lastA = t;
    this._cue(cue, amount, t + 0.005);
  }

  public loop(_cue: 'buzzerLoop', on: boolean): void {
    const ctx = this._ctx;

    if (!on) {
      if (this._buzzer && ctx) {
        const b = this._buzzer;

        b.out.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
        b.osc.stop(ctx.currentTime + 0.3);
        b.lfo.stop(ctx.currentTime + 0.3);
      }
      this._buzzer = null;

      return;
    }
    if (this._buzzer || !ctx || !this._ui || this._muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const trem = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const out = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.value = 110;
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    trem.gain.value = 0.5;
    lfo.frequency.value = 8;
    depth.gain.value = 0.5;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.12, t + 0.08);
    lfo.connect(depth).connect(trem.gain);
    osc.connect(filter).connect(trem).connect(out).connect(this._ui);
    osc.onended = () => out.disconnect();
    osc.start(t);
    lfo.start(t);
    this._buzzer = { osc, lfo, out };
  }

  /** Stops the buzzer and disconnects from the game's graph. Idempotent. */
  public destroy(): void {
    this._release();
  }

  private _release(): void {
    this.loop('buzzerLoop', false);
    this._ui?.disconnect();
    this._ui = null;
    this._ctx = null;
    this._noise = null;
    this._pink = null;
  }

  private _cue(cue: UiCue, amount: number, t: number): void {
    switch (cue) {
      case 'tick':
        this._tone('square', 2400 * amount, 2400 * amount, t, 0.018, this._racing ? 0.03 : 0.05);
        break;
      case 'thock':
        this._tone('sine', 140, 90, t, 0.06, 0.35);
        this._noiseHit(t, 0.03, 0.2, 'lowpass', 900);
        break;
      case 'confirm':
        this._tone('triangle', 660, 660, t, 0.06, 0.25);
        this._tone('triangle', 990, 990, t + 0.06, 0.06, 0.25);
        break;
      case 'back':
        this._tone('triangle', 660, 660, t, 0.05, 0.22);
        this._tone('triangle', 440, 440, t + 0.05, 0.05, 0.22);
        break;
      case 'arm':
        this._tone('square', 330, 330, t, 0.07, 0.2, 1500);
        this._tone('square', 330, 330, t + 0.09, 0.07, 0.2, 1500);
        break;
      case 'error':
        for (const at of [t, t + 0.12]) {
          this._tone('square', 220, 220, at, 0.08, 0.15);
          this._tone('square', 233, 233, at, 0.08, 0.15);
        }
        break;
      case 'join':
        [523, 659, 784].forEach((f, i) => this._tone('triangle', f, f, t + i * 0.05, 0.12, 0.25));
        break;
      case 'leave':
        [784, 659, 523].forEach((f, i) => this._tone('triangle', f, f, t + i * 0.05, 0.12, 0.22));
        break;
      case 'pluck':
        this._tone('sine', 880 * amount, 880 * amount, t, 0.155, 0.2, 0, 0.005);
        break;
      case 'warn':
        this._tone('sine', 440, 440, t, 0.09, 0.22);
        this._tone('sine', 440, 440, t + 0.12, 0.09, 0.22);
        break;
      case 'lowBeep':
        this._tone('square', 440, 440, t, 0.15, 0.3, 2000, 0.004, false);
        break;
      case 'highBeep':
        this._tone('square', 880, 880, t, 0.45, 0.35, 2000, 0.004, false);
        this._tone('square', 1760, 1760, t, 0.45, 0.105, 2000, 0.004, false);
        break;
      case 'launch':
        this._noiseSweep(t, 0.35, 0.3, 300, 4000);
        this._tone('sawtooth', 110, 220, t, 0.35, 0.18, 3000);
        break;
      case 'chargeTick': {
        const f = amount >= 2 ? 880 : 660;

        this._tone('triangle', f, f, t, 0.018, 0.18);
        break;
      }
      case 'chargeReady':
        this._tone('triangle', 1175, 1175, t, 0.06, 0.2);
        this._tone('triangle', 1568, 1568, t + 0.06, 0.12, 0.22);
        this._tone('sine', 2349, 2349, t + 0.06, 0.18, 0.06);
        break;
      case 'ultraBoost':
        this._noiseSweep(t, 0.55, 0.38, 200, 5200);
        this._tone('sawtooth', 90, 330, t, 0.45, 0.2, 3200);
        this._tone('sine', 72, 44, t, 0.28, 0.32);
        break;
      case 'bump':
        this._tone('sine', 90, 50, t, 0.08, 0.4 * Math.min(1, amount));
        this._noiseHit(t, 0.04, 0.3 * Math.min(1, amount), 'lowpass', 400);
        break;
      case 'respawn':
        this._tone('sawtooth', 880, 220, t, 0.18, 0.22, 2000);
        this._tone('sine', 660, 660, t + 0.18, 0.06, 0.22);
        break;
      case 'bell':
        [1, 2.76, 5.4].forEach((k, i) => this._tone('sine', 620 * k, 620 * k, t, 1.2, 0.3 / (i + 1), 0, 0.002));
        break;
      case 'record':
        [1046.5, 1318.5, 1568, 2093].forEach((f, i) => this._tone('sine', f, f, t + i * 0.07, 0.4, 0.25));
        break;
      case 'whooshUp':
        this._noiseSweep(t, 0.25, 0.15, 400, 3000);
        break;
      case 'whooshDown':
        this._noiseSweep(t, 0.25, 0.15, 3000, 400);
        break;
      case 'clack':
        this._noiseHit(t, 0.015, 0.25, 'highpass', 2000);
        this._tone('sine', 300, 300, t, 0.03, 0.25);
        break;
      case 'revBlip':
        this._tone('sawtooth', 120, 260, t, 0.18, 0.25, 1200);
        break;
      case 'neonBuzz':
        this._neon(t);
        break;
      case 'copySnap':
        this._noiseHit(t, 0.008, 0.2, 'highpass', 3000);
        this._tone('sine', 1400, 1400, t, 0.02, 0.2);
        break;
      case 'finishStab':
        this._stab(t);
        break;
      case 'fanfare':
        [523.3, 659.3, 784].forEach((f, i) => this._tone('triangle', f, f, t + i * 0.12, 0.14, 0.3));
        this._tone('triangle', 1046.5, 1046.5, t + 0.36, 0.6, 0.3, 0, 0.01, false);
        break;
    }
  }

  /** One oscillator with a pitch glide, an optional lowpass and a short attack then decay. */
  private _tone(
    type: Wave,
    f0: number,
    f1: number,
    t: number,
    dur: number,
    gain: number,
    lowpass = 0,
    attack = 0.003,
    exp = true,
  ): void {
    const ctx = this._ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + attack);
    if (exp) env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    else {
      env.gain.setValueAtTime(gain, t + dur - 0.02);
      env.gain.linearRampToValueAtTime(0.0001, t + dur);
    }
    let tail: AudioNode = osc;

    if (lowpass) {
      const f = ctx.createBiquadFilter();

      f.type = 'lowpass';
      f.frequency.value = lowpass;
      tail = osc.connect(f);
    }
    tail.connect(env).connect(this._ui!);
    osc.onended = () => env.disconnect();
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private _noiseSource(t: number, dur: number, pink = false): AudioBufferSourceNode {
    const src = this._ctx!.createBufferSource();

    src.buffer = pink ? this._pink : this._noise;
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);

    return src;
  }

  private _noiseHit(t: number, dur: number, gain: number, type: BiquadFilterType, freq: number): void {
    const ctx = this._ctx!;
    const src = this._noiseSource(t, dur);
    const f = ctx.createBiquadFilter();
    const env = ctx.createGain();

    f.type = type;
    f.frequency.value = freq;
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(env).connect(this._ui!);
    src.onended = () => env.disconnect();
  }

  private _noiseSweep(t: number, dur: number, gain: number, f0: number, f1: number): void {
    const ctx = this._ctx!;
    const src = this._noiseSource(t, dur);
    const f = ctx.createBiquadFilter();
    const env = ctx.createGain();

    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + dur * 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(env).connect(this._ui!);
    src.onended = () => env.disconnect();
  }

  /** A saw hum cut by random 30 ms gaps, matching the sign's flicker. */
  private _neon(t: number): void {
    const ctx = this._ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const dur = 0.42;

    osc.type = 'sawtooth';
    osc.frequency.value = 120;
    env.gain.setValueAtTime(0, t);
    for (let at = 0; at < dur; at += 0.03) env.gain.setValueAtTime(Math.random() < 0.35 ? 0 : 0.03, t + at);
    env.gain.setValueAtTime(0, t + dur);
    osc.connect(env).connect(this._ui!);
    osc.onended = () => env.disconnect();
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** The finish stab: a saw chord through an opening lowpass, and the crowd swelling under it. */
  private _stab(t: number): void {
    const ctx = this._ctx!;
    const f = ctx.createBiquadFilter();
    const env = ctx.createGain();

    f.type = 'lowpass';
    f.frequency.setValueAtTime(800, t);
    f.frequency.exponentialRampToValueAtTime(4000, t + 0.4);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.35 / 4, t + 0.01);
    env.gain.setValueAtTime(0.35 / 4, t + 0.45);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    f.connect(env).connect(this._ui!);
    for (const freq of [261.6, 329.6, 392, 523.3]) {
      const osc = ctx.createOscillator();

      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.connect(f);
      osc.start(t);
      osc.stop(t + 0.62);
      osc.onended = () => osc.disconnect();
    }
    const crowd = this._noiseSource(t, 1.5, true);
    const cf = ctx.createBiquadFilter();
    const cenv = ctx.createGain();

    cf.type = 'bandpass';
    cf.frequency.value = 1200;
    cf.Q.value = 0.5;
    cenv.gain.setValueAtTime(0.0001, t);
    cenv.gain.linearRampToValueAtTime(0.2, t + 0.5);
    cenv.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    crowd.connect(cf).connect(cenv).connect(this._ui!);
    crowd.onended = () => {
      cenv.disconnect();
      env.disconnect();
    };
  }
}
