import type { Text } from 'pixi.js';
import { Container, Sprite, Texture, TilingSprite } from 'pixi.js';

import { chequerSvg } from '../art/motifs';
import { ordinalSvg } from '../art/numerals';
import type { SvgTextures } from '../art/svgTexture';
import { ArtTexture } from './ArtTexture';
import type { HudScene, HudServices } from './scene';
import { atFace, faceOf } from './sprites';
import { BOARD_800, BOARD_900, CYAN, hudText, INK, place, placeMiddle, resize } from './text';

const CONFETTI = 96;
const GRAVITY = 900;
const LIFE = 2.8;
/** Seconds after the finish the FINISHED plate slams down: right behind the chequer's leading edge */
const SLAM_AT = 0.12;
const SLAM_DURATION = 0.2;

/**
 * Box px from the safe top to the FINISHED plate: under the top row's plates, and on a phone where the map was. In
 * landscape the place beside the plate stands taller than it, so the row starts low enough for the place's top to clear
 * the timing plate.
 */
const PLATE_TOP = { desktop: 52, portrait: 84, landscape: 80 } as const;
/** Box px between the plate and the place under it (or beside it, in landscape) */
const GAP = 12;
/** A place numeral's extruded depth, as a share of its size (`ordinalSvg`) */
const ORDINAL_DEPTH = 0.075;

/**
 * Your finish: a chequered band wipes across the screen and dims it, the FINISHED plate slams down from 1.3x with a
 * white flash and a jolt, your place punches in big under it and a glint sweeps it, then your time. A win fires a
 * big burst of confetti in your colour from the place and from both bottom corners.
 *
 * The photo finish holds your truck's middle at 0.6 to 0.7 of the height, so all of it stays in the top 55 %: stacked
 * down from the top on desktop and in portrait, and in one row (place, then plate, the time under the plate) on a
 * phone in landscape, where the screen is too short for a stack.
 */
export class FinishView extends Container {
  private readonly _dim = new Sprite(Texture.WHITE);
  private readonly _wipe = new TilingSprite();
  private readonly _plate = new Container();
  private readonly _plateSprite = new Sprite();
  private readonly _word: Text;
  private readonly _ordinalBox = new Container();
  private readonly _ordinal = new Sprite();
  private readonly _ordinalMask = new Sprite();
  private readonly _glint = new Sprite();
  private readonly _flash = new Sprite(Texture.WHITE);
  private readonly _time: Text;
  private readonly _confetti: Sprite[] = [];
  private readonly _state = new Float32Array(CONFETTI * 7);
  private readonly _services: HudServices;
  private readonly _ordinalTexture: ArtTexture;
  private readonly _chequerTexture: ArtTexture;
  private _scene: HudScene | null = null;
  private _ordinalDue = false;
  private _plateX = 0;
  private _plateY = 0;
  private _timeX = 0;
  private _timeY = 0;
  /** Width of the place numeral's face, box px, for the landscape row */
  private _ordinalW = 0;
  private _flying = 0;
  private _won = false;
  /** Called as the FINISHED plate lands, so the HUD can jolt */
  public onSlam: (() => void) | null = null;

  constructor(services: HudServices, textures: SvgTextures) {
    super();
    this._services = services;
    this._ordinalTexture = new ArtTexture(textures, this._ordinal);
    this._chequerTexture = new ArtTexture(textures, this._wipe);
    this._dim.tint = INK;
    this._word = hudText({ ...BOARD_900, spacing: 2 }, 50, 0xffffff, 'FINISHED');
    this._time = hudText(BOARD_800, 30);
    this._ordinal.anchor.set(0.5);
    this._ordinalMask.anchor.set(0.5);
    this._ordinalMask.renderable = false;
    this._glint.anchor.set(0.5);
    this._glint.visible = false;
    this._flash.visible = false;
    this._ordinalBox.visible = false;
    this._ordinalBox.addChild(this._ordinal, this._ordinalMask, this._glint);
    this._plate.addChild(this._plateSprite, this._word);
    this.addChild(this._dim, this._wipe, this._plate, this._ordinalBox, this._time, this._flash);
    for (let i = 0; i < CONFETTI; i++) {
      const c = new Sprite();

      c.anchor.set(0.5);
      c.visible = false;
      this._confetti.push(c);
      this.addChild(c);
    }
    this.visible = false;
  }

