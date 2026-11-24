import type { Texture } from 'pixi.js';
import { Rectangle, Sprite } from 'pixi.js';

import type { SvgArt } from '../art/svg';
import { faceOf } from './sprites';

/** The smallest hit area a HUD button gets, in box px */
const MIN_HIT = 48;

/**
 * A HUD button drawn from two textures, at rest and pressed. Its hit area is its face grown to at least 48 px, so the
 * 40 px pause button is still easy to hit.
 */
export class HudButton extends Sprite {
  private _idle: Texture | null = null;
  private _down: Texture | null = null;
  private _pressed = false;
  private readonly _onTap: () => void;

  /** @param onTap - Called on a tap or click. */
  constructor(onTap: () => void) {
    super();
    this._onTap = onTap;
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointerdown', this._onDown);
    this.on('pointerup', this._onUp);
    this.on('pointerupoutside', this._onCancel);
    this.on('pointercancel', this._onCancel);
  }

  /** Sets its art and puts its face's top-left on x, y */
  public setArt(art: SvgArt, idle: Texture, down: Texture, x: number, y: number): void {
    this._idle = idle;
    this._down = down;
    this.texture = this._pressed ? down : idle;
    const f = faceOf(art);
    const w = Math.max(MIN_HIT, f.w);
    const h = Math.max(MIN_HIT, f.h);

    this.hitArea = new Rectangle(f.x + (f.w - w) / 2, f.y + (f.h - h) / 2, w, h);
    this.position.set(x - f.x, y - f.y);
  }

  public override destroy(): void {
    this.off('pointerdown', this._onDown);
    this.off('pointerup', this._onUp);
    this.off('pointerupoutside', this._onCancel);
    this.off('pointercancel', this._onCancel);
    this._idle = null;
    this._down = null;
    super.destroy();
  }

  private readonly _onDown = (): void => {
    this._pressed = true;
    if (this._down) this.texture = this._down;
  };

  private readonly _onUp = (): void => {
    if (!this._pressed) return;
    this._onCancel();
    this._onTap();
  };

  private readonly _onCancel = (): void => {
    this._pressed = false;
    if (this._idle) this.texture = this._idle;
  };
}
