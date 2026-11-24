/**
 * NIGHT RUN's design tokens: colours, racer colours, type and motion. The art functions and the screens read them from here so the two never drift apart.
 */

/** Hex colours as CSS strings, for SVG art. Pixi code converts with `Number('0x' + hex.slice(1))` or `new Color()`. */
export const COLORS = {
  /** Deepest shadow: extrusions, drop shadows, text on bright plates. */
  ink900: '#060920',
  /** Plate body. */
  ink800: '#0c1234',
  /** Plate face. */
  ink700: '#16204e',
  /** Raised or hovered plate face. */
  ink600: '#24306a',
  /** Rules and empty wells on plates. */
  line: '#3b4a92',
  /** Secondary text and inactive icons. */
  mist: '#a3afe0',
  /** Primary text and reflective tape. */
  white: '#f4f7ff',
  /** Interactive, focus, and anything that is yours. */
  cyan: '#2ce8ff',
  /** Cyan's return and pressed face. */
  cyanDeep: '#007fb0',
  /** Live, heat and boost: the broadcast's own colour. */
  magenta: '#ff2e97',
  /** Magenta's return. */
  magentaDeep: '#9c0858',
  /**
   * Caution: reconnecting, the final-lap counter, a shaky connection, Start anyway. Pushed to orange so it never reads
   * as the yellow racer or place gold.
   */
  amber: '#ff8a1f',
  /** Amber's return. */
  amberDeep: '#9e4600',
  /** Danger and destructive actions; always paired with hazard stripes or an icon so it never reads as a racer. */
  danger: '#ff3358',
  /** Danger's return. */
  dangerDeep: '#99102e',
  /** Success and GO. */
  go: '#3dffa0',
  /** GO's return. */
  goDeep: '#00915a',
} as const;

/**
 * Metal plates for places 1 to 4, top highlight then body then return. Gold is always drawn as this bevelled gradient
 * with an ink keyline, never as a flat fill, so it never reads as the yellow racer or caution amber.
 */
export const PLACE_METALS = [
  { hi: '#fff3b8', mid: '#ffc93d', lo: '#b9770f', deep: '#5e3600' },
  { hi: '#ffffff', mid: '#cfd8ec', lo: '#7d8aa8', deep: '#363f5a' },
  { hi: '#ffd9b5', mid: '#e98d4f', lo: '#97481d', deep: '#4a1d05' },
  { hi: '#8a97d6', mid: '#3d4a8f', lo: '#1f2759', deep: '#0a0e2a' },
] as const;

/** A racer's colour set, used only to say who someone is. */
export interface RacerColor {
  /** The id the room syncs. */
  readonly id: 'yellow' | 'green' | 'purple' | 'red';
  /** The name the colour picker shows. */
  readonly name: string;
  /** The UI accent: dots, stripes, name tags. */
  readonly main: string;
  /** Highlight for gradients. */
  readonly hi: string;
  /** Shade for gradients and extrusions. */
  readonly deep: string;
  /** Text colour that reads on `main`. */
  readonly on: string;
}

/** The four truck colours in seat order, matched to the Kenney truck paints but lifted for legibility at night. */
export const RACERS: readonly RacerColor[] = [
  { id: 'yellow', name: 'Yellow', main: '#ffcc1f', hi: '#fff09a', deep: '#b07800', on: '#2a1a00' },
  { id: 'green', name: 'Green', main: '#3fdc6e', hi: '#b8ffc8', deep: '#11823a', on: '#032410' },
  { id: 'purple', name: 'Purple', main: '#a974ff', hi: '#e2ccff', deep: '#5a2fbf', on: '#ffffff' },
  { id: 'red', name: 'Red', main: '#ff4f3f', hi: '#ffc0b5', deep: '#a3200f', on: '#ffffff' },
];

/** The font families pixi Text uses; load them before the first Text is made. */
export const FONTS = {
  /** The board voice: numbers, places, times, callouts. Condensed, upright, signage. */
  board: '"Big Shoulders Display", "Arial Narrow", sans-serif',
  /** The driver voice: buttons, names, labels, body. Chunky, leans forward in italic. */
  driver: 'Kanit, "Segoe UI", sans-serif',
  /** The stylesheet that loads every weight the UI uses, served from this site's `public/fonts/`. */
  url: `${import.meta.env.BASE_URL}fonts/fonts.css`,
} as const;

/** Named eases (gsap strings), durations in seconds and stagger, so every screen moves the same way. */
export const MOTION = {
  /** Plates and cards seat into place: a drop with a small overshoot. */
  slot: { ease: 'back.out(1.7)', duration: 0.32 },
  /** Hover and focus responses. */
  snap: { ease: 'power3.out', duration: 0.16 },
  /** Numerals and badges punch in from oversize. */
  punch: { ease: 'elastic.out(1, 0.5)', duration: 0.6 },
  /** The light sweep across a plate. */
  sweep: { ease: 'power2.inOut', duration: 0.55 },
  /** Exits leave fast and lean into the direction they go. */
  whip: { ease: 'expo.in', duration: 0.22 },
  /** Idle loops: neon breathing, waiting pulses. */
  idle: { ease: 'sine.inOut', duration: 1.6 },
  /** Press sink. */
  press: { ease: 'power2.out', duration: 0.07 },
  /** Gap between items entering in a list. */
  stagger: 0.045,
  /** Gap between items leaving, in reverse order. */
  staggerOut: 0.03,
  /** Lean of everything that moves or can be pressed, in degrees. */
  lean: 12,
} as const;
