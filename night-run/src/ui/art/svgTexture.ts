import { ImageSource, Texture } from 'pixi.js';

import type { SvgArt } from './svg';

interface Entry {
  readonly token: symbol;
  refs: number;
  texture: Texture | null;
  bitmap: ImageBitmap | null;
  readonly promise: Promise<Texture>;
}

/** FNV-1a over the markup: a short, stable cache key for a piece of art. */
function hash(text: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0).toString(36);
}

/**
 * Rasterises SVG art into pixi textures at the display's resolution, cached by the art's markup and counted by
 * reference: `load` adds a reference, `release` drops one and frees the texture when none are left, `destroy`
 * frees everything. An SVG drawn as an image can't load web fonts, which is why the art is text-free and the words are
 * pixi Text.
 *
 * Each texture is drawn once through a throwaway canvas and kept as an `ImageBitmap`, so no canvas backing store
 * stays alive (iOS caps the total).
 * @example
 * const textures = new SvgTextures(window.devicePixelRatio);
 * const art = buttonSvg({ width: 280, variant: 'primary' });
 * const face = new NineSliceSprite({ texture: await textures.load(art), ...nineSlice(art) });
 *
 * // when the screen closes
 * textures.release(art);
 */
export class SvgTextures {
  /** Device pixels per CSS px the art is drawn at. */
  public readonly resolution: number = 1;
  private readonly _entries = new Map<string, Entry>();
  private _destroyed = false;

  /** @param resolution - Device pixels per CSS px: the display's, not the governed renderer's. */
  constructor(resolution: number) {
    this.resolution = resolution;
  }

  /** How many textures are alive. */
  public get size(): number {
    return this._entries.size;
  }

  /**
   * The texture for `art`, drawn on first use, adding one reference.
   * @param art - The art.
   * @param scale - Extra density for art shown scaled up (a countdown numeral punched in at 1.6x); the texture keeps
   * the art's CSS size, so sprites stay the same size.
   */
  public load(art: SvgArt, scale = 1): Promise<Texture> {
    const key = this._key(art, scale);
    const hit = this._entries.get(key);

    if (hit) {
      hit.refs++;

      return hit.promise;
    }
    const token = Symbol(key);
    const promise = this._draw(art, this.resolution * scale).then(
      ({ texture, bitmap }) => {
        const live = this._entries.get(key);

        if (this._destroyed || live?.token !== token) {
          bitmap.close();

          return Texture.EMPTY;
        }
        live.texture = texture;
        live.bitmap = bitmap;

        return texture;
      },
      (error: unknown) => {
        if (this._entries.get(key)?.token === token) this._entries.delete(key);
        throw error;
      },
    );

    this._entries.set(key, { token, refs: 1, texture: null, bitmap: null, promise });

    return promise;
  }

  /** Loads several pieces of art at once, one reference each. */
  public loadAll(arts: readonly SvgArt[], scale = 1): Promise<Texture[]> {
    return Promise.all(arts.map((art) => this.load(art, scale)));
  }

  /** The texture for `art` if it has finished drawing, without adding a reference. */
  public peek(art: SvgArt, scale = 1): Texture | null {
    return this._entries.get(this._key(art, scale))?.texture ?? null;
  }

  /** Drops one reference to `art`; the last one frees its texture. */
  public release(art: SvgArt, scale = 1): void {
    const key = this._key(art, scale);
    const entry = this._entries.get(key);

    if (!entry || --entry.refs > 0) return;
    this._entries.delete(key);
    this._free(entry);
  }

  /** Frees every texture whatever its references. Idempotent. */
  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const entry of this._entries.values()) this._free(entry);
    this._entries.clear();
  }

  /**
   * Frees an entry's GPU texture and bitmap. The source is unloaded rather than destroyed: pixi's batcher keeps every
   * texture it has drawn in a cached bind group, and a destroyed source still bound there warns on WebGPU. An unloaded
   * one leaves no GPU memory and no renderer GC entry behind.
   */
  private _free(entry: Entry): void {
    entry.texture?.source.unload();
    entry.bitmap?.close();
    entry.texture = null;
    entry.bitmap = null;
  }

  private _key(art: SvgArt, scale: number): string {
    return `${hash(art.svg)}.${art.svg.length}@${scale}`;
  }

  private async _draw(art: SvgArt, resolution: number): Promise<{ texture: Texture; bitmap: ImageBitmap }> {
    const image = new Image();

    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(art.svg)}`;
    await image.decode();
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, Math.ceil(art.width * resolution));
    canvas.height = Math.max(1, Math.ceil(art.height * resolution));
    const ctx = canvas.getContext('2d');

    if (!ctx) throw new Error('SvgTextures: no 2D canvas context');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const bitmap = await createImageBitmap(canvas);

    canvas.width = 0;
    canvas.height = 0;
    const source = new ImageSource({ resource: bitmap, resolution, alphaMode: 'premultiply-alpha-on-upload' });

    return { texture: new Texture({ source }), bitmap };
  }
}

/** `NineSliceSprite` options from art drawn to stretch; empty when the art has no slice. */
export function nineSlice(art: SvgArt): {
  leftWidth: number;
  topHeight: number;
  rightWidth: number;
  bottomHeight: number;
} {
  const s = art.slice ?? { left: 0, top: 0, right: 0, bottom: 0 };

  return { leftWidth: s.left, topHeight: s.top, rightWidth: s.right, bottomHeight: s.bottom };
}
