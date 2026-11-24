import { Rectangle, Texture } from 'pixi.js';

import type { SvgArt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';

/** Longest side of a page in device px; phones take 4096 */
const MAX_PAGE_PX = 4096;
/** Empty px round every piece so linear filtering never reads a neighbour */
const GAP = 3;

interface Placed<K> {
  readonly key: K;
  readonly art: SvgArt;
  x: number;
  y: number;
  page: number;
}

/**
 * Packs many pieces of HUD art into as few textures as possible: each page is one SVG made of the pieces nested at
 * their packed spots, rasterised once through {@link SvgTextures}, and each piece becomes a frame of it. A whole HUD
 * layout costs one or two textures, so sprites from it batch into one draw call and the GPU holds one allocation.
 */
export class HudAtlas<K extends string> {
  /** Resolves once every page has been drawn */
  public readonly ready: Promise<void>;
  private readonly _textures: SvgTextures;
  private readonly _scale: number = 1;
  private readonly _pages: SvgArt[] = [];
  private readonly _frames = new Map<K, Texture>();
  private readonly _arts: Readonly<Record<K, SvgArt>>;
  private _destroyed = false;

  /**
   * @param textures - The game's shared rasteriser.
   * @param arts - The pieces, by key.
   * @param scale - Extra density for a layout drawn scaled up.
   */
  constructor(textures: SvgTextures, arts: Readonly<Record<K, SvgArt>>, scale: number) {
    this._textures = textures;
    this._scale = scale;
    this._arts = arts;
    const placed = this._pack(Object.keys(arts) as K[]);

    this.ready = textures.loadAll(this._pages, scale).then((pageTextures) => {
      if (this._destroyed) return;
      for (const p of placed) {
        const frame = new Rectangle(p.x, p.y, p.art.width, p.art.height);

        this._frames.set(p.key, new Texture({ source: pageTextures[p.page].source, frame }));
      }
    });
  }

  /** How many GPU textures the atlas holds */
  public get pageCount(): number {
    return this._pages.length;
  }

  /** The frame for `key`, or the empty texture until the pages are drawn */
  public texture(key: K): Texture {
    return this._frames.get(key) ?? Texture.EMPTY;
  }

  /** The art a key was drawn from, for its face, anchor and content boxes */
  public art(key: K): SvgArt {
    return this._arts[key];
  }

  /** Maps each of this atlas's frames to the same piece in `next` (the empty texture where `next` has none) */
  public mapTo(next: HudAtlas<K>, swap: Map<Texture, Texture>): void {
    for (const [key, frame] of this._frames) swap.set(frame, next.texture(key));
  }

  /** Frees the frames and drops the atlas's references to its pages. Idempotent */
  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const frame of this._frames.values()) frame.destroy(false);
    this._frames.clear();
    for (const page of this._pages) this._textures.release(page, this._scale);
    this._pages.length = 0;
  }

  private _pack(keys: K[]): Placed<K>[] {
    const maxSide = Math.floor(MAX_PAGE_PX / (this._textures.resolution * this._scale));
    const items: Placed<K>[] = keys.map((key) => ({ key, art: this._arts[key], x: 0, y: 0, page: 0 }));

    items.sort((a, b) => b.art.height - a.art.height);
    let area = 0;
    let widest = 0;

    for (const it of items) {
      area += (Math.ceil(it.art.width) + GAP) * (Math.ceil(it.art.height) + GAP);
      widest = Math.max(widest, Math.ceil(it.art.width) + GAP * 2);
    }
    const pageW = Math.min(maxSide, Math.max(widest, Math.ceil(Math.sqrt(area) * 1.12)));
    const bodies: string[] = [''];
    const heights: number[] = [0];
    let x = GAP;
    let y = GAP;
    let row = 0;
    let page = 0;

    items.forEach((it, i) => {
      const w = Math.ceil(it.art.width);
      const h = Math.ceil(it.art.height);

      if (x + w + GAP > pageW) {
        x = GAP;
        y += row + GAP;
        row = 0;
      }
      if (y + h + GAP > maxSide) {
        page++;
        bodies.push('');
        heights.push(0);
        x = GAP;
        y = GAP;
        row = 0;
      }
      it.x = x;
      it.y = y;
      it.page = page;
      bodies[page] += nest(it.art.svg, x, y, `a${i}_`);
      heights[page] = Math.max(heights[page], y + h + GAP);
      x += w + GAP;
      row = Math.max(row, h);
    });
    bodies.forEach((body, i) => {
      const h = heights[i];

      this._pages.push({
        svg:
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${pageW}" ` +
          `height="${h}" viewBox="0 0 ${pageW} ${h}">${body}</svg>`,
        width: pageW,
        height: h,
      });
    });

    return items;
  }
}

/** One document nested into a page at x, y, with its ids prefixed so gradients and filters don't collide */
function nest(svg: string, x: number, y: number, prefix: string): string {
  return svg
    .replace('<svg ', `<svg x="${x}" y="${y}" `)
    .replace(/id="/g, `id="${prefix}`)
    .replace(/url\(#/g, `url(#${prefix}`)
    .replace(/href="#/g, `href="#${prefix}`);
}
