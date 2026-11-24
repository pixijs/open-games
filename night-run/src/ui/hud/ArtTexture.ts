import { Texture } from 'pixi.js';

import type { SvgArt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';

/**
 * One sprite's texture drawn from art on demand, for the HUD art that isn't in an atlas (the mini-map's track, a
 * toast's plate, the finish's numeral). A newer request supersedes an older one still drawing, the art on show is
 * released only once its replacement is up, and `clear` gives every reference back.
 */
export class ArtTexture {
  private readonly _textures: SvgTextures;
  private readonly _sprite: { texture: Texture };
  private _shown: SvgArt | null = null;
  private _shownScale = 1;
  private _pending: SvgArt | null = null;

  /**
   * @param textures - The game's rasteriser.
   * @param sprite - What shows it: a Sprite or a TilingSprite.
   */
  constructor(textures: SvgTextures, sprite: { texture: Texture }) {
    this._textures = textures;
    this._sprite = sprite;
  }

  /** Whether the sprite shows drawn art (not the empty texture) */
  public get ready(): boolean {
    return this._shown !== null && this._pending === null;
  }

  /**
   * Draws `art` and puts it on the sprite.
   * @param art - The art.
   * @param scale - Extra density, as for {@link SvgTextures.load}.
   * @returns Whether this art made it onto the sprite (false when a later request or `clear` came first).
   */
  public async set(art: SvgArt, scale = 1): Promise<boolean> {
    if (!this._pending && this._shown?.svg === art.svg && this._shownScale === scale) return true;
    this._pending = art;
    let texture: Texture;

    try {
      texture = await this._textures.load(art, scale);
    } catch {
      if (this._pending === art) this._pending = null;

      return false;
    }
    if (this._pending !== art) {
      this._textures.release(art, scale);

      return false;
    }
    this._pending = null;
    if (this._shown) this._textures.release(this._shown, this._shownScale);
    this._shown = art;
    this._shownScale = scale;
    this._sprite.texture = texture;

    return true;
  }

  /** Empties the sprite and releases the art. Idempotent */
  public clear(): void {
    this._pending = null;
    this._sprite.texture = Texture.EMPTY;
    if (this._shown) this._textures.release(this._shown, this._shownScale);
    this._shown = null;
  }
}
