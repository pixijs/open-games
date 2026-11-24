import type { Text } from 'pixi.js';
import { Container, Sprite, Texture } from 'pixi.js';

import { startFrame } from './CountdownView';
import { cardStickSize } from './hudArt';
import type { HudScene, HudServices } from './scene';
import { atAnchor, atFace, faceOf } from './sprites';
import { BODY, BOARD_800, BOARD_900, fit, hudText, MIST, place, placeMiddle, resize } from './text';

const KEY_ROWS: readonly (readonly [readonly string[], string])[] = [
  [['W', 'S'], 'Drive, brake, reverse'],
  [['A', 'D'], 'Steer (or the arrow keys)'],
  [['C'], 'Camera'],
  [['R'], 'Back on track'],
  [['Esc'], 'Race menu'],
];
/** What the stick does on the Chase, where it steers the truck, and on the other cameras, where it points on screen. */
const CHASE_HELP = 'Push the stick to drive and slide it to steer. Pull it down to brake, lift your thumb to coast.';
const SCREEN_HELP =
  'Point the stick where you want to go on screen and the truck drives there flat out. Lift your thumb to coast.';

/**
 * "How to drive", over the grid during a player's first race in this tab: the keys, or the stick and camera when touch
 * controls show. It sits where the countdown will be, above the player's truck, and whips out at the end of the
 * grid second, so it has gone by the time the countdown's 3 lands on the spot.
 */
export class ControlsCard extends Container {
  private readonly _plate = new Sprite();
  private readonly _title: Text;
  private readonly _fades: Text;
  private readonly _keys = new Container();
  private readonly _touch = new Container();
  private readonly _keySprites: Sprite[] = [];
  private readonly _keyWords: Text[] = [];
  private readonly _rowWords: Text[] = [];
  private readonly _stick = new Sprite();
  private readonly _knob = new Sprite();
  private readonly _help: Text;
  private readonly _camera = new Sprite();
  private readonly _cameraWord: Text;
  private readonly _services: HudServices;
  private _x = 0;
  private _y = 0;
  private _leaving = false;

  constructor(services: HudServices) {
    super();
    this._services = services;
    this._title = hudText(BOARD_900, 26, 0xffffff, 'How to drive');
    this._fades = hudText(BODY, 13, MIST, 'Leaves at 3');
    for (const [keys, what] of KEY_ROWS) {
      for (const key of keys) {
        const sprite = new Sprite();
        const word = hudText(BOARD_800, 20, 0xffffff, key);

        this._keySprites.push(sprite);
        this._keyWords.push(word);
        this._keys.addChild(sprite, word);
      }
      const row = hudText(BODY, 15, 0xffffff, what);

      this._rowWords.push(row);
      this._keys.addChild(row);
    }
    this._help = hudText(BODY, 14, 0xffffff, SCREEN_HELP);
    this._help.style.wordWrap = true;
    this._help.style.lineHeight = 18;
    this._cameraWord = hudText({ family: 'driver', weight: '600' }, 15, 0xffffff, 'Camera');
    this._touch.addChild(this._stick, this._knob, this._help, this._camera, this._cameraWord);
    this.addChild(this._plate, this._title, this._fades, this._keys, this._touch);
    this.visible = false;
  }

