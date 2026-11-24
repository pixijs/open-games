import type { MusicMixer } from './MusicMixer';
import type { ChannelMix, Song } from './score';
import { STEPS } from './score';

/** A step this late is dropped rather than played out of time. */
const LATE = 0.01;

/**
 * One song's player: its channels, each with a level, sends and an optional pump from the kick, its own ping-pong
 * delay, a fader the crossfades move, and the clock that steps the song a sixteenth at a time ahead of the audio.
 */
export class Track {
  public readonly kick: AudioNode;
  public readonly snare: AudioNode;
  public readonly hat: AudioNode;
  public readonly bass: AudioNode;
  public readonly pad: AudioNode;
  public readonly arp: AudioNode;
  public readonly lead: AudioNode;
  public readonly fx: AudioNode;
  public readonly song: Song;
  /** Seconds a sixteenth lasts. */
  public readonly step: number = 0;
  /** Context time of step 0. */
  public origin = 0;
  /** The next step to schedule. */
  public next = 0;
  /** Whether the clock runs. */
  public playing = false;
  /** Context time after which no step is scheduled. */
  public stopAt = Infinity;
  /** Where the fader is heading: 1 heard, 0 faded out. */
  public target = 0;

  private readonly _ctx: BaseAudioContext;
  private readonly _nodes: AudioNode[] = [];
  private readonly _pumps: AudioParam[] = [];
  private readonly _fader: GainNode;
  private readonly _wet: GainNode;
  private readonly _delay: GainNode;

  /**
   * @param ctx - The audio context.
   * @param mixer - The bus it plays into.
   * @param song - What it plays.
   */
  constructor(ctx: BaseAudioContext, mixer: MusicMixer, song: Song) {
    this._ctx = ctx;
    this.song = song;
    this.step = 60 / song.bpm / 4;
    this._fader = this._gain(0);
    this._wet = this._gain(0);
    this._delay = this._gain(1);
    this._fader.connect(mixer.input);
    this._wet.connect(mixer.reverb);
    this._pingPong(song.delay).connect(this._fader);

    const mix = song.mix;

    this.kick = this._channel(mix.kick);
    this.snare = this._channel(mix.snare);
    this.hat = this._channel(mix.hat);
    this.bass = this._channel(mix.bass);
    this.pad = this._channel(mix.pad);
    this.arp = this._channel(mix.arp);
    this.lead = this._channel(mix.lead);
    this.fx = this._channel(mix.fx);
  }

  /** Seconds a bar lasts. */
  public get bar(): number {
    return this.step * STEPS;
  }

  /**
   * Start the clock.
   * @param origin - Context time of step 0.
   * @param from - The first step to play.
   */
  public play(origin: number, from: number): void {
    this.origin = origin;
    this.next = from;
    this.playing = true;
    this.stopAt = Infinity;
  }

  /**
   * Move the fader.
   * @param to - 1 heard, 0 silent.
   * @param at - Context time the move starts.
   * @param seconds - Roughly how long it takes.
   */
  public fade(to: number, at: number, seconds: number): void {
    const now = this._ctx.currentTime;

    this.target = to;
    Track._move(this._fader.gain, to, now, Math.max(at, now), seconds);
    Track._move(this._wet.gain, to, now, Math.max(at, now), seconds);
  }

  /**
   * Fade out and stop the clock once it's silent.
   * @param at - Context time the fade starts.
   * @param seconds - Roughly how long it takes.
   */
  public fadeOut(at: number, seconds: number): void {
    this.fade(0, at, seconds);
    this.stopAt = Math.min(this.stopAt, at + seconds * 1.3);
  }

  /**
   * Duck the pumped channels under a kick, sidechain style.
   * @param t - The kick's time.
   */
  public pump(t: number): void {
    const floor = 1 - this.song.pump;

    for (let i = 0; i < this._pumps.length; i++) {
      const gain = this._pumps[i];

      gain.setTargetAtTime(floor, t, 0.004);
      gain.setTargetAtTime(1, t + 0.04, 0.075);
    }
  }

  /**
   * Hand the song every step that lands before `until`.
   * @param now - Context time now; steps already gone are skipped.
   * @param until - Context time to schedule up to.
   * @param silent - Keep time without making a sound, as while the sound is off.
   */
  public schedule(now: number, until: number, silent: boolean): void {
    if (!this.playing) return;

    let t = this.origin + this.next * this.step;

    while (t < until) {
      if (t >= this.stopAt) {
        this.playing = false;

        return;
      }

      if (!silent && t >= now - LATE) this.song.play(this.next, t, this);

      this.next++;
      t = this.origin + this.next * this.step;
    }
  }

  /** Disconnect every node of the track. */
  public destroy(): void {
    this.playing = false;

    for (const node of this._nodes) node.disconnect();
    this._nodes.length = 0;
    this._pumps.length = 0;
  }

  private _gain(value: number): GainNode {
    const gain = this._ctx.createGain();

    gain.gain.value = value;
    this._nodes.push(gain);

    return gain;
  }

  /** A channel's input: its level, then its fixed filter and pump, into the fader and its sends. */
  private _channel(mix: ChannelMix): AudioNode {
    const ctx = this._ctx;
    const input = this._gain(mix.level);
    let tail: AudioNode = input;

    if (mix.highpass) {
      const hp = ctx.createBiquadFilter();

      hp.type = 'highpass';
      hp.frequency.value = mix.highpass;
      hp.Q.value = 0.7;
      this._nodes.push(hp);
      tail = tail.connect(hp);
    }

    if (mix.pump) {
      const pump = this._gain(1);

      this._pumps.push(pump.gain);
      tail = tail.connect(pump);
    }

    tail.connect(this._fader);
    if (mix.delay) tail.connect(this._gain(mix.delay)).connect(this._delay);
    if (mix.reverb) tail.connect(this._gain(mix.reverb)).connect(this._wet);

    return input;
  }

  /** Echoes that bounce left, right, left, each darker than the last. */
  private _pingPong(seconds: number): AudioNode {
    const ctx = this._ctx;
    const left = ctx.createDelay(1);
    const right = ctx.createDelay(1);
    const damp = ctx.createBiquadFilter();
    const feedback = this._gain(0.42);
    const merger = ctx.createChannelMerger(2);
    const out = this._gain(0.7);

    left.delayTime.value = seconds;
    right.delayTime.value = seconds;
    damp.type = 'lowpass';
    damp.frequency.value = 3200;
    this._delay.connect(left);
    left.connect(merger, 0, 0);
    left.connect(damp).connect(right);
    right.connect(merger, 0, 1);
    right.connect(feedback).connect(left);
    merger.connect(out);
    this._nodes.push(left, right, damp, merger);

    return out;
  }

  private static _move(param: AudioParam, to: number, now: number, at: number, seconds: number): void {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(to, at, Math.max(seconds, 0.02) / 4);
  }
}
