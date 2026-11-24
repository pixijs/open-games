import type { Bar, Chord } from './score';
import { arpNote } from './score';
import type { Track } from './Track';
import type { Voices } from './Voices';

/** How a song's instruments are played: levels, envelopes and tone. */
export interface Tone {
  readonly kick: number;
  readonly snare: number;
  /** Seconds the snare's gate stays open. */
  readonly gate: number;
  readonly hat: number;
  readonly open: number;
  readonly crash: number;
  readonly riser: number;
  readonly tom: number;
  readonly pad: number;
  readonly padAttack: number;
  readonly padRelease: number;
  /** The pad's cutoff against the bar's. */
  readonly padCutoff: number;
  readonly bass: number;
  readonly bassCutoff: number;
  readonly arp: number;
  readonly arpDecay: number;
  readonly arpWave: OscillatorType;
  /** Semitones the arpeggio sits above the pad's voicing. */
  readonly arpOctave: number;
  readonly lead: number;
  readonly bell: number;
}

const PULSE = [1, 0.55, 0.78, 0.55];
const TOMS = [50, 47, 43, 40];

/**
 * Plays a compiled {@link Bar} a sixteenth at a time with a song's {@link Tone}: drums and fills, pads and held bass
 * on chord changes, the bass's pulse, the arpeggio, and the lead gliding between legato notes.
 */
export class BarPlayer {
  public readonly tone: Tone;

  private readonly _voices: Voices;
  private _lastLead = -1;
  private _leadEnds = 0;

  /**
   * @param voices - The instruments.
   * @param tone - How they're played.
   */
  constructor(voices: Voices, tone: Tone) {
    this._voices = voices;
    this.tone = tone;
  }

  /**
   * Play what the bar holds on one sixteenth.
   * @param bar - The bar.
   * @param s - The sixteenth, 0 to 15.
   * @param t - Its context time.
   * @param track - Where it plays.
   * @param arpCutoff - The arpeggio's cutoff against the bar's, as a final lap opens it.
   */
  public play(bar: Bar, s: number, t: number, track: Track, arpCutoff = 1): void {
    const voices = this._voices;
    const tone = this.tone;
    const spec = bar.spec;
    const step = track.step;
    const chord = bar.chords[s];

    this.drums(bar, s, t, track);

    if (s === 0 && bar.first && spec.crash) voices.crash(t, tone.crash, track.fx);
    if (s === 0 && bar.last && spec.riser) voices.riser(t, t + track.bar, tone.riser, track.fx);

    const held = bar.held[s];

    if (held) {
      const seconds = held.len * step;

      voices.pad(
        t,
        held.chord.pad,
        seconds,
        tone.pad,
        bar.cutoff * tone.padCutoff,
        tone.padAttack,
        tone.padRelease,
        track.pad,
      );
      if (spec.bass === 'held') voices.bass(t, held.chord.bass, seconds - 0.04, tone.bass, tone.bassCutoff, track.bass);
    }

    this._bass(spec.bass, chord, s, t, step, track);

    if (spec.arp !== 'none' && bar.index >= (spec.arpFrom ?? 0) && (spec.arp === 'sixteenths' || s % 2 === 0)) {
      const vel = tone.arp * (s % 4 === 0 ? 1 : 0.72) * (0.92 + voices.random() * 0.16);
      const decay = spec.arp === 'eighths' ? tone.arpDecay * 1.6 : tone.arpDecay;

      voices.pluck(t, arpNote(chord, s, tone.arpOctave), vel, bar.cutoff * arpCutoff, decay, tone.arpWave, track.arp);
    }

    const lead = bar.lead[s];

    if (lead) {
      const seconds = lead.len * step * 0.94;
      const from = this._lastLead >= 0 && t - this._leadEnds < step * 0.5 ? this._lastLead : -1;

      voices.lead(t, lead.midi, seconds, tone.lead, from, track.lead);
      if (spec.double)
        voices.lead(t, lead.midi + 12, seconds, tone.lead * 0.42, from >= 0 ? from + 12 : -1, track.lead);
      this._lastLead = lead.midi;
      this._leadEnds = t + lead.len * step;
    }

    const bell = bar.pluck[s];

    if (bell) voices.pluck(t, bell.midi, tone.bell, 2400, Math.min(bell.len * step * 1.5, 1.6), 'triangle', track.arp);
  }

  /**
   * The bar's drums on one sixteenth, and the fill that closes a section.
   * @param bar - The bar.
   * @param s - The sixteenth, 0 to 15.
   * @param t - Its context time.
   * @param track - Where it plays.
   */
  public drums(bar: Bar, s: number, t: number, track: Track): void {
    const voices = this._voices;
    const tone = this.tone;
    const fill = bar.last ? (bar.spec.fill ?? 'none') : 'none';

    if (bar.kick && bar.kick[s] > 0) {
      voices.kick(t, bar.kick[s] * tone.kick, track.kick);
      track.pump(t);
    }

    if (fill === 'roll' && s >= 8) {
      const k = (s - 8) / 7;

      voices.snare(t, tone.snare * (0.3 + 0.6 * k), 0.06, track.snare);
      if (s >= 12) voices.snare(t + track.step / 2, tone.snare * (0.4 + 0.6 * k), 0.05, track.snare);
    } else if (fill === 'toms' && s >= 12) {
      voices.tom(t, TOMS[s - 12], tone.tom, track.kick);
    } else if (bar.snare && bar.snare[s] > 0) {
      voices.snare(t, bar.snare[s] * tone.snare, tone.gate, track.snare);
    }

    const humanise = 0.85 + voices.random() * 0.3;

    if (bar.open && bar.open[s] > 0) voices.hat(t, bar.open[s] * tone.open * humanise, true, track.hat);
    else if (bar.hat && bar.hat[s] > 0) voices.hat(t, bar.hat[s] * tone.hat * humanise, false, track.hat);
  }

  /** Forget the lead's last note, so a new section's first doesn't glide in from an old one. */
  public reset(): void {
    this._lastLead = -1;
    this._leadEnds = 0;
  }

  private _bass(style: Bar['spec']['bass'], chord: Chord, s: number, t: number, step: number, track: Track): void {
    const voices = this._voices;
    const tone = this.tone;

    if (style === 'pulse16') {
      voices.bass(t, chord.bass, step * 0.72, tone.bass * PULSE[s % 4], tone.bassCutoff, track.bass);
    } else if (style === 'pulse8' && s % 2 === 0) {
      voices.bass(t, chord.bass, step * 1.7, tone.bass * (s % 4 === 0 ? 1 : 0.7), tone.bassCutoff, track.bass);
    } else if (style === 'octave' && s % 2 === 0) {
      const up = s % 4 === 2 ? 12 : 0;

      voices.bass(t, chord.bass + up, step * 1.5, tone.bass * (up ? 0.7 : 1), tone.bassCutoff, track.bass);
    }
  }
}
