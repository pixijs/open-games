import { Draft } from './Draft';
import { glyphRun, paintedLetters, runWidth, solidLetters } from './glyphs';
import type { IconName } from './icons';
import { drawIcon } from './icons';
import { chequerPattern, hazardPattern } from './motifs';
import { plate } from './plate';
import type { SvgArt } from './svg';
import { chamferRect, inset, leanShift, mix, n, poly, slantRect } from './svg';
import type { RacerColor } from './tokens';
import { COLORS, PLACE_METALS } from './tokens';
import { drawTruck, GHOST_PAINT } from './truck';

/** Panel finishes: `sheet` for screens and dialogs, `card` for raised items, `well` for recessed lists, `hud` for race readouts. */
export type PanelTone = 'sheet' | 'card' | 'well' | 'hud';

/** Options for {@link panelSvg}. */
export interface PanelOptions {
  readonly width?: number;
  readonly height?: number;
  readonly tone?: PanelTone;
  /** A lit bar along the top edge in this colour: cyan for menus, danger for errors, amber for warnings. */
  readonly accent?: string;
  /** Size of the big corner cuts (top left and bottom right) in px. */
  readonly chamfer?: number;
}

/**
 * A panel, made to stretch with `NineSliceSprite` (use `slice`). The big cuts at top left and bottom right give every
 * panel the same forward lean as the type without slanting its edges, so it still stretches cleanly.
 * @param options - Size, tone, accent and corner size.
 */
export function panelSvg(options: PanelOptions = {}): SvgArt {
  const w = options.width ?? 160;
  const h = options.height ?? 120;
  const tone = options.tone ?? 'sheet';
  const c = options.chamfer ?? (tone === 'hud' ? 10 : 18);
  const depth = tone === 'sheet' ? 6 : tone === 'card' ? 4 : tone === 'hud' ? 3 : 0;
  const pad = 16;
  const d = new Draft();
  const pts = chamferRect(pad, pad, w, h, [c, c * 0.3, c, c * 0.3]);

  if (tone === 'well') {
    plate(d, pts, {
      face: [COLORS.ink900, COLORS.ink800],
      faceOpacity: 0.88,
      tape: { color: COLORS.line, width: 1.25, inset: 0.75, opacity: 0.8 },
    });
    const clip = d.clip(poly(pts));
    const top = d.vgrad(pad, pad + 12, [
      [0, '#000000', 0.5],
      [1, '#000000', 0],
    ]);

    d.add(`<rect x="${pad}" y="${pad}" width="${w}" height="12" fill="url(#${top})" clip-path="url(#${clip})"/>`);
  } else {
    plate(d, pts, {
      face:
        tone === 'card'
          ? [COLORS.ink600, COLORS.ink700]
          : tone === 'hud'
            ? ['#18215a', '#0b1034']
            : [COLORS.ink700, COLORS.ink800],
      faceOpacity: tone === 'hud' ? 0.84 : 0.95,
      depth,
      side: [COLORS.ink800, COLORS.ink900],
      rim: '#9fb0ff',
      rimOpacity: tone === 'hud' ? 0.35 : 0.5,
      rimWidth: 1.5,
      gloss: tone === 'card' ? 0.07 : 0.05,
      tape: tone === 'sheet' ? { color: '#ffffff', width: 1, inset: 5, opacity: 0.08 } : undefined,
      shadow: tone === 'hud' ? 0.45 : 0.6,
      shade: 0.3,
    });
  }
  if (options.accent) {
    const bar = chamferRect(pad + c + 6, pad + 4, Math.max(8, w - c * 2 - 12), 4, 0);
    const glow = d.blur(4);

    d.add(`<path d="${poly(bar)}" fill="${options.accent}" opacity="0.7" filter="url(#${glow})"/>`);
    d.add(`<path d="${poly(bar)}" fill="${options.accent}"/>`);
  }
  const edge = pad + c + 8;

  return d.art(w + pad * 2, h + pad * 2 + depth, {
    slice: { left: edge, top: edge, right: edge, bottom: edge + depth },
    content: { x: pad, y: pad, w, h },
    face: { x: pad, y: pad, w, h },
  });
}

/**
 * What a race callout announces. `caution` is the amber timer chip (the race closing after the first finisher);
 * `gain` and `loss` also carry lap splits against your best.
 */
export type CalloutKind = 'final' | 'wrong' | 'record' | 'gain' | 'loss' | 'finish' | 'boost' | 'info' | 'caution';

/**
 * A race callout banner: a long leaning plate with a trim that says what kind of moment it is before the words are
 * read. Final lap is the white flag with chequer trims, wrong way is hazard red with chevrons pointing back, a lap
 * record is gold with stars, a finish is a chequered plate with an ink centre.
 * @param kind - The moment.
 * @param width - Face width in px.
 * @param height - Face height in px.
 */
