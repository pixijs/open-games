import { BarPlayer } from './BarPlayer';
import type { Bar, Song, SongMix, SectionSpec } from './score';
import { arpNote, chord, compile, STEPS } from './score';
import type { Track } from './Track';
import type { Voices } from './Voices';

const CHORDS = {
  Am: chord('A2', 'A3', 'C4', 'E4', 'A4'),
  F: chord('F2', 'A3', 'C4', 'F4', 'G4'),
  C: chord('C3', 'G3', 'C4', 'E4', 'G4'),
  G: chord('G2', 'G3', 'B3', 'D4', 'G4'),
  E: chord('E2', 'G#3', 'B3', 'E4', 'G#4'),
  Dm: chord('D2', 'A3', 'D4', 'F4', 'A4'),
};

/** The chord the countdown swells on, and the one a finish resolves to. */
const SWELL = CHORDS.Am;
const HOME = chord('A1', 'A3', 'C#4', 'E4', 'A4');

const HOOK =
  'E5:6 D5:2 E5:4 A5:4 | G5:6 F5:2 E5:4 C5:4 | E5:6 D5:2 E5:4 G5:4 | D5:12 B4:2 D5:2 |' +
  'E5:6 D5:2 E5:4 A5:4 | C6:6 B5:2 A5:4 F5:4 | G5:6 F5:2 D5:4 B4:4 | B4:4 E5:4 G#5:8';
const ANSWER =
  '-:16 | -:16 | -:16 | -:16 |' +
  'A4:3 C5:3 E5:2 A5:8 | F5:3 E5:3 D5:2 A4:8 | C5:3 F5:3 A5:2 C6:8 | B5:6 A5:2 G5:4 D5:4';
const TEASE = 'E5:6 D5:2 E5:4 A5:4 | G5:6 E5:2 -:8 | D5:6 B4:2 D5:4 G5:4 | G#5:16';

const FOUR = '9...9...9...9...';
const CLAP = '....9.......9...';
const HATS = '3262326232623262';
const OFFBEAT = '..6...6...6...6.';

/**
 * The form after GO: a four-bar drop straight into the hook, a drive with the lead's answer, a breakdown that teases
 * the hook back, and the hook again doubled an octave up. After its 32 bars it loops from the drive.
 */
const FORM: readonly SectionSpec[] = [
  {
    bars: 4,
    chords: 'Am F C G',
    kick: FOUR,
    snare: CLAP,
    hat: HATS,
    bass: 'pulse16',
    arp: 'sixteenths',
    cutoff: [1000, 1400],
    crash: true,
    fill: 'roll',
  },
  {
    bars: 8,
    chords: 'Am F C G Am F G E',
    kick: FOUR,
    snare: CLAP,
    hat: HATS,
    open: OFFBEAT,
    bass: 'pulse16',
    arp: 'sixteenths',
    cutoff: [1500, 2000],
    lead: HOOK,
    crash: true,
    fill: 'toms',
  },
  {
    bars: 8,
    chords: 'Am Dm F E Am Dm F G',
    kick: FOUR,
    snare: CLAP,
    hat: HATS,
    open: OFFBEAT,
    bass: 'octave',
    arp: 'sixteenths',
    cutoff: [2000, 2600],
    lead: ANSWER,
    crash: true,
  },
  {
    bars: 4,
    chords: 'F C G E',
    hat: '..4...4...4...4.',
    bass: 'held',
    arp: 'sixteenths',
    cutoff: [600, 2000],
    pluck: TEASE,
    fill: 'roll',
    riser: true,
  },
  {
    bars: 8,
    chords: 'Am F C G Am F G E',
    kick: FOUR,
    snare: CLAP,
    hat: HATS,
    open: OFFBEAT,
    bass: 'pulse16',
    arp: 'sixteenths',
    cutoff: [2000, 2600],
    lead: HOOK,
    double: true,
    crash: true,
    fill: 'toms',
  },
];

/** The bar the loop goes back to, the drive. */
const LOOP_FROM = 12;
/** Sixteenths of the countdown's riser: the room's 4.5 s countdown at 140 BPM. */
export const RISER_STEPS = 42;

const MIX: SongMix = {
  kick: { level: 0.66 },
  snare: { level: 0.46, reverb: 0.3, highpass: 300 },
  hat: { level: 0.5, highpass: 8000 },
  bass: { level: 0.46, pump: true },
  pad: { level: 0.3, reverb: 0.4, pump: true },
  arp: { level: 0.46, delay: 0.32, reverb: 0.15, pump: true },
  lead: { level: 0.32, delay: 0.26, reverb: 0.3 },
  fx: { level: 0.4, reverb: 0.35 },
};

/**
 * The race's music, "Night Run": A minor at 140 BPM, four on the floor, a pulsing sixteenth bass ducked by the kick,
 * a sawtooth arpeggio and a lead hook. It's locked to the race: a riser under the countdown with a boom on each light
 * and a snare roll into GO, where the beat drops; the final lap opens the arpeggio's filter and adds a second one an
 * octave up; the player's finish lands on a held A major chord.
 */
