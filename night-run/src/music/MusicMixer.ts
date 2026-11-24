/** Seconds of the reverb's tail. */
const REVERB_SECONDS = 2.2;
/** The music while paused: quieter, and through a closed lowpass. */
const PAUSED_LEVEL = 0.4;
const PAUSED_CUTOFF = 650;
const OPEN_CUTOFF = 20000;
/** The tracks' sum is turned down this far before the compressor, so it only catches the loudest hits. */
const HEADROOM = 0.5;

/**
 * The music's bus, from the tracks to the output: a shared reverb, a highpass and low shelf that keep the low end
 * from crowding the engine, the pause's duck and lowpass, a glue compressor and
 * a limiter that keeps peaks under -1 dBFS, then the level the music sits at in the game.
 */
export class MusicMixer {
  /** Where the tracks' dry sound and delay returns go. */
  public readonly input: GainNode;
  /** The reverb's send bus. */
  public readonly reverb: GainNode;

  private readonly _ctx: BaseAudioContext;
  private readonly _nodes: AudioNode[];
  private readonly _duck: GainNode;
  private readonly _lowpass: BiquadFilterNode;
  private readonly _level: GainNode;
  private _paused = false;

  /**
   * @param ctx - The audio context.
   * @param output - Where the finished mix goes.
   * @param level - The mix's level there.
   */
  constructor(ctx: BaseAudioContext, output: AudioNode, level: number) {
    this._ctx = ctx;
    this.input = ctx.createGain();
    this.reverb = ctx.createGain();
    this._duck = ctx.createGain();
    this._lowpass = ctx.createBiquadFilter();
    this._level = ctx.createGain();

    const rumble = ctx.createBiquadFilter();
    const shelf = ctx.createBiquadFilter();
    const convolver = ctx.createConvolver();
    const wet = ctx.createGain();
    const glue = ctx.createDynamicsCompressor();
    const limiter = ctx.createDynamicsCompressor();
    const trim = ctx.createGain();

    convolver.normalize = true;
    convolver.buffer = MusicMixer._impulse(ctx);
    wet.gain.value = 0.55;
    rumble.type = 'highpass';
    rumble.frequency.value = 30;
    shelf.type = 'lowshelf';
    shelf.frequency.value = 100;
    shelf.gain.value = -4;
    this._lowpass.type = 'lowpass';
    this._lowpass.Q.value = 0.8;
    this._lowpass.frequency.value = OPEN_CUTOFF;
    this.input.gain.value = HEADROOM;
    glue.threshold.value = -14;
    glue.knee.value = 10;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.01;
    glue.release.value = 0.2;
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.09;
    trim.gain.value = 0.86;
    this._level.gain.value = level;

    this.reverb.connect(convolver).connect(wet).connect(this.input);
    this.input
      .connect(rumble)
      .connect(shelf)
      .connect(this._duck)
      .connect(this._lowpass)
      .connect(glue)
      .connect(limiter)
      .connect(trim);
    trim.connect(this._level).connect(output);
    this._nodes = [this.input, this.reverb, convolver, wet, rumble, shelf, this._duck, this._lowpass, glue, limiter];
    this._nodes.push(trim, this._level);
  }

  /**
   * Duck the music and close its filter while the race menu is open, or bring it back.
   * @param paused - Whether it's paused.
   */
  public setPaused(paused: boolean): void {
    if (paused === this._paused) return;

    const now = this._ctx.currentTime;

    this._paused = paused;
    this._duck.gain.setTargetAtTime(paused ? PAUSED_LEVEL : 1, now, 0.12);
    this._lowpass.frequency.setTargetAtTime(paused ? PAUSED_CUTOFF : OPEN_CUTOFF, now, paused ? 0.1 : 0.25);
  }

  /**
   * Move the level the music sits at in the game.
   * @param level - The new level.
   * @param seconds - Roughly how long the move takes.
   */
  public setLevel(level: number, seconds: number): void {
    this._level.gain.setTargetAtTime(level, this._ctx.currentTime, seconds / 4);
  }

  /** Disconnect every node of the bus. */
  public destroy(): void {
    for (const node of this._nodes) node.disconnect();
    this._nodes.length = 0;
  }

  /** A stereo room: decaying noise, darker as it fades, a little different left and right. */
  private static _impulse(ctx: BaseAudioContext): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * REVERB_SECONDS);
    const buffer = ctx.createBuffer(2, length, rate);
    const predelay = Math.floor(rate * 0.012);
    let seed = 0x9e3779b9;

    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      let low = 0;

      for (let i = predelay; i < length; i++) {
        const k = (i - predelay) / (length - predelay);

        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        low += (seed / 2147483648 - 1 - low) * (0.75 - 0.65 * k);
        data[i] = low * Math.pow(1 - k, 2.2) * Math.exp(-3.2 * k);
      }
    }

    return buffer;
  }
}