export function calloutSvg(kind: CalloutKind, width = 560, height = 96): SvgArt {
  const pad = Math.round(height * 0.4);
  const d = new Draft();
  const pts = slantRect(pad, pad, width, height, 12, height * 0.12);
  const s = leanShift(height, 12);
  const gold = PLACE_METALS[0];
  const faces: Record<CalloutKind, { face: [string, string]; side: [string, string]; glow: string }> = {
    final: { face: ['#ffffff', '#d5ddf2'], side: ['#7c88aa', '#262d4a'], glow: '#ffffff' },
    wrong: { face: ['#ff7189', COLORS.danger], side: [COLORS.dangerDeep, '#3a0010'], glow: COLORS.danger },
    record: { face: [gold.hi, gold.mid], side: [gold.lo, gold.deep], glow: '#ffbf2e' },
    gain: { face: ['#c4ffe1', COLORS.go], side: [COLORS.goDeep, '#003a20'], glow: COLORS.go },
    loss: { face: ['#ff7189', COLORS.danger], side: [COLORS.dangerDeep, '#3a0010'], glow: COLORS.danger },
    finish: { face: [COLORS.ink700, COLORS.ink900], side: ['#7c88aa', '#262d4a'], glow: '#ffffff' },
    boost: { face: ['#ff8cc6', COLORS.magenta], side: [COLORS.magentaDeep, '#3a0021'], glow: COLORS.magenta },
    info: { face: [COLORS.ink600, COLORS.ink800], side: [COLORS.ink800, COLORS.ink900], glow: COLORS.cyan },
    caution: { face: ['#ffc58f', COLORS.amber], side: [COLORS.amberDeep, '#3d1a00'], glow: COLORS.amber },
  };
  const f = faces[kind];
  const depth = Math.round(height * 0.08);

  plate(d, pts, {
    face: f.face,
    faceOpacity: kind === 'info' ? 0.94 : 1,
    depth,
    side: f.side,
    rim: '#ffffff',
    rimOpacity: 0.85,
    gloss: kind === 'info' || kind === 'finish' ? 0.08 : 0.3,
    glow: { color: f.glow, blur: height * 0.2, opacity: kind === 'info' ? 0.25 : 0.5 },
    shadow: 0.6,
    tape: kind === 'info' ? { color: COLORS.cyan, width: 2, inset: 3, opacity: 0.8 } : undefined,
  });
  if (kind === 'record') {
    d.add(`<path d="${poly(pts)}" fill="none" stroke="${COLORS.ink900}" stroke-width="2" stroke-linejoin="miter"/>`);
  }
  const clip = d.clip(poly(pts));
  const band = height * 0.17;
  const trim = (fill: string): string =>
    `<g clip-path="url(#${clip})"><rect x="0" y="${n(pad)}" width="${n(width + pad * 2)}" height="${n(band)}" fill="${fill}"/>` +
    `<rect x="0" y="${n(pad + height - band)}" width="${n(width + pad * 2)}" height="${n(band)}" fill="${fill}"/></g>`;
  let content = { x: pad + s * 0.5, y: pad, w: width - s, h: height };

  if (kind === 'final') d.add(trim(`url(#${chequerPattern(d, band / 2, COLORS.ink900, '#ffffff', 12)})`));
  if (kind === 'wrong') d.add(trim(`url(#${hazardPattern(d, band * 0.55, COLORS.ink900, '#ff9fb0')})`));
  if (kind === 'finish') {
    d.add(`<path d="${poly(pts)}" fill="url(#${chequerPattern(d, height / 6, COLORS.ink900, '#ffffff', 12)})"/>`);
    const core = slantRect(pad + width * 0.16, pad + height * 0.16, width * 0.68, height * 0.68, 12, 6);

    plate(d, core, { face: [COLORS.ink700, COLORS.ink900], depth: 3, rim: '#9fb0ff', rimOpacity: 0.6, shadow: 0.6 });
    content = {
      x: pad + width * 0.16 + s * 0.34,
      y: pad + height * 0.16,
      w: width * 0.68 - s * 0.68,
      h: height * 0.68,
    };
  }
  if (kind === 'record') {
    const glint = d.lgrad(pad, pad, pad + height, pad + height, [
      [0, '#ffffff', 0],
      [0.5, '#ffffff', 0.7],
      [1, '#ffffff', 0],
    ]);

    d.add(
      `<path clip-path="url(#${clip})" d="M${n(pad + width * 0.62)} ${n(pad)}h${n(height * 0.3)}l${n(-height * 0.5)} ${n(height)}h${n(-height * 0.3)}Z" fill="url(#${glint})"/>`,
    );
  }
  const ends: Partial<Record<CalloutKind, { icon: IconName; color: string; accent?: string }>> = {
    wrong: { icon: 'uturn', color: COLORS.white },
    record: { icon: 'star', color: COLORS.ink900 },
    gain: { icon: 'up', color: COLORS.ink900 },
    loss: { icon: 'down', color: COLORS.white },
    boost: { icon: 'bolt', color: COLORS.white },
    final: { icon: 'flag', color: COLORS.ink900, accent: COLORS.white },
    caution: { icon: 'timer', color: COLORS.ink900 },
  };
  const end = ends[kind];

  if (end) {
    const size = height * 0.46;
    const y = pad + (height - size) / 2;
    const iconOpts = { size, color: end.color, accent: end.accent ?? end.color, keyline: end.color === COLORS.white };

    drawIcon(d, end.icon, pad + s * 0.5 + height * 0.2, y, iconOpts);
    drawIcon(d, end.icon, pad + width - s * 0.5 - height * 0.2 - size, y, iconOpts);
    content = { x: content.x + height * 0.75, y: content.y, w: content.w - height * 1.5, h: content.h };
  }

  return d.art(width + pad * 2, height + pad * 2 + depth, { content, face: { x: pad, y: pad, w: width, h: height } });
}

/** What a toast reports. */
export type ToastTone = 'join' | 'leave' | 'warn' | 'error' | 'info';

/**
 * A toast: a leaning ink chip with a coloured icon cell on its left. Stretches sideways with `slice`.
 * @param tone - What happened; sets the cell colour and default icon.
 * @param options - Width, height, an icon in place of the tone's own, a racer colour for the cell (joins and leaves),
 * and `cell`, the tallest the icon cell grows: a toast taller than that (lines of text) keeps a one-line toast's cell,
 * centred on its left edge, so the cell doesn't eat the text column.
 */