export class RaceSong implements Song {
  public readonly bpm = 140;
  public readonly delay = (60 / 140) * 0.75;
  public readonly pump = 0.55;
  public readonly mix = MIX;
  /** The first sixteenth of the final lap's layer. */
  public finalFrom = Infinity;
  /** The sixteenth the finish chord lands on; nothing plays after it. */
  public finishStep = Infinity;
  /** Context time the drop was scheduled for, or -1. */
  public droppedAt = -1;

  private readonly _bars: Bar[] = compile(FORM, CHORDS);
  private readonly _voices: Voices;
  private readonly _player: BarPlayer;
  private _riser = false;

  /** @param voices - The instruments. */
  constructor(voices: Voices) {
    this._voices = voices;
    this._player = new BarPlayer(voices, {
      kick: 1,
      snare: 0.62,
      gate: 0.085,
      hat: 0.4,
      open: 0.3,
      crash: 0.38,
      riser: 0.34,
      tom: 0.75,
      pad: 0.85,
      padAttack: 0.06,
      padRelease: 0.45,
      padCutoff: 1.5,
      bass: 1,
      bassCutoff: 480,
      arp: 0.42,
      arpDecay: 0.2,
      arpWave: 'sawtooth',
      arpOctave: 12,
      lead: 0.62,
      bell: 0.5,
    });
  }

  /**
   * A new race.
   * @param riser - Whether the countdown's riser plays: not when joining a race already under way.
   */
  public reset(riser: boolean): void {
    this._riser = riser;
    this.finalFrom = Infinity;
    this.finishStep = Infinity;
    this.droppedAt = -1;
    this._player.reset();
  }

  public play(step: number, time: number, track: Track): void {
    if (step < 0) {
      this._countdown(step, time, track);

      return;
    }

    if (step >= this.finishStep) {
      if (step === this.finishStep) this._resolve(time, track);

      return;
    }

    if (step === 0) {
      this.droppedAt = time;
      this._voices.boom(time, 0.8, track.kick);
    }

    const b = step >> 4;
    const bar = this._bars[b < this._bars.length ? b : LOOP_FROM + ((b - LOOP_FROM) % (this._bars.length - LOOP_FROM))];
    const s = step & (STEPS - 1);
    const final = step >= this.finalFrom;

    this._player.play(bar, s, time, track, final ? 1.9 : 1);

    if (final) this._finalLap(bar, s, step, time, track);
  }

  /**
   * The riser from wherever the countdown was joined, a boom under each light, and a snare roll into GO. All of it
   * stops a sixteenth short of GO, so the drop lands out of a breath of silence.
   */
  private _countdown(step: number, time: number, track: Track): void {
    const voices = this._voices;
    const go = time - step * track.step;

    if (this._riser) {
      this._riser = false;

      const top = go - track.step;
      const span = top - time;

      voices.pad(time, SWELL.pad, span, 0.85, 2600, span * 0.95, 0.03, track.pad);
      voices.riser(time, top, 0.4, track.fx);
      voices.climb(time, top, 45, 0.2, track.fx);
    }

    for (let light = 1; light <= 3; light++) {
      const at = go - light;

      if (at >= time && at < time + track.step) voices.boom(at, 0.9, track.kick);
    }

    if (step < -STEPS) return;

    const k = (step + STEPS) / STEPS;
    const vel = this._player.tone.snare * (0.22 + 0.7 * k);

    if ((step < -8 && step % 2 !== 0) || step === -1) return;

    voices.snare(time, vel, 0.05, track.snare);
    if (step >= -4) voices.snare(time + track.step / 2, vel, 0.045, track.snare);
  }

  /** The final lap's layer: a crash and a boom to mark it, then a square arpeggio an octave over the first. */
  private _finalLap(bar: Bar, s: number, step: number, time: number, track: Track): void {
    const voices = this._voices;

    if (step === this.finalFrom && step > 0) {
      voices.crash(time, 0.4, track.fx);
      voices.boom(time, 0.7, track.kick);
    }

    if (bar.spec.arp === 'none') return;

    voices.pluck(time, arpNote(bar.chords[s], (s + 2) % STEPS, 24), 0.2, 3400, 0.14, 'square', track.arp);
  }

  /** The finish: everything lands on a held A major chord, and the song stops there. */
  private _resolve(time: number, track: Track): void {
    const voices = this._voices;
    const tone = this._player.tone;

    voices.kick(time, 1, track.kick);
    voices.boom(time, 0.9, track.kick);
    voices.crash(time, 0.5, track.fx);
    voices.pad(time, HOME.pad, 2.6, tone.pad * 1.15, 3200, 0.02, 2.4, track.pad);
    voices.bass(time, HOME.bass, 1.4, tone.bass, 320, track.bass, 2.4);
    voices.lead(time, 81, 1.8, tone.lead * 0.75, -1, track.lead, 1.6);
  }
}
