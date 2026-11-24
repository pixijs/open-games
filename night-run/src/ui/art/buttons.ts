import { Draft } from './Draft';
import type { IconName } from './icons';
import { drawIcon } from './icons';
import type { PlateStyle } from './plate';
import { plate } from './plate';
import type { Pt, SvgArt } from './svg';
import { chamferRect, inset, leanShift, n, poly, shift, slantRect } from './svg';
import { COLORS } from './tokens';

/**
 * What a button does: `primary` moves you forward, `go` commits (Ready, Start), `caution` overrides a safeguard
 * (Start anyway, End race), `danger` destroys or leaves.
 */
export type ButtonVariant = 'primary' | 'go' | 'secondary' | 'caution' | 'danger';

/** The states every pressable thing is drawn in. */
export type ButtonState = 'idle' | 'hover' | 'press' | 'disabled' | 'focus';

/** Options for {@link buttonSvg} and {@link iconButtonSvg}. */
export interface ButtonOptions {
  /** Width of the face in px (the art adds padding for glow). */
  readonly width?: number;
  /** Height of the face in px: 64 large (phone primary), 52 medium, 40 small. */
  readonly height?: number;
  readonly variant?: ButtonVariant;
  readonly state?: ButtonState;
}

interface Finish {
  readonly face: readonly [string, string];
  readonly side: readonly [string, string];
  readonly rim: string;
  readonly glow: string;
  readonly gloss: number;
  readonly tape?: string;
}

const FINISHES: Record<ButtonVariant, Finish> = {
  primary: {
    face: ['#a6f8ff', '#16c4ee'],
    side: [COLORS.cyanDeep, '#00304d'],
    rim: '#ffffff',
    glow: COLORS.cyan,
    gloss: 0.4,
  },
  go: { face: ['#b6ffd9', '#22e08a'], side: [COLORS.goDeep, '#003d22'], rim: '#ffffff', glow: COLORS.go, gloss: 0.4 },
  secondary: {
    face: [COLORS.ink600, COLORS.ink800],
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#9fb0ff',
    glow: COLORS.cyan,
    gloss: 0.1,
    tape: COLORS.cyan,
  },
  caution: {
    face: ['#ffc58f', COLORS.amber],
    side: [COLORS.amberDeep, '#3d1a00'],
    rim: '#ffffff',
    glow: COLORS.amber,
    gloss: 0.38,
  },
  danger: {
    face: ['#ff9db0', COLORS.danger],
    side: [COLORS.dangerDeep, '#3d0012'],
    rim: '#ffffff',
    glow: COLORS.danger,
    gloss: 0.35,
  },
};

/** Text colour that reads on each button face. */
export const BUTTON_TEXT: Record<ButtonVariant, string> = {
  primary: COLORS.ink900,
  go: COLORS.ink900,
  secondary: COLORS.white,
  caution: COLORS.ink900,
  danger: COLORS.ink900,
};

function depthFor(h: number): number {
  return Math.round(h * 0.1);
}

/** Draws a pressable plate from an outline, sinking or lifting it by state; returns the face offset in px. */
function pressable(d: Draft, outline: Pt[], h: number, f: Finish, state: ButtonState): number {
  const depth = depthFor(h);
  const disabled = state === 'disabled';
  const lift = state === 'hover' || state === 'focus' ? 2 : state === 'press' ? -(depth - 1) : 0;
  const pts = shift(outline, 0, -lift);
  const style: PlateStyle = disabled
    ? {
        face: [COLORS.ink700, COLORS.ink800],
        faceOpacity: 0.85,
        depth: 2,
        side: [COLORS.ink800, COLORS.ink900],
        tape: { color: COLORS.line, width: 1.5, inset: 2.5, opacity: 0.9 },
        shadow: 0.3,
      }
    : {
        face: state === 'press' ? [f.face[1], f.face[1]] : f.face,
        depth: depth + lift,
        side: f.side,
        rim: f.rim,
        rimOpacity: state === 'press' ? 0.25 : 0.85,
        gloss: state === 'press' ? f.gloss * 0.3 : f.gloss,
        shade: 0.35,
        shadow: state === 'press' ? 0.35 : 0.6,
        tape: f.tape
          ? { color: f.tape, width: 1.5, inset: 3, opacity: state === 'idle' ? 0.45 : state === 'press' ? 0.7 : 1 }
          : undefined,
        glow:
          state === 'hover' || state === 'focus'
            ? { color: f.glow, blur: h * 0.22, opacity: f.tape ? 0.35 : 0.55 }
            : undefined,
      };

  plate(d, pts, style);
  if (state === 'focus') {
    d.add(
      `<path d="${poly(inset(pts, -5))}" fill="none" stroke="${COLORS.white}" stroke-width="2.5" ` +
        `stroke-dasharray="7 4" stroke-linejoin="miter"/>`,
    );
  }

  return -lift;
}