export function toastSvg(
  tone: ToastTone,
  options: { width?: number; height?: number; icon?: IconName; color?: RacerColor; cell?: number } = {},
): SvgArt {
  const w = options.width ?? 340;
  const h = options.height ?? 56;
  const pad = 16;
  const d = new Draft();
  const toneColor: Record<ToastTone, string> = {
    join: COLORS.go,
    leave: COLORS.mist,
    warn: COLORS.amber,
    error: COLORS.danger,
    info: COLORS.cyan,
  };
  const toneIcon: Record<ToastTone, IconName> = {
    join: 'join',
    leave: 'leave',
    warn: 'offline',
    error: 'warning',
    info: 'info',
  };
  const cellColor = options.color?.main ?? toneColor[tone];
  const s = leanShift(h, 12);

  plate(d, slantRect(pad, pad, w, h, 12, 6), {
    face: [COLORS.ink600, COLORS.ink800],
    faceOpacity: 0.96,
    depth: 4,
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#9fb0ff',
    rimOpacity: 0.5,
    shadow: 0.65,
    tape: { color: cellColor, width: 1.5, inset: 2.5, opacity: 0.6 },
  });
  // The height of the toast the cell is sized for: this one, or a shorter one when `cell` caps it.
  const row = Math.min(h, (options.cell ?? h) + 8);
  const cw = row * 1.05;
  // A shorter cell sits in the middle, its left edge following the plate's lean.
  const cx = pad + 4 + leanShift((h - row) / 2, 12);

  plate(d, slantRect(cx, pad + 4 + (h - row) / 2, cw, row - 8, 12, 4), {
    face: [mix(cellColor, '#ffffff', 0.35), cellColor],
    rim: '#ffffff',
    rimOpacity: 0.7,
    gloss: 0.25,
  });
  const size = row * 0.5;
  const ix = cx + (cw - size) / 2 + leanShift(row, 12) * 0.08;

  drawIcon(d, options.icon ?? toneIcon[tone], ix, pad + (h - size) / 2, {
    size,
    color: COLORS.ink900,
    accent: '#ffffff',
    keyline: false,
  });
  // The words start a clear gap past the cell's slanted edge where they sit, at its middle, not its foot.
  const left = cx + cw + leanShift((row - 8) / 2, 12) + 12;

  return d.art(w + pad * 2, h + pad * 2 + 4, {
    slice: { left, right: pad + s + 8, top: 0, bottom: 0 },
    content: { x: left, y: pad, w: pad + w - s - left, h },
    face: { x: pad, y: pad, w, h },
  });
}

/**
 * The name tag that floats over another racer's truck (never your own): an ink plate with the racer's colour block on
 * the left (their place goes there as Text) and a pointer down to the truck. On the podium, `podium` swaps the colour
 * block for the place's metal with the numeral drawn in, and the racer's colour moves to a stripe.
 * @param color - The racer colour.
 * @param options - Width, height, and the podium place.
 */
export function nameTagSvg(
  color: RacerColor,
  options: { width?: number; height?: number; podium?: 1 | 2 | 3 } = {},
): SvgArt {
  const w = options.width ?? 120;
  const h = options.height ?? 28;
  const pad = 8;
  const d = new Draft();
  const pts = slantRect(pad, pad, w, h, 12, 4);
  const pointer = h * 0.32;
  const cx = pad + w / 2;

  d.add(
    `<path d="M${n(cx - pointer)} ${n(pad + h - 1)}L${n(cx)} ${n(pad + h + pointer)}L${n(cx + pointer)} ${n(pad + h - 1)}Z" ` +
      `fill="${color.main}" stroke="${COLORS.ink900}" stroke-width="1.5"/>`,
  );
  plate(d, pts, {
    face: [COLORS.ink600, COLORS.ink900],
    faceOpacity: 0.92,
    rim: '#9fb0ff',
    rimOpacity: 0.45,
    shadow: 0.5,
  });
  const bw = h * 1.05;
  let left = pad + bw + 4;

  if (options.podium) {
    const m = PLACE_METALS[options.podium - 1];
    const cell = slantRect(pad + 2, pad + 2, bw, h - 4, 12, 3);

    plate(d, cell, { face: [m.hi, m.mid], depth: 1.5, side: [m.lo, m.deep], rim: '#ffffff', rimOpacity: 0.8 });
    d.add(`<path d="${poly(cell)}" fill="none" stroke="${COLORS.ink900}" stroke-width="1.2"/>`);
    const run = glyphRun(String(options.podium));
    const size = h * 0.56;

    solidLetters(
      d,
      run,
      { x: pad + 2 + (bw - runWidth(run, size, 12)) / 2, y: pad + (h - size) / 2 - 0.5, size, lean: 12 },
      { face: ['#ffffff', '#e6ebf8'], side: [COLORS.ink800, COLORS.ink900], depth: size * 0.08, lip: '#ffffff' },
    );
    plate(d, slantRect(left, pad + 4, 6, h - 8, 12), { face: [color.hi, color.main] });
    left += 10;
  } else {
    plate(d, slantRect(pad + 2, pad + 2, bw, h - 4, 12, 3), {
      face: [color.hi, color.main],
      rim: '#ffffff',
      rimOpacity: 0.6,
    });
  }

  return d.art(w + pad * 2, h + pad * 2 + pointer, {
    anchor: { x: cx / (w + pad * 2), y: 1 - 2 / (h + pad * 2 + pointer) },
    content: { x: left, y: pad, w: w - (left - pad) - leanShift(h, 12), h },
    face: { x: pad, y: pad, w, h },
  });
}

