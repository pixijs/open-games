import { clamp, lerp } from './MathUtils';
import { Music } from './music/Music';

const NUM_GEARS = 3;
const UPSHIFT_RPM = 0.92;
const DOWNSHIFT_RPM = 0.35;
const SHIFT_COOLDOWN = 0.35;

const PITCH_LOW = [1.05, 1.25, 1.4];
const PITCH_HIGH = [3.5, 2.9, 2.3];

const FILTER_CUTOFF_MIN = 700;
const FILTER_CUTOFF_MAX = 7000;

/** The UI's share of the mix: its cues sit under the engine. */
const UI_GAIN = 0.3;
/** The game bus's level: the engine, skids, hits and whooshes. */
const SFX_GAIN = 0.5;
/** The game bus during the countdown, against {@link SFX_GAIN}, so the start beeps carry. */
const DUCKED = 0.4;
/** Metres at which a remote sound falls to half its gain. */
const HALF_GAIN_DISTANCE = 9;

function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + ((outMax - outMin) * (value - inMin)) / (inMax - inMin);
}

/**
 * Gain for a sound this far from the listener.
 * @param distance - Metres.
 * @returns 1 at the lens, falling to half at {@link HALF_GAIN_DISTANCE}.
 */
export function distanceGain(distance: number): number {
  return 1 / (1 + distance / HALF_GAIN_DISTANCE);
}

interface LoopVoice {
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  filter: BiquadFilterNode | null;
  buffer: AudioBuffer | null;
  currentVolume: number;
  currentPitch: number;
}

/**
 * The race's sound: an engine loop with a three-gear pitch model and a filtered layer under it, a tyre skid loop for
 * drifts, impact one-shots, and a synthesised boost whoosh placed in the stereo field by where the truck is. Three
 * buses feed the master: the game's, ducked through the countdown and silenced while paused, the UI's, which
 * {@link GameAudio.uiOutput} hands to the interface, and the {@link Music}'s, under both. Silent until a user gesture
 * unlocks the audio context.
 */
export class GameAudio {
  /** The title and race tracks. */
  public readonly music: Music;
  private readonly _ctx: AudioContext;
  private readonly _master: GainNode;
  /** The game's mix every race voice feeds. */
  private readonly _bus: GainNode;
  private readonly _ui: GainNode;
  private readonly _engine: LoopVoice;
  private readonly _engineLayer: LoopVoice;
  private readonly _skid: LoopVoice;
  private readonly _impactBuffers: AudioBuffer[] = [];
  private _impactIndex = 0;
  private _noise: AudioBuffer | null = null;

  private _ready = false;
  private _unlocked = false;
  private _started = false;
  private _ducked = false;
  private _paused = false;

  private _rpm = 0;
  private _gear = 0;
  private _shiftCooldown = 0;

