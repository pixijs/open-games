import { Draft } from './Draft';
import type { SvgArt } from './svg';
import { n } from './svg';
import { COLORS, PLACE_METALS } from './tokens';

/** One shape of an icon on its 24 unit grid. */
interface IconPart {
  readonly d: string;
  /** Filled rather than stroked. */
  readonly fill?: boolean;
  /** Drawn in the accent colour. */
  readonly accent?: boolean;
  /** Stroke width in grid units; 2.6 when left out. */
  readonly w?: number;
}

/** Moves and scales absolute path data made of M, L, H, V and Z commands. */
function moved(d: string, k: number, dx: number, dy: number): string {
  return d.replace(/([MLHV])([^MLHVZ]*)/g, (_, cmd: string, args: string) => {
    const v = args
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const out = v.map((x, i) => {
      const isY = cmd === 'V' || (cmd !== 'H' && i % 2 === 1);

      return n(x * k + (isY ? dy : dx));
    });

    return cmd + out.join(' ');
  });
}

/** A racing helmet in side profile, facing right: round shell, visor window at the front, chin bar under it. */
const HELMET =
  'M2.5 13L3.2 9 5.5 5.2 9 3H14L17.8 4.6 20.4 7.6 21.6 11.5 22 15.2 20.8 18.6 17.5 20.6H10.5L7.5 18.8H4.2L2.8 16.6Z';
const VISOR = 'M10.8 8.4H20.3L21.1 12.4H10.8L10 10.4Z';
const CHIN_VENT = 'M16.2 16.4H20.2';
/** An octagon badge at the top right of the grid, for the helmet's plus and minus. */
const BADGE = 'M17.8 0.3H21.2L23.7 2.8V6.2L21.2 8.7H17.8L15.3 6.2V2.8Z';