/** States of the party-code plate. */
export type CodePlateState = 'idle' | 'hover' | 'copied';

/**
 * The party code plate, styled as a reflective licence plate: the code is the lobby's plate number. Bright face,
 * embossed rim, bolt heads and a chequer header strip; `copied` tints it green with a check. Its `content` is the
 * white face between the strip and the inked rim, so a code centred in it has even room above and below, and clear of
 * the check at either end, so a narrow plate's code never runs under it.
 * @param state - Idle, hover or copied.
 * @param width - Face width in px.
 * @param height - Face height in px.
 */
export function codePlateSvg(state: CodePlateState = 'idle', width = 300, height = 104): SvgArt {
  const pad = 18;
  const d = new Draft();
  const pts = chamferRect(pad, pad, width, height, height * 0.12);
  const copied = state === 'copied';
  const stripH = height * 0.13;
  const top = pad + 12 + stripH;
  const free = pad + height - 8 - top;
  // The copied check's size. The code keeps clear of it, and of the same room on the left so it stays centred.
  const mark = height * 0.24;

  plate(d, pts, {
    face: copied ? ['#e8fff3', '#9ff5c8'] : ['#ffffff', '#cdd6ee'],
    depth: 6,
    side: copied ? [COLORS.goDeep, '#003a20'] : ['#69769c', '#1d2340'],
    rim: '#ffffff',
    rimOpacity: 1,
    gloss: 0.5,
    shadow: 0.65,
    glow:
      state === 'hover'
        ? { color: COLORS.cyan, blur: 10, opacity: 0.55 }
        : copied
          ? { color: COLORS.go, blur: 10, opacity: 0.55 }
          : undefined,
  });
  const ring = inset(pts, 6);

  d.add(`<path d="${poly(ring)}" fill="none" stroke="${COLORS.ink900}" stroke-width="3.5" stroke-linejoin="miter"/>`);
  d.add(`<path d="${poly(inset(pts, 8.5))}" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.8"/>`);
  const strip = chamferRect(pad + 14, pad + 12, width - 28, stripH, 0);
  const cell = stripH / 2;

  d.add(
    `<path d="${poly(strip)}" fill="url(#${chequerPattern(d, cell, COLORS.ink900, copied ? '#e8fff3' : '#ffffff')})"/>`,
  );
  for (const bx of [pad + 22, pad + width - 22]) {
    const by = pad + height - 16;

    d.add(`<circle cx="${n(bx)}" cy="${n(by)}" r="4.6" fill="#7d89ad" stroke="${COLORS.ink900}" stroke-width="1.2"/>`);
    d.add(`<path d="M${n(bx - 2.6)} ${n(by)}H${n(bx + 2.6)}" stroke="${COLORS.ink900}" stroke-width="1.3"/>`);
  }
  if (copied) {
    // On the code's line, in from the bolt below its end.
    drawIcon(d, 'check', pad + width - mark - 30, top + (free - mark) / 2, {
      size: mark,
      color: COLORS.goDeep,
      keyline: false,
    });
  }

  return d.art(width + pad * 2, height + pad * 2 + 6, {
    content: { x: pad + 36 + mark, y: top, w: width - 72 - mark * 2, h: free },
    face: { x: pad, y: pad, w: width, h: height },
  });
}

/** A lobby seat's state. */
export type SlotState = 'empty' | 'joining' | 'player' | 'ready' | 'bot';

/** Options for {@link slotCardSvg}. */
export interface SlotCardOptions {
  readonly width?: number;
  readonly height?: number;
  readonly color?: RacerColor;
  readonly state?: SlotState;
  /** The local player's own seat: a cyan YOU tab on the top edge. Ready never uses cyan, so the two can't mix up. */
  readonly you?: boolean;
  /** The host's seat: a crown on the bay. */
  readonly host?: boolean;
  /** The bay number painted on the back wall (or on the shutter of an open seat), 1 to 4. */
  readonly bay?: number;
}

/**
 * A lobby seat card, drawn as a garage bay: the bay on the left has a back wall lit by a strip light in the seat's
 * colour, a painted bay number, a floor with bay lines and the seat's truck parked on it. The name area (`content`)
 * is on the right, with the ready stamp at the right end. A ready seat gets solid lit green tape round the card; your
 * own seat gets a cyan YOU tab. An open seat has its roller shutter down; a seat someone is joining has it half up
 * over a ghost truck.
 * @param options - Size, colour, state, bay number, and whether it's yours or the host's.
 */