/**
 * A text button: a leaning moulded plate that lifts on hover and sinks into its return on press. Text is pixi Text,
 * centred in `content` (which moves with the face); it stretches sideways with `slice`.
 * @param options - Size, variant and state.
 */
export function buttonSvg(options: ButtonOptions = {}): SvgArt {
  const w = options.width ?? 280;
  const h = options.height ?? 56;
  const variant = options.variant ?? 'primary';
  const state = options.state ?? 'idle';
  const pad = Math.round(h * 0.35);
  const d = new Draft();
  const outline = slantRect(pad, pad, w, h, 12, h * 0.14);
  const dy = pressable(d, outline, h, FINISHES[variant], state);
  const s = leanShift(h, 12);
  const edge = pad + s + h * 0.2;

  return d.art(w + pad * 2, h + pad * 2 + depthFor(h), {
    slice: { left: edge, right: edge, top: 0, bottom: 0 },
    content: { x: pad + s * 0.5, y: pad + dy, w: w - s, h },
    face: { x: pad, y: pad, w, h },
  });
}

/**
 * A square leaning button holding one icon: back, close, copy, settings, add and remove bot.
 * @param icon - The icon on its face.
 * @param options - Size (the face is `height` square), variant and state.
 */
export function iconButtonSvg(icon: IconName, options: ButtonOptions = {}): SvgArt {
  const h = options.height ?? 48;
  const variant = options.variant ?? 'secondary';
  const state = options.state ?? 'idle';
  const w = h + leanShift(h, 12);
  const pad = Math.round(h * 0.35);
  const d = new Draft();
  const outline = slantRect(pad, pad, w, h, 12, h * 0.16);
  const dy = pressable(d, outline, h, FINISHES[variant], state);
  const size = h * 0.5;
  const color = state === 'disabled' ? COLORS.line : variant === 'secondary' ? COLORS.white : COLORS.ink900;
  const accent = variant === 'secondary' && state !== 'disabled' ? COLORS.cyan : color;

  drawIcon(d, icon, pad + (w - size) / 2, pad + dy + (h - size) / 2, {
    size,
    color,
    accent,
    keyline: variant === 'secondary',
  });

  return d.art(Math.ceil(w + pad * 2), h + pad * 2 + depthFor(h), {
    content: { x: pad, y: pad + dy, w, h },
    face: { x: pad, y: pad, w, h },
  });
}

/** Options for {@link keySvg}. */
export interface KeyOptions {
  readonly width?: number;
  readonly height?: number;
  readonly state?: 'idle' | 'press' | 'disabled';
  /** `char` keys type a letter; `action` keys (backspace, paste, join) are tinted. */
  readonly variant?: 'char' | 'action' | 'go';
}

/**
 * An on-screen keypad key for typing a party code on a phone. Keys stand upright so the grid lines up under thumbs.
 * @param options - Size, state and variant.
 */
export function keySvg(options: KeyOptions = {}): SvgArt {
  const w = options.width ?? 64;
  const h = options.height ?? 52;
  const state = options.state ?? 'idle';
  const variant = options.variant ?? 'char';
  const pad = 8;
  const d = new Draft();
  const finish: Finish =
    variant === 'go'
      ? FINISHES.primary
      : variant === 'action'
        ? { ...FINISHES.secondary, face: ['#2f3c80', COLORS.ink700], tape: undefined }
        : { ...FINISHES.secondary, face: ['#3a478c', '#1d2758'], tape: undefined, gloss: 0.16 };
  const dy = pressable(d, chamferRect(pad, pad, w, h, 7), h, finish, state);

  return d.art(w + pad * 2, h + pad * 2 + depthFor(h), {
    content: { x: pad, y: pad + dy, w, h },
    face: { x: pad, y: pad, w, h },
  });
}

