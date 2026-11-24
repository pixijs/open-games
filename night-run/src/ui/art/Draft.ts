import { Ids } from './Ids';
import type { Stop, SvgArt } from './svg';
import { doc, n } from './svg';

/** Collects `<defs>` children and body markup while a piece of art is built. */
export class Draft {
  public readonly ids = new Ids();
  public defs = '';
  public body = '';

  /** Adds a def and returns its id. */
  public def(prefix: string, make: (id: string) => string): string {
    const id = this.ids.get(prefix);

    this.defs += make(id);

    return id;
  }

  /** Appends body markup. */
  public add(markup: string): this {
    this.body += markup;

    return this;
  }

  /** Finishes the document. */
  public art(width: number, height: number, extra?: Pick<SvgArt, 'slice' | 'anchor' | 'content' | 'face'>): SvgArt {
    return { svg: doc(width, height, this.defs, this.body), width, height, ...extra };
  }

  /** A vertical linear gradient across `y0` to `y1` in user space; stops are `[offset 0 to 1, colour, opacity?]`. */
  public vgrad(y0: number, y1: number, stops: Stop[]): string {
    return this.lgrad(0, y0, 0, y1, stops);
  }

  /** A linear gradient in user space. */
  public lgrad(x1: number, y1: number, x2: number, y2: number, stops: Stop[]): string {
    return this.def(
      'g',
      (id) =>
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" ` +
        `y2="${n(y2)}">${stopsMarkup(stops)}</linearGradient>`,
    );
  }

  /** A radial gradient in user space. */
  public rgrad(cx: number, cy: number, r: number, stops: Stop[], fy?: number): string {
    return this.def(
      'r',
      (id) =>
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}"` +
        (fy !== undefined ? ` fx="${n(cx)}" fy="${n(fy)}"` : '') +
        `>${stopsMarkup(stops)}</radialGradient>`,
    );
  }

  /** A Gaussian blur filter with room for the blur to spread. */
  public blur(std: number): string {
    return this.def(
      'f',
      (id) =>
        `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">` +
        `<feGaussianBlur stdDeviation="${n(std)}"/></filter>`,
    );
  }

  /** A clip path from path data. */
  public clip(d: string): string {
    return this.def('c', (id) => `<clipPath id="${id}"><path d="${d}"/></clipPath>`);
  }
}

function stopsMarkup(stops: Stop[]): string {
  return stops
    .map(([o, c, a]) => `<stop offset="${n(o)}" stop-color="${c}"${a === undefined ? '' : ` stop-opacity="${n(a)}"`}/>`)
    .join('');
}
