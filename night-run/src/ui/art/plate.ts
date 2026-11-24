import type { Draft } from './Draft';
import type { Pt } from './svg';
import { bounds, extrude, inset, n, poly, shift } from './svg';
import { COLORS } from './tokens';

/**
 * How a plate is finished. Every panel, button, chip and badge is a plate: a flat face with a lit top lip, an
 * extruded return underneath that makes it read as a chunky moulded toy part, and optional tape, gloss and glow.
 */
export interface PlateStyle {
  /** Face gradient, top then bottom. */
  readonly face: readonly [string, string];
  /** Face opacity, below 1 for smoked panels. */
  readonly faceOpacity?: number;
  /** Extrusion depth in px, straight down. */
  readonly depth?: number;
  /** Return gradient, top then bottom. */
  readonly side?: readonly [string, string];
  /** Colour of the lit lip along the top inside edge. */
  readonly rim?: string;
  /** Opacity of the lip, 0 to 1. */
  readonly rimOpacity?: number;
  /** Width of the lip in px. */
  readonly rimWidth?: number;
  /** Reflective tape inset from the edge. */
  readonly tape?: { readonly color: string; readonly width: number; readonly inset: number; readonly opacity?: number };
  /** Opacity of the toy-plastic gloss band over the top of the face. */
  readonly gloss?: number;
  /** A coloured halo behind the plate. */
  readonly glow?: { readonly color: string; readonly blur: number; readonly opacity: number; readonly spread?: number };
  /** Opacity of the soft drop shadow under the plate. */
  readonly shadow?: number;
  /** Opacity of the inner shade along the bottom inside edge. */
  readonly shade?: number;
}

/** Draws a plate from a convex outline into `d`. */
export function plate(d: Draft, pts: Pt[], s: PlateStyle): void {
  const b = bounds(pts);
  const depth = s.depth ?? 0;
  const solid = depth > 0 ? extrude(pts, 0, depth) : pts;

  if (s.shadow) {
    const f = d.blur(3 + depth * 0.5);

    d.add(
      `<path d="${poly(shift(solid, 0, 3 + depth * 0.5))}" fill="${COLORS.ink900}" opacity="${n(s.shadow)}" filter="url(#${f})"/>`,
    );
  }
  if (s.glow) {
    const f = d.blur(s.glow.blur);
    const spread = s.glow.spread ?? 0;
    const shape = spread ? inset(solid, -spread) : solid;

    d.add(`<path d="${poly(shape)}" fill="${s.glow.color}" opacity="${n(s.glow.opacity)}" filter="url(#${f})"/>`);
  }
  if (depth > 0) {
    const [top, bottom] = s.side ?? [COLORS.ink800, COLORS.ink900];
    const g = d.vgrad(b.y + b.h * 0.5, b.y + b.h + depth, [
      [0, top],
      [1, bottom],
    ]);

    d.add(`<path d="${poly(solid)}" fill="url(#${g})"/>`);
    d.add(
      `<path d="${poly(shift(pts, 0, depth))}" fill="none" stroke="${COLORS.ink900}" stroke-opacity="0.35" stroke-width="1"/>`,
    );
  }
  const face = d.vgrad(b.y, b.y + b.h, [
    [0, s.face[0]],
    [1, s.face[1]],
  ]);
  const opacity = s.faceOpacity !== undefined ? ` fill-opacity="${n(s.faceOpacity)}"` : '';

  d.add(`<path d="${poly(pts)}" fill="url(#${face})"${opacity}/>`);

  const clip = d.clip(poly(pts));

  if (s.gloss) {
    const g = d.vgrad(b.y, b.y + b.h * 0.55, [
      [0, '#ffffff', s.gloss],
      [1, '#ffffff', 0],
    ]);

    d.add(
      `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h * 0.55)}" fill="url(#${g})" clip-path="url(#${clip})"/>`,
    );
  }
  if (s.shade) {
    const g = d.vgrad(b.y + b.h - Math.min(14, b.h * 0.4), b.y + b.h, [
      [0, COLORS.ink900, 0],
      [1, COLORS.ink900, s.shade],
    ]);

    d.add(
      `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="url(#${g})" clip-path="url(#${clip})"/>`,
    );
  }
  if (s.rim) {
    const w = s.rimWidth ?? 2;
    const g = d.vgrad(b.y, b.y + Math.min(b.h * 0.5, 18), [
      [0, s.rim, s.rimOpacity ?? 0.9],
      [1, s.rim, 0],
    ]);

    d.add(
      `<path d="${poly(pts)}" fill="none" stroke="url(#${g})" stroke-width="${n(w * 2)}" clip-path="url(#${clip})"/>`,
    );
  }
  if (s.tape) {
    const t = s.tape;

    d.add(
      `<path d="${poly(inset(pts, t.inset))}" fill="none" stroke="${t.color}" stroke-width="${n(t.width)}" ` +
        `stroke-opacity="${n(t.opacity ?? 1)}" stroke-linejoin="miter"/>`,
    );
  }
}