  public layout(scene: HudScene): void {
    this._scene = scene;
    const { box, sizes, callouts } = scene;
    const art = callouts.art('finish');
    const f = faceOf(art);
    const c = art.content ?? f;

    this._dim.width = box.width;
    this._dim.height = box.height;
    this._plateSprite.texture = callouts.texture('finish');
    atFace(this._plateSprite, art, -sizes.finishW / 2, -sizes.finishH / 2);
    resize(this._word, Math.round(sizes.finishH * 0.42));
    placeMiddle(this._word, this._plateSprite.x + c.x + c.w / 2, this._plateSprite.y + c.y + c.h / 2 + 2);
    this._glint.texture = callouts.texture('glint');
    this._flash.width = box.width;
    this._flash.height = box.height;
    resize(this._time, box.kind === 'desktop' ? 30 : 22);
    this._arrange();
    this._wipe.height = box.height * 1.4;
    this._wipe.width = Math.round(box.width * 0.16);
    this._wipe.skew.x = -0.21;
    this._wipe.position.set(-this._wipe.width * 2, -box.height * 0.2);
    for (let i = 0; i < CONFETTI; i++) {
      const k = i % 3 === 0 ? 'a' : i % 3 === 1 ? 'b' : 'c';

      this._confetti[i].texture = callouts.texture(`conf0${k}`);
    }
    void this._chequerTexture.set(chequerSvg(32, 2, 16), Math.max(1, box.scale));
  }

  /**
   * Plays the finish.
   * @param place - Your place.
   * @param time - The line under your place.
   * @param car - Your colour, for a winner's confetti.
   */
  public play(place: number, time: string, car: number): void {
    const scene = this._scene;

    if (!scene) return;
    const motion = this._services.motion;
    const box = scene.box;

    this.visible = true;
    this._services.sound.play('finishStab');
    motion.kill(this._dim, this._wipe.position, this._plate, this._plate.scale, this._ordinalBox, this._time);
    motion.kill(this._flash, this._glint, this._glint.position);
    this._glint.visible = false;
    this._glint.mask = null;
    this._flash.visible = false;
    this._dim.alpha = 0;
    motion.to(this._dim, { alpha: 0.3, duration: 0.5, ease: 'power1.inOut' });
    if (!motion.reduced) {
      this._wipe.visible = true;
      this._wipe.x = -this._wipe.width;
      const lean = this._wipe.height * Math.sin(-this._wipe.skew.x);

      motion.to(this._wipe.position, { x: box.width + lean + 20, duration: 0.5, ease: 'power1.inOut' });
      motion.to(this._wipe.tilePosition, { y: 64, duration: 0.5 });
    }
    this._plate.visible = false;
    motion.delay(SLAM_AT, this._showPlate);
    this._ordinalBox.visible = false;
    this._time.visible = false;
    this._time.text = time;
    this._ordinalDue = false;
    this._won = place === 1;
    const art = ordinalSvg(place, { size: scene.sizes.finishOrdinal });
    const f = faceOf(art);
    const ax = (f.x + f.w / 2) / art.width;
    const ay = (f.y + f.h / 2) / art.height;

    this._ordinalW = f.w;
    this._arrange();
    this._ordinal.anchor.set(ax, ay);
    this._ordinalMask.anchor.set(ax, ay);
    void this._ordinalTexture.set(art, Math.max(1, box.scale) * 1.4).then(this._popOrdinal);
    if (this._won && !motion.reduced) {
      for (let i = 0; i < CONFETTI; i++) {
        const k = i % 3 === 0 ? 'a' : i % 3 === 1 ? 'b' : 'c';

        this._confetti[i].texture = scene.callouts.texture(`conf${car}${k}`);
      }
    }
  }