export function slotCardSvg(options: SlotCardOptions = {}): SvgArt {
  const w = options.width ?? 420;
  const h = options.height ?? 84;
  const state = options.state ?? 'player';
  const color = options.color;
  const pad = 16;
  const d = new Draft();
  const pts = chamferRect(pad, pad, w, h, [14, 4, 14, 4]);
  const empty = state === 'empty' || !color;
  const ready = state === 'ready';

  if (empty) {
    plate(d, pts, { face: [COLORS.ink900, COLORS.ink800], faceOpacity: 0.72 });
    d.add(
      `<path d="${poly(inset(pts, 1.5))}" fill="none" stroke="${COLORS.line}" stroke-width="2" stroke-dasharray="10 6" stroke-linejoin="miter"/>`,
    );
  } else {
    plate(d, pts, {
      face: [COLORS.ink600, COLORS.ink800],
      faceOpacity: 0.95,
      depth: 4,
      side: [COLORS.ink800, COLORS.ink900],
      rim: '#9fb0ff',
      rimOpacity: 0.5,
      gloss: 0.06,
      shadow: 0.55,
      tape: ready ? { color: COLORS.go, width: 3, inset: 2 } : undefined,
      glow: ready ? { color: COLORS.go, blur: 9, opacity: 0.5 } : undefined,
    });
  }
  const bw = h * 1.55;
  const bx = pad + 6;
  const by = pad + 6;
  const bh = h - 12;
  const bay = chamferRect(bx, by, bw, bh, [10, 0, 0, 0]);
  const clip = d.clip(poly(bay));
  const floorY = by + bh * 0.74;
  const lit = !empty && color ? color : null;
  const wall = d.vgrad(by, floorY, [
    [0, lit ? mix(lit.deep, COLORS.ink900, 0.45) : COLORS.ink800],
    [1, COLORS.ink900],
  ]);
  const floor = d.vgrad(floorY, by + bh, [
    [0, '#2c3568'],
    [1, '#121838'],
  ]);
  let bayMarkup = `<path d="${poly(bay)}" fill="url(#${wall})"/>`;

  for (let i = 1; i < 4; i++) {
    const x = bx + (bw * i) / 4;

    bayMarkup += `<path d="M${n(x)} ${n(by)}V${n(floorY)}" stroke="#000000" stroke-opacity="0.35" stroke-width="1"/>`;
  }
  if (lit) {
    const pool = d.rgrad(bx + bw * 0.55, by, bw * 0.75, [
      [0, lit.main, 0.55],
      [1, lit.main, 0],
    ]);

    bayMarkup += `<rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(floorY - by)}" fill="url(#${pool})"/>`;
  }
  bayMarkup +=
    `<rect x="${n(bx)}" y="${n(floorY)}" width="${n(bw)}" height="${n(by + bh - floorY)}" fill="url(#${floor})"/>` +
    `<path d="M${n(bx)} ${n(floorY)}H${n(bx + bw)}" stroke="#ffffff" stroke-opacity="0.28" stroke-width="1"/>` +
    `<path d="M${n(bx + bw * 0.12)} ${n(by + bh)}L${n(bx + bw * 0.18)} ${n(floorY + 2)}M${n(bx + bw * 0.88)} ${n(by + bh)}` +
    `L${n(bx + bw * 0.82)} ${n(floorY + 2)}" stroke="#ffffff" stroke-opacity="0.4" stroke-width="1.6"/>`;
  d.add(`<g clip-path="url(#${clip})">${bayMarkup}</g>`);
  if (options.bay && !empty) {
    const run = glyphRun(String(options.bay));
    const size = bh * 0.3;

    paintedLetters(d, run, { x: bx + 7, y: by + 7, size, lean: 0 }, '#ffffff', 0.4);
  }
  const tw = bw * 0.68;
  const tk = tw / 120;
  const tx = bx + (bw - tw) / 2 + bw * 0.08;
  const ty = floorY + (by + bh - floorY) * 0.55 - 62 * tk;

  if (state === 'joining' || empty) d.add('<g opacity="0.45">');
  drawTruck(d, empty || state === 'joining' || !color ? GHOST_PAINT : color, tx, ty, tk);
  if (state === 'joining' || empty) d.add('</g>');
  if (empty || state === 'joining') drawShutter(d, bx, by, bw, empty ? bh : bh * 0.42, clip, options.bay ?? 0);
  if (lit) {
    const glow = d.blur(2.5);
    const strip = `M${n(bx + 12)} ${n(by + 2.5)}H${n(bx + bw - 6)}`;

    d.add(
      `<path d="${strip}" stroke="${lit.main}" stroke-width="5" opacity="0.8" filter="url(#${glow})"/>` +
        `<path d="${strip}" stroke="${lit.hi}" stroke-width="2.4"/>`,
    );
    d.add(`<path d="M${n(bx + bw)} ${n(by)}V${n(by + bh)}" stroke="${lit.main}" stroke-width="3"/>`);
  }
  if (options.host) {
    const sz = h * 0.36;

    drawCrown(d, pad - 2, pad - sz * 0.55, sz);
  }
  if (state === 'bot') {
    const sz = h * 0.3;

    drawIcon(d, 'bot', bx + bw - sz - 5, by + 4, { size: sz, color: COLORS.white, accent: color?.main ?? COLORS.cyan });
  }
  if (state === 'joining') {
    const sz = h * 0.3;

    drawIcon(d, 'signal', bx + bw - sz - 5, by + bh - sz - 5, { size: sz, color: COLORS.cyan, level: 2 });
  }
  let right = w - bw - 22;

  if (ready) {
    const sz = h * 0.62;

    drawReadyStamp(d, pad + w - sz - 12, pad + (h - sz) / 2, sz);
    right -= sz + 12;
  }
  if (options.you) {
    const th = Math.max(15, Math.round(h * 0.24));
    const run = glyphRun('YOU', 0.8);
    const ts = th * 0.6;
    const tabW = runWidth(run, ts, 12) + th * 1.1;
    const tx0 = pad + bw + 20;
    const ty0 = pad - th * 0.55;

    plate(d, slantRect(tx0, ty0, tabW, th, 12, 3), {
      face: ['#a6f8ff', COLORS.cyan],
      depth: 2,
      side: [COLORS.cyanDeep, '#00304d'],
      rim: '#ffffff',
      rimOpacity: 0.9,
      glow: { color: COLORS.cyan, blur: 4, opacity: 0.6 },
      shadow: 0.5,
    });
    paintedLetters(d, run, { x: tx0 + th * 0.5, y: ty0 + (th - ts) / 2, size: ts, lean: 12 }, COLORS.ink900);
  }

  return d.art(w + pad * 2, h + pad * 2 + 4, {
    content: { x: pad + bw + 20, y: pad, w: right, h },
    face: { x: pad, y: pad, w, h },
  });
}

