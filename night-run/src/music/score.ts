import type { Track } from './Track';

/** Sixteenths in a bar of 4/4. */
export const STEPS = 16;

const NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * A note's frequency.
 * @param midi - MIDI note number; 69 is A4.
 * @returns Hz.
 */
export function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * A note name as MIDI.
 * @param name - Such as `A4`, `C#5` or `Bb1`.
 * @returns The MIDI note number.
 */
export function midi(name: string): number {
  const match = /^([A-G])([#b]?)(-?\d)$/.exec(name);

  if (!match) throw new Error(`music: bad note ${name}`);

  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;

  return 12 * (Number(match[3]) + 1) + NAMES[match[1]] + accidental;
}

/** A chord as the pads voice it, and the bass note under it. */
export interface Chord {
  readonly pad: readonly number[];
  readonly bass: number;
}

/**
 * A chord from note names.
 * @param bass - The bass note.
 * @param pad - The pad's voicing, low to high.
 * @returns The chord.
 */
export function chord(bass: string, ...pad: string[]): Chord {
  return { bass: midi(bass), pad: pad.map(midi) };
}

/** A note that starts on a sixteenth and lasts `len` of them. */
export interface NoteEvent {
  readonly midi: number;
  readonly len: number;
}

/** A held chord that starts on a sixteenth: the pads and a held bass play it. */
export interface ChordEvent {
  readonly chord: Chord;
  readonly len: number;
}

/** How a section's bass plays. */
export type BassStyle = 'none' | 'held' | 'pulse8' | 'pulse16' | 'octave';
/** How a section's arpeggio runs. */
export type ArpStyle = 'none' | 'eighths' | 'sixteenths';
/** What drums close a section's last bar. */
export type FillStyle = 'none' | 'toms' | 'roll';

/**
 * A section as written: its chords, drum patterns as strings of velocities (`.` rests, `1` to `9` hits), and which
 * parts play.
 */
export interface SectionSpec {
  readonly bars: number;
  /** Chord names, one a bar, repeated to fill the section; `A>B` changes chord halfway through the bar. */
  readonly chords: string;
  readonly kick?: string;
  readonly snare?: string;
  readonly hat?: string;
  readonly open?: string;
  readonly bass: BassStyle;
  readonly arp: ArpStyle;
  /** The first bar the arpeggio plays in. */
  readonly arpFrom?: number;
  /** The arpeggio and pad filter's cutoff in the first bar and the last, Hz. */
  readonly cutoff: readonly [number, number];
  readonly lead?: string;
  /** Doubles the lead an octave up. */
  readonly double?: boolean;
  readonly pluck?: string;
  readonly fill?: FillStyle;
  readonly crash?: boolean;
  /** A noise riser over the last bar, into the next section. */
  readonly riser?: boolean;
}

/** One bar of a compiled song, read a sixteenth at a time while it plays. */
export interface Bar {
  readonly spec: SectionSpec;
  /** Which bar of its section this is. */
  readonly index: number;
  readonly first: boolean;
  readonly last: boolean;
  /** The chord on each sixteenth. */
  readonly chords: readonly Chord[];
  readonly kick: Float32Array | null;
  readonly snare: Float32Array | null;
  readonly hat: Float32Array | null;
  readonly open: Float32Array | null;
  /** Held chords starting on each sixteenth, or null. */
  readonly held: readonly (ChordEvent | null)[];
  readonly lead: readonly (NoteEvent | null)[];
  readonly pluck: readonly (NoteEvent | null)[];
  readonly cutoff: number;
}

/** A piece of music a {@link Track} plays a sixteenth at a time. */
export interface Song {
  readonly bpm: number;
  /** Seconds of the ping-pong delay. */
  readonly delay: number;
  /** How far a kick ducks the pumped channels, 0 to 1. */
  readonly pump: number;
  /** Each channel's level and sends. */
  readonly mix: SongMix;
  /**
   * Play whatever starts on this sixteenth.
   * @param {number} step - Sixteenths since the song's origin; negative before it.
   * @param {number} time - Context time the sixteenth lands on.
   * @param {Track} track - Where it plays.
   */
  play(step: number, time: number, track: Track): void;
}

/** A channel's level, its sends to the delay and the reverb, whether kicks pump it, and a fixed highpass. */
export interface ChannelMix {
  readonly level: number;
  readonly delay?: number;
  readonly reverb?: number;
  readonly pump?: boolean;
  readonly highpass?: number;
}

/** The channels every song plays through. */
export type ChannelName = 'kick' | 'snare' | 'hat' | 'bass' | 'pad' | 'arp' | 'lead' | 'fx';

/** A song's mix: one {@link ChannelMix} a channel. */
export type SongMix = Readonly<Record<ChannelName, ChannelMix>>;

function pattern(source: string | undefined): Float32Array | null {
  if (!source) return null;
  if (source.length !== STEPS) throw new Error(`music: a drum pattern needs ${STEPS} steps: ${source}`);

  const out = new Float32Array(STEPS);

  for (let i = 0; i < STEPS; i++) out[i] = source[i] === '.' ? 0 : Number(source[i]) / 9;

  return out;
}

/** A melody, `|` between bars, `Note:sixteenths` or `-:sixteenths` for a rest, into a list a sixteenth per entry. */
function melody(source: string | undefined, bars: number): (NoteEvent | null)[][] {
  const out: (NoteEvent | null)[][] = [];

  for (let b = 0; b < bars; b++) out.push(Array.from({ length: STEPS }, () => null));

  if (!source) return out;

  const written = source.split('|').map((bar) => bar.trim());

  for (let b = 0; b < bars; b++) {
    const text = written[b % written.length];
    let at = 0;

    for (const token of text.split(/\s+/)) {
      if (!token) continue;

      const [name, len] = token.split(':');
      const steps = Number(len);

      if (name !== '-') out[b][at] = { midi: midi(name), len: steps };
      at += steps;
    }

    if (at !== STEPS) throw new Error(`music: a melody bar lasts ${at} sixteenths: ${text}`);
  }

  return out;
}

/**
 * Compile sections into bars, so playing a sixteenth is a lookup. Held chords run until the chord changes or the
 * section ends.
 * @param sections - The song's form, in order.
 * @param chords - The chord names the sections use.
 * @returns One {@link Bar} a bar of the form.
 */
export function compile(sections: readonly SectionSpec[], chords: Readonly<Record<string, Chord>>): Bar[] {
  const bars: Bar[] = [];

  for (const spec of sections) {
    const names = spec.chords.split(/\s+/);
    const lead = melody(spec.lead, spec.bars);
    const pluck = melody(spec.pluck, spec.bars);
    const kick = pattern(spec.kick);
    const snare = pattern(spec.snare);
    const hat = pattern(spec.hat);
    const open = pattern(spec.open);
    const steps: Chord[] = [];

    for (let b = 0; b < spec.bars; b++) {
      const [first, second] = names[b % names.length].split('>');
      const a = chords[first];
      const c = chords[second ?? first];

      if (!a || !c) throw new Error(`music: unknown chord in ${names[b % names.length]}`);
      for (let s = 0; s < STEPS; s++) steps.push(s < STEPS / 2 ? a : c);
    }

    const held: (ChordEvent | null)[] = Array.from({ length: steps.length }, () => null);

    for (let s = 0; s < steps.length;) {
      let end = s + 1;

      while (end < steps.length && steps[end] === steps[s]) end++;
      held[s] = { chord: steps[s], len: end - s };
      s = end;
    }

    for (let b = 0; b < spec.bars; b++) {
      const k = spec.bars > 1 ? b / (spec.bars - 1) : 0;

      bars.push({
        spec,
        index: b,
        first: b === 0,
        last: b === spec.bars - 1,
        chords: steps.slice(b * STEPS, (b + 1) * STEPS),
        kick,
        snare,
        hat,
        open,
        held: held.slice(b * STEPS, (b + 1) * STEPS),
        lead: lead[b],
        pluck: pluck[b],
        cutoff: spec.cutoff[0] * Math.pow(spec.cutoff[1] / spec.cutoff[0], k),
      });
    }
  }

  return bars;
}

/** The arpeggio's walk through a chord, a sixteenth at a time: indexes into the voicing, 4 and up an octave higher. */
const ARP_WALK = [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 1, 3, 2, 4, 3, 5];

/**
 * The arpeggio's note on a sixteenth.
 * @param chord - The chord under it.
 * @param step - Sixteenth in the bar.
 * @param octave - Semitones to lift it by.
 * @returns MIDI note.
 */
export function arpNote(chord: Chord, step: number, octave: number): number {
  const pad = chord.pad;
  const i = ARP_WALK[step];

  return pad[i % pad.length] + 12 * Math.floor(i / pad.length) + octave;
}
