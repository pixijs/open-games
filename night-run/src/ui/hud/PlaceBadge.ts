import type { Text } from 'pixi.js';
import { Container, Sprite, Texture } from 'pixi.js';

import type { HudScene, HudServices } from './scene';
import { faceOf } from './sprites';
import { BOARD_800, hudText, place, resize } from './text';

/**
 * Your place, top left: the place numeral in its metal (`ordinalSvg`) and, on desktop, `/4` on its baseline. A change
 * flips it: the old numeral drops and fades, the new one rises and punches in; a lost place also shakes.
 */
export class PlaceBadge extends Container {
  private readonly _now = new Sprite();
  private readonly _old = new Sprite();
  private readonly _of: Text;
  private readonly _textures: Texture[] = [];
  private readonly _services: HudServices;
  private _place = 0;
  private _count = 0;
  private _homeX = 0;
  private _homeY = 0;
  private _shake = 0;

  constructor(services: HudServices) {
    super();
    this._services = services;
    this._of = hudText(BOARD_800, 30);
    this._of.alpha = 0.8;
    this._old.visible = false;
    this.addChild(this._old, this._now, this._of);
  }

  public layout(scene: HudScene): void {
    const { box, hud } = scene;
    const art = hud.art('ord1');
    const f = faceOf(art);
    const d = box.kind === 'desktop';
    const x = box.safe.left + (d ? 4 : box.kind === 'portrait' ? 2 : 0);
    const y = box.safe.top + (d ? 6 : 2);

    this._textures.length = 0;
    for (let p = 1; p <= 4; p++) this._textures.push(hud.texture(`ord${p}`));
    this._homeX = x + f.w / 2;
    this._homeY = y + f.h / 2;
    for (const s of [this._now, this._old]) {
      s.anchor.set((f.x + f.w / 2) / art.width, (f.y + f.h / 2) / art.height);
      s.position.set(this._homeX, this._homeY);
    }
    if (this._place) this._now.texture = this._textures[this._place - 1];
    this._old.texture = Texture.EMPTY;
    this._old.visible = false;
    this._of.visible = d;
    resize(this._of, 30);
    place(this._of, box.safe.left + 8 + f.w, box.safe.top + 58);
  }

  /**
   * Shows a place.
   * @param value - 1 to 4.
   * @param count - Racers in the race.
   * @param animate - Flip to it rather than set it.
   */
  public setPlace(value: number, count: number, animate: boolean): void {
    if (count !== this._count) {
      this._count = count;
      this._of.text = `/${count}`;
    }
    if (value === this._place || value < 1) return;
    const was = this._place;

    this._place = value;
    const motion = this._services.motion;

    if (!animate || !was || this._textures.length === 0) {
      motion.kill(this._now, this._now.scale, this._now.position);
      if (this._textures.length) this._now.texture = this._textures[value - 1];
      this._now.alpha = 1;
      this._now.scale.set(1);
      this._now.position.set(this._homeX, this._homeY);

      return;
    }
    this._old.texture = this._textures[was - 1];
    this._old.visible = true;
    this._old.alpha = 1;
    this._old.position.set(this._homeX, this._homeY);
    this._old.scale.set(1);
    motion.kill(this._old, this._old.position);
    motion.to(this._old.position, { y: this._homeY + 12, duration: 0.15, ease: 'power2.in' });
    motion.to(this._old, { alpha: 0, duration: 0.15, ease: 'power1.in', onComplete: this._hideOld });
    this._now.texture = this._textures[value - 1];
    if (motion.reduced) {
      motion.fadeIn(this._now);
    } else {
      motion.kill(this._now, this._now.position);
      this._now.position.set(this._homeX, this._homeY + 20);
      this._now.alpha = 0;
      motion.to(this._now.position, { y: this._homeY, duration: 0.32, ease: 'back.out(1.7)', delay: 0.05 });
      motion.to(this._now, { alpha: 1, duration: 0.12, delay: 0.05 });
      motion.punch(this._now, value < was ? 1.35 : 1.15, 0.05);
    }
    if (value > was) this._shake = 0.25;
  }

  /** Per frame: the lost-place shake */
  public update(dt: number): void {
    if (this._shake <= 0) return;
    this._shake = Math.max(0, this._shake - dt);
    const amp = this._services.motion.reduced ? 0 : 3 * (this._shake / 0.25);

    this._now.x = this._homeX + Math.sin(this._shake * 90) * amp;
  }

  private readonly _hideOld = (): void => {
    this._old.visible = false;
  };
}
