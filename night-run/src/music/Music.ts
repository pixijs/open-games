import { MusicMixer } from './MusicMixer';
import { RaceSong, RISER_STEPS } from './RaceSong';
import { STEPS } from './score';
import { TitleSong } from './TitleSong';
import { Track } from './Track';
import { Voices } from './Voices';

/** Seconds of music scheduled ahead of the audio clock, so a dropped frame never makes it stutter. */
const LOOKAHEAD = 0.2;
/** Lookahead in a hidden tab, where timers fire about once a second. */
const HIDDEN_LOOKAHEAD = 1.5;
const TICK_MS = 50;
/** The title's level in the game: over the attract race's engines. */
const TITLE_LEVEL = 0.42;
/** The race's level in the game, under the engine and the effects. */
const RACE_LEVEL = 0.2;
/** Seconds the title fades in over when the sound first comes on. */
const FIRST_FADE = 5;
/** Seconds the title waits after the finish chord before it fades back in. */
const HANDBACK = 2.2;

/** What the music is doing, measured each second while it runs. */
export interface MusicStats {
  /** The track that's heard. */
  track: 'title' | 'race';
  /** Milliseconds a second the scheduler spends on the main thread. */
  schedulerMs: number;
  /** Nodes sounding now. */
  nodes: number;
  /** Nodes made in the last second. */
  nodesPerSecond: number;
  /** `performance.now()` the race's drop is heard at, or -1. */
  dropAt: number;
}

/** Options for {@link Music}. */
export interface MusicOptions {
  /** The music's level at the output for both tracks; by default the title's and the race's own. */
  level?: number;
  /** Rendering into an `OfflineAudioContext`: no timer, and times are the context's own, in milliseconds. */
  offline?: boolean;
}

/**
 * NIGHT RUN's music: the title track and the race track, synthesised live and stepped a sixteenth at a time by a
 * scheduler that runs {@link LOOKAHEAD} seconds ahead of the audio clock. The game tells it the phase: the title on the
 * menus, the lobby and the results; the race from the countdown, its riser locked to the synced GO time so every
 * screen in a party drops together; the final lap; the player's finish, which resolves and hands back to the title;
 * and pause, which ducks it and closes its filter. It starts when the audio unlocks.
 */
export class Music {
  public readonly stats: MusicStats = { track: 'title', schedulerMs: 0, nodes: 0, nodesPerSecond: 0, dropAt: -1 };

  private readonly _ctx: BaseAudioContext;
  private readonly _offline: boolean;
  private readonly _titleLevel: number;
  private readonly _raceLevel: number;
  private readonly _voices: Voices;
  private readonly _mixer: MusicMixer;
  private readonly _raceSong: RaceSong;
  private readonly _title: Track;
  private readonly _race: Track;
  private _timer = 0;
  private _live = false;
  private _muted = false;
  /** Context seconds minus `performance.now()` seconds, for when a sound is heard. */
  private _offset = 0;
  private _goAt = 0;
  private _windowAt = 0;
  private _spent = 0;
  private _createdAt = 0;

  /**
   * @param ctx - The audio context.
   * @param output - Where the music goes: the game's master.
   * @param options - Level and offline rendering.
   */
  constructor(ctx: BaseAudioContext, output: AudioNode, options: MusicOptions = {}) {
    this._ctx = ctx;
    this._offline = options.offline ?? false;
    this._titleLevel = options.level ?? TITLE_LEVEL;
    this._raceLevel = options.level ?? RACE_LEVEL;
    this._voices = new Voices(ctx);
    this._mixer = new MusicMixer(ctx, output, this._titleLevel);
    this._raceSong = new RaceSong(this._voices);
    this._title = new Track(ctx, this._mixer, new TitleSong(this._voices));
    this._race = new Track(ctx, this._mixer, this._raceSong);
  }

  /** Start once the audio is unlocked: the title fades in, or the race comes in where it's got to. */
  public start(): void {
    if (this._offline) {
      this._live = true;
      this._begin();

      return;
    }

    if (this._timer) return;

    this._windowAt = performance.now();
    this._timer = window.setInterval(this._tick, TICK_MS);
  }

  /**
   * Schedule both tracks up to a time. The timer does this live; an offline render calls it itself.
   * @param until - Context time.
   */
  public pump(until: number): void {
    const now = this._ctx.currentTime;

    this._title.schedule(now, until, this._muted);
    this._race.schedule(now, until, this._muted);
  }

  /** The title track: on the title, the menus, the lobby and the results. */
  public title(): void {
    this.stats.track = 'title';

    if (this._live) this._toTitle(this._ctx.currentTime + 0.05, 3);
  }

  /**
   * The race track from the countdown: its riser, and the drop on GO.
   * @param goAt - `performance.now()` of the green light (the context's own milliseconds when offline).
   */
  public countdown(goAt: number): void {
    this.stats.track = 'race';
    this._goAt = goAt;

    if (this._live) this._toRace(true);
  }

  /** The green light, as the room's clock moves it during the countdown. */
  public set goAt(value: number) {
    this._goAt = value;

    if (this._live && this._race.playing && this._race.next < 0) this._race.origin = this._time(value);
  }

