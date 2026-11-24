/**
 * The race HUD's layouts: which of the three reference layouts a screen gets, its scale, the
 * layout box and the safe area, plus the sizes every HUD element takes in each layout.
 */

export type HudKind = 'desktop' | 'portrait' | 'landscape';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A screen as the HUD lays it out: everything is placed in box px, and the root is scaled by `scale` */
export interface HudBox {
  readonly kind: HudKind;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly safe: Insets;
  /** Device px per CSS px */
  readonly resolution: number;
}

/** Element sizes in box px for one layout */
export interface HudSpec {
  readonly ordinal: number;
  readonly tower: boolean;
  readonly plateW: number;
  readonly plateH: number;
  readonly plateChamfer: number;
  readonly pause: number;
  /** Mini-map height; its frame is 0.78 as wide */
  readonly map: number;
  /** Speed dial size, or 0 for the phone strip */
  readonly dial: number;
  readonly dot: number;
  readonly you: number;
  readonly chevron: number;
  readonly tagW: number;
  readonly tagH: number;
  readonly stick: number;
  readonly knob: number;
  readonly camera: number;
  readonly phoneType: boolean;
}

const MIN_SAFE: Record<HudKind, Insets> = {
  desktop: { top: 28, right: 36, bottom: 28, left: 36 },
  portrait: { top: 59, right: 20, bottom: 42, left: 20 },
  landscape: { top: 16, right: 59, bottom: 22, left: 59 },
};

const SPEC: Record<HudKind, HudSpec> = {
  desktop: {
    ordinal: 76,
    tower: true,
    plateW: 250,
    plateH: 128,
    plateChamfer: 10,
    pause: 44,
    map: 200,
    dial: 176,
    dot: 18,
    you: 22,
    chevron: 22.88,
    tagW: 104,
    tagH: 26,
    stick: 150,
    knob: 70,
    camera: 52,
    phoneType: false,
  },
  portrait: {
    ordinal: 54,
    tower: false,
    plateW: 160,
    plateH: 74,
    plateChamfer: 8,
    pause: 40,
    map: 128,
    dial: 0,
    dot: 15,
    you: 18,
    chevron: 13,
    tagW: 96,
    tagH: 26,
    stick: 116,
    knob: 58,
    camera: 44,
    phoneType: true,
  },
  landscape: {
    ordinal: 50,
    tower: false,
    plateW: 164,
    plateH: 60,
    plateChamfer: 8,
    pause: 40,
    map: 108,
    dial: 100,
    dot: 15,
    you: 18,
    chevron: 13,
    tagW: 96,
    tagH: 26,
    stick: 112,
    knob: 58,
    camera: 44,
    phoneType: true,
  },
};

/**
 * The narrowest landscape box, box px, as the menus' `computeLayout` has it: a 16:9 phone scales down to keep it, so
 * the top row (place, timing plate, start lights, pause, map) has room on every phone instead of squeezing together.
 */
const LANDSCAPE_MIN_W = 740;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The sizes for a layout */
export function hudSpec(kind: HudKind): HudSpec {
  return SPEC[kind];
}

/**
 * Picks the layout for a screen and works out its box.
 * @param width - Screen width in CSS px.
 * @param height - Screen height in CSS px.
 * @param resolution - Device px per CSS px.
 * @param insets - The device's safe-area insets in CSS px.
 */
export function hudBox(width: number, height: number, resolution: number, insets: Insets): HudBox {
  const kind: HudKind = height > width ? 'portrait' : height < 500 ? 'landscape' : 'desktop';
  const scale =
    kind === 'portrait'
      ? clamp(Math.min(width / 390, height / 844), 0.9, 1.4)
      : kind === 'landscape'
        ? clamp(Math.min(height / 390, width / LANDSCAPE_MIN_W), 0.8, 1.25)
        : clamp(Math.min(width / 1280, height / 720), 0.55, 1.6);
  const min = MIN_SAFE[kind];
  const pad = (inset: number, base: number, margin: number): number =>
    Math.round(Math.max(base, inset > 0 ? inset / scale + margin : 0));

  return {
    kind,
    scale,
    width: Math.round(width / scale),
    height: Math.round(height / scale),
    resolution,
    safe: {
      top: pad(insets.top, min.top, 12),
      right: pad(insets.right, min.right, 12),
      bottom: pad(insets.bottom, min.bottom, 8),
      left: pad(insets.left, min.left, 12),
    },
  };
}

/** Width of the mini-map frame for its height */
export function mapWidth(height: number): number {
  return Math.round(height * 0.78);
}

/** Left edge of the pause button on a phone in landscape: in the top row, just left of the mini-map */
export function landscapePauseX(box: HudBox, spec: HudSpec): number {
  return box.width - box.safe.right - mapWidth(spec.map) - 62;
}
