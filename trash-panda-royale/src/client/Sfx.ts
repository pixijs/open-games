import { EngineVoice, Gearbox, type EngineInput } from "./EngineSound.js";
import engineWorkletUrl from "./engineWorklet.ts?worker&url";

/**
 * Every sound effect is synthesised with Web Audio: no audio files, instant start.
 * Positional sounds fade with distance from the listener.
 * The only files are the music: two loops rendered with BBC SO Discover in REAPER.
 */
/** Each file is its loop with MUSIC_PAD seconds of wrap-around on each side, so MP3 priming never reaches the loop points. */
const MUSIC_PAD = 0.25;
/** The tunes take turns: a new one every round, or on B. */
const MUSIC = [
  { url: "assets/music/trash-panda-caper.mp3", loop: 84.705875 }, // "Trash Panda Caper", 48 bars at 136 BPM
  { url: "assets/music/dumpster-dash.mp3", loop: 88.421063 }, // "Dumpster Dash", 56 bars at 152 BPM
];
const MUSIC_VOL = 0.4;

/**
 * Cars besides ours heard at once, and how far off one still is (m). Their level falls with the
 * distance as a real sound does (half as loud each time it doubles), from as loud as ours at
 * ENGINE_NEAR m (about where the camera sits behind our own car), fading out over the last 15 m.
 */
const ENGINE_VOICES = 3;
const ENGINE_RANGE = 70;
const ENGINE_NEAR = 7;

interface EngineEntry {
  box: Gearbox;
  voice: EngineVoice | null;
  input: EngineInput;
  vol: number;
  /** How far from us (m). */
  dist: number;
  mine: boolean;
  /** Reported this frame. */
  seen: boolean;
}

export class Sfx {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  /** The music's own gain, straight to the speakers (it skips the effects' compressor); mute and ducking move it. */
  private music: GainNode | null = null;
  /** The tune playing, with its own gain for the crossfade, and which one is playing or on its way. */
  private tune: { i: number; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private tuneNext = 0;
  private tunes = new Map<number, Promise<AudioBuffer>>();
  private noise!: AudioBuffer;
  muted = false;
  listener = { x: 0, z: 0 };
  /** When the next patter (or drip) down the sewer is due (audio clock). */
  private sewerNext = 0;

  /**
   * Engines of the cars with a raccoon at the wheel, by car id: each has its gearbox, and ours
   * and the loudest few others have a voice (see `engine` and `endEngines`).
   */
  private engines = new Map<number, EngineEntry>();
  /** The engines' AudioWorklet, loaded the first time one is wanted (no voices until it's in). */
  private engineWorklet: Promise<void> | null = null;
  private engineReady = false;
  /** A knocked-off hydrant's geyser: a band of hiss, started on the first and kept (silent between). */
  private hiss: { band: BiquadFilterNode; gain: GainNode } | null = null;
  /** Tyres screeching: a squeal over a band of hiss, started on the first skid and kept (silent between). */
  private skid: { band: BiquadFilterNode; squeal: OscillatorNode; gain: GainNode } | null = null;
  /** The rubber-band stretch of a stink bomb being wound up. */
  private windup: { osc: OscillatorNode; lfo: OscillatorNode; depth: GainNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private bellUntil = 0;
  private coughUntil = 0;
  private eekUntil = 0;

  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.music = this.ctx.createGain();
    this.music.gain.value = this.muted ? 0 : MUSIC_VOL;
    this.music.connect(this.ctx.destination);
    void this.playTune(this.tuneNext);
  }

  /** Each tune is fetched the first time it's wanted (never before audio is unlocked, so never holding up loading). */
  private loadTune(i: number) {
    let p = this.tunes.get(i);
    if (!p) {
      p = fetch(MUSIC[i].url).then((r) => r.arrayBuffer()).then((data) => this.ctx!.decodeAudioData(data));
      p.catch(() => this.tunes.delete(i)); // a failed fetch is tried again next time
      this.tunes.set(i, p);
    }
    return p;
  }

  /** Crossfade to tune i, from its start (the very first one just fades in). */
  private async playTune(i: number) {
    this.tuneNext = i;
    let buf: AudioBuffer;
    try {
      buf = await this.loadTune(i);
    } catch (e) {
      console.warn("music unavailable", e);
      return;
    }
    const c = this.ctx!;
    if (this.tuneNext !== i || this.tune?.i === i) return; // another switch came while this one loaded
    const t = c.currentTime + 0.05;
    const old = this.tune;
    if (old) {
      old.gain.gain.setTargetAtTime(0, t, 0.4);
      old.src.stop(t + 3);
      old.src.onended = () => old.gain.disconnect();
    }
    const gain = c.createGain();
    gain.gain.value = 0;
    gain.connect(this.music!);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = MUSIC_PAD;
    src.loopEnd = MUSIC_PAD + MUSIC[i].loop;
    src.connect(gain);
    src.start(t, MUSIC_PAD);
    gain.gain.setTargetAtTime(1, t, old ? 0.25 : 0.5);
    this.tune = { i, src, gain };
  }

  /** On to the other tune: every new round, and the B key. */
  nextTune() {
    const i = (this.tuneNext + 1) % MUSIC.length;
    if (this.music) void this.playTune(i);
    else this.tuneNext = i; // audio isn't unlocked yet: it starts on this one
  }

  /** Dip the music under a stinger, then bring it back. */
  private duck(sec: number) {
    if (!this.music || !this.ctx || this.muted) return;
    const g = this.music.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(MUSIC_VOL * 0.25, t, 0.06);
    g.setTargetAtTime(MUSIC_VOL, t + sec, 0.7);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    if (this.music && this.ctx) {
      this.music.gain.cancelScheduledValues(this.ctx.currentTime);
      this.music.gain.setTargetAtTime(this.muted ? 0 : MUSIC_VOL, this.ctx.currentTime, 0.05);
    }
  }

  /** Distance attenuation for a world position (1 = right here). */
  att(x?: number, z?: number, range = 70) {
    if (x === undefined || z === undefined) return 1;
    const d = Math.hypot(x - this.listener.x, z - this.listener.z);
    const f = Math.max(0, 1 - d / range);
    return f * f;
  }

  private out(vol: number): GainNode | null {
    if (!this.ctx || vol < 0.01) return null;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    g.connect(this.master);
    return g;
  }

  private noiseBurst(dest: AudioNode, dur: number, type: BiquadFilterType, freq: number, q = 1, freqEnd?: number, vol = 1, delay = 0) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.Q.value = q;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol = 1, delay = 0) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** The junk arsenal: a cork pop, a bottle-cap tick, a clattering blunderbuss. */
  shot(weapon: number, x?: number, z?: number) {
    const o = this.out(0.5 * this.att(x, z, 90));
    if (!o) return;
    if (weapon === 3) {
      // trash blunderbuss: a fat clunk, then the junk clattering out
      this.noiseBurst(o, 0.4, "lowpass", 1800, 0.7, 250, 1.1);
      this.tone(o, "sine", 130, 38, 0.3, 0.9);
      for (let i = 0; i < 4; i++) {
        const f = 700 + Math.random() * 900;
        this.tone(o, "triangle", f, f * 0.92, 0.07, 0.18, 0.05 + i * 0.045 + Math.random() * 0.02);
      }
    } else if (weapon === 2) {
      // cap blaster: a crisp metallic tick
      this.noiseBurst(o, 0.05, "highpass", 3200, 0.8, 5000, 0.7);
      this.tone(o, "square", 2100 + Math.random() * 300, 1500, 0.035, 0.2);
    } else {
      // pop-gun: the cork leaving the barrel
      this.noiseBurst(o, 0.07, "bandpass", 1300, 2, 600, 0.9);
      this.tone(o, "sine", 950, 210, 0.07, 0.8);
      this.tone(o, "triangle", 1900, 1300, 0.05, 0.15, 0.015);
    }
  }

