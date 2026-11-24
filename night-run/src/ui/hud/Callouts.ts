import type { Text, Texture } from 'pixi.js';
import { Container, Sprite, TilingSprite } from 'pixi.js';

import { hazardSvg } from '../art/motifs';
import type { SvgArt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';
import { COLORS, MOTION } from '../art/tokens';
import { ArtTexture } from './ArtTexture';
import { landscapePauseX, mapWidth } from './layout';
import type { HudScene, HudServices } from './scene';
import { atFace, faceOf } from './sprites';
import { BOARD_800, BOARD_900, fit, hudText, INK, NAME, place, placeMiddle, resize, WHITE } from './text';

const HAZARD_STRIPE = 7.0710678;
const ORDINALS = ['th', 'st', 'nd', 'rd', 'th'];
/** Seconds FINAL LAP holds, and LAP RECORD (shorter when FINAL LAP waits behind it) */
const FINAL_HOLD = 1.6;
const RECORD_HOLD = 1.9;
const RECORD_HOLD_SHORT = 1.1;

/** A chip: a callout plate with its words, seated by its face's top-left */
interface Chip {
  readonly view: Container;
  readonly plate: Sprite;
  readonly word: Text;
  x: number;
  y: number;
}

/** 1st, 2nd, 3rd, 4th */
export function ordinal(place: number): string {
  return `${place}${ORDINALS[Math.min(4, Math.max(0, place))]}`;
}

/**
 * The race callouts: the centre banners (final lap, wrong way, lap record) and the chips round the place and the
 * timing plate (ULTRA BOOST, UP 1, the lap split, back on track, someone finished and the race-closing timer).
 */
export class Callouts extends Container {
  private readonly _banner = new Container();
  private readonly _bannerPlate = new Sprite();
  private readonly _inkWord: Text;
  private readonly _whiteWord: Text;
  private readonly _sub: Text;
  private readonly _glint = new Sprite();
  private readonly _tape = new TilingSprite();
  private readonly _sparkles: Sprite[] = [];
  private readonly _chips: Chip[] = [];
  private readonly _ultra: Chip;
  private readonly _up: Chip;
  private readonly _upLine: Text;
  private readonly _split: Chip;
  private readonly _splitLine: Text;
  private readonly _fin: Chip;
  private readonly _finFlag = new Sprite();
  private readonly _finTime: Text;
  private readonly _closing: Chip;
  private readonly _back: Chip;
  private readonly _backIcon = new Sprite();
  private readonly _services: HudServices;
  private readonly _hazard: ArtTexture;
  private _scene: HudScene | null = null;
  private _bannerKind: 'final' | 'wrong' | 'record' | '' = '';
  /** performance.now() time the banner showing has left the screen */
  private _bannerEndsAt = 0;
  /** A banner waiting for the one on screen to leave, and the record's time for it */
  private _queued: 'final' | 'record' | '' = '';
  private _queuedTime = '';
  private _bannerX = 0;
  private _bannerY = 0;
  private _wrong = false;
  private _wrongTime = 0;
  private _closesAt = 0;
  private _closingShown = -1;
  private _finWordX = 0;
  private _finWordMax = 200;

  constructor(services: HudServices, textures: SvgTextures) {
    super();
    this._services = services;
    this._hazard = new ArtTexture(textures, this._tape);
    this._inkWord = hudText({ ...BOARD_900, flat: true, spacing: 1 }, 62, INK);
    this._whiteWord = hudText({ ...BOARD_900, spacing: 1 }, 62, WHITE);
    this._sub = hudText(BOARD_800, 28);
    this._glint.blendMode = 'add';
    this._glint.anchor.set(0.5);
    this._glint.visible = false;
    this._tape.visible = false;
    this._banner.addChild(this._tape, this._bannerPlate, this._glint, this._inkWord, this._whiteWord, this._sub);
    for (let i = 0; i < 6; i++) {
      const s = new Sprite();

      s.anchor.set(0.5);
      s.visible = false;
      this._sparkles.push(s);
      this._banner.addChild(s);
    }
    this._banner.visible = false;
    this._ultra = this._chip(hudText({ ...BOARD_900, spacing: 1 }, 36));
    this._up = this._chip(hudText({ ...BOARD_900, flat: true }, 28, INK));
    this._upLine = hudText(NAME, 15);
    this._up.view.addChild(this._upLine);
    this._split = this._chip(hudText({ ...BOARD_900, flat: true }, 26, INK));
    this._splitLine = hudText(NAME, 14);
    this._splitLine.style.wordWrap = true;
    this._splitLine.style.wordWrapWidth = 230;
    this._splitLine.style.lineHeight = 18;
    this._split.view.addChild(this._splitLine);
    this._fin = this._chip(hudText(NAME, 18));
    this._finTime = hudText(BOARD_800, 22);
    this._fin.view.addChild(this._finFlag, this._finTime);
    this._closing = this._chip(hudText({ ...NAME, weight: '700', flat: true }, 17, INK));
    this._back = this._chip(hudText(NAME, 18, WHITE, 'Back on track'));
    this._back.view.addChild(this._backIcon);
    this.addChild(this._banner);
  }

  public layout(scene: HudScene): void {
    this._scene = scene;
    const { box, sizes, callouts, spec } = scene;
    const d = box.kind === 'desktop';
    const p = box.kind === 'portrait';
    const s = box.safe;
    const W = box.width;

    this._bannerX = W / 2;
    this._bannerY = sizes.bannerY + sizes.bannerH / 2;
    this._services.motion.kill(this._banner.position, this._banner.skew);
    this._banner.skew.set(0, 0);
    this._banner.position.set(this._bannerX, this._bannerY);
    resize(this._inkWord, Math.round(sizes.bannerH * 0.62));
    resize(this._whiteWord, Math.round(sizes.bannerH * 0.62));
    resize(this._sub, d ? 28 : 22);
    if (this._bannerKind) this._setBanner(this._bannerKind);
    this._glint.texture = callouts.texture('glint');
    for (const sp of this._sparkles) sp.texture = callouts.texture('sparkle');
    this._loadHazard(scene);
    this._tape.width = sizes.tapeW;
    this._tape.height = Math.round(sizes.bannerH * 0.36);
    this._tape.position.set(-this._tape.width / 2, -this._tape.height / 2);

    this._seat(
      this._ultra,
      callouts.art('ultra'),
      callouts.texture('ultra'),
      (W - sizes.ultraW) / 2,
      d ? 120 : p ? 292 : 80,
    );
    resize(this._ultra.word, d ? 36 : 28);
    this._centreWord(this._ultra, callouts.art('ultra'));

    // In landscape the chips sit in the top row between the timing plate and the pause button when they fit there,
    // else under the place
    const besidePlate = !d && !p && s.left + 290 + Math.max(sizes.upW, sizes.backW) + 8 <= landscapePauseX(box, spec);
    const upX = d ? s.left + 150 : p || !besidePlate ? s.left : s.left + 290;
    const upY = d ? s.top + 20 : p ? s.top + 66 : besidePlate ? s.top + 4 : s.top + 64;

    this._seat(this._up, callouts.art('up'), callouts.texture('up'), upX, upY);
    resize(this._up.word, d ? 28 : 22);
    this._centreWord(this._up, callouts.art('up'));
    this._upLine.visible = d;
    place(this._upLine, 4, sizes.upH + 16);

    const splitX = d ? W - s.right - 250 : p ? W - s.right - mapWidth(128) - 14 - sizes.splitW : s.left;
    const splitY = d ? s.top + 140 : p ? s.top + 86 : besidePlate ? s.top + 70 : upY + sizes.upH + 8;

    this._seat(this._split, callouts.art('splitGain'), callouts.texture('splitGain'), splitX, splitY);
    resize(this._split.word, d ? 26 : 22);
    this._splitLine.visible = d;
    place(this._splitLine, 4, sizes.splitH + 14);

    const finX = d || !p ? (W - sizes.finW) / 2 : s.left;
    const finY = d ? s.top + 4 : p ? s.top + 86 : s.top + 70;
    const finArt = callouts.art('fin');
    const fc = finArt.content ?? faceOf(finArt);
    const ff = faceOf(finArt);

    this._seat(this._fin, finArt, callouts.texture('fin'), finX, finY);
    this._finFlag.texture = callouts.texture('flag');
    const flagArt = callouts.art('flag');

    atFace(this._finFlag, flagArt, fc.x - ff.x - 6 + 4, (sizes.finH - faceOf(flagArt).h) / 2);
    resize(this._fin.word, d ? 18 : 15);
    this._finTime.visible = d;
    place(this._finTime, fc.x - ff.x + fc.w - 4, 17 - 4, 'right');
    this._finWordX = fc.x - ff.x + 34;
    this._finWordMax = fc.w - 34 - (d ? 90 : 4);

    const closeX = finX + (d ? (sizes.finW - sizes.closeW) / 2 : 0);
    const closeY = finY + (d ? 66 : 54);

    this._seat(this._closing, callouts.art('closing'), callouts.texture('closing'), closeX, closeY);
    resize(this._closing.word, d ? 17 : 15);
    this._closingShown = -1;

    this._seat(this._back, callouts.art('backOn'), callouts.texture('backOn'), upX, upY);
    const backArt = callouts.art('backOn');
    const bc = backArt.content ?? faceOf(backArt);
    const bf = faceOf(backArt);

    this._backIcon.texture = callouts.texture('respawn');
    atFace(
      this._backIcon,
      callouts.art('respawn'),
      bc.x - bf.x + 2,
      (sizes.backH - faceOf(callouts.art('respawn')).h) / 2,
    );
    resize(this._back.word, d ? 18 : 15);
    placeMiddle(this._back.word, bc.x - bf.x + (d ? 36 : 30), sizes.backH / 2, 'left');
  }

  /** FINAL LAP with its bell: whips in from the left, holds 1.6 s, whips out right; after any banner on screen */
  public finalLap(): void {
    const motion = this._services.motion;
    const b = this._banner;

    if (this._wrong || this._wait('final', '')) return;
    this._services.sound.play('bell');
    this._setBanner('final');
    motion.kill(b, b.position, b.scale, b.skew);
    b.visible = true;
    b.alpha = 1;
    b.scale.set(1);
    if (motion.reduced) {
      b.position.set(this._bannerX, this._bannerY);
      motion.fadeIn(b);
    } else {
      const w = this._scene?.box.width ?? 1280;

      b.position.set(this._bannerX - w, this._bannerY);
      b.skew.x = -0.25;
      motion.to(b.position, { x: this._bannerX, duration: 0.35, ease: 'expo.out' });
      motion.to(b.skew, { x: 0, duration: 0.45, ease: 'power2.out' });
    }
    this._leaveAfter(0.35 + FINAL_HOLD, (this._scene?.box.width ?? 1280) * 0.8, 0);
  }

  /** WRONG WAY on or off; it shows only if it's still on 0.4 s later */
  public wrongWay(on: boolean): void {
    if (on === this._wrong) return;
    this._wrong = on;
    this._wrongTime = 0;
    const motion = this._services.motion;
    const b = this._banner;

    if (on) {
      motion.delay(0.4, this._showWrong);

      return;
    }
    motion.kill(this._showWrong);
    this._services.sound.loop('buzzerLoop', false);
    this._tape.visible = false;
    if (this._bannerKind === 'wrong') motion.whip(b, 0, -40);
  }

  /**
   * Whether a box (box px) meets the centre banner (its line under it included) or a chip at its home while they
   * show, so name tags keep off them. Each counts its whole plate art, depth and shadow too, as the HUD's plates do.
   */
  public blocks(left: number, top: number, w: number, h: number): boolean {
    const meets = (x: number, y: number, rw: number, rh: number): boolean =>
      left < x + rw && left + w > x && top < y + rh && top + h > y;
    const b = this._banner;
    const p = this._bannerPlate;

    if (b.visible && b.alpha > 0.05) {
      const bottom = this._sub.visible
        ? Math.max(p.y + p.height, this._sub.y + Number(this._sub.style.fontSize))
        : p.y + p.height;

      if (meets(b.x + p.x, b.y + p.y, p.width, bottom - p.y)) return true;
    }
    for (const c of this._chips) {
      if (
        c.view.visible &&
        c.view.alpha > 0.05 &&
        meets(c.x + c.plate.x, c.y + c.plate.y, c.plate.width, c.plate.height)
      ) {
        return true;
      }
    }

    return false;
  }

  /** Whether the wrong-way banner is up */
  public get wrongShowing(): boolean {
    return this._wrong && this._bannerKind === 'wrong' && this._banner.visible;
  }

  /**
   * LAP RECORD with its chime, the time under it, a glint and gold sparkles; after any banner on screen.
   * @param timeText - The lap's time.
   * @param short - FINAL LAP follows it, so it holds for less.
   */
  public lapRecord(timeText: string, short = false): void {
    const motion = this._services.motion;
    const b = this._banner;

    if (this._wrong || this._wait('record', timeText)) return;
    this._services.sound.play('record');
    this._setBanner('record');
    this._sub.text = timeText;
    this._sub.visible = true;
    motion.kill(b, b.position, b.scale, b.skew);
    b.position.set(this._bannerX, this._bannerY);
    b.skew.set(0, 0);
    b.visible = true;
    b.alpha = 1;
    motion.slot(b, this._bannerX, this._bannerY, 0, -30);
    this._sweep();
    const sizes = this._scene?.sizes;

    if (sizes && !motion.reduced) {
      for (let i = 0; i < this._sparkles.length; i++) {
        const sp = this._sparkles[i];
        const side = i % 2 === 0 ? -1 : 1;
        const a = (i / this._sparkles.length) * Math.PI * 2;

        sp.position.set(
          side * (sizes.bannerW * (0.3 + 0.08 * (i % 3))) + Math.cos(a) * 12,
          (i % 3 === 0 ? -1 : 1) * sizes.bannerH * (0.45 + 0.1 * (i % 2)),
        );
        sp.visible = true;
        sp.alpha = 1;
        sp.scale.set(0);
        sp.rotation = a;
        const delay = 0.12 + i * 0.07;

        motion.to(sp.scale, { x: 1.7, y: 1.7, delay, duration: 0.25, ease: 'back.out(3)' });
        motion.to(sp, { rotation: a + 2.4, delay, duration: 0.9, ease: 'power1.out' });
        motion.to(sp, { alpha: 0, delay: delay + 0.45, duration: 0.35 });
      }
    }
    this._leaveAfter(0.3 + (short ? RECORD_HOLD_SHORT : RECORD_HOLD), 0, -40);
  }

  /** ULTRA BOOST, as a held slide's charge fires */
  public ultraBoost(): void {
    const motion = this._services.motion;
    const v = this._ultra.view;

    this._ultra.word.text = 'ULTRA BOOST';
    motion.kill(v, v.position, v.scale, v.skew);
    v.position.set(this._ultra.x, this._ultra.y);
    v.visible = true;
    v.alpha = 1;
    motion.punch(v, 1.4);
    motion.whip(v, 0, -30, 1.1);
  }

  /** UP 1 by the place, with who you passed on desktop */
  public positionGained(by: number, passed: string): void {
    const c = this._up;

    c.word.text = `UP ${by}`;
    if (this._scene) this._centreWord(c, this._scene.callouts.art('up'));
    this.setPassed(passed);
    this._services.motion.kill(this._back.view);
    this._back.view.visible = false;
    this._pop(c, 1.6);
  }

  /** Who you passed, under UP 1 on desktop; the HUD fills it in once the frame's places agree */
  public setPassed(name: string): void {
    this._upLine.text = name ? `You passed ${name}` : '';
  }

  /** The split chip by the timing plate: green under your best, red over it */
  public lapSplit(split: number, lap: number, lapTime: string): void {
    const scene = this._scene;

    if (!scene) return;
    const gain = split <= 0;
    const key = gain ? 'splitGain' : 'splitLoss';
    const art = scene.callouts.art(key);
    const desktop = scene.box.kind === 'desktop';
    const abs = Math.abs(split) / 1000;
    const delta = `${gain ? '-' : '+'}${abs.toFixed(2)}`;

    this._split.plate.texture = scene.callouts.texture(key);
    this._split.word.tint = gain ? INK : WHITE;
    this._split.word.text = desktop ? `LAP ${lap}  ${delta}` : delta;
    this._centreWord(this._split, art);
    this._splitLine.text = lapTime
      ? `Lap ${lap} in ${lapTime}, ${abs.toFixed(2)} ${gain ? 'under' : 'over'} your best`
      : `${abs.toFixed(2)} ${gain ? 'under' : 'over'} your best`;
    this._pop(this._split, 2);
  }

  /** Back on track, under the place for 1.2 s */
  public backOnTrack(): void {
    this._services.motion.kill(this._up.view);
    this._up.view.visible = false;
    this._pop(this._back, 1.2);
  }

  /**
   * Someone finished: who, in what place, and the timer to the race closing, which stays until you finish.
   * @param name - Who finished.
   * @param place - Their place.
   * @param time - Their time, shown on desktop.
   * @param closesAt - performance.now() time the race closes.
   */
  public someoneFinished(name: string, place: number, time: string, closesAt: number): void {
    const c = this._fin;

    fit(c.word, `${name} finished ${ordinal(place)}`, Number(c.word.style.fontSize), this._finWordMax);
    placeMiddle(c.word, this._finWordX, (this._scene?.sizes.finH ?? 52) / 2, 'left');
    this._finTime.text = time;
    this._pop(c, 5);
    if (closesAt > 0 && (this._closesAt === 0 || closesAt < this._closesAt)) {
      this._closesAt = closesAt;
      this._closingShown = -1;
      this._tickClosing(performance.now());
      this._pop(this._closing, 0, 0.12);
    }
  }

  /** Your finish takes the screen: the race-closing timer stops, and every chip still up whips out */
  public yieldToFinish(): void {
    this._closesAt = 0;
    for (const chip of this._chips) {
      if (chip.view.visible) this._services.motion.whip(chip.view, 0, -20);
    }
  }

  /** Per frame: the wrong-way pulse and tape, and the closing timer */
  public update(dt: number, now: number): void {
    if (this.wrongShowing) {
      this._wrongTime += dt;
      const reduced = this._services.motion.reduced;
      const pulse = reduced ? 1 : 1 + 0.02 * (1 - Math.cos(this._wrongTime * Math.PI * 4));

      this._banner.scale.set(pulse);
      this._tape.tilePosition.x += 40 * dt;
    }
    if (this._closesAt) this._tickClosing(now);
  }

  /** Hides every callout at once */
  public clear(): void {
    const motion = this._services.motion;

    motion.kill(this._showWrong);
    for (const v of [this._banner, ...this._chips.map((chip) => chip.view)]) {
      motion.kill(v, v.position, v.scale, v.skew);
      v.visible = false;
    }
    if (this._wrong) this._services.sound.loop('buzzerLoop', false);
    motion.kill(this._playQueued);
    this._queued = '';
    this._bannerEndsAt = 0;
    this._wrong = false;
    this._bannerKind = '';
    this._closesAt = 0;
    this._tape.visible = false;
  }

  public override destroy(): void {
    this.clear();
    this._hazard.clear();
    super.destroy({ children: true });
  }

  private readonly _showWrong = (): void => {
    if (!this._wrong) return;
    const motion = this._services.motion;
    const b = this._banner;

    motion.kill(this._playQueued);
    this._queued = '';
    this._bannerEndsAt = 0;
    this._setBanner('wrong');
    this._sub.text = 'Turn around';
    this._sub.visible = true;
    motion.kill(b, b.position, b.scale, b.skew);
    b.position.set(this._bannerX, this._bannerY);
    b.skew.set(0, 0);
    b.visible = true;
    b.alpha = 1;
    motion.punch(b, 1.25);
    this._tape.visible = true;
    this._wrongTime = 0;
    this._services.sound.loop('buzzerLoop', true);
  };

  /** Whether a banner is on screen still; if so `kind` waits its turn and plays once that one has left */
  private _wait(kind: 'final' | 'record', time: string): boolean {
    const left = this._bannerEndsAt - performance.now();

    if (!this._banner.visible || left <= 0) return false;
    this._queued = kind;
    this._queuedTime = time;
    this._services.motion.kill(this._playQueued);
    this._services.motion.delay(left / 1000, this._playQueued);

    return true;
  }

  private readonly _playQueued = (): void => {
    const kind = this._queued;

    this._queued = '';
    this._bannerEndsAt = 0;
    if (kind === 'final') this.finalLap();
    else if (kind === 'record') this.lapRecord(this._queuedTime);
  };

  /** Holds the banner `hold` seconds from now, then whips it out toward dx, dy */
  private _leaveAfter(hold: number, dx: number, dy: number): void {
    this._services.motion.whip(this._banner, dx, dy, hold);
    this._bannerEndsAt = performance.now() + (hold + MOTION.whip.duration) * 1000;
  }

  private _setBanner(kind: 'final' | 'wrong' | 'record'): void {
    const scene = this._scene;

    this._bannerKind = kind;
    if (!scene) return;
    const art = scene.callouts.art(kind);
    const f = faceOf(art);
    const c = art.content ?? f;
    const ink = kind !== 'wrong';
    const word = ink ? this._inkWord : this._whiteWord;
    const sizes = scene.sizes;

    this._bannerPlate.texture = scene.callouts.texture(kind);
    atFace(this._bannerPlate, art, -sizes.bannerW / 2, -sizes.bannerH / 2);
    this._inkWord.visible = ink;
    this._whiteWord.visible = !ink;
    word.text = kind === 'final' ? 'FINAL LAP' : kind === 'wrong' ? 'WRONG WAY' : 'LAP RECORD';
    placeMiddle(word, this._bannerPlate.x + c.x + c.w / 2, this._bannerPlate.y + c.y + c.h / 2 + 2);
    this._sub.visible = kind !== 'final';
    place(this._sub, 0, sizes.bannerH / 2 + (scene.box.kind === 'desktop' ? 22 : 16), 'center');
    this._tape.visible = kind === 'wrong' && this._wrong;
  }

  private _sweep(): void {
    const scene = this._scene;
    const motion = this._services.motion;

    if (!scene || motion.reduced) return;
    const half = scene.sizes.bannerW / 2;
    const g = this._glint;

    motion.kill(g, g.position);
    g.visible = true;
    g.alpha = 0;
    g.position.set(-half * 0.8, 0);
    motion.to(g.position, { x: half * 0.8, delay: 0.2, duration: 0.55, ease: 'power2.inOut' });
    motion.to(g, { alpha: 1, delay: 0.2, duration: 0.18, yoyo: true, repeat: 1, repeatDelay: 0.2 });
  }

  private _chip(word: Text): Chip {
    const view = new Container();
    const plate = new Sprite();

    view.addChild(plate, word);
    view.visible = false;
    this.addChild(view);
    const chip = { view, plate, word, x: 0, y: 0 };

    this._chips.push(chip);

    return chip;
  }

  /** Seats a chip at its home for this layout; one already showing stops travelling and stays, at its new home */
  private _seat(chip: Chip, art: SvgArt, texture: Texture, x: number, y: number): void {
    chip.plate.texture = texture;
    atFace(chip.plate, art, 0, 0);
    chip.x = x;
    chip.y = y;
    this._services.motion.kill(chip.view.position, chip.view.skew);
    chip.view.skew.set(0, 0);
    chip.view.position.set(x, y);
  }

  private _centreWord(chip: Chip, art: SvgArt): void {
    const f = faceOf(art);
    const c = art.content ?? f;

    placeMiddle(chip.word, c.x - f.x + c.w / 2, c.y - f.y + c.h / 2 + 1);
  }

  /** Slots a chip in from the left and whips it out after `hold` seconds (0 keeps it) */
  private _pop(chip: Chip, hold: number, delay = 0): void {
    const motion = this._services.motion;

    motion.slot(chip.view, chip.x, chip.y, -40, 0, delay);
    if (hold > 0) motion.whip(chip.view, 0, -20, delay + hold);
  }

  private _tickClosing(now: number): void {
    const left = Math.max(0, Math.ceil((this._closesAt - now) / 1000));

    if (left === this._closingShown) return;
    if (this._closingShown > 0 && left < 10) this._services.sound.play('tick');
    this._closingShown = left;
    const m = Math.floor(left / 60);
    const s = left % 60;

    this._closing.word.text = `Race closes in ${m}:${s < 10 ? '0' : ''}${s}`;
    const art = this._scene?.callouts.art('closing');

    if (art) this._centreWord(this._closing, art);
  }

  private _loadHazard(scene: HudScene): void {
    const art = hazardSvg(40, Math.round(scene.sizes.bannerH * 0.36), HAZARD_STRIPE, COLORS.danger);

    void this._hazard.set(art, Math.max(1, scene.box.scale));
  }
}
