import type { Text } from 'pixi.js';
import { Container, Sprite, Texture } from 'pixi.js';

import { RACERS } from '../art/tokens';
import type { HudFrame } from '../contract';
import { DigitReadout } from './DigitReadout';
import type { HudScene, HudServices } from './scene';
import { atFace } from './sprites';
import { BOARD_700, CYAN, fit, hex, hudText, MIST, NAME, place, WHITE } from './text';

const ROW_GAP = 34;
const NAME_MAX = 118;

interface Row {
  readonly view: Container;
  readonly plate: Sprite;
  readonly place: DigitReadout;
  readonly stripe: Sprite;
  readonly name: Text;
  readonly gap: DigitReadout;
  readonly leader: Text;
  shownName: string;
  shownPlace: number;
  shownCar: number;
  shownYou: boolean;
}

/**
 * The desktop timing tower under the place: one row per racer, place, colour stripe, name and gap to the leader.
 * Rows belong to racer slots, not places, so a pass slides two rows past each other instead of rewriting them.
 */
export class TimingTower extends Container {
  private readonly _rows: Row[] = [];
  private readonly _services: HudServices;

  constructor(services: HudServices) {
    super();
    this._services = services;
    for (let i = 0; i < 4; i++) {
      const view = new Container();
      const plate = new Sprite();
      const placeDigits = new DigitReadout(1);
      const stripe = new Sprite(Texture.WHITE);
      const name = hudText(NAME, 15);
      const gap = new DigitReadout(9);
      const leader = hudText(BOARD_700, 17, MIST, 'Leader');

      gap.align = 'right';
      gap.tint = MIST;
      stripe.width = 5;
      stripe.height = 18;
      stripe.skew.x = -0.21;
      view.addChild(plate, placeDigits, stripe, name, gap, leader);
      view.visible = false;
      this.addChild(view);
      this._rows.push({
        view,
        plate,
        place: placeDigits,
        stripe,
        name,
        gap,
        leader,
        shownName: '',
        shownPlace: 0,
        shownCar: -1,
        shownYou: false,
      });
    }
  }

  public layout(scene: HudScene): void {
    const { box, hud } = scene;

    this.visible = scene.spec.tower;
    if (!scene.spec.tower) return;
    this.position.set(box.safe.left, box.safe.top + 112);
    for (const row of this._rows) {
      row.plate.texture = hud.texture('row');
      atFace(row.plate, hud.art('row'), 0, 0);
      row.place.setFont(scene.heavy, 22);
      row.place.position.set(12, 5);
      row.stripe.position.set(36, 6);
      place(row.name, 48, 7);
      row.gap.setFont(scene.light, 17);
      row.gap.position.set(226, 8);
      place(row.leader, 226, 8, 'right');
      if (row.shownPlace) row.view.y = (row.shownPlace - 1) * ROW_GAP;
    }
  }

  /** Per frame: names, places and gaps */
  public update(frame: HudFrame, animate: boolean): void {
    if (!this.visible) return;
    for (let i = 0; i < this._rows.length; i++) {
      const row = this._rows[i];
      const r = frame.racers[i];

      if (!r || !r.active) {
        row.view.visible = false;
        row.shownPlace = 0;
        continue;
      }
      row.view.visible = true;
      if (r.name !== row.shownName) {
        row.shownName = r.name;
        fit(row.name, r.name, 15, NAME_MAX);
      }
      if (r.car !== row.shownCar) {
        row.shownCar = r.car;
        row.stripe.tint = hex(RACERS[r.car].main);
      }
      if (r.isYou !== row.shownYou) {
        row.shownYou = r.isYou;
        row.name.tint = r.isYou ? CYAN : WHITE;
        row.place.tint = r.isYou ? CYAN : WHITE;
        row.plate.alpha = r.isYou ? 1 : 0.92;
      }
      if (r.place !== row.shownPlace) {
        const y = (r.place - 1) * ROW_GAP;
        const motion = this._services.motion;

        motion.kill(row.view.position);
        if (r.isYou || r.place < row.shownPlace) this.addChild(row.view);
        if (animate && row.shownPlace && !motion.reduced) {
          motion.to(row.view.position, { y, duration: 0.32, ease: 'back.out(1.7)' });
        } else row.view.y = y;
        row.shownPlace = r.place;
        row.place.showInt(r.place);
      }
      const leads = r.place === 1;

      row.leader.visible = leads;
      row.gap.visible = !leads;
      if (!leads) row.gap.showDelta(r.gap);
    }
  }
}