const ICONS = {
  crown: [
    { d: 'M3 17.5L3.4 6.5 8.3 11 12 4 15.7 11 20.6 6.5 21 17.5Z', fill: true },
    { d: 'M3 19.5H21V22H3Z', fill: true },
  ],
  check: [{ d: 'M4 12.5L9.3 17.8 20 6.5', w: 3.4 }],
  link: [
    { d: 'M10.6 7.4L13.2 4.8 15.2 4.8 19.2 8.8 19.2 10.8 16.6 13.4' },
    { d: 'M13.4 16.6L10.8 19.2 8.8 19.2 4.8 15.2 4.8 13.2 7.4 10.6' },
    { d: 'M9.2 14.8L14.8 9.2', accent: true },
  ],
  copy: [{ d: 'M8.5 3.5H20.5V15.5' }, { d: 'M3.5 8.5H15.5V20.5H3.5Z', fill: true }],
  sliders: [
    { d: 'M3 6H21M3 12H21M3 18H21', w: 2.2 },
    { d: 'M13 3.5H17V8.5H13ZM6 9.5H10V14.5H6ZM15 15.5H19V20.5H15Z', fill: true, accent: true },
  ],
  close: [{ d: 'M5.5 5.5L18.5 18.5M18.5 5.5L5.5 18.5', w: 3.2 }],
  back: [{ d: 'M15.5 3.5L7 12 15.5 20.5', w: 3.4 }],
  forward: [{ d: 'M8.5 3.5L17 12 8.5 20.5', w: 3.4 }],
  plus: [{ d: 'M12 4V20M4 12H20', w: 3.4 }],
  minus: [{ d: 'M4 12H20', w: 3.4 }],
  bot: [
    { d: 'M7 8H17L19.5 10.5V18L17.5 20.5H6.5L4.5 18V10.5Z', fill: true },
    { d: 'M8 12H11V15H8ZM13 12H16V15H13Z', fill: true, accent: true },
    { d: 'M12 8V4', w: 2.2 },
    { d: 'M10.5 1.5H13.5V4.5H10.5Z', fill: true, accent: true },
  ],
  driver: [
    { d: HELMET, fill: true },
    { d: VISOR, fill: true, accent: true },
    { d: CHIN_VENT, accent: true, w: 1.6 },
  ],
  flag: [
    { d: 'M5 2.5V21.5', w: 2.6 },
    { d: 'M6.3 3.5H20.5V14.5H6.3Z', fill: true },
    {
      d: 'M6.3 3.5H10V7.2H6.3ZM13.7 3.5H17.4V7.2H13.7ZM10 7.2H13.7V10.9H10ZM17.4 7.2H20.5V10.9H17.4ZM6.3 10.9H10V14.5H6.3ZM13.7 10.9H17.4V14.5H13.7Z',
      fill: true,
      accent: true,
    },
  ],
  pause: [{ d: 'M5.5 4H10V20H5.5ZM14 4H18.5V20H14Z', fill: true }],
  play: [{ d: 'M6.5 3.5L20 12 6.5 20.5Z', fill: true }],
  exit: [{ d: 'M13 3.5H4.5V20.5H13' }, { d: 'M9.5 12H21M16.5 7.5L21 12 16.5 16.5', accent: true }],
  rematch: [
    { d: 'M4.5 11V8.5L8 5H16L19 8', w: 2.6 },
    { d: 'M19.5 13V15.5L16 19H8L5 16', w: 2.6 },
    { d: 'M15 9H22.5L19.5 3.5Z', fill: true, accent: true },
    { d: 'M9 15H1.5L4.5 20.5Z', fill: true, accent: true },
  ],
  warning: [
    { d: 'M12 2.5L22.5 20.5H1.5Z', fill: true },
    { d: 'M10.6 8.5H13.4L13 14.5H11ZM10.6 16.2H13.4V18.8H10.6Z', fill: true, accent: true },
  ],
  backspace: [
    { d: 'M8.5 4.5H21.5V19.5H8.5L2.5 12Z', fill: true },
    { d: 'M11.5 8.5L18 15.5M18 8.5L11.5 15.5', accent: true, w: 2.6 },
  ],
  share: [{ d: 'M12 2.5V14.5M7.5 7L12 2.5 16.5 7', accent: true }, { d: 'M8.5 10H4.5V21H19.5V10H15.5' }],
  laps: [
    { d: 'M18.5 15V9L15 5.5H9L5.5 9V15L9 18.5H14', w: 2.6 },
    { d: 'M12 15H19L15.2 21.5Z', fill: true, accent: true },
  ],
  timer: [
    { d: 'M9 7.5H15L18.5 11V17L15 20.5H9L5.5 17V11Z' },
    { d: 'M9.5 2.5H14.5M12 2.5V6', w: 2.4 },
    { d: 'M12 14V10.5', accent: true, w: 2.4 },
  ],
  trophy: [
    { d: 'M6.5 3H17.5V9.5L14.5 13.5H9.5L6.5 9.5Z', fill: true },
    { d: 'M6.5 5.5H3.5V8.5L6 11M17.5 5.5H20.5V8.5L18 11', w: 2 },
    { d: 'M10.8 13.5H13.2V18H10.8Z', fill: true },
    { d: 'M7 18.5H17V21.5H7Z', fill: true, accent: true },
  ],
  offline: [
    { d: 'M3 17H6.5V21H3ZM8.5 13H12V21H8.5ZM14 9H17.5V21H14ZM19.5 5H23V21H19.5Z', fill: true },
    { d: 'M2 3.5L21.5 21', accent: true, w: 3 },
  ],
  join: [
    { d: moved(HELMET, 0.78, 0, 5), fill: true },
    { d: moved(VISOR, 0.78, 0, 5), fill: true, accent: true },
    { d: BADGE, fill: true },
    { d: 'M19.5 2.2V6.8M17.2 4.5H21.8', accent: true, w: 1.8 },
  ],
  leave: [
    { d: moved(HELMET, 0.78, 0, 5), fill: true },
    { d: moved(VISOR, 0.78, 0, 5), fill: true, accent: true },
    { d: BADGE, fill: true },
    { d: 'M17.2 4.5H21.8', accent: true, w: 2 },
  ],
  uturn: [
    { d: 'M17.5 21.5V9.5L14 6H10.5L7 9.5V13.5', w: 3.2 },
    { d: 'M2.4 12.4H11.6L7 19Z', fill: true, accent: true },
  ],
  respawn: [
    { d: 'M2 20.8H22', accent: true, w: 2.6 },
    { d: 'M12 2.5V10.5', w: 3.2 },
    { d: 'M6.5 9.5H17.5L12 16Z', fill: true },
  ],
  camera: [
    { d: 'M2.5 6.5H15.5V17.5H2.5Z', fill: true },
    { d: 'M16.5 12L22 7.5V16.5Z', fill: true, accent: true },
  ],
  sound: [
    { d: 'M2.5 9H7L13 4.5V19.5L7 15H2.5Z', fill: true },
    { d: 'M16 8.5L18 11V13L16 15.5M19 5.5L22 9.5V14.5L19 18.5', accent: true, w: 2.2 },
  ],
  mute: [
    { d: 'M2.5 9H7L13 4.5V19.5L7 15H2.5Z', fill: true },
    { d: 'M16 9L22 15M22 9L16 15', accent: true, w: 2.6 },
  ],
  edit: [
    { d: 'M3.5 20.5L4.5 15.5 15.5 4.5 19.5 8.5 8.5 19.5Z', fill: true },
    { d: 'M13.5 6.5L17.5 10.5', accent: true, w: 2 },
  ],
  lock: [
    { d: 'M8 11V7.5L10 5.5H14L16 7.5V11', w: 2.6 },
    { d: 'M4.5 10.5H19.5V21H4.5Z', fill: true },
    { d: 'M11 14H13V18H11Z', fill: true, accent: true },
  ],
  eye: [
    { d: 'M1.5 12L7 6H17L22.5 12 17 18H7Z', fill: true },
    { d: 'M9 9H15V15H9Z', fill: true, accent: true },
  ],
  up: [{ d: 'M3 15.5L12 6.5 21 15.5 17.5 19 12 13.5 6.5 19Z', fill: true }],
  down: [{ d: 'M3 8.5L12 17.5 21 8.5 17.5 5 12 10.5 6.5 5Z', fill: true }],
  bolt: [{ d: 'M14 1.5L4.5 13.5H11L8.5 22.5 19.5 9.5H13L16 1.5Z', fill: true }],
  star: [{ d: 'M12 2L14.9 8.6 22 9.3 16.6 14 18.2 21 12 17.3 5.8 21 7.4 14 2 9.3 9.1 8.6Z', fill: true }],
  info: [
    { d: 'M8 2.5H16L21.5 8V16L16 21.5H8L2.5 16V8Z', fill: true },
    { d: 'M10.7 10.5H13.3V18H10.7ZM10.7 5.8H13.3V8.4H10.7Z', fill: true, accent: true },
  ],
  undo: [
    { d: 'M5 10H15.5L20.5 15V20.5', w: 3 },
    { d: 'M10.5 3.5L3 10 10.5 16.5Z', fill: true, accent: true },
  ],
  redo: [
    { d: 'M19 10H8.5L3.5 15V20.5', w: 3 },
    { d: 'M13.5 3.5L21 10 13.5 16.5Z', fill: true, accent: true },
  ],
  /** A U-turn: the race's way round, turned back. */
  reverse: [
    { d: 'M5 21V10L9 6H13L17 10V12.5', w: 2.6 },
    { d: 'M12.5 12H21.5L17 18.5Z', fill: true, accent: true },
  ],
  dice: [
    { d: 'M5 3H19L21 5V19L19 21H5L3 19V5Z', fill: true },
    {
      d: 'M7 7H10V10H7ZM14 14H17V17H14ZM10.5 10.5H13.5V13.5H10.5ZM14 7H17V10H14ZM7 14H10V17H7Z',
      fill: true,
      accent: true,
    },
  ],
  erase: [
    { d: 'M2.5 15L12.5 5 20.5 13 13.5 20H7.5Z', fill: true },
    { d: 'M7.5 10L15.5 18', accent: true, w: 2.4 },
    { d: 'M14.5 21H21.5', w: 2 },
  ],
  track: [
    { d: 'M7.5 4H16.5L20.5 8V16L16.5 20H7.5L3.5 16V8Z', w: 3 },
    { d: 'M9.5 1.5H13.5V6.5H9.5Z', fill: true, accent: true },
  ],
  more: [{ d: 'M3 10H7V14H3ZM10 10H14V14H10ZM17 10H21V14H17Z', fill: true }],
  paste: [
    { d: 'M4.5 4.5H19.5V22H4.5Z', fill: true },
    { d: 'M8.5 2H15.5V7H8.5Z', fill: true, accent: true },
  ],
  trash: [
    { d: 'M5 7.5H19L17.5 22H6.5Z', fill: true },
    { d: 'M3 5H21M9 2.5H15', w: 2.4 },
    { d: 'M10 11V18.5M14 11V18.5', accent: true, w: 2 },
  ],
  keys: [
    { d: 'M2 6H22V18H2Z', fill: true },
    {
      d: 'M5 9H7.5V11.5H5ZM9 9H11.5V11.5H9ZM13 9H15.5V11.5H13ZM17 9H19.5V11.5H17ZM7 13.5H17V15.5H7Z',
      fill: true,
      accent: true,
    },
  ],
  signal: [],
} satisfies Record<string, IconPart[]>;

