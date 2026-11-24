import type { Text } from 'pixi.js';
import { Container, Sprite } from 'pixi.js';

import type { HudFrame } from '../contract';
import { DigitReadout } from './DigitReadout';
import type { HudScene, HudServices } from './scene';
import { atFace, faceOf } from './sprites';
import { AMBER, BOARD_700, hudText, LABEL, MIST, place, resize, WHITE } from './text';

/**
 * The timing plate, top right on desktop and portrait (beside the place in landscape): the lap counter, the race time,
 * the current lap's time (desktop) and your best lap, with a gold star by the best for the lap after a record. The
 * counter punches on each lap and turns amber on the final lap.
 */
export class TimingPlate extends Container {
  /** Where the plate's face sits, in box px, for the parts placed beside it */
  public readonly face = { x: 0, y: 0, w: 0, h: 0 };
  private readonly _plate = new Sprite();
  private readonly _lapLabel: Text;
  private readonly _raceLabel: Text;
  private readonly _lapTimeLabel: Text;
  private readonly _bestLabel: Text;
  private readonly _bestWord: Text;
  private readonly _counterBox = new Container();
  private readonly _counter = new DigitReadout(5);
  private readonly _race = new DigitReadout(8);
  private readonly _lapTime = new DigitReadout(8);
  private readonly _best = new DigitReadout(8);
  private readonly _star = new Sprite();
  private readonly _services: HudServices;
  private _desktop = false;
  private _starFaceX = 0;
  private _counterX = 0;
  private _counterY = 0;
  private _lap = -1;
  private _laps = -1;
  private _bestShown = -1;
  private _final = false;

  constructor(services: HudServices) {
    super();
    this._services = services;
    this._lapLabel = hudText(LABEL, 13, MIST, 'Lap');
    this._raceLabel = hudText(LABEL, 13, MIST, 'Race');
    this._lapTimeLabel = hudText(LABEL, 13, MIST, 'Lap');
    this._bestLabel = hudText(LABEL, 13, MIST, 'Best');
    this._bestWord = hudText(BOARD_700, 16, WHITE, 'Best');
    this._bestWord.alpha = 0.8;
    this._lapTime.tint = MIST;
    this._star.visible = false;
    this._counterBox.addChild(this._counter);
    this.addChild(
      this._plate,
      this._lapLabel,
      this._raceLabel,
      this._lapTimeLabel,
      this._bestLabel,
      this._bestWord,
      this._counterBox,
      this._race,
      this._lapTime,
      this._best,
      this._star,
    );
  }

  public layout(scene: HudScene): void {
    const { box, spec, hud } = scene;
    const kind = box.kind;
    const art = hud.art('plate');
    const f = faceOf(art);
    const x = kind === 'landscape' ? box.safe.left + 120 : box.width - box.safe.right - spec.plateW;
    const y = box.safe.top;

    this._desktop = kind === 'desktop';
    this.face.x = x;
    this.face.y = y;
    this.face.w = f.w;
    this.face.h = f.h;
    this._plate.texture = hud.texture('plate');
    atFace(this._plate, art, x, y);
    this._star.texture = hud.texture('star');
    const starArt = hud.art('star');

    this._starFaceX = faceOf(starArt).x;
    const labelSize = this._desktop ? 13 : 12;

    resize(this._lapLabel, labelSize);
    resize(this._raceLabel, labelSize);
    resize(this._lapTimeLabel, labelSize);
    this._bestLabel.visible = this._desktop;
    this._bestWord.visible = !this._desktop;
    this._lapTimeLabel.visible = this._desktop;
    this._lapTime.visible = this._desktop;
    if (this._desktop) {
      place(this._lapLabel, x + 18, y + 14);
      this._counter.setFont(scene.heavy, 52);
      this._counterX = x + 18;
      this._counterY = y + 30;
      place(this._raceLabel, x + 130, y + 14);
      this._race.setFont(scene.heavy, 30);
      this._race.position.set(x + 130, y + 30);
      place(this._lapTimeLabel, x + 130, y + 70);
      this._lapTime.setFont(scene.light, 24);
      this._lapTime.position.set(x + 130, y + 86);
      place(this._bestLabel, x + 18, y + 92);
      this._best.setFont(scene.light, 24);
      this._best.alpha = 1;
      this._best.position.set(x + 52, y + 86);
      this._star.scale.set(1);
      atFace(this._star, starArt, x + 110, y + 87);
    } else {
      const p = kind === 'portrait';
      const col = p ? 78 : 74;
      const top = p ? 9 : 7;
      const bestY = y + (p ? 50 : 42);

      place(this._lapLabel, x + 12, y + top);
      this._counter.setFont(scene.heavy, p ? 32 : 30);
      this._counterX = x + 12;
      this._counterY = y + (p ? 24 : 21);
      place(this._raceLabel, x + col, y + top);
      this._race.setFont(scene.heavy, p ? 22 : 21);
      this._race.position.set(x + col, y + (p ? 24 : 21));
      resize(this._bestWord, p ? 16 : 14);
      place(this._bestWord, x + col, bestY);
      this._best.setFont(scene.light, p ? 16 : 14);
      this._best.alpha = 0.8;
      this._best.position.set(x + col + this._bestWord.width + 3, bestY);
      this._star.scale.set(0.7);
      atFace(this._star, starArt, x + col - 16, bestY + 1);
      this._star.x += this._starFaceX * 0.3;
    }
    this._lap = -1;
    this._bestShown = -1;
  }

  /** Per frame: the counter and the clocks */
  public update(frame: HudFrame): void {
    if (frame.lap !== this._lap || frame.laps !== this._laps) {
      this._lap = frame.lap;
      this._laps = frame.laps;
      const c = this._counter;

      c.showFraction(Math.max(1, Math.min(frame.lap, frame.laps)), frame.laps);
      c.position.set(-c.textWidth / 2, -c.size / 2);
      this._counterBox.position.set(this._counterX + c.textWidth / 2, this._counterY + c.size / 2);
    }
    this._race.showTime(frame.raceTime);
    if (this._desktop) this._lapTime.showTime(frame.raceTime < 0 ? 0 : frame.lapTime);
    if (frame.bestLap !== this._bestShown) {
      this._bestShown = frame.bestLap;
      if (frame.bestLap > 0) this._best.showTime(frame.bestLap);
      else this._best.showNoTime();
    }
  }

  /** The counter punches from 1.3x; amber from the final lap on */
  public punchLap(final: boolean): void {
    this.setFinal(final);
    this._services.motion.punch(this._counterBox, 1.3);
  }

  /** Amber counter on the final lap */
  public setFinal(final: boolean): void {
    if (final === this._final) return;
    this._final = final;
    this._counter.tint = final ? AMBER : WHITE;
  }

  /** The gold star by the best lap, after a record, until the next lap */
  public showStar(on: boolean): void {
    if (on && !this._star.visible) this._services.motion.punch(this._star, 1.8, 0, this._star.scale.x);
    this._star.visible = on;
  }

  /** Back to a race's start: white counter, no star */
  public reset(): void {
    this.setFinal(false);
    this._star.visible = false;
  }
}