  public layout(scene: HudScene): void {
    const start = scene.start;

    if (!start) return;
    const { box, sizes, spec } = scene;
    const d = box.kind === 'desktop';
    const p = box.kind === 'portrait';
    const l = box.kind === 'landscape';
    const art = start.art('card');
    const f = faceOf(art);
    const lightsBottom = startFrame(box, sizes).lightsBottom;

    this._x = (box.width - sizes.cardW) / 2;
    this._y = d
      ? lightsBottom + 8
      : p
        ? box.safe.top + 86 + spec.map + 10
        : Math.max(box.safe.top + spec.plateH + 12, lightsBottom + 8);
    this.position.set(this._x, this._y);
    this._plate.texture = start.texture('card');
    atFace(this._plate, art, 0, 0);
    resize(this._title, d ? 26 : 22);
    place(this._title, 22, l ? 14 : 18);
    place(this._fades, f.w - 20, l ? 20 : 24, 'right');
    this._keys.visible = !scene.touch;
    this._touch.visible = scene.touch;
    if (!scene.touch) {
      let k = 0;

      // Each column's words start 10 px past its widest keys: two keys on the left, one (Esc is wide) on the right
      KEY_ROWS.forEach(([keys], i) => {
        const left = i < 3;
        const rx = left ? 22 : 312;
        const ry = 62 + (i % 3) * 56;
        let kx = rx;

        for (const key of keys) {
          const wide = key.length > 1;
          const keyArt = start.art(wide ? 'keyWide' : 'key');
          const kc = keyArt.content ?? faceOf(keyArt);
          const kf = faceOf(keyArt);
          const sprite = this._keySprites[k];

          sprite.texture = start.texture(wide ? 'keyWide' : 'key');
          atFace(sprite, keyArt, kx, ry);
          placeMiddle(this._keyWords[k], kx + kc.x - kf.x + kc.w / 2, ry + kc.y - kf.y + kc.h / 2 + 1);
          kx += kf.w + 6;
          k++;
        }
        fit(this._rowWords[i], KEY_ROWS[i][1], 15, left ? 170 : 150);
        place(this._rowWords[i], rx + (left ? 96 : 62), ry + 11);
      });

      return;
    }
    const s = cardStickSize(box.kind);
    const sy = l ? 46 : 56;
    const stickArt = start.art('cardStick');

    this._stick.texture = start.texture('cardStick');
    atAnchor(this._stick, stickArt, 22 + s / 2, sy + s / 2);
    this._knob.texture = start.texture('cardKnob');
    atAnchor(this._knob, start.art('cardKnob'), 22 + s / 2, sy + s / 2 - s * 0.16);
    this._help.style.wordWrapWidth = p ? sizes.cardW - s - 70 : l ? 170 : 160;
    place(this._help, s + 40, sy + (l ? 0 : 4));
    // Under the stick on a phone held upright, else level with the stick's middle past the help
    const iy = p ? sy + s + 12 : sy + s / 2 - 20;
    const ix = p ? 22 : l ? 300 : 280;

    this._camera.texture = start.texture('cardCam');
    atFace(this._camera, start.art('cardCam'), ix, iy);
    place(this._cameraWord, ix + 50, iy + 12);
  }

  /**
   * Says what the stick does on the race camera the race opens on.
   * @param camera - The camera's label, as the HUD frame names it.
   */
  public setCamera(camera: string): void {
    const help = camera === 'Chase' ? CHASE_HELP : SCREEN_HELP;

    if (this._help.text !== help) this._help.text = help;
  }

  /** Whether a box (box px) meets the card while it shows, its plate art's shadow included, so name tags keep off it */
  public blocks(left: number, top: number, w: number, h: number): boolean {
    if (!this.visible || this.alpha < 0.05) return false;
    const x = this._x + this._plate.x;
    const y = this._y + this._plate.y;

    return left < x + this._plate.width && left + w > x && top < y + this._plate.height && top + h > y;
  }

  /** Slots in at the centre of the grid */
  public show(): void {
    this._leaving = false;
    this._services.motion.slot(this, this._x, this._y, 0, 30);
  }

  /** Lets go of the start atlas's textures before it is freed */
  public unbind(): void {
    this._services.motion.kill(this, this.position, this.skew);
    this.visible = false;
    for (const s of [this._plate, this._stick, this._knob, this._camera, ...this._keySprites]) {
      s.texture = Texture.EMPTY;
    }
  }

  /** Whips out, once */
  public hide(): void {
    if (!this.visible || this._leaving) return;
    this._leaving = true;
    this._services.motion.whip(this, 80, 0);
  }

  /** Gone at once, unless it is already on its way out */
  public cut(): void {
    if (this._leaving) return;
    this._services.motion.kill(this, this.position, this.skew);
    this.visible = false;
  }
}
