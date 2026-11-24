import { Draft } from './Draft';
import type { IconName } from './icons';
import { drawIcon } from './icons';
import { plate } from './plate';
import type { SvgArt } from './svg';
import { chamferRect, inset, n, poly } from './svg';
import { COLORS } from './tokens';

/** A touch control's state. */
export type TouchState = 'idle' | 'press' | 'disabled';

/** How far down the stick has to be pulled, as a share of its travel, before it brakes and then reverses. */
export const STICK_BRAKE_PULL = 0.6;

/**
 * The driving stick's base, a recessed octagon that appears where the left thumb lands. It is marked for the stick the
 * game has: left and right chevrons steer, the up chevron drives (the throttle is on while the thumb holds the stick),
 * and the shaded zone below the dashed line, past {@link STICK_BRAKE_PULL} of the travel, brakes and then reverses.
 * @param size - Width in px; the knob travels half of it.
 */
export function stickBaseSvg(size = 148): SvgArt {
  const pad = Math.round(size * 0.08);
  const d = new Draft();
  const pts = chamferRect(pad, pad, size, size, size * 0.29);

  plate(d, pts, {
    face: ['#0a0f30', '#141c4e'],
    faceOpacity: 0.55,
    tape: { color: COLORS.white, width: 2, inset: 1, opacity: 0.35 },
  });
  const c = pad + size / 2;
  const brakeY = c + (size / 2) * STICK_BRAKE_PULL;
  const clip = d.clip(poly(inset(pts, 2)));

  d.add(
    `<rect clip-path="url(#${clip})" x="${n(pad)}" y="${n(brakeY)}" width="${n(size)}" height="${n(size / 2)}" ` +
      `fill="${COLORS.white}" opacity="0.1"/>`,
  );
  d.add(
    `<path clip-path="url(#${clip})" d="M${n(pad)} ${n(brakeY)}H${n(pad + size)}" stroke="${COLORS.white}" ` +
      `stroke-opacity="0.45" stroke-width="${n(size * 0.015)}" stroke-dasharray="${n(size * 0.04)} ${n(size * 0.03)}"/>`,
  );
  d.add(
    `<path d="${poly(inset(pts, size * 0.16))}" fill="none" stroke="${COLORS.white}" stroke-opacity="0.12" stroke-width="2"/>`,
  );
  const a = size * 0.1;
  const stroke = `fill="none" stroke="${COLORS.white}" stroke-opacity="0.6" stroke-width="${n(size * 0.035)}"`;

  for (const dir of [-1, 1]) {
    const x = c + dir * size * 0.38;

    d.add(
      `<path d="M${n(x - dir * a * 0.6)} ${n(c - a)}L${n(x + dir * a * 0.5)} ${n(c)}L${n(x - dir * a * 0.6)} ${n(c + a)}" ${stroke}/>`,
    );
  }
  const up = c - size * 0.36;

  d.add(
    `<path d="M${n(c - a * 0.8)} ${n(up + a * 0.5)}L${n(c)} ${n(up - a * 0.4)}L${n(c + a * 0.8)} ${n(up + a * 0.5)}" ${stroke}/>`,
  );
  const down = c + size * 0.33;

  d.add(
    `<path d="M${n(c - a * 0.8)} ${n(down - a * 0.5)}L${n(c)} ${n(down + a * 0.35)}L${n(c + a * 0.8)} ${n(down - a * 0.5)}" ${stroke}/>` +
      `<path d="M${n(c - a * 0.8)} ${n(down + a * 0.75)}H${n(c + a * 0.8)}" ${stroke}/>`,
  );

  return d.art(size + pad * 2, size + pad * 2, {
    anchor: { x: 0.5, y: 0.5 },
    face: { x: pad, y: pad, w: size, h: size },
  });
}

/**
 * The steering stick's knob: a chunky octagon cap with a cyan rim, sinking when held.
 * @param size - Width in px.
 * @param state - Idle or held.
 */
export function stickKnobSvg(size = 72, state: TouchState = 'idle'): SvgArt {
  const pad = Math.round(size * 0.25);
  const press = state === 'press';
  const depth = press ? 2 : 6;
  const d = new Draft();
  const pts = chamferRect(pad, pad + (press ? 4 : 0), size, size, size * 0.29);

  plate(d, pts, {
    face: press ? ['#2a3a8a', '#1a2462'] : ['#3c4ca0', '#1c2562'],
    depth,
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#ffffff',
    rimOpacity: 0.55,
    gloss: 0.18,
    tape: { color: COLORS.cyan, width: 3, inset: 4, opacity: press ? 1 : 0.75 },
    glow: press ? { color: COLORS.cyan, blur: size * 0.15, opacity: 0.6 } : undefined,
    shadow: 0.6,
  });
  const c = pad + size / 2 + (press ? 4 : 0);

  for (let i = -1; i <= 1; i++) {
    d.add(
      `<path d="M${n(pad + size / 2 + i * size * 0.12)} ${n(c - size * 0.16)}v${n(size * 0.32)}" stroke="${COLORS.ink900}" ` +
        `stroke-opacity="0.5" stroke-width="${n(size * 0.05)}"/>`,
    );
  }

  return d.art(size + pad * 2, size + pad * 2 + 6, {
    anchor: { x: 0.5, y: (pad + size / 2) / (size + pad * 2 + 6) },
    face: { x: pad, y: pad, w: size, h: size },
  });
}

/**
 * An octagon touch button holding one icon, for the right thumb: the camera. Cyan tape, because cyan means you can
 * press it; it never wears a racer colour.
 * @param icon - The icon.
 * @param options - Size and state.
 */
export function touchButtonSvg(icon: IconName, options: { size?: number; state?: TouchState } = {}): SvgArt {
  const size = options.size ?? 64;
  const state = options.state ?? 'idle';
  const press = state === 'press';
  const pad = Math.round(size * 0.22);
  const depth = Math.round(size * 0.08);
  const d = new Draft();
  const pts = chamferRect(pad, pad + (press ? depth - 1 : 0), size, size, size * 0.29);
  const rim = COLORS.cyan;

  plate(d, pts, {
    face: press ? [COLORS.ink700, COLORS.ink800] : [COLORS.ink600, COLORS.ink800],
    faceOpacity: 0.86,
    depth: press ? 1 : depth,
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#ffffff',
    rimOpacity: 0.5,
    gloss: 0.12,
    tape: { color: rim, width: 2.5, inset: 3, opacity: press ? 1 : 0.8 },
    glow: press ? { color: rim, blur: size * 0.14, opacity: 0.6 } : undefined,
    shadow: 0.55,
  });
  const s = size * 0.48;

  drawIcon(d, icon, pad + (size - s) / 2, pad + (press ? depth - 1 : 0) + (size - s) / 2, {
    size: s,
    color: COLORS.white,
    accent: rim,
  });

  return d.art(size + pad * 2, size + pad * 2 + depth, {
    anchor: { x: 0.5, y: (pad + size / 2) / (size + pad * 2 + depth) },
    face: { x: pad, y: pad, w: size, h: size },
  });
}
