import row from './collab.svg?raw';
import { Draft } from './Draft';
import type { SvgArt } from './svg';
import { n } from './svg';

/** The row's own size, and its drawing without the root tag, so it can nest in other art. */
const [, ROW_WIDTH, ROW_HEIGHT] = /width="([\d.]+)" height="([\d.]+)"/.exec(row)!.map(Number);
const ROW_INNER = row.slice(row.indexOf('>') + 1, row.lastIndexOf('</svg>'));

/** Options for {@link collabSvg}. */
export interface CollabOptions {
  /** Height of the PixiJS logo, the row's tallest, in px. */
  readonly size?: number;
}

/**
 * Colyseus × PixiJS, as the row on the finish arch reads: `collab.svg`, which the loading screen shows too, on a soft
 * dark halo so it reads over the race. `face` is the row without the halo.
 * @param options - Its size.
 */
export function collabSvg(options: CollabOptions = {}): SvgArt {
  const size = options.size ?? 40;
  const width = (ROW_WIDTH * size) / ROW_HEIGHT;
  const pad = size * 0.35;
  const d = new Draft();
  const halo = d.def(
    'h',
    (id) =>
      `<filter id="${id}" x="-20%" y="-60%" width="140%" height="220%" color-interpolation-filters="sRGB">` +
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${n(size * 0.12)}" result="b"/>` +
      `<feColorMatrix in="b" values="0 0 0 0 0.02 0 0 0 0 0.03 0 0 0 0 0.12 0 0 0 0.9 0" result="s"/>` +
      `<feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
  );

  d.add(
    `<g filter="url(#${halo})"><svg x="${n(pad)}" y="${n(pad)}" width="${n(width)}" height="${n(size)}" ` +
      `viewBox="0 0 ${ROW_WIDTH} ${ROW_HEIGHT}">${ROW_INNER}</svg></g>`,
  );

  return d.art(width + pad * 2, size + pad * 2, { face: { x: pad, y: pad, w: width, h: size } });
}