/** Draws a garage roller shutter down from the top of a bay to `height`, with its bay number painted on. */
function drawShutter(d: Draft, x: number, y: number, w: number, height: number, clip: string, bay: number): void {
  const steel = d.vgrad(y, y + height, [
    [0, '#3d4a86'],
    [1, '#26306a'],
  ]);
  const slat = Math.max(4, height / 9);
  let markup = `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(height)}" fill="url(#${steel})"/>`;

  for (let sy = y + slat; sy < y + height - 2; sy += slat) {
    markup +=
      `<path d="M${n(x)} ${n(sy)}H${n(x + w)}" stroke="${COLORS.ink900}" stroke-opacity="0.55" stroke-width="1.2"/>` +
      `<path d="M${n(x)} ${n(sy + 1.2)}H${n(x + w)}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1"/>`;
  }
  markup +=
    `<rect x="${n(x)}" y="${n(y + height - 4)}" width="${n(w)}" height="4" fill="#5d6aa8"/>` +
    `<rect x="${n(x + w / 2 - 7)}" y="${n(y + height - 2.5)}" width="14" height="3" fill="${COLORS.ink900}"/>`;
  d.add(`<g clip-path="url(#${clip})">${markup}</g>`);
  if (bay && height > w * 0.4) {
    const run = glyphRun(String(bay));
    const size = height * 0.42;

    paintedLetters(
      d,
      run,
      { x: x + (w - runWidth(run, size, 0)) / 2, y: y + (height - size) / 2 - 2, size, lean: 0 },
      '#ffffff',
      0.5,
    );
  }
}

/** Draws the host crown: a solid gold crown with three gems, extruded. */
function drawCrown(d: Draft, x: number, y: number, size: number): void {
  const m = PLACE_METALS[0];
  const k = size / 24;
  const face = d.vgrad(0, 22, [
    [0, m.hi],
    [0.5, m.mid],
    [1, m.lo],
  ]);
  const shape = 'M2 18L2.5 6 8 11 12 3.5 16 11 21.5 6 22 18Z';
  const band = 'M2 18.5H22V22H2Z';

  d.add(`<g transform="translate(${n(x)} ${n(y)}) scale(${n(k)})">`);
  d.add(
    `<g transform="translate(0.6 1.8)" fill="${m.deep}" stroke="${m.deep}" stroke-width="2.6" stroke-linejoin="round"><path d="${shape}"/><path d="${band}"/></g>`,
  );
  d.add(
    `<g fill="${COLORS.ink900}" stroke="${COLORS.ink900}" stroke-width="2.4" stroke-linejoin="round"><path d="${shape}"/><path d="${band}"/></g>`,
  );
  d.add(`<path d="${shape}" fill="url(#${face})"/><path d="${band}" fill="${m.lo}"/>`);
  d.add(`<path d="M3 17.5L3.4 8 8 12.2 12 5.2" fill="none" stroke="#ffffff" stroke-opacity="0.7" stroke-width="0.9"/>`);
  d.add(
    `<circle cx="7" cy="20.2" r="1.1" fill="${COLORS.magenta}"/><circle cx="12" cy="20.2" r="1.1" fill="${COLORS.cyan}"/><circle cx="17" cy="20.2" r="1.1" fill="${COLORS.magenta}"/>`,
  );
  d.add('</g>');
}

/** Draws the ready stamp: an octagon in GO green with a heavy check. */
export function drawReadyStamp(d: Draft, x: number, y: number, size: number): void {
  const pts = chamferRect(x, y, size, size, size * 0.29);

  plate(d, pts, {
    face: ['#c8ffe3', COLORS.go],
    depth: Math.max(2, size * 0.07),
    side: [COLORS.goDeep, '#00351d'],
    rim: '#ffffff',
    rimOpacity: 0.9,
    gloss: 0.35,
    glow: { color: COLORS.go, blur: size * 0.15, opacity: 0.5 },
    shadow: 0.5,
  });
  const s = size * 0.66;

  drawIcon(d, 'check', x + (size - s) / 2, y + (size - s) / 2, { size: s, color: COLORS.ink900, keyline: false });
}

/**
 * The ready stamp on its own; `on` false draws the empty socket it sits in before you're ready.
 * @param size - Width in px.
 * @param on - Ready or not.
 */
export function readyStampSvg(size = 48, on = true): SvgArt {
  const d = new Draft();
  const pad = Math.ceil(size * 0.25);

  if (on) drawReadyStamp(d, pad, pad, size);
  else {
    const pts = chamferRect(pad, pad, size, size, size * 0.29);

    plate(d, pts, {
      face: [COLORS.ink900, COLORS.ink800],
      faceOpacity: 0.8,
      tape: { color: COLORS.line, width: 2, inset: 1 },
    });
  }

  return d.art(size + pad * 2, size + pad * 2 + Math.ceil(size * 0.07), { face: { x: pad, y: pad, w: size, h: size } });
}

/** Options for {@link resultRowSvg}. */
export interface ResultRowOptions {
  readonly width?: number;
  readonly height?: number;
  readonly place: number;
  readonly color: RacerColor;
  readonly you?: boolean;
  /** Did not finish: the row dims and the place cell shows no metal. */
  readonly dnf?: boolean;
}