  /** Hides it */
  public clear(): void {
    const motion = this._services.motion;

    this._ordinalDue = false;
    this._won = false;
    motion.kill(this._showPlate, this._landPlate, this._burst, this._showOrdinal, this._sweepPlace, this._dim);
    motion.kill(
      this._plate,
      this._plate.scale,
      this._ordinalBox,
      this._ordinalBox.scale,
      this._flash,
      this._glint.position,
    );
    this.visible = false;
    this._wipe.visible = false;
    this._flash.visible = false;
    this._glint.visible = false;
    this._glint.mask = null;
    this._ordinalMask.texture = Texture.EMPTY;
    this._flying = 0;
    for (const c of this._confetti) c.visible = false;
  }

  /** Per frame: the confetti */
  public update(dt: number): void {
    if (this._flying <= 0) return;
    const s = this._state;
    let alive = 0;

    for (let i = 0; i < CONFETTI; i++) {
      const o = i * 7;
      const c = this._confetti[i];

      s[o + 6] += dt;
      if (s[o + 6] > LIFE) {
        c.visible = false;
        continue;
      }
      alive++;
      s[o + 3] += GRAVITY * dt;
      s[o + 2] *= 1 - 1.2 * dt;
      s[o + 3] *= 1 - 1.2 * dt;
      s[o] += s[o + 2] * dt;
      s[o + 1] += s[o + 3] * dt;
      s[o + 4] += s[o + 5] * dt;
      c.position.set(s[o], s[o + 1]);
      c.rotation = s[o + 4];
      c.scale.y = 1.15 * Math.cos(s[o + 6] * 9 + i);
      c.alpha = Math.min(1, (LIFE - s[o + 6]) * 2);
    }
    this._flying = alive;
  }

  public override destroy(): void {
    this.clear();
    this._ordinalTexture.clear();
    this._chequerTexture.clear();
    super.destroy({ children: true });
  }

  /** Puts the plate, the place and the time at their homes for this layout and the place showing */
  private _arrange(): void {
    const scene = this._scene;

    if (!scene) return;
    const { box, sizes } = scene;
    const plateTop = box.safe.top + PLATE_TOP[box.kind];
    const size = sizes.finishOrdinal;
    let ordinalX = box.width / 2;
    let ordinalY: number;
    let timeTop: number;

    this._plateX = box.width / 2;
    this._plateY = plateTop + sizes.finishH / 2;
    if (box.kind === 'landscape') {
      const left = (box.width - (this._ordinalW + GAP + sizes.finishW)) / 2;

      ordinalX = left + this._ordinalW / 2;
      ordinalY = this._plateY;
      this._plateX = left + this._ordinalW + GAP + sizes.finishW / 2;
      timeTop = plateTop + sizes.finishH + 6;
    } else {
      ordinalY = plateTop + sizes.finishH + GAP + size / 2;
      timeTop = ordinalY + size * (0.5 + ORDINAL_DEPTH) + 6;
    }
    this._services.motion.kill(this._plate.position, this._time.position);
    this._plate.position.set(this._plateX, this._plateY);
    this._ordinalBox.position.set(ordinalX, ordinalY);
    place(this._time, this._plateX, timeTop, 'center');
    this._timeX = this._time.x;
    this._timeY = this._time.y;
  }

  /** FINISHED slams down from 1.3x; as it lands the screen flashes white and the HUD jolts */
  private readonly _showPlate = (): void => {
    const motion = this._services.motion;
    const plate = this._plate;

    motion.kill(plate, plate.position, plate.scale, plate.skew);
    plate.position.set(this._plateX, this._plateY);
    plate.skew.set(0, 0);
    plate.visible = true;
    if (motion.reduced) {
      plate.scale.set(1);
      motion.fadeIn(plate);
    } else {
      plate.alpha = 0;
      plate.scale.set(1.3);
      motion.to(plate, { alpha: 1, duration: 0.06 });
      motion.to(plate.scale, { x: 1, y: 1, duration: SLAM_DURATION, ease: 'power3.in' });
      motion.delay(SLAM_DURATION, this._landPlate);
    }
    motion.delay(SLAM_DURATION + 0.18, this._showOrdinal);
    if (this._won && !motion.reduced) motion.delay(SLAM_DURATION + 0.32, this._burst);
  };