  /**
   * The race track joined part way, as a spectator or a guest coming back.
   * @param elapsed - Seconds since GO.
   */
  public racing(elapsed: number): void {
    this.stats.track = 'race';
    this._goAt = this._now() - elapsed * 1000;

    if (this._live) this._toRace(false);
  }

  /** The final lap: a layer joins on the next bar. */
  public finalLap(): void {
    const race = this._race;

    if (!this._live || !race.playing || this._raceSong.finalFrom !== Infinity) return;

    this._raceSong.finalFrom = race.next < 0 ? 0 : Math.ceil(race.next / STEPS) * STEPS;
  }

  /** The player's finish: the race lands on a held chord on the next beat, then the title comes back. */
  public finish(): void {
    const race = this._race;
    const song = this._raceSong;

    this.stats.track = 'title';

    if (!this._live || !race.playing || song.finishStep !== Infinity) return;

    const step = Math.max(0, Math.ceil(race.next / 4) * 4);
    const at = race.origin + step * race.step;

    song.finishStep = step;
    race.stopAt = at + race.step / 2;
    this._title.play(at + HANDBACK, 0);
    this._title.fade(1, at + HANDBACK, 4);
    this._mixer.setLevel(this._titleLevel, HANDBACK + 4);
  }

  /**
   * Duck the music and close its filter under the race menu.
   * @param paused - Whether the menu is open.
   */
  public setPaused(paused: boolean): void {
    this._mixer.setPaused(paused);
  }

  /**
   * With the sound off, the scheduler keeps time but makes no notes.
   * @param muted - Whether the sound is off.
   */
  public setMuted(muted: boolean): void {
    this._muted = muted;
  }

  /** Stop the scheduler and disconnect every node. */
  public destroy(): void {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = 0;
    this._live = false;
    this._title.destroy();
    this._race.destroy();
    this._mixer.destroy();
  }

  private readonly _tick = (): void => {
    const ctx = this._ctx;
    const started = performance.now();

    if (!this._live) {
      if (ctx.state !== 'running') return;

      this._live = true;
      this._begin();
    }

    this.pump(ctx.currentTime + (document.hidden ? HIDDEN_LOOKAHEAD : LOOKAHEAD));

    const done = performance.now();

    this._spent += done - started;

    if (done - this._windowAt < 1000) return;

    const stats = this.stats;
    const created = this._voices.created;

    stats.schedulerMs = (this._spent * 1000) / (done - this._windowAt);
    stats.nodes = this._voices.active(ctx.currentTime);
    stats.nodesPerSecond = ((created - this._createdAt) * 1000) / (done - this._windowAt);
    stats.dropAt = this._raceSong.droppedAt < 0 ? -1 : (this._raceSong.droppedAt - this._offset) * 1000;
    this._createdAt = created;
    this._spent = 0;
    this._windowAt = done;
  };

  /** The audio's just come on: play whatever the game is showing. */
  private _begin(): void {
    this._sync();

    if (this.stats.track === 'title') this._toTitle(this._ctx.currentTime + 0.05, FIRST_FADE);
    else this._toRace(this._time(this._goAt) - this._ctx.currentTime > 0.3);
  }

  private _toTitle(at: number, fade: number): void {
    const title = this._title;
    const race = this._race;

    if (!title.playing) {
      title.play(at, 0);
      title.fade(1, at, fade);
    } else if (title.target < 1) {
      title.fade(1, at, 1.5);
      title.stopAt = Infinity;
    }

    if (race.playing && race.target > 0 && at < race.stopAt) race.fadeOut(at, 1.6);
    this._mixer.setLevel(this._titleLevel, fade);
  }

  private _toRace(riser: boolean): void {
    const now = this._ctx.currentTime;
    const race = this._race;

    this._sync();

    const go = this._time(this._goAt);
    const from = Math.ceil((now + 0.02 - go) / race.step);

    this._raceSong.reset(riser);
    race.play(go, riser ? Math.max(from, -RISER_STEPS) : Math.max(from, 0));
    race.fade(1, now, riser ? 0.02 : 1);
    if (this._title.playing) this._title.fadeOut(now, 1.4);
    this._mixer.setLevel(this._raceLevel, 1.4);
  }

  /** Line the context's clock up with `performance.now()`, through the output's latency. */
  private _sync(): void {
    const ctx = this._ctx;

    if (this._offline) {
      this._offset = 0;

      return;
    }

    const audio = ctx as AudioContext;
    const stamp = audio.getOutputTimestamp?.();

    if (stamp && stamp.contextTime && stamp.performanceTime) {
      this._offset = stamp.contextTime - stamp.performanceTime / 1000;
    } else {
      this._offset = ctx.currentTime - performance.now() / 1000 - (audio.outputLatency || audio.baseLatency || 0);
    }
  }

  private _now(): number {
    return this._offline ? this._ctx.currentTime * 1000 : performance.now();
  }

  /** The context time a `performance.now()` moment is heard at. */
  private _time(ms: number): number {
    return ms / 1000 + this._offset;
  }
}