/** The names of NIGHT RUN's icons. */
export type IconName = keyof typeof ICONS;

/** Options for {@link iconSvg} and {@link drawIcon}. */
export interface IconOptions {
  /** Size in px of the 24 unit grid. */
  readonly size?: number;
  /** Main colour. */
  readonly color?: string;
  /** Second colour for the parts that carry detail (a visor, a slash, an arrowhead). */
  readonly accent?: string;
  /** A dark keyline and a dropped return under the icon so it reads over a busy night scene. */
  readonly keyline?: boolean;
  /** For `signal`: bars lit, 0 to 4. */
  readonly level?: number;
  /** Fill the main parts with a bevelled place metal instead of `color`; forces the keyline. */
  readonly metal?: 'gold' | 'silver' | 'bronze';
}

function signalParts(level: number): IconPart[] {
  const parts: IconPart[] = [];

  for (let i = 0; i < 4; i++) {
    const h = 5 + i * 4.5;

    parts.push({
      d: `M${n(2 + i * 5.5)} ${n(21 - h)}H${n(6 + i * 5.5)}V21H${n(2 + i * 5.5)}Z`,
      fill: true,
      accent: i >= level,
    });
  }

  return parts;
}

/** Draws an icon into `d` with its grid's top-left at `x`, `y`. */
export function drawIcon(d: Draft, name: IconName, x: number, y: number, o: IconOptions = {}): void {
  const size = o.size ?? 24;
  const k = size / 24;
  const metal = o.metal ? PLACE_METALS[['gold', 'silver', 'bronze'].indexOf(o.metal)] : null;
  const color = metal
    ? `url(#${d.vgrad(1, 23, [
        [0, metal.hi],
        [0.45, metal.mid],
        [1, metal.lo],
      ])})`
    : (o.color ?? COLORS.white);
  const accent = o.accent ?? (name === 'signal' ? COLORS.line : color);
  const parts: IconPart[] = name === 'signal' ? signalParts(o.level ?? 4) : ICONS[name];
  const shape = (p: IconPart, paint: string, grow: number): string =>
    p.fill
      ? `<path d="${p.d}" fill="${paint}"${grow ? ` stroke="${paint}" stroke-width="${n(grow)}" stroke-linejoin="round"` : ''}/>`
      : `<path d="${p.d}" fill="none" stroke="${paint}" stroke-width="${n((p.w ?? 2.6) + grow)}" ` +
        `stroke-linejoin="miter" stroke-miterlimit="4"${grow ? ' stroke-linecap="round"' : ''}/>`;
  let markup = '';

  if (metal || (o.keyline ?? true)) {
    const drop = parts.map((p) => shape(p, COLORS.ink900, 2.6)).join('');

    markup += `<g transform="translate(0 1.6)" opacity="0.55">${drop}</g><g opacity="0.85">${drop}</g>`;
  }
  markup += parts.map((p) => shape(p, p.accent ? accent : color, 0)).join('');
  d.add(`<g transform="translate(${n(x)} ${n(y)}) scale(${n(k)})">${markup}</g>`);
}

/**
 * An icon on its own, on a 24 unit grid drawn at `size` px, with a little room round it for the keyline.
 * @param name - Which icon.
 * @param options - Size, colours, keyline and signal level.
 */
export function iconSvg(name: IconName, options: IconOptions = {}): SvgArt {
  const size = options.size ?? 24;
  const pad = Math.ceil(size * 0.12) + 1;
  const d = new Draft();

  drawIcon(d, name, pad, pad, options);

  return d.art(size + pad * 2, size + pad * 2 + Math.ceil(size * 0.07), { face: { x: pad, y: pad, w: size, h: size } });
}
