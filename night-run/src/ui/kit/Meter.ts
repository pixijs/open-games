import { Container } from 'pixi.js';

import { meterSvg } from '../art/hud';
import { ArtSprite } from './ArtSprite';
import type { UiKit } from './kit';
import { SlicedArt } from './SlicedArt';

/**
 * A draining meter: the recessed track and its lit fill, one stretched texture, so setting the fraction every frame
 * costs nothing. Its origin is the track face's top-left.
 */
export class Meter extends Container {
  private readonly _fill: SlicedArt;
  private readonly _pad: number = 0;
  private readonly _span: number = 0;
  private readonly _min: number = 0;
  private _frac = -1;

  constructor(kit: UiKit, w: number, h: number, color: string, frac = 1) {
    super();
    const track = meterSvg('track', { width: w, height: h });
    const fillArt = meterSvg('fill', { width: w - 4, height: h - 4, color });
    const tf = track.face!;
    const tc = track.content!;
    const bg = new ArtSprite(kit.textures, track, kit.layout.density);

    bg.position.set(-tf.x, -tf.y);
    this._pad = fillArt.face!.x;
    this._span = w - 4;
    this._min = h;
    this._fill = new SlicedArt(kit.textures, fillArt, kit.layout.density);
    this._fill.position.set(tc.x - tf.x - this._pad, tc.y - tf.y - this._pad);
    this.addChild(bg, this._fill);
    this.set(frac);
  }

  public get loaded(): Promise<void> {
    return this._fill.loaded;
  }

  /** Shows `frac` (0 to 1) of the meter lit. */
  public set(frac: number): void {
    const f = Math.min(1, Math.max(0, frac));

    if (f === this._frac) return;
    this._frac = f;
    this._fill.visible = f > 0;
    this._fill.width = Math.max(this._min, Math.round(this._span * f)) + this._pad * 2;
  }
}