  /** A paw slap: a smack with a bit of thud. */
  punch(x?: number, z?: number) {
    const o = this.out(0.5 * this.att(x, z, 40));
    if (!o) return;
    this.noiseBurst(o, 0.06, "highpass", 1800, 0.7, 3500, 0.9);
    this.noiseBurst(o, 0.1, "lowpass", 900, 1, 200, 0.6);
    this.tone(o, "sine", 260, 90, 0.1, 0.6);
  }

  /** The stink bomb: a wet squelch under a soft boom. */
  stinkBoom(x?: number, z?: number) {
    const o = this.out(0.85 * this.att(x, z, 140));
    if (!o || !this.ctx) return;
    this.noiseBurst(o, 1.1, "lowpass", 900, 0.9, 70, 1.1);
    this.tone(o, "sine", 85, 30, 0.8, 1);
    // the squelch: two detuned saws, a wobbling lowpass
    const c = this.ctx, t = c.currentTime;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.55);
    const lfo = c.createOscillator(), depth = c.createGain();
    lfo.frequency.value = 17;
    depth.gain.value = 120;
    lfo.connect(depth).connect(lp.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    for (const f of [92, 97]) {
      const s = c.createOscillator();
      s.type = "sawtooth";
      s.frequency.setValueAtTime(f, t);
      s.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.55);
      s.connect(lp);
      s.start(t);
      s.stop(t + 0.65);
    }
    lp.connect(g).connect(o);
    lfo.start(t);
    lfo.stop(t + 0.65);
  }

  /** A raccoon chitter: a quick run of squeaky chirps. */
  chitter(x?: number, z?: number) {
    const o = this.out(0.35 * this.att(x, z, 50));
    if (!o) return;
    const n = 5 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const f = 1700 + Math.random() * 900;
      this.tone(o, "triangle", f, f * (0.75 + Math.random() * 0.15), 0.04, 0.35, i * 0.05 + Math.random() * 0.01);
    }
  }

  /** You're out: wah, wah, wah, waaah. */
  sadTrombone() {
    const o = this.out(0.4);
    if (!o || !this.ctx) return;
    this.duck(2.3);
    const c = this.ctx;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1100;
    lp.connect(o);
    const notes = [[392, 0.32], [370, 0.32], [349, 0.32], [330, 1.1]] as const;
    let t = c.currentTime + 0.05;
    notes.forEach(([f, dur], i) => {
      const s = c.createOscillator();
      s.type = "sawtooth";
      s.frequency.setValueAtTime(f, t);
      s.frequency.linearRampToValueAtTime(f * 0.97, t + dur);
      if (i === notes.length - 1) {
        // the long last note wobbles
        const lfo = c.createOscillator(), depth = c.createGain();
        lfo.frequency.value = 6;
        depth.gain.value = 9;
        lfo.connect(depth).connect(s.frequency);
        lfo.start(t);
        lfo.stop(t + dur);
      }
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.04);
      g.gain.setValueAtTime(0.3, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(g).connect(lp);
      s.start(t);
      s.stop(t + dur + 0.05);
      t += dur + 0.04;
    });
  }

  /** Last raccoon standing: a little brass-ish fanfare. */
  fanfare() {
    const o = this.out(0.4);
    if (!o) return;
    this.duck(1.6);
    [523, 659, 784].forEach((f, i) => this.tone(o, "square", f, f, 0.13, 0.22, i * 0.13));
    for (const f of [523, 659, 784, 1047]) this.tone(o, "square", f, f * 1.005, 0.9, 0.16, 0.42);
    this.tone(o, "triangle", 262, 262, 0.9, 0.3, 0.42);
    this.noiseBurst(o, 0.3, "highpass", 5000, 0.5, 9000, 0.2);
  }

  /** Digging through a trash can (then the pickup jingle). */
  rummage() {
    const o = this.out(0.4);
    if (!o) return;
    for (let i = 0; i < 3; i++) this.noiseBurst(o, 0.07, "bandpass", 2200 + Math.random() * 1800, 1.5, 1200, 0.7, i * 0.06);
    this.tone(o, "triangle", 1150, 1020, 0.16, 0.25, 0.16);
    [660, 880, 1320].forEach((f, i) => this.tone(o, "square", f, f * 1.01, 0.1, 0.2, 0.22 + i * 0.06));
  }

  /** A metal trash can getting hit: a bright, wobbly clang. */
  clang(x?: number, z?: number) {
    const o = this.out(0.4 * this.att(x, z, 70));
    if (!o) return;
    this.noiseBurst(o, 0.04, "highpass", 3000, 0.7, 6000, 0.8);
    for (const [f, v] of [[540, 0.5], [1310, 0.3], [2170, 0.18]] as const) this.tone(o, "sine", f, f * 0.985, 0.45, v);
  }

  /** Diving into a trash can: a rustle of trash, then the lid clanks shut. */
  binIn(x?: number, z?: number) {
    const o = this.out(0.4 * this.att(x, z, 50));
    if (!o) return;
    this.noiseBurst(o, 0.14, "bandpass", 1800, 1.2, 700, 0.6);
    this.tone(o, "sine", 210, 120, 0.1, 0.35, 0.05);
    this.tone(o, "sine", 690, 660, 0.18, 0.3, 0.16);
    this.tone(o, "sine", 1650, 1610, 0.12, 0.14, 0.16);
  }

  /** Hopping out of one: the lid rattles off and back on, and a springy hop. */
  binOut(x?: number, z?: number) {
    const o = this.out(0.4 * this.att(x, z, 50));
    if (!o) return;
    this.tone(o, "sine", 640, 610, 0.1, 0.3);
    this.tone(o, "square", 300, 700, 0.12, 0.12, 0.03);
    this.tone(o, "sine", 720, 690, 0.12, 0.25, 0.24);
  }

  /** Knock knock: someone's in that one already. */
  knock(x?: number, z?: number) {
    const o = this.out(0.45 * this.att(x, z, 40));
    if (!o) return;
    for (let i = 0; i < 2; i++) {
      this.noiseBurst(o, 0.05, "lowpass", 900, 1.5, 300, 0.9, i * 0.17);
      this.tone(o, "sine", 330, 220, 0.07, 0.4, i * 0.17);
    }
  }

  /** Nom nom nom. */
  munch() {
    const o = this.out(0.45);
    if (!o) return;
    for (let i = 0; i < 3; i++) {
      this.noiseBurst(o, 0.06, "lowpass", 600 + Math.random() * 300, 1.5, 250, 0.9, i * 0.12);
      this.tone(o, "sine", 300, 180, 0.06, 0.3, i * 0.12);
    }
    this.tone(o, "sine", 520, 880, 0.12, 0.25, 0.4);
  }

  /** A coffee gulped down, and the zoomies kicking in: slurp, then a rising zip. */
  slurp() {
    const o = this.out(0.45);
    if (!o) return;
    this.noiseBurst(o, 0.22, "bandpass", 500, 3, 1400, 0.8);
    this.noiseBurst(o, 0.12, "bandpass", 900, 3, 2000, 0.6, 0.24);
    this.tone(o, "square", 220, 1320, 0.32, 0.18, 0.36);
    this.tone(o, "sine", 440, 1760, 0.32, 0.3, 0.36);
  }

  /** A townsperson's "eek!" (rate-limited: a crowd doesn't shriek in unison). */
  eek(x?: number, z?: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now < this.eekUntil) return;
    this.eekUntil = now + 0.35;
    const o = this.out(0.25 * this.att(x, z, 45));
    if (!o) return;
    const f = 900 + Math.random() * 400;
    this.tone(o, "sine", f, f * 1.8, 0.12, 0.5);
    this.tone(o, "triangle", f * 1.8, f * 1.5, 0.14, 0.25, 0.1);
  }

  /** The fumes are moving in: a soft wee-woo. */
  fumeSiren() {
    const o = this.out(0.22);
    if (!o) return;
    for (let i = 0; i < 2; i++) {
      this.tone(o, "sine", 660, 680, 0.28, 0.5, i * 0.6);
      this.tone(o, "sine", 495, 505, 0.28, 0.5, i * 0.6 + 0.3);
    }
  }

  whoosh() {
    const o = this.out(0.2);
    if (o) this.noiseBurst(o, 0.18, "bandpass", 600, 2, 2400, 0.6);
  }

  boom(x?: number, z?: number) {
    const o = this.out(0.9 * this.att(x, z, 140));
    if (!o) return;
    this.noiseBurst(o, 1.4, "lowpass", 1600, 0.8, 80, 1.3);
    this.tone(o, "sine", 90, 28, 0.9, 1.2);
    this.noiseBurst(o, 0.25, "highpass", 3000, 0.5, 6000, 0.4);
  }

  crash(x?: number, z?: number, big = false) {
    const o = this.out((big ? 0.8 : 0.45) * this.att(x, z, 90));
    if (!o) return;
    this.noiseBurst(o, big ? 0.7 : 0.35, "bandpass", 1200, 0.8, 300, 1);
    this.tone(o, "square", 220, 110, 0.25, 0.25);
    this.tone(o, "triangle", 1400, 900, 0.3, 0.2, 0.03);
  }

  /** A car snaps a lamp post off its stub: a thump, a crack and the post ringing. */
  poleSnap(x?: number, z?: number) {
    const o = this.out(0.5 * this.att(x, z, 80));
    if (!o) return;
    this.noiseBurst(o, 0.18, "lowpass", 900, 0.9, 200, 0.9);
    this.noiseBurst(o, 0.05, "highpass", 2500, 0.8, 5000, 0.6, 0.01);
    for (const [f, v] of [[310, 0.35], [760, 0.22], [1490, 0.12]] as const) this.tone(o, "sine", f, f * 0.97, 0.6, v, 0.01);
  }

  /** The post hits the ground: a hollow, low clang and a rattle. */
  poleClang(x?: number, z?: number) {
    const o = this.out(0.5 * this.att(x, z, 80));
    if (!o) return;
    this.noiseBurst(o, 0.25, "bandpass", 700, 0.7, 250, 0.8);
    for (const [f, v] of [[190, 0.4], [470, 0.25], [1120, 0.12]] as const) this.tone(o, "triangle", f, f * 0.96, 0.5, v);
    this.tone(o, "sine", 520, 500, 0.12, 0.15, 0.16);
  }

  boing(x?: number, z?: number) {
    const o = this.out(0.45 * this.att(x, z, 60));
    if (!o) return;
    this.tone(o, "sine", 220, 880, 0.18, 0.7);
    this.tone(o, "triangle", 660, 300, 0.25, 0.3, 0.12);
  }

  jump() {
    const o = this.out(0.25);
    if (o) this.tone(o, "square", 260, 620, 0.14, 0.25);
  }

  land() {
    const o = this.out(0.25);
    if (o) this.noiseBurst(o, 0.12, "lowpass", 500, 1, 120, 0.8);
  }

  pickup() {
    const o = this.out(0.4);
    if (!o) return;
    [660, 880, 1320].forEach((f, i) => this.tone(o, "square", f, f * 1.01, 0.12, 0.25, i * 0.06));
  }

  hitMarker() {
    const o = this.out(0.3);
    if (o) { this.tone(o, "square", 1900, 1700, 0.05, 0.3); this.tone(o, "sine", 2600, 2400, 0.08, 0.2, 0.02); }
  }

  coin() {
    const o = this.out(0.3);
    if (o) { this.tone(o, "square", 988, 988, 0.08, 0.25); this.tone(o, "square", 1319, 1319, 0.2, 0.25, 0.08); }
  }

  door() {
    const o = this.out(0.35);
    if (o) { this.noiseBurst(o, 0.08, "lowpass", 1500, 1, 400, 0.6); this.tone(o, "square", 150, 90, 0.08, 0.3, 0.05); }
  }

  climb() {
    const o = this.out(0.3);
    if (o) [300, 400, 500].forEach((f, i) => this.tone(o, "triangle", f, f, 0.07, 0.3, i * 0.07));
  }

  /** Claws into a wall (the zoomies): a soft thump, then a quick scrabble. */
  claws(x?: number, z?: number) {
    const o = this.out(0.35 * this.att(x, z, 50));
    if (!o) return;
    this.noiseBurst(o, 0.07, "lowpass", 700, 1, 250, 0.8);
    for (let i = 0; i < 3; i++) this.noiseBurst(o, 0.035, "bandpass", 3200 + i * 500, 3, 2400, 0.4, 0.05 + i * 0.045);
  }

  hurt() {
    const o = this.out(0.45);
    if (o) { this.tone(o, "sawtooth", 600, 200, 0.2, 0.3); this.noiseBurst(o, 0.15, "bandpass", 1000, 2, 400, 0.5); }
  }

  /** A car's horn; the garbage truck's (`deep`) is an air horn, an octave and a bit down. */
  honk(x?: number, z?: number, deep = false) {
    const o = this.out((deep ? 0.45 : 0.35) * this.att(x, z, deep ? 120 : 80));
    if (!o || !this.ctx) return;
    for (const f of deep ? [165, 208, 247] : [392, 494]) {
      const osc = this.ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      const t = this.ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.setValueAtTime(0.25, t + 0.32);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1800;
      osc.connect(lp).connect(g).connect(o);
      osc.start(t);
      osc.stop(t + 0.45);
    }
  }

  trainHorn(x: number, z: number) {
    const o = this.out(0.5 * this.att(x, z, 160));
    if (!o || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const f of [277, 349, 415]) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.08);
      g.gain.setValueAtTime(0.18, t + 0.9);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1400;
      osc.connect(lp).connect(g).connect(o);
      osc.start(t);
      osc.stop(t + 1.4);
    }
  }

  /** Railway crossing bell, rate limited. */
  bell(x: number, z: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now < this.bellUntil) return;
    this.bellUntil = now + 0.5;
    const o = this.out(0.3 * this.att(x, z, 60));
    if (!o) return;
    this.tone(o, "sine", 1760, 1750, 0.35, 0.5);
    this.tone(o, "sine", 2640, 2630, 0.25, 0.2);
  }

  // ---------------------------------------------------------------- seagulls
  /**
   * A gull's cry: "kyaa-ow", harsh and nasal (a sawtooth falling through a nasal formant), `n`
   * times; shooed (`panic`), higher and quicker. Rate-limited per caller by the caller.
   */
  squawk(x?: number, z?: number, n = 2, panic = false) {
    const o = this.out(0.32 * this.att(x, z, 80));
    if (!o || !this.ctx) return;
    const c = this.ctx;
    for (let i = 0; i < n; i++) {
      const t = c.currentTime + i * (panic ? 0.16 : 0.27) + Math.random() * 0.03;
      const f0 = (panic ? 1500 : 1150) * (0.92 + Math.random() * 0.16), dur = panic ? 0.14 : 0.24;
      const s = c.createOscillator();
      s.type = "sawtooth";
      s.frequency.setValueAtTime(f0 * 0.75, t);
      s.frequency.linearRampToValueAtTime(f0, t + dur * 0.25);
      s.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + dur);
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 3.5;
      bp.frequency.setValueAtTime(1900, t);
      bp.frequency.linearRampToValueAtTime(1300, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(bp).connect(g).connect(o);
      s.start(t);
      s.stop(t + dur + 0.05);
      this.noiseBurst(o, dur * 0.6, "bandpass", 2600, 2, 1500, 0.25, t - c.currentTime);
    }
  }

  /** Wings beating: soft, quick whumps of air (`n` beats, `k` 0..1 how hard). */
  flap(x?: number, z?: number, n = 2, k = 0.5) {
    const o = this.out((0.12 + 0.12 * k) * this.att(x, z, 35));
    if (!o) return;
    for (let i = 0; i < n; i++) this.noiseBurst(o, 0.09, "lowpass", 700 + 400 * k, 0.8, 200, 0.9, i * 0.15);
  }

  /** A dropping let go of: a little wet plip. */
  plop(x?: number, z?: number) {
    const o = this.out(0.25 * this.att(x, z, 40));
    if (!o) return;
    this.tone(o, "sine", 900, 320, 0.08, 0.5);
    this.noiseBurst(o, 0.05, "bandpass", 1500, 3, 600, 0.3);
  }

  /** It lands: splurt. */
  splat(x?: number, z?: number) {
    const o = this.out(0.35 * this.att(x, z, 45));
    if (!o) return;
    this.noiseBurst(o, 0.16, "lowpass", 1200, 2.5, 180, 1);
    this.tone(o, "sine", 220, 70, 0.12, 0.45);
    this.noiseBurst(o, 0.07, "bandpass", 3000, 4, 1200, 0.3, 0.04);
  }

  // ---------------------------------------------------------------- manholes
  /** An iron lid clanking: heavy and dull, with a ring (`k` 0..1: a knock, or flung off). */
  manholeClank(x?: number, z?: number, k = 1) {
    const o = this.out((0.25 + 0.3 * k) * this.att(x, z, 70));
    if (!o) return;
    this.noiseBurst(o, 0.08, "lowpass", 1400, 1, 300, 0.9);
    for (const [f, v] of [[180, 0.45], [410, 0.25], [950, 0.12]] as const) this.tone(o, "triangle", f, f * 0.97, 0.25 + 0.3 * k, v * (0.6 + 0.4 * k));
  }

  /** A lid rattling over someone scurrying under it: a quick clatter of small knocks. */
  manholeRattle(x?: number, z?: number) {
    const o = this.out(0.3 * this.att(x, z, 55));
    if (!o) return;
    for (let i = 0; i < 4; i++) {
      this.noiseBurst(o, 0.03, "bandpass", 1100 + Math.random() * 500, 4, 700, 0.6, i * 0.055);
      this.tone(o, "triangle", 330 + Math.random() * 60, 300, 0.04, 0.2, i * 0.055);
    }
  }

  /** Down the hole: a scrape, a drop and a splash far below, echoing. */
  sewerIn(x?: number, z?: number) {
    const o = this.out(0.4 * this.att(x, z, 50));
    if (!o) return;
    this.noiseBurst(o, 0.12, "bandpass", 1600, 1.5, 700, 0.5);
    for (let i = 0; i < 3; i++) this.noiseBurst(o, 0.25, "lowpass", 900, 1, 250, 0.7 * 0.5 ** i, 0.18 + i * 0.12);
    this.tone(o, "sine", 300, 120, 0.2, 0.25, 0.18);
  }

  /** Up and out: a spring off the ladder and the lid flung off. */
  sewerOut(x?: number, z?: number) {
    const o = this.out(0.4 * this.att(x, z, 60));
    if (!o) return;
    this.tone(o, "square", 260, 660, 0.12, 0.2);
    this.manholeClank(x, z, 1);
  }

  /**
   * Scurrying through the pipes: little claws pattering on wet concrete, echoing (on while we're
   * down there; `speed` 0..1 how fast we go, 0: stopped, just the drip).
   */
  setSewer(on: boolean, speed = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!on) { this.sewerNext = 0; return; }
    if (t < this.sewerNext) return;
    if (speed > 0.15) {
      // a patter of steps, quicker the faster we go
      const o = this.out(0.16 + 0.12 * speed);
      if (o) for (let i = 0; i < 2; i++) this.noiseBurst(o, 0.035, "bandpass", 2200 + Math.random() * 900, 3, 1500, 0.6, i * 0.05);
      this.sewerNext = t + 0.16 - 0.07 * speed;
    } else {
      // stopped: a drip somewhere, echoing
      const o = this.out(0.12);
      if (o) { this.tone(o, "sine", 1400 + Math.random() * 600, 600, 0.08, 0.4); this.tone(o, "sine", 1000, 500, 0.08, 0.15, 0.22); }
      this.sewerNext = t + 0.8 + Math.random() * 1.4;
    }
  }

  // ---------------------------------------------------------------- Garbage Day
  /** GARBAGE DAY! A jaunty little tune on the truck's chimes, and its air horn. */
  garbageDay() {
    const o = this.out(0.35);
    if (!o) return;
    this.duck(2.2);
    const notes = [523, 659, 784, 659, 698, 880, 784];
    notes.forEach((f, i) => { this.tone(o, "triangle", f, f, 0.2, 0.35, i * 0.16); this.tone(o, "sine", f * 2, f * 2, 0.12, 0.12, i * 0.16); });
    this.honk(undefined, undefined, true);
  }

  /** The truck backing up: beep. */
  truckBeep(x?: number, z?: number) {
    const o = this.out(0.3 * this.att(x, z, 90));
    if (!o) return;
    this.tone(o, "square", 1040, 1040, 0.26, 0.2);
  }

  /** The hydraulics lowering the dumpster: a whine. */
  hydraulics(x?: number, z?: number) {
    const o = this.out(0.22 * this.att(x, z, 60));
    if (!o) return;
    this.tone(o, "sawtooth", 140, 95, 1.4, 0.18);
    this.noiseBurst(o, 0.6, "bandpass", 3000, 1, 1500, 0.15, 1.1);
  }

  /** A heavy dumpster set down: a deep thud and a clang. */
  dumpsterThud(x?: number, z?: number) {
    const o = this.out(0.55 * this.att(x, z, 90));
    if (!o) return;
    this.noiseBurst(o, 0.35, "lowpass", 600, 1, 80, 1.1);
    this.tone(o, "sine", 75, 35, 0.35, 0.9);
    for (const [f, v] of [[260, 0.3], [620, 0.15]] as const) this.tone(o, "triangle", f, f * 0.95, 0.5, v, 0.02);
  }

  /** The golden dumpster bursts: a pop, a ka-ching and a shower of coins. */
  jackpot(x?: number, z?: number) {
    const o = this.out(0.5 * this.att(x, z, 110));
    if (!o) return;
    this.duck(1.4);
    this.noiseBurst(o, 0.3, "lowpass", 1800, 0.8, 200, 1);
    this.tone(o, "sine", 120, 50, 0.3, 0.8);
    [1319, 1568, 2093].forEach((f, i) => this.tone(o, "square", f, f, 0.18, 0.18, 0.1 + i * 0.08));
    for (let i = 0; i < 9; i++) this.tone(o, "triangle", 2400 + Math.random() * 1600, 2200, 0.06, 0.12, 0.35 + i * 0.07 + Math.random() * 0.03);
  }

  /** Round countdown pip: 3, 2, 1 (rising). */
  countdown(n: number) {
    const o = this.out(0.35);
    if (!o) return;
    const f = [0, 880, 784, 698][n] ?? 698;
    this.tone(o, "square", f, f, 0.12, 0.3);
    this.tone(o, "sine", f * 2, f * 2, 0.1, 0.12, 0.01);
  }

  /** GO! A bright rising fanfare chord. */
  go() {
    const o = this.out(0.4);
    if (!o) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone(o, "square", f, f * 1.01, 0.35 - i * 0.04, 0.22, i * 0.05));
    this.noiseBurst(o, 0.25, "highpass", 4000, 0.5, 8000, 0.25);
  }

  /** A little cough in the fumes, or out of a manhole at (x, z) (rate-limited). */
  cough(x?: number, z?: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now < this.coughUntil) return;
    this.coughUntil = now + 0.7;
    const o = this.out(0.3 * this.att(x, z, 45));
    if (!o) return;
    this.noiseBurst(o, 0.09, "bandpass", 900, 3, 500, 0.9);
    this.noiseBurst(o, 0.08, "bandpass", 800, 3, 450, 0.7);
    this.tone(o, "triangle", 260, 140, 0.08, 0.15, 0.11);
  }

  /**
   * Winding up a stink bomb: a rubber band stretching, higher as `k` (0..1) grows, and
   * trembling once it's at full power. Off: it lets go.
   */
  setWindup(on: boolean, k = 0, full = false) {
    if (!this.ctx) return;
    const c = this.ctx;
    if (on && !this.windup) {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      const filter = c.createBiquadFilter();
      filter.type = "bandpass";
      filter.Q.value = 4;
      const lfo = c.createOscillator(), depth = c.createGain();
      lfo.frequency.value = 9;
      depth.gain.value = 0;
      lfo.connect(depth).connect(osc.frequency);
      const gain = c.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start();
      lfo.start();
      this.windup = { osc, lfo, depth, filter, gain };
    }
    if (!this.windup) return;
    const t = c.currentTime;
    if (!on) {
      const w = this.windup;
      this.windup = null;
      w.gain.gain.setTargetAtTime(0, t, 0.03);
      setTimeout(() => { w.osc.stop(); w.lfo.stop(); }, 300);
      return;
    }
    const f = 140 + 360 * k * k;
    this.windup.osc.frequency.setTargetAtTime(f, t, 0.04);
    this.windup.filter.frequency.setTargetAtTime(f * 3, t, 0.04);
    this.windup.lfo.frequency.setTargetAtTime(full ? 17 : 7 + 6 * k, t, 0.05);
    this.windup.depth.gain.setTargetAtTime(full ? f * 0.06 : f * 0.015, t, 0.05);
    this.windup.gain.gain.setTargetAtTime(0.045 + 0.05 * k, t, 0.05);
  }

  /** Wound up all the way: a bright little ping. */
  ready() {
    const o = this.out(0.3);
    if (!o) return;
    this.tone(o, "sine", 1568, 1568, 0.12, 0.35);
    this.tone(o, "sine", 2093, 2093, 0.16, 0.25, 0.06);
  }

  /** Letting go of a stink bomb: a whoosh as strong as the throw (`k` 0..1), and a "hup!". */
  toss(k = 0.5, x?: number, z?: number) {
    const o = this.out((0.3 + 0.25 * k) * this.att(x, z, 60));
    if (!o) return;
    this.noiseBurst(o, 0.12 + 0.18 * k, "bandpass", 500, 2, 1800 + 2200 * k, 0.8);
    this.tone(o, "square", 700, 1100, 0.06, 0.12);
    this.tone(o, "sine", 900, 1500, 0.08, 0.25, 0.01);
  }

  /** A glass stink bomb hitting the ground: a clink (`k` 0..1 how hard). */
  clink(x?: number, z?: number, k = 0.5) {
    const o = this.out((0.12 + 0.25 * k) * this.att(x, z, 50));
    if (!o) return;
    const f = 2400 + Math.random() * 500;
    this.tone(o, "sine", f, f * 0.97, 0.12, 0.6);
    this.tone(o, "sine", f * 1.52, f * 1.5, 0.08, 0.3);
    this.noiseBurst(o, 0.03, "highpass", 4000, 0.7, 7000, 0.3);
  }

  /** The stink bomb's fuse: a soft tick, higher as it's about to go (`k` 0..1). */
  fuseTick(x?: number, z?: number, k = 0) {
    const o = this.out(0.18 * this.att(x, z, 35));
    if (!o) return;
    const f = 1200 + 900 * k;
    this.tone(o, "square", f, f, 0.025, 0.25);
  }

  /** The pressure in a stink bomb, the moment before it goes: a rising whistle. */
  whistle(x?: number, z?: number) {
    const o = this.out(0.22 * this.att(x, z, 45));
    if (!o) return;
    this.tone(o, "sine", 900, 2600, 0.38, 0.4);
    this.noiseBurst(o, 0.38, "bandpass", 1500, 6, 4500, 0.25);
  }

  /** A predicted stink bomb the server never threw: pfft. */
  fizzle() {
    const o = this.out(0.3);
    if (!o) return;
    this.noiseBurst(o, 0.25, "lowpass", 1400, 1, 200, 0.7);
    this.tone(o, "sine", 400, 120, 0.22, 0.3);
  }

  /** G with no stink bombs: an empty click. */
  dud() {
    const o = this.out(0.3);
    if (!o) return;
    this.tone(o, "square", 300, 260, 0.04, 0.3);
    this.tone(o, "square", 240, 200, 0.04, 0.25, 0.07);
  }

  // ---------------------------------------------------------------- street furniture
  /** A car through street furniture (`k` 0..1: how hard), or it landing (a smaller `k`). */
  furniture(kind: "hydrant" | "bin" | "bench" | "bags" | "drum", x?: number, z?: number, k = 1) {
    const o = this.out((0.18 + 0.32 * k) * this.att(x, z, 70));
    if (!o) return;
    if (kind === "hydrant") {
      // cast iron: a dull bonk with a short ring
      this.noiseBurst(o, 0.08, "lowpass", 1200, 1, 250, 0.9);
      for (const [f, v] of [[250, 0.45], [670, 0.22], [1390, 0.1]] as const) this.tone(o, "triangle", f, f * 0.97, 0.15 + 0.3 * k, v);
    } else if (kind === "bin") {
      // a tin can bowled over: a bright clang and the trash in it rattling
      this.noiseBurst(o, 0.05, "highpass", 2500, 0.7, 5000, 0.6);
      for (const [f, v] of [[470, 0.45], [1170, 0.25], [1980, 0.13]] as const) this.tone(o, "sine", f, f * 0.98, 0.2 + 0.3 * k, v);
      this.noiseBurst(o, 0.2, "bandpass", 1800, 1.2, 700, 0.45 * k, 0.03);
    } else if (kind === "drum") {
      // an empty steel drum: a hollow bwong that rings on
      this.noiseBurst(o, 0.07, "lowpass", 1500, 1, 400, 0.8);
      this.tone(o, "sine", 118, 96, 0.35 + 0.35 * k, 0.6);
      for (const [f, v] of [[296, 0.3], [530, 0.16], [905, 0.08]] as const) this.tone(o, "triangle", f, f * 0.97, 0.2 + 0.3 * k, v);
    } else if (kind === "bench") {
      // wood: a hollow thunk, and slats clattering
      this.noiseBurst(o, 0.1, "bandpass", 700, 1.5, 300, 0.9);
      this.tone(o, "triangle", 190, 140, 0.12, 0.5);
      this.tone(o, "triangle", 420, 380, 0.08, 0.25, 0.05);
      if (k > 0.5) for (let i = 1; i < 3; i++) this.noiseBurst(o, 0.05, "bandpass", 900 + Math.random() * 400, 2, 500, 0.5, i * 0.07);
    } else {
      // trash bags: a soft flump and a rustle
      this.noiseBurst(o, 0.16, "lowpass", 700, 1, 150, 1);
      this.tone(o, "sine", 140, 70, 0.12, 0.4);
      this.noiseBurst(o, 0.22, "bandpass", 2600, 1.5, 1200, 0.35, 0.04);
    }
  }

  /** Brushing into a bush: a leafy shh-shh, `k` 0..1 how hard. */
  rustle(x?: number, z?: number, k = 0.5) {
    const o = this.out((0.1 + 0.2 * k) * this.att(x, z, 35));
    if (!o) return;
    for (let i = 0; i < 3; i++) this.noiseBurst(o, 0.07 + 0.08 * k, "bandpass", 2600 + Math.random() * 1600, 1.1, 1500, 0.9 - i * 0.2, i * (0.05 + Math.random() * 0.04));
  }

  /** Street furniture popping back up on its spot: a soft bloop. */
  popBack(x?: number, z?: number) {
    const o = this.out(0.22 * this.att(x, z, 40));
    if (!o) return;
    this.tone(o, "sine", 300, 720, 0.12, 0.45);
    this.noiseBurst(o, 0.06, "bandpass", 1400, 2, 2400, 0.2, 0.02);
  }

  /** A hydrant's geyser hissing: `k` (0..1) is the loudest one where we listen. */
  setHiss(k: number) {
    if (!this.ctx) return;
    const c = this.ctx;
    if (!this.hiss) {
      if (k < 0.02) return;
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const band = c.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 3000;
      band.Q.value = 0.7;
      const gain = c.createGain();
      gain.gain.value = 0;
      src.connect(band).connect(gain).connect(this.master);
      src.start();
      this.hiss = { band, gain };
    }
    const t = c.currentTime;
    this.hiss.gain.gain.setTargetAtTime(k < 0.02 ? 0 : 0.05 + 0.12 * k, t, 0.1);
    this.hiss.band.frequency.setTargetAtTime(2600 + 900 * k, t, 0.2);
  }

  /** Tyres screeching: `k` (0..1) is the loudest skid where we listen. */
  setSkid(k: number) {
    if (!this.ctx) return;
    const c = this.ctx;
    if (!this.skid) {
      if (k < 0.02) return;
      const hiss = c.createBufferSource();
      hiss.buffer = this.noise;
      hiss.loop = true;
      const band = c.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1800;
      band.Q.value = 8;
      // the rubber's squeal, with a quick chatter in it
      const squeal = c.createOscillator();
      squeal.type = "triangle";
      squeal.frequency.value = 950;
      const chatter = c.createOscillator(), depth = c.createGain();
      chatter.frequency.value = 23;
      depth.gain.value = 45;
      chatter.connect(depth).connect(squeal.frequency);
      const tone = c.createGain();
      tone.gain.value = 0.22;
      const gain = c.createGain();
      gain.gain.value = 0;
      hiss.connect(band).connect(gain);
      squeal.connect(tone).connect(gain);
      gain.connect(this.master);
      hiss.start();
      squeal.start();
      chatter.start();
      this.skid = { band, squeal, gain };
    }
    const t = c.currentTime, s = this.skid;
    s.gain.gain.setTargetAtTime(k < 0.02 ? 0 : 0.03 + 0.1 * k, t, k < 0.02 ? 0.08 : 0.04);
    s.band.frequency.setTargetAtTime(1500 + 900 * k, t, 0.08);
    s.squeal.frequency.setTargetAtTime(820 + 380 * k, t, 0.08);
  }

  /**
   * A car with a raccoon at the wheel, this frame: `mine` is the one we drive (heard as from
   * just behind it); the others by their distance. Call `endEngines` once they're all in.
   */
  engine(id: number, kind: number, mine: boolean, input: EngineInput, x?: number, z?: number) {
    if (!this.ctx) return;
    let e = this.engines.get(id);
    if (e && e.box.kind !== kind) { e.voice?.stop(); e = undefined; }
    if (!e) {
      // ours, sitting still, starts up: the starter turns it over, then it catches
      e = { box: new Gearbox(kind, mine && Math.abs(input.vF) < 0.5), voice: null, input, vol: 0, dist: 0, mine, seen: true };
      this.engines.set(id, e);
    }
    e.input = input;
    e.mine = mine;
    e.seen = true;
    e.dist = mine || x === undefined || z === undefined ? 0 : Math.hypot(x - this.listener.x, z - this.listener.z);
    e.vol = mine ? 1 : Math.min(1, ENGINE_NEAR / Math.max(1, e.dist)) * Math.min(1, Math.max(0, (ENGINE_RANGE - e.dist) / 15));
  }

  /**
   * After the frame's `engine` calls: every gearbox steps; ours and the loudest few others get a
   * voice (one that has a voice keeps it against one barely louder); engines nobody reported die away.
   */
  endEngines(dt: number) {
    if (!this.ctx) return;
    const others: EngineEntry[] = [];
    for (const [id, e] of this.engines) {
      if (!e.seen) { e.voice?.stop(); this.engines.delete(id); continue; }
      e.seen = false;
      e.box.step(dt, e.input);
      if (!e.mine) others.push(e);
    }
    if (!this.engineReady) {
      // (AudioWorklet needs a secure page: https, or localhost)
      if (!this.engineWorklet && this.ctx.audioWorklet) {
        this.engineWorklet = this.ctx.audioWorklet.addModule(engineWorkletUrl).then(
          () => { this.engineReady = true; },
          (err) => console.warn("engine sound unavailable", err),
        );
      }
      return;
    }
    const rank = (e: EngineEntry) => e.vol + (e.voice ? 0.05 : 0);
    others.sort((a, b) => rank(b) - rank(a));
    const heard = new Set(others.slice(0, ENGINE_VOICES).filter((e) => e.vol >= 0.01));
    for (const e of this.engines.values()) {
      if (!e.mine && !heard.has(e)) {
        if (e.voice) { e.voice.stop(); e.voice = null; }
        continue;
      }
      e.voice ??= new EngineVoice(this.ctx, this.noise, this.master, e.box.p);
      e.voice.set(e.box, e.input.vF, e.vol, e.dist);
      for (let i = 0; i < e.box.pops; i++) e.voice.pop();
    }
  }
}

export const sfx = new Sfx();