/**
 * A results-table row: a place cell in its metal with the numeral drawn in and an ink keyline, the racer's colour
 * stripe, then the name, time and gap area (`content`). Your row gets cyan tape. A racer who didn't finish (`dnf`,
 * the room's `time` 0) gets a plain ink cell and a dimmed row; the time column says DNF.
 * @param options - Size, place, colour, yours, and did-not-finish.
 */
export function resultRowSvg(options: ResultRowOptions): SvgArt {
  const w = options.width ?? 640;
  const h = options.height ?? 60;
  const pad = 12;
  const d = new Draft();
  const m = PLACE_METALS[Math.min(3, Math.max(0, options.place - 1))];
  const pts = chamferRect(pad, pad, w, h, [12, 3, 12, 3]);

  plate(d, pts, {
    face: options.you ? ['#24306f', COLORS.ink800] : [COLORS.ink700, COLORS.ink800],
    faceOpacity: options.dnf ? 0.7 : 0.95,
    depth: 3,
    side: [COLORS.ink800, COLORS.ink900],
    rim: '#9fb0ff',
    rimOpacity: 0.45,
    shadow: 0.5,
    tape: options.you ? { color: COLORS.cyan, width: 2, inset: 1.5 } : undefined,
  });
  const cw = h * 1.15;
  const cell = slantRect(pad + 4, pad + 4, cw, h - 8, 12, 5);

  plate(d, cell, {
    face: options.dnf ? [COLORS.ink600, COLORS.ink700] : [m.hi, m.mid],
    side: options.dnf ? [COLORS.ink800, COLORS.ink900] : [m.lo, m.deep],
    depth: 2,
    rim: '#ffffff',
    rimOpacity: options.dnf ? 0.3 : 0.8,
    gloss: options.dnf ? 0 : 0.35,
  });
  d.add(`<path d="${poly(cell)}" fill="none" stroke="${COLORS.ink900}" stroke-width="1.5" stroke-linejoin="miter"/>`);
  const run = glyphRun(String(options.place));
  const size = h * 0.52;

  solidLetters(
    d,
    run,
    {
      x: pad + 4 + (cw - runWidth(run, size, 12)) / 2 + leanShift(h, 12) * 0.2,
      y: pad + (h - size) / 2 - 1,
      size,
      lean: 12,
    },
    {
      face: ['#ffffff', '#e6ebf8'],
      side: [COLORS.ink800, COLORS.ink900],
      depth: size * 0.08,
      lip: '#ffffff',
    },
  );
  const sx = pad + cw + 12;

  plate(d, slantRect(sx, pad + 6, 10, h - 12, 12), {
    face: [options.color.hi, options.color.main],
    rim: '#ffffff',
    rimOpacity: 0.5,
  });

  return d.art(w + pad * 2, h + pad * 2 + 3, {
    content: { x: sx + 22, y: pad, w: w - cw - 46, h },
    face: { x: pad, y: pad, w, h },
  });
}

/** The pit board's aluminium. */
const STEEL = { hi: '#e3e8f6', mid: '#a3adc8', lo: '#5f6a8c', deep: '#2a3150' } as const;
/** The pit board's frame width and its chequer header's height, px. */
const BOARD_FRAME = 9;
const BOARD_HEADER = 14;

/** The pit board's aluminium frame round a slate face, with the chequer header across the slate's top. */
function boardFrame(d: Draft, px: number, py: number, w: number, h: number): void {
  const frame = BOARD_FRAME;
  const outer = chamferRect(px, py, w, h, [16, 6, 16, 6]);

  plate(d, outer, {
    face: [STEEL.hi, STEEL.mid],
    depth: 6,
    side: [STEEL.lo, STEEL.deep],
    rim: '#ffffff',
    rimOpacity: 0.9,
    gloss: 0.25,
    shadow: 0.65,
  });
  d.add(`<path d="${poly(outer)}" fill="none" stroke="${COLORS.ink900}" stroke-width="1.5"/>`);
  const slate = chamferRect(px + frame, py + frame, w - frame * 2, h - frame * 2, [10, 3, 10, 3]);

  plate(d, slate, { face: ['#151a3a', '#070a1c'], faceOpacity: 0.97, shade: 0.3 });
  const slateClip = d.clip(poly(slate));

  d.add(
    `<rect clip-path="url(#${slateClip})" x="${n(px + frame)}" y="${n(py + frame)}" width="${n(w - frame * 2)}" ` +
      `height="${BOARD_HEADER}" fill="url(#${chequerPattern(d, BOARD_HEADER / 2, COLORS.ink900, '#e9eefb')})"/>`,
  );
}

/**
 * A pit board with nothing on it: the title menu's frame, slate and chequer, for the track in My tracks that's
 * selected. Drawn at its size, since stretching would smear the chequer; `content` is the slate under the chequer.
 * @param width - Face width in px.
 * @param height - Face height in px.
 */
export function specBoardSvg(width: number, height: number): SvgArt {
  const d = new Draft();
  const p = 18;
  const top = p + BOARD_FRAME + BOARD_HEADER;

  boardFrame(d, p, p, width, height);

  return d.art(width + p * 2, height + p * 2 + 6, {
    content: { x: p + BOARD_FRAME, y: top, w: width - BOARD_FRAME * 2, h: height - BOARD_FRAME * 2 - BOARD_HEADER },
    face: { x: p, y: p, w: width, h: height },
  });
}