/** States of one party-code character cell. */
export type CodeCellState = 'empty' | 'active' | 'filled' | 'error' | 'ok';

/**
 * One character cell of the party code entry: a recessed well. `active` shows the caret bar; `error` and `ok` light
 * the rim.
 * @param state - The cell's state.
 * @param width - Cell width in px; the height is 1.25 times it.
 */
export function codeCellSvg(state: CodeCellState, width = 56): SvgArt {
  const h = Math.round(width * 1.25);
  const pad = 10;
  const d = new Draft();
  const pts = chamferRect(pad, pad, width, h, width * 0.16);
  const rim =
    state === 'active' ? COLORS.cyan : state === 'error' ? COLORS.danger : state === 'ok' ? COLORS.go : COLORS.line;

  plate(d, pts, {
    face: [COLORS.ink900, state === 'filled' ? COLORS.ink700 : COLORS.ink800],
    faceOpacity: 0.96,
    tape: { color: rim, width: state === 'empty' || state === 'filled' ? 1.5 : 2.5, inset: 1.25 },
    glow: state === 'empty' || state === 'filled' ? undefined : { color: rim, blur: 7, opacity: 0.55 },
  });
  const clip = d.clip(poly(pts));
  const top = d.vgrad(pad, pad + 14, [
    [0, '#000000', 0.55],
    [1, '#000000', 0],
  ]);

  d.add(`<rect x="${pad}" y="${pad}" width="${width}" height="14" fill="url(#${top})" clip-path="url(#${clip})"/>`);
  d.add(
    `<path d="M${n(pad + width * 0.2)} ${n(pad + h - 1.5)}H${n(pad + width * 0.8)}" stroke="#8fa0ff" stroke-opacity="0.35" stroke-width="1"/>`,
  );
  if (state === 'active') {
    d.add(
      `<rect x="${n(pad + width * 0.22)}" y="${n(pad + h - 12)}" width="${n(width * 0.56)}" height="4" fill="${COLORS.cyan}"/>`,
    );
  }

  return d.art(width + pad * 2, h + pad * 2, {
    content: { x: pad, y: pad, w: width, h },
    face: { x: pad, y: pad, w: width, h },
  });
}

/**
 * An on/off switch for settings rows (Sound): a leaning recessed track with a sliding knob. On, the track lights cyan
 * and the knob sits right. The row's label is pixi Text beside it; say what the switch controls, not its state.
 * @param on - On or off.
 * @param options - Height of the track in px, and the press state.
 */
export function switchSvg(on: boolean, options: { height?: number; state?: ButtonState } = {}): SvgArt {
  const h = options.height ?? 32;
  const state = options.state ?? 'idle';
  const w = Math.round(h * 2);
  const pad = Math.round(h * 0.4);
  const d = new Draft();
  const track = slantRect(pad, pad, w, h, 12, h * 0.16);

  plate(d, track, {
    face: on ? [COLORS.cyanDeep, '#005a80'] : [COLORS.ink900, COLORS.ink800],
    faceOpacity: 0.96,
    tape: { color: on ? COLORS.cyan : COLORS.line, width: 1.5, inset: 1, opacity: 0.9 },
    glow: state === 'hover' || state === 'focus' ? { color: COLORS.cyan, blur: h * 0.2, opacity: 0.5 } : undefined,
  });
  const kw = h * 0.95;
  const kh = h - 6;
  const kx = on ? pad + w - kw - 3 - leanShift(kh, 12) * 0.2 : pad + 3 + leanShift(kh, 12) * 0.2;
  const press = state === 'press';

  plate(d, slantRect(kx, pad + 3 + (press ? 1 : -1), kw, kh, 12, kh * 0.16), {
    face: on ? ['#e6fdff', '#7eeeff'] : [COLORS.ink600, COLORS.ink700],
    depth: press ? 1 : 3,
    side: on ? [COLORS.cyanDeep, '#00304d'] : [COLORS.ink800, COLORS.ink900],
    rim: '#ffffff',
    rimOpacity: 0.8,
    gloss: 0.3,
    shadow: 0.5,
  });
  if (state === 'focus') {
    d.add(
      `<path d="${poly(inset(track, -4))}" fill="none" stroke="${COLORS.white}" stroke-width="2" stroke-dasharray="6 3"/>`,
    );
  }

  return d.art(w + pad * 2, h + pad * 2, { face: { x: pad, y: pad, w, h } });
}
