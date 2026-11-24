import type { DestroyOptions, Texture } from 'pixi.js';
import { Sprite } from 'pixi.js';

import type { SvgArt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';

/**
 * A sprite showing one piece of SVG art at its own size. It holds one texture reference for the art it wants and,
 * while that art is still drawing, one for the art it shows, so a swap keeps the old texture alive and on screen until
 * the new one is up: a shared texture is never freed while this sprite draws it.
 */
export class ArtSprite extends Sprite {
  /** Resolves once the current art's texture is on the sprite */
  public loaded: Promise<void>;
  private _art: SvgArt;
  /** The art whose texture is on the sprite; null until the first one draws */
  private _shown: SvgArt | null = null;
  private readonly _textures: SvgTextures;
  private readonly _density: number = 1;

  constructor(textures: SvgTextures, art: SvgArt, density: number) {
    const ready = textures.peek(art, density);

    super(ready ?? undefined);
    this._textures = textures;
    this._density = density;
    this._art = art;
    this.loaded = this._load(art);
    if (ready) this._shown = art;
  }

  public get art(): SvgArt {
    return this._art;
  }

  /** Shows `art` in place of the current art. */
  public setArt(art: SvgArt): void {
    if (art.svg === this._art.svg) return;
    const wanted = this._art;

    this._art = art;
    if (wanted !== this._shown) this._textures.release(wanted, this._density);
    if (this._shown && art.svg === this._shown.svg) {
      this._art = this._shown;
      this.loaded = Promise.resolve();

      return;
    }
    const ready = this._textures.peek(art, this._density);

    this.loaded = this._load(art);
    if (ready) this._show(art, ready);
  }

  public override destroy(options?: DestroyOptions): void {
    if (this.destroyed) return;
    this._textures.release(this._art, this._density);
    if (this._shown && this._shown !== this._art) this._textures.release(this._shown, this._density);
    this._shown = null;
    super.destroy(options);
  }

  private _load(art: SvgArt): Promise<void> {
    return this._textures.load(art, this._density).then(
      (texture: Texture) => {
        if (!this.destroyed && this._art === art) this._show(art, texture);
      },
      () => undefined,
    );
  }

  /** Puts `art`'s texture on the sprite and lets go of the art it replaces. */
  private _show(art: SvgArt, texture: Texture): void {
    const prev = this._shown;

    this.texture = texture;
    this._shown = art;
    if (prev && prev !== art) this._textures.release(prev, this._density);
  }
}