/** Options for {@link pitBoardSvg}. */
export interface PitBoardOptions {
  /** Width of the board in px. */
  readonly width?: number;
  /** How many rows (menu choices) the board holds. */
  readonly rows?: number;
  /** Height of each row in px: the button height. */
  readonly rowHeight?: number;
  /** Gap between rows in px. */
  readonly gap?: number;
  /** Where the crew's pole sticks out: left on wide screens, down on a phone, or none. */
  readonly handle?: 'left' | 'bottom' | 'none';
  /**
   * How far the pole's end lies from the face's top-left corner, px: leftward for a `left` pole, downward for a
   * `bottom` one. Set past the screen edge, the board reads as held out from off screen.
   */
  readonly reach?: number;
}

/**
 * The title menu, held out like a pit board over the pit wall: an aluminium frame round a slate face with a chequer
 * header, slide rails, a white number plate per row (1, 2, 3: the keys that pick each row) and the crew's pole. The
 * buttons go in `content`, one per row, `rowHeight` tall and `gap` apart.
 * @param options - Size, rows and handle.
 */
export function pitBoardSvg(options: PitBoardOptions = {}): SvgArt {
  const w = options.width ?? 420;
  const rows = options.rows ?? 3;
  const rh = options.rowHeight ?? 60;
  const gap = options.gap ?? 14;
  const handle = options.handle ?? 'left';
  const frame = BOARD_FRAME;
  const header = BOARD_HEADER;
  const inner = 14;
  const nw = Math.round(rh * 0.74);
  const rowsH = rows * rh + (rows - 1) * gap;
  const h = frame * 2 + header + inner * 2 + rowsH;
  const left = handle === 'left';
  const pole = left ? (options.reach ?? 70) : handle === 'bottom' ? (options.reach ?? h + 70) - h : 0;
  const px = 18 + (left ? pole : 0);
  const py = 18;
  const d = new Draft();
  const t = 12;
  const ax = px + w * 0.5;
  const ay = py + h * 0.62;

  if (handle !== 'none') {
    const [x, y, bw, bh] = left ? [px - pole, ay - t / 2, pole + 10, t] : [ax - t / 2, py + h - 10, t, pole + 10];
    const across: [number, number, number, number] = left ? [0, y, 0, y + t] : [x, 0, x + t, 0];
    // Shaded across the tube, not along it, so it reads the same wherever the screen edge cuts it.
    const tube = d.lgrad(...across, [
      [0, STEEL.mid],
      [0.3, STEEL.hi],
      [1, STEEL.lo],
    ]);
    const box = `x="${n(x)}" y="${n(y)}" width="${n(bw)}" height="${n(bh)}"`;

    d.add(
      `<rect x="${n(x)}" y="${n(y + 4)}" width="${n(bw)}" height="${n(bh)}" fill="${COLORS.ink900}" opacity="0.5" ` +
        `filter="url(#${d.blur(4)})"/><rect ${box} fill="url(#${tube})"/>` +
        `<rect ${box} fill="none" stroke="${COLORS.ink900}" stroke-width="1.5"/>`,
    );
  }
  boardFrame(d, px, py, w, h);
  if (handle !== 'none') {
    // The pole's collar, bolted over the frame's edge: one steel part with the frame, not a loose stick.
    const collar = left
      ? chamferRect(px - 16, ay - t / 2 - 6, 19, t + 12, 3)
      : chamferRect(ax - t / 2 - 6, py + h - 3, t + 12, 19, 3);
    const [bx, by] = left ? [px - 7, ay] : [ax, py + h + 7];

    plate(d, collar, {
      face: [STEEL.hi, STEEL.mid],
      depth: 3,
      side: [STEEL.lo, STEEL.deep],
      rim: '#ffffff',
      rimOpacity: 0.9,
      gloss: 0.25,
      shadow: 0.5,
    });
    d.add(
      `<path d="${poly(collar)}" fill="none" stroke="${COLORS.ink900}" stroke-width="1.5"/>` +
        `<circle cx="${n(bx)}" cy="${n(by)}" r="2.6" fill="${STEEL.lo}" stroke="${COLORS.ink900}" stroke-width="1"/>`,
    );
  }
  const top = py + frame + header + inner;
  const nx = px + frame + inner;
  // One rail midway between rows, so no rail hugs a button.
  for (let i = 1; i < rows; i++) {
    const ry = top + i * (rh + gap) - gap / 2;

    d.add(
      `<path d="M${n(px + frame)} ${n(ry)}H${n(px + w - frame)}" stroke="#2f3866" stroke-width="2.5"/>` +
        `<path d="M${n(px + frame)} ${n(ry - 1)}H${n(px + w - frame)}" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1"/>`,
    );
  }

  for (let i = 0; i < rows; i++) {
    const y = top + i * (rh + gap);
    const tile = chamferRect(nx, y, nw, rh, [6, 2, 6, 2]);

    plate(d, tile, {
      face: ['#ffffff', '#cfd7ee'],
      depth: 3,
      side: ['#69769c', '#1d2340'],
      rim: '#ffffff',
      rimOpacity: 1,
      gloss: 0.3,
      shadow: 0.4,
    });
    const run = glyphRun(String(i + 1));
    const size = rh * 0.58;

    paintedLetters(
      d,
      run,
      { x: nx + (nw - runWidth(run, size, 0)) / 2, y: y + (rh - size) / 2, size, lean: 0 },
      COLORS.ink900,
    );
  }
  const cx = nx + nw + 14;
  return d.art(Math.ceil(w + 36 + (left ? pole : 0)), Math.ceil(h + 42 + (handle === 'bottom' ? pole : 0)), {
    content: { x: cx, y: top, w: px + w - frame - inner - cx, h: rowsH },
    face: { x: px, y: py, w, h },
  });
}
