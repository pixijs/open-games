import type { Text } from 'pixi.js';
import { Container, Sprite } from 'pixi.js';

import { RACERS } from '../art/tokens';
import type { HudRacer } from '../contract';
import { DigitReadout } from './DigitReadout';
import type { HudScene, HudServices } from './scene';
import { fit, hex, hudText, NAME, placeMiddle } from './text';

/**
 * The tag over another racer's truck: their colour block with their place, their name, and a pointer down to the
 * truck. It fades in close and far away.
 */
export class NameTag extends Container {
  /** The racer it follows; '' when free */
  public racerId = '';
  private readonly _body = new Container();
  private readonly _plate = new Sprite();
  private readonly _place = new DigitReadout(1);
  private readonly _name: Text;
  private readonly _services: HudServices;
  private _scene: HudScene | null = null;
  private _car = -1;
  private _placeShown = 0;
  private _nameShown = '';
  private _nameMax = 80;

  constructor(services: HudServices) {
    super();
    this._services = services;
    this._name = hudText(NAME, 13);
    this._body.addChild(this._plate, this._place, this._name);
    this.addChild(this._body);
    this.visible = false;
  }

  public layout(scene: HudScene): void {
    this._scene = scene;
    this._place.setFont(scene.heavy, scene.spec.tagH * 0.72);
    this._place.align = 'center';
    this._car = -1;
    this._nameShown = '';
  }

  /** Per frame: follows a racer; `x`, `y` is the pointer tip in box px */
  public follow(r: HudRacer, x: number, y: number, alpha: number): void {
    const scene = this._scene;

    if (!scene) return;
    this.racerId = r.id;
    this.visible = alpha > 0.01;
    this.alpha = alpha;
    this.position.set(x, y);
    if (r.car !== this._car) {
      this._car = r.car;
      const key = `tag${r.car}`;
      const art = scene.hud.art(key);
      const f = art.face ?? { x: 0, y: 0, w: art.width, h: art.height };
      const c = art.content ?? f;
      const ax = (art.anchor?.x ?? 0.5) * art.width;
      const ay = (art.anchor?.y ?? 1) * art.height;
      const h = scene.spec.tagH;

      this._plate.texture = scene.hud.texture(key);
      this._plate.position.set(-ax, -ay);
      this._place.tint = hex(RACERS[r.car].on);
      this._place.position.set(-ax + 9 + h / 2, -ay + c.y + h / 2 - this._place.size / 2);
      placeMiddle(this._name, -ax + c.x + 4, -ay + c.y + c.h / 2, 'left');
      this._nameMax = c.w - 8;
      this._nameShown = '';
    }
    if (r.place !== this._placeShown) {
      this._placeShown = r.place;
      this._place.showInt(r.place);
    }
    if (r.name !== this._nameShown) {
      this._nameShown = r.name;
      fit(this._name, r.name, 13, this._nameMax);
    }
  }

  /** Stops following */
  public free(): void {
    this.racerId = '';
    this.visible = false;
  }

  /** A single punch, when the spectate camera switches to this racer */
  public punch(): void {
    this._services.motion.punch(this._body, 1.25);
  }
}