  constructor() {
    const Ctx = (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;

    this._ctx = new Ctx();
    this._master = this._ctx.createGain();
    this._master.connect(this._ctx.destination);
    this._bus = this._ctx.createGain();
    this._bus.gain.value = SFX_GAIN;
    this._bus.connect(this._master);
    this._ui = this._ctx.createGain();
    this._ui.gain.value = UI_GAIN;
    this._ui.connect(this._master);
    this.music = new Music(this._ctx, this._master);

    this._engine = this._makeVoice(true);
    this._engineLayer = this._makeVoice(false);
    this._skid = this._makeVoice(false);
  }

  /** The audio context, for the interface's own sounds. */
  public get context(): AudioContext {
    return this._ctx;
  }

  /** Where the interface's sounds go: under the engine, through the master. */
  public get uiOutput(): AudioNode {
    return this._ui;
  }

  private _makeVoice(withFilter: boolean): LoopVoice {
    const gain = this._ctx.createGain();

    gain.gain.value = 0;

    let filter: BiquadFilterNode | null = null;
    let head: AudioNode = gain;

    if (withFilter) {
      filter = this._ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.7;
      filter.frequency.value = FILTER_CUTOFF_MIN;
      gain.connect(filter);
      head = filter;
    }

    head.connect(this._bus);

    return { source: null, gain, filter, buffer: null, currentVolume: 0, currentPitch: 1 };
  }

  public async load(): Promise<void> {
    // Ogg Vorbis where the browser plays it; AAC otherwise, which iPhones before iOS 18.4 need.
    const ext = document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'm4a';
    const [engineBuf, skidBuf, impactBuf] = await Promise.all(
      ['engine', 'skid', 'impact'].map((name) =>
        this._fetchBuffer(`${import.meta.env.BASE_URL}racing/audio/${name}.${ext}`),
      ),
    );

    this._engine.buffer = engineBuf;
    this._engineLayer.buffer = engineBuf;
    this._skid.buffer = skidBuf;

    for (let i = 0; i < 3; i++) this._impactBuffers.push(impactBuf);

    this._ready = true;
    if (this._unlocked) this._start();
  }

  private async _fetchBuffer(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();

    return this._ctx.decodeAudioData(arr);
  }

  public unlock(): void {
    if (this._unlocked) return;
    this._unlocked = true;

    if (this._ctx.state === 'suspended') {
      void this._ctx.resume();
    }

    this.music.start();
    if (this._ready) this._start();
  }

  /**
   * Sound on or off, as the player's switch sets it.
   * @param on - Whether anything plays.
   */
  public setSound(on: boolean): void {
    this._master.gain.setTargetAtTime(on ? 1 : 0, this._ctx.currentTime, 0.03);
    this.music.setMuted(!on);
  }

  /**
   * Duck the game under the countdown's beeps, or bring it back.
   * @param on - Whether to duck.
   */
  public duck(on: boolean): void {
    if (on === this._ducked) return;

    this._ducked = on;
    this._mixGame(on ? 0.1 : 0.4);
  }

  /**
   * Silence the race while a quick race is paused.
   * @param paused - Whether it's paused.
   */
  public setPaused(paused: boolean): void {
    if (paused === this._paused) return;

    this._paused = paused;
    this._mixGame(0.05);
  }

  private _start(): void {
    if (this._started) return;
    this._started = true;

    this._startVoice(this._engine);
    this._startVoice(this._engineLayer);
    this._startVoice(this._skid);
  }

  private _startVoice(voice: LoopVoice): void {
    if (!voice.buffer) return;

    const src = this._ctx.createBufferSource();

    src.buffer = voice.buffer;
    src.loop = true;
    src.playbackRate.value = 1;
    src.connect(voice.gain);
    src.start();
    voice.source = src;
  }

  public update(dt: number, speed: number, throttle: number, driftIntensity: number): void {
    if (!this._started) return;

    const absSpeed = clamp(Math.abs(speed), 0, 1);
    const load = clamp(Math.max(0, throttle), 0, 1);

    const gearWindow = 1 / NUM_GEARS;
    const gearStart = this._gear * gearWindow;
    const inGear = clamp((absSpeed - gearStart) / gearWindow, 0, 1);

    let targetRpm = inGear * 0.85 + load * 0.2;

    targetRpm = clamp(targetRpm, 0, 1.05);

    const riseRate = 4;
    const fallRate = 4;
    const rate = targetRpm > this._rpm ? riseRate * (0.3 + load) : fallRate;

    this._rpm = lerp(this._rpm, targetRpm, Math.min(1, dt * rate));

    this._shiftCooldown = Math.max(0, this._shiftCooldown - dt);

    if (this._shiftCooldown === 0) {
      if (this._rpm > UPSHIFT_RPM && this._gear < NUM_GEARS - 1 && load > 0.1) {
        this._gear++;
        this._rpm = 0.45;
        this._shiftCooldown = SHIFT_COOLDOWN;
      } else if (this._rpm < DOWNSHIFT_RPM && this._gear > 0) {
        this._gear--;
        this._rpm = 0.78;
        this._shiftCooldown = SHIFT_COOLDOWN;
      }
    }

    const targetVol = remap(absSpeed + load * 0.5, 0, 1.5, 0.02, 0.25);

    this._engine.currentVolume = lerp(this._engine.currentVolume, targetVol, dt * 5);
    this._engine.gain.gain.value = this._engine.currentVolume;
    this._engineLayer.currentVolume = this._engine.currentVolume * 0.4;
    this._engineLayer.gain.gain.value = this._engineLayer.currentVolume;

    const pitch = lerp(PITCH_LOW[this._gear], PITCH_HIGH[this._gear], this._rpm);

    if (this._engine.source) this._engine.source.playbackRate.value = pitch;
    if (this._engineLayer.source) this._engineLayer.source.playbackRate.value = pitch * 0.5;

    if (this._engine.filter) {
      const targetCutoff = remap(load, 0, 1, FILTER_CUTOFF_MIN, FILTER_CUTOFF_MAX);

      this._engine.filter.frequency.setTargetAtTime(targetCutoff, this._ctx.currentTime, 0.05);
    }

    let skidVol = 0;

    if (driftIntensity > 0.5) {
      skidVol = remap(clamp(driftIntensity, 0.5, 2.5), 0.5, 2.5, 0.05, 0.3);
    }

    this._skid.currentVolume = lerp(this._skid.currentVolume, skidVol, dt * 10);
    this._skid.gain.gain.value = this._skid.currentVolume;

    const skidPitch = clamp(Math.abs(speed), 1, 3);

    this._skid.currentPitch = lerp(this._skid.currentPitch, skidPitch, 0.1);
    if (this._skid.source) this._skid.source.playbackRate.value = this._skid.currentPitch;
  }

  /**
   * A hit's thud.
   * @param impactVelocity - Closing speed, world units per second.
   * @param distance - Metres from the listener; 0 for the truck the cameras follow.
   * @param pan - Left -1 to right 1.
   */
  public playImpact(impactVelocity: number, distance = 0, pan = 0): void {
    if (!this._unlocked || this._impactBuffers.length === 0) return;

    const buffer = this._impactBuffers[this._impactIndex];

    this._impactIndex = (this._impactIndex + 1) % this._impactBuffers.length;

    const src = this._ctx.createBufferSource();
    const volume = clamp(remap(impactVelocity, 0, 6, 0.01, 1.0), 0.01, 1.0);

    src.buffer = buffer;
    src.connect(this._oneShot(volume * distanceGain(distance), pan));
    src.start();
  }

  /**
   * Another truck firing a boost: a rush of air rising through a bandpass.
   * @param power - Its strength, 0 to 1.
   * @param distance - Metres from the listener.
   * @param pan - Left -1 to right 1.
   */
  public whoosh(power: number, distance: number, pan: number): void {
    if (!this._unlocked) return;

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const out = this._oneShot((0.12 + power * 0.18) * distanceGain(distance), pan);
    const source = ctx.createBufferSource();
    const band = ctx.createBiquadFilter();
    const env = ctx.createGain();

    source.buffer = this._noiseBuffer();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(380, now);
    band.frequency.exponentialRampToValueAtTime(3200, now + 0.32);
    env.gain.setValueAtTime(0.001, now);
    env.gain.exponentialRampToValueAtTime(1, now + 0.06);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    source.connect(band).connect(env).connect(out);
    source.start(now);
    source.stop(now + 0.52);
  }

  /** Stop every voice and the music, and close the audio context. */
  public destroy(): void {
    this.music.destroy();
    this._engine.source?.stop();
    this._engineLayer.source?.stop();
    this._skid.source?.stop();
    void this._ctx.close();
  }

  /** A gain and panner into the game bus for one short sound; the graph lets both go when the sound ends. */
  private _oneShot(gain: number, pan: number): AudioNode {
    const ctx = this._ctx;
    const level = ctx.createGain();
    const panner = ctx.createStereoPanner();

    level.gain.value = gain;
    panner.pan.value = clamp(pan, -1, 1);
    level.connect(panner).connect(this._bus);

    return level;
  }

  private _noiseBuffer(): AudioBuffer {
    if (!this._noise) {
      const length = Math.floor(this._ctx.sampleRate * 0.6);
      const buffer = this._ctx.createBuffer(1, length, this._ctx.sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this._noise = buffer;
    }

    return this._noise;
  }

  private _mixGame(time: number): void {
    const level = this._paused ? 0 : (this._ducked ? DUCKED : 1) * SFX_GAIN;

    this._bus.gain.setTargetAtTime(level, this._ctx.currentTime, time / 3);
  }
}
