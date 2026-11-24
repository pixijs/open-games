/** Which reference layout a screen uses: desktop 1280x720, phone portrait 390x844, phone landscape 844x390. */
export type LayoutKind = 'd' | 'p' | 'l';

export interface Insets {
  readonly t: number;
  readonly r: number;
  readonly b: number;
  readonly l: number;
}

/**
 * The layout box every screen lays out in: the viewport divided by the layout's scale, with
 * the safe-area insets in box px. Elements anchor to the box's edges.
 */
export interface UiLayout {
  readonly kind: LayoutKind;
  readonly scale: number;
  /** Box width and height in px */
  readonly W: number;
  readonly H: number;
  readonly safe: Insets;
  /** Viewport size in CSS px */
  readonly width: number;
  readonly height: number;
  /** Renderer resolution */
  readonly resolution: number;
  /** Extra art density so a scaled-up layout stays sharp: `textures.load(art, density)` */
  readonly density: number;
  /** Device pixels per box px, for pixi Text */
  readonly textResolution: number;
}

/** The margins a layout keeps on a screen with no notch; a notched phone's own insets push past them. */
const SAFE_MIN: Record<LayoutKind, Insets> = {
  d: { t: 28, r: 36, b: 28, l: 36 },
  p: { t: 59, r: 20, b: 42, l: 20 },
  l: { t: 16, r: 28, b: 22, l: 28 },
};

/**
 * The narrowest box a phone in landscape lays out in. A 16:9 phone (an iPhone SE turned, 568 x 320) scales down until
 * its box is this wide, so the landscape screens never squeeze; every other phone lays out by its height.
 */
const LANDSCAPE_MIN_W = 740;

/** What each layout adds past the device's own inset: room under a notch, over a home bar. */
const SAFE_EXTRA: Record<LayoutKind, Insets> = {
  d: { t: 0, r: 0, b: 0, l: 0 },
  p: { t: 12, r: 0, b: 8, l: 0 },
  l: { t: 0, r: 12, b: 0, l: 12 },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Reads `env(safe-area-inset-*)` in CSS px through a throwaway probe element. */
export function readSafeInsets(): Insets {
  if (typeof document === 'undefined') return { t: 0, r: 0, b: 0, l: 0 };
  const probe = document.createElement('div');

  probe.style.cssText =
    'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) ' +
    'env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = {
    t: parseFloat(cs.paddingTop) || 0,
    r: parseFloat(cs.paddingRight) || 0,
    b: parseFloat(cs.paddingBottom) || 0,
    l: parseFloat(cs.paddingLeft) || 0,
  };

  probe.remove();

  return insets;
}

/**
 * The layout for a viewport, by its breakpoints and scale rules. A phone's box is never shorter than its
 * reference (844 tall in portrait, 390 tall and {@link LANDSCAPE_MIN_W} wide in landscape), so a small or 16:9 phone
 * scales the layout down instead of squeezing it, down to a floor where text would get too small to read.
 */
export function computeLayout(width: number, height: number, resolution: number, device: Insets): UiLayout {
  const kind: LayoutKind = height > width ? 'p' : height < 500 ? 'l' : 'd';
  const scale =
    kind === 'p'
      ? clamp(Math.min(width / 390, height / 844), 0.75, 1.4)
      : kind === 'l'
        ? clamp(Math.min(height / 390, width / LANDSCAPE_MIN_W), 0.6, 1.25)
        : clamp(Math.min(width / 1280, height / 720), 0.55, 1.6);
  const min = SAFE_MIN[kind];
  const extra = SAFE_EXTRA[kind];
  const safe = {
    t: Math.max(min.t, device.t / scale + extra.t),
    r: Math.max(min.r, device.r / scale + extra.r),
    b: Math.max(min.b, device.b / scale + extra.b),
    l: Math.max(min.l, device.l / scale + extra.l),
  };

  return {
    kind,
    scale,
    W: Math.round(width / scale),
    H: Math.round(height / scale),
    safe,
    width,
    height,
    resolution,
    density: Math.max(1, scale),
    textResolution: resolution * scale,
  };
}

/** Whether two layouts would draw the same screen, so a resize can skip the rebuild. */
export function sameLayout(a: UiLayout | null, b: UiLayout): boolean {
  return (
    !!a &&
    a.kind === b.kind &&
    a.W === b.W &&
    a.H === b.H &&
    a.scale === b.scale &&
    a.resolution === b.resolution &&
    a.safe.t === b.safe.t &&
    a.safe.r === b.safe.r &&
    a.safe.b === b.safe.b &&
    a.safe.l === b.safe.l
  );
}