  private readonly _landPlate = (): void => {
    const motion = this._services.motion;
    const f = this._flash;

    this.onSlam?.();
    f.visible = true;
    f.alpha = 0.16;
    motion.to(f, { alpha: 0, duration: 0.22, ease: 'power2.out', onComplete: this._hideFlash });
  };

  private readonly _hideFlash = (): void => {
    this._flash.visible = false;
  };

  private readonly _showOrdinal = (): void => {
    this._ordinalDue = true;
    if (this._ordinalTexture.ready) this._popOrdinal();
    this._services.motion.slot(this._time, this._timeX, this._timeY, 0, 16, 0.3);
  };

  /** Punches the place in once it is both due and drawn, then sweeps the glint across it */
  private readonly _popOrdinal = (): void => {
    const box = this._ordinalBox;

    if (!this._ordinalDue || box.visible || !this._ordinalTexture.ready) return;
    box.visible = true;
    box.alpha = 1;
    this._ordinalMask.texture = this._ordinal.texture;
    this._services.motion.punch(box, 1.8);
    this._services.motion.delay(0.32, this._sweepPlace);
  };

  /** A sheen sweeps across the place inside its shape: white light over a winner's gold, cyan over a white place */
  private readonly _sweepPlace = (): void => {
    const motion = this._services.motion;
    const g = this._glint;
    const art = this._scene?.callouts.art('glint');

    if (motion.reduced || !art || this._ordinal.texture === Texture.EMPTY) return;
    const h = this._ordinal.height * 1.2;
    const half = this._ordinal.width / 2;

    g.scale.set(h / art.height);
    g.mask = this._ordinalMask;
    g.tint = this._won ? 0xffffff : CYAN;
    g.blendMode = this._won ? 'add' : 'normal';
    g.visible = true;
    g.alpha = 0.9;
    g.position.set(-half - g.width / 2, 0);
    motion.to(g.position, {
      x: half + g.width / 2,
      duration: 0.5,
      ease: 'power2.inOut',
      onComplete: this._endSweep,
    });
  };

  private readonly _endSweep = (): void => {
    this._glint.visible = false;
    this._glint.mask = null;
  };

  /** Three cannons: up and out from the place, and in from each bottom corner */
  private readonly _burst = (): void => {
    const box = this._scene?.box;

    if (!box) return;
    const s = this._state;
    const cx = box.width / 2;
    const cy = this._ordinalBox.y;
    const third = Math.floor(CONFETTI / 3);

    for (let i = 0; i < CONFETTI; i++) {
      const o = i * 7;
      const cannon = i < third ? 0 : i < third * 2 ? -1 : 1;
      const a =
        cannon === 0
          ? -Math.PI / 2 + (Math.random() - 0.5) * 2.6
          : -Math.PI / 2 - cannon * (0.15 + Math.random() * 0.4);
      const v =
        cannon === 0 ? 460 + Math.random() * 560 : (0.9 + Math.random() * 0.6) * Math.max(900, box.height * 1.5);

      s[o] = cannon === 0 ? cx + (Math.random() - 0.5) * 80 : cannon < 0 ? -10 : box.width + 10;
      s[o + 1] = cannon === 0 ? cy : box.height + 10;
      s[o + 2] = Math.cos(a) * v;
      s[o + 3] = Math.sin(a) * v;
      s[o + 4] = Math.random() * 6;
      s[o + 5] = (Math.random() - 0.5) * 14;
      s[o + 6] = Math.random() * 0.25;
      this._confetti[i].visible = true;
      this._confetti[i].scale.set(1.15);
    }
    this._flying = CONFETTI;
  };
}
