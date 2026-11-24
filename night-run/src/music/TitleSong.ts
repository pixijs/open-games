import { BarPlayer } from './BarPlayer';
import type { Bar, Song, SongMix, SectionSpec } from './score';
import { chord, compile, STEPS } from './score';
import type { Track } from './Track';
import type { Voices } from './Voices';

const CHORDS = {
  Dm9: chord('D2', 'F3', 'A3', 'C4', 'E4'),
  Bbmaj7: chord('Bb1', 'F3', 'A3', 'D4', 'F4'),
  Fadd9: chord('F2', 'F3', 'A3', 'C4', 'G4'),
  Cadd9: chord('C2', 'E3', 'G3', 'D4', 'G4'),
  Gm9: chord('G1', 'F3', 'Bb3', 'D4', 'A4'),
  Asus4: chord('A1', 'E3', 'A3', 'D4', 'E4'),
  A: chord('A1', 'E3', 'A3', 'C#4', 'E4'),
};

const HOME = 'Dm9 Bbmaj7 Fadd9 Cadd9';
const AWAY = 'Gm9 Bbmaj7 Dm9 Asus4>A';
const BRIDGE = 'Bbmaj7 Cadd9 Dm9 Dm9 Gm9 Bbmaj7 Asus4 A';

const THEME =
  'D5:6 C5:2 Bb4:4 G4:4 | F4:4 Bb4:4 C5:4 D5:4 | F5:8 E5:4 D5:4 | E5:8 C#5:8 |' +
  'D5:6 C5:2 Bb4:4 D5:4 | F5:6 D5:2 C5:4 Bb4:4 | A4:6 D5:2 F5:4 E5:4 | E5:8 C#5:4 A4:4';
const THEME_LIFT =
  'D5:6 C5:2 Bb4:4 G4:4 | F4:4 Bb4:4 C5:4 D5:4 | F5:8 E5:4 D5:4 | E5:8 C#5:8 |' +
  'G5:6 F5:2 D5:4 Bb4:4 | C5:4 D5:4 F5:8 | E5:6 F5:2 A5:8 | G5:4 E5:4 C#5:8';
const LANDING = 'D5:16 | -:16 | -:16 | -:16 | -:16 | -:16 | -:16 | -:16';
const BELLS =
  'A5:4 -:2 F5:2 D5:8 | G5:4 -:2 E5:2 C5:8 | F5:4 E5:4 D5:4 A4:4 | D5:16 |' +
  'A5:4 -:2 Bb5:2 F5:8 | A5:4 -:2 F5:2 D5:8 | E5:8 D5:8 | C#5:8 E5:8';

const KICK_HALF = '9.......9.......';
const KICK_PUSH = '9.......9.....5.';
const BACKBEAT = '....9.......9...';
const HATS = '5.3.5.3.5.3.5.3.';
const HATS_SOFT = '3.1.3.1.3.1.3.1.';

/**
 * The form: an intro of pads with the arpeggio creeping in, then five eight-bar sections that loop, the theme twice
 * with a bridge between, each with its own chords, drums and bass so the loop takes 96 seconds to come round.
 */
const FORM: readonly SectionSpec[] = [
  { bars: 8, chords: HOME, bass: 'none', arp: 'eighths', arpFrom: 4, cutoff: [420, 2000], riser: true },
  {
    bars: 8,
    chords: HOME,
    kick: KICK_HALF,
    hat: HATS_SOFT,
    bass: 'held',
    arp: 'eighths',
    cutoff: [1500, 2100],
    fill: 'toms',
  },
  {
    bars: 8,
    chords: AWAY,
    kick: KICK_PUSH,
    snare: BACKBEAT,
    hat: HATS,
    bass: 'pulse8',
    arp: 'eighths',
    cutoff: [2100, 2500],
    lead: THEME,
    crash: true,
  },
  {
    bars: 8,
    chords: BRIDGE,
    hat: HATS_SOFT,
    bass: 'held',
    arp: 'sixteenths',
    cutoff: [800, 2300],
    pluck: BELLS,
    fill: 'roll',
    riser: true,
  },
  {
    bars: 8,
    chords: AWAY,
    kick: KICK_PUSH,
    snare: BACKBEAT,
    hat: HATS,
    open: '..............6.',
    bass: 'pulse8',
    arp: 'eighths',
    cutoff: [2300, 2900],
    lead: THEME_LIFT,
    double: true,
    crash: true,
    fill: 'toms',
  },
  {
    bars: 8,
    chords: HOME,
    kick: KICK_HALF,
    snare: '............9...',
    hat: HATS_SOFT,
    bass: 'held',
    arp: 'eighths',
    cutoff: [2300, 1300],
    lead: LANDING,
    fill: 'toms',
  },
];

/** The bar the loop goes back to: the intro plays once. */
const LOOP_FROM = 8;

const MIX: SongMix = {
  kick: { level: 0.74 },
  snare: { level: 0.44, reverb: 0.55, highpass: 240 },
  hat: { level: 0.69, delay: 0.12, highpass: 7500 },
  bass: { level: 0.46, pump: true },
  pad: { level: 0.53, reverb: 0.5, pump: true },
  arp: { level: 0.3, delay: 0.5, reverb: 0.25, pump: true },
  lead: { level: 0.41, delay: 0.34, reverb: 0.4 },
  fx: { level: 0.46, reverb: 0.55 },
};

/**
 * The title's music, "Pit Wall After Dark": D minor at 100 BPM, wide detuned pads, a slow square arpeggio through a
 * dotted-eighth delay, a warm held bass, and a gated snare on the backbeat once the theme comes in. It plays on the
 * title, the menus, the lobby and the results.
 */
export class TitleSong implements Song {
  public readonly bpm = 100;
  public readonly delay = (60 / 100) * 0.75;
  public readonly pump = 0.3;
  public readonly mix = MIX;

  private readonly _bars: Bar[] = compile(FORM, CHORDS);
  private readonly _player: BarPlayer;

  /** @param voices - The instruments. */
  constructor(voices: Voices) {
    this._player = new BarPlayer(voices, {
      kick: 0.85,
      snare: 0.6,
      gate: 0.21,
      hat: 0.5,
      open: 0.4,
      crash: 0.32,
      riser: 0.32,
      tom: 0.65,
      pad: 0.95,
      padAttack: 0.9,
      padRelease: 1.6,
      padCutoff: 1,
      bass: 0.9,
      bassCutoff: 360,
      arp: 0.5,
      arpDecay: 0.34,
      arpWave: 'square',
      arpOctave: 12,
      lead: 0.55,
      bell: 0.42,
    });
  }

  public play(step: number, time: number, track: Track): void {
    if (step < 0) return;

    const b = Math.floor(step / STEPS);
    const bar = this._bars[b < this._bars.length ? b : LOOP_FROM + ((b - LOOP_FROM) % (this._bars.length - LOOP_FROM))];

    this._player.play(bar, step % STEPS, time, track);
  }
}
