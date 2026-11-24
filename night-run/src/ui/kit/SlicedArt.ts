import type { DestroyOptions } from 'pixi.js';
import { NineSliceSprite, Texture } from 'pixi.js';

import type { SvgArt } from '../art/svg';
import { nineSlice } from '../art/svgTexture';
import type { SvgTextures } from '../art/svgTexture';

/**
 * Art drawn to stretch (panels, toasts, meter fills, scrims) on a `NineSliceSprite`, holding one texture reference.
 * Its size is the art's own until `width` and `height` are set; art without `slice` stretches whole.
 */
export class SlicedArt extends NineSliceSprite {
  public readonly loaded: Promise<void>;
  private readonly _art: SvgArt;
  private readonly _textures: SvgTextures;
  private readonly _density: number = 1;

  constructor(textures: SvgTextures, art: SvgArt, density: number, width = art.width, height = art.height) {
    super({
      texture: textures.peek(art, density) ?? Texture.EMPTY,
      ...nineSlice(art),
      width,
      height,
    });
    this._textures = textures;
    this._art = art;
    this._density = density;
    this.loaded = textures.load(art, density).then(
      (texture) => {
        if (!this.destroyed) this.texture = texture;
      },
      () => undefined,
    );
  }

  public get art(): SvgArt {
    return this._art;
  }

  public override destroy(options?: DestroyOptions): void {
    if (this.destroyed) return;
    this._textures.release(this._art, this._density);
    super.destroy(options);
  }
}
