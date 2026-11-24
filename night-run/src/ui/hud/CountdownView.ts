import type { Text } from 'pixi.js';
import { Container, Sprite, Texture } from 'pixi.js';

import type { CalloutSizes } from './hudArt';
import type { HudBox } from './layout';
import { landscapePauseX } from './layout';
import type { HudScene, HudServices } from './scene';
import { atFace, faceOf } from './sprites';
import { BOARD_900, hudText, placeMiddle, resize } from './text';

const STEP_KEYS = ['nGo', 'n1', 'n2', 'n3'] as const;

/** GO: seconds to punch in, then to burst out (grow to {@link GO_GROW} and fade) */
const GO_IN = 0.2;
const GO_OUT = 0.35;
const GO_GROW = 1.25;
/** Seconds after GO the LAUNCH BOOST chip stamps down, once GO has landed */
const LAUNCH_AT = 0.12;
/** Box px between GO's foot and the LAUNCH BOOST chip under it */
const LAUNCH_GAP = 6;
/**
 * The line the numerals stand on, as a share of the screen's height. The start camera frames the player's truck with
 * its top at about 63 %: the numerals stay above 52 %, which leaves room for the 4 px shake and their glow, and the
 * LAUNCH BOOST chip under GO ends by 62 % on the shortest phone.
 */
const NUMERAL_BASE = 0.5;
/** A numeral's extruded depth, as a share of its cap height (`countdownSvg`) */
const NUMERAL_DEPTH = 0.07;
/** The lamp bar's face height and its return under it, as shares of its width (`startLightsSvg`) */
const LIGHTS_HEIGHT = 0.3 * 1.12;

/** Where the start sits, in box px */
export interface StartFrame {
  /** Top of the lamp bar's face */
  readonly lightsTop: number;
  /** Bottom of the lamp bar, its return included */
  readonly lightsBottom: number;
  /** Top of a numeral's face */
  readonly numeralTop: number;
  /** The line a numeral's solid bottom stands on */
  readonly numeralBase: number;
}

/**
 * The start's frame for a layout: the numerals stand on half the screen's height, clear of the player's truck, and the
 * lamps hang just over them, below the HUD's top plates.
 */
export function startFrame(box: HudBox, sizes: CalloutSizes): StartFrame {
  const landscape = box.kind === 'landscape';
  const numeralBase = Math.round(box.height * NUMERAL_BASE);
  const numeralTop = numeralBase - sizes.countdown * (1 + NUMERAL_DEPTH);
  const lightsH = sizes.lightsW * LIGHTS_HEIGHT;
  const lightsTop = Math.max(box.safe.top + (landscape ? 4 : 10), numeralTop - (landscape ? 8 : 14) - lightsH);

  return { lightsTop, lightsBottom: lightsTop + lightsH, numeralTop, numeralBase };
}

/**
 * The start: the light gantry (red, red, amber, then all green) and the countdown numerals punching in under it, then
 * GO bursting away, and the magenta LAUNCH BOOST chip stamped under GO for a throttle held on GO. GO is gone and the
 * gantry has lifted away within 0.7 s, so neither hangs over the launch. Everything stays over the player's truck: a
 * numeral stands on its baseline, so its punch and GO's burst grow up and out, away from the chip under it.
 */
export class CountdownView extends Container {
  /** The light gantry, layered apart so the first-race card can sit over it and under the numerals */
  public readonly gantry = new Container();
  private readonly _lights = new Sprite();
  private readonly _flash = new Sprite();
  private readonly _numeral = new Sprite();
  private readonly _launch = new Container();
  private readonly _launchPlate = new Sprite();
  private readonly _launchWord: Text;
  private readonly _services: HudServices;
  private _scene: HudScene | null = null;
  private _step = -1;
  private _lightsX = 0;
  private _lightsY = 0;
  private _launchX = 0;
  private _launchY = 0;
  private _launchW = 0;
  private _launchH = 0;

  constructor(services: HudServices) {
    super();
    this._services = services;
    this._flash.blendMode = 'add';
    this._flash.visible = false;
    this._launchWord = hudText({ ...BOARD_900, spacing: 1 }, 30, 0xffffff, 'LAUNCH BOOST');
    this._launch.addChild(this._launchPlate, this._launchWord);
    this._lights.visible = false;
    this._numeral.visible = false;
    this._launch.visible = false;
    this.gantry.addChild(this._lights, this._flash);
    this.addChild(this._numeral, this._launch);
  }

  /**
   * Lays the start out.
   * @param scene - The layout.
   * @param plateRight - Right edge of the timing plate: in landscape the gantry shares the top row with it.
   */
  public layout(scene: HudScene, plateRight: number): void {
    this._scene = scene;
    const start = scene.start;

    if (!start) return;
    const { box, sizes, spec } = scene;
    const d = box.kind === 'desktop';
    const frame = startFrame(box, sizes);
    const lightsArt = start.art('lights0');
    const lf = faceOf(lightsArt);
    let lightsLeft = (box.width - lf.w) / 2;

    // Over the numerals where the top row leaves room, else nudged clear of the timing plate and the pause button
    if (box.kind === 'landscape') {
      lightsLeft = Math.max(plateRight + 8, Math.min(lightsLeft, landscapePauseX(box, spec) - 8 - lf.w));
    }
    this._lightsX = lightsLeft - lf.x;
    this._lightsY = frame.lightsTop - lf.y;
    this._services.motion.kill(this._lights.position, this._lights.skew, this._launch.position, this._launch.skew);
    this._lights.skew.set(0, 0);
    this._launch.skew.set(0, 0);
    this._lights.position.set(this._lightsX, this._lightsY);
    this._flash.position.set(this._lightsX, this._lightsY);
    this._lights.texture = start.texture(this._lightsKey());
    this._flash.texture = this._lights.texture;
    const numeralArt = start.art('n3');
    const nf = faceOf(numeralArt);

    this._numeral.anchor.set(
      (nf.x + nf.w / 2) / numeralArt.width,
      (nf.y + nf.h * (1 + NUMERAL_DEPTH)) / numeralArt.height,
    );
    this._numeral.position.set(box.width / 2, frame.numeralBase);
    if (this._step >= 0) this._numeral.texture = start.texture(STEP_KEYS[this._step]);
    const launch = start.art('launch');
    const c = launch.content ?? faceOf(launch);

    this._launchPlate.texture = start.texture('launch');
    atFace(this._launchPlate, launch, -sizes.launchW / 2, -sizes.launchH / 2);
    resize(this._launchWord, d ? 30 : 24);
    placeMiddle(this._launchWord, this._launchPlate.x + c.x + c.w / 2, this._launchPlate.y + c.y + c.h / 2 + 1);
    this._launchX = box.width / 2;
    this._launchY = frame.numeralBase + LAUNCH_GAP + sizes.launchH / 2;
    this._launchW = sizes.launchW;
    this._launchH = sizes.launchH;
    this._launch.position.set(this._launchX, this._launchY);
  }

  /** The gantry on the grid, lamps out */
  public showGrid(): void {
    this._step = -1;
    this._numeral.visible = false;
    this._launch.visible = false;
    if (this._scene?.start) this._lights.texture = this._scene.start.texture('lights0');
    this._services.motion.slot(this._lights, this._lightsX, this._lightsY, 0, -40);
  }

  /** One step: 3, 2, 1, or 0 for GO */
  public show(step: 3 | 2 | 1 | 0): void {
    const start = this._scene?.start;

    if (!start) return;
    const motion = this._services.motion;

    this._step = step;
    motion.kill(this._lights, this._lights.position);
    this._lights.visible = true;
    this._lights.alpha = 1;
    this._lights.position.set(this._lightsX, this._lightsY);
    this._lights.texture = start.texture(this._lightsKey());
    this._flash.texture = this._lights.texture;
    motion.kill(this._flash);
    this._flash.visible = true;
    this._flash.alpha = 0.85;
    motion.to(this._flash, { alpha: 0, duration: 0.3, ease: 'power2.out', onComplete: this._hideFlash });
    const n = this._numeral;

    motion.kill(n, n.scale);
    n.texture = start.texture(STEP_KEYS[step]);
    n.visible = true;
    n.alpha = 1;
    if (step > 0) {
      motion.punch(n, 1.6);
      motion.to(n, { alpha: 0, delay: 0.62, duration: 0.18, ease: 'power1.in' });

      return;
    }
    if (motion.reduced) {
      n.scale.set(1);
      motion.to(n, { alpha: 0, delay: GO_IN, duration: GO_OUT, onComplete: this._hideNumeral });
    } else {
      n.scale.set(1.6);
      motion.to(n.scale, { x: 1, y: 1, duration: GO_IN, ease: 'back.out(2.5)' });
      motion.to(n.scale, { x: GO_GROW, y: GO_GROW, delay: GO_IN, duration: GO_OUT, ease: 'power2.out' });
      motion.to(n, { alpha: 0, delay: GO_IN, duration: GO_OUT, ease: 'power1.in', onComplete: this._hideNumeral });
    }
    motion.whip(this._lights, 0, -50, GO_IN + 0.2);
  }

  /** LAUNCH BOOST stamps down under GO as GO lands, holds 0.9 s and whips out */
  public launchBoost(): void {
    const motion = this._services.motion;
    const v = this._launch;

    if (!this._scene?.start) return;
    motion.kill(v, v.scale, v.position, v.skew);
    v.position.set(this._launchX, this._launchY);
    v.skew.set(0, 0);
    v.visible = true;
    v.alpha = 0;
    motion.to(v, { alpha: 1, delay: LAUNCH_AT, duration: 0.05 });
    motion.punch(v, 1.35, LAUNCH_AT);
    motion.whip(v, 60, 0, LAUNCH_AT + 0.9);
  }

  /** Whether a box (box px) meets the numeral or the LAUNCH BOOST chip while they show, so name tags keep off them */
  public blocks(left: number, top: number, w: number, h: number): boolean {
    const n = this._numeral;

    if (n.visible && n.alpha > 0.05) {
      const nx = n.x - n.width * n.anchor.x;
      const ny = n.y - n.height * n.anchor.y;

      if (left < nx + n.width && left + w > nx && top < ny + n.height && top + h > ny) return true;
    }
    if (!this._launch.visible || this._launch.alpha < 0.05) return false;
    const lx = this._launch.x - this._launchW / 2;
    const ly = this._launch.y - this._launchH / 2;

    return left < lx + this._launchW && left + w > lx && top < ly + this._launchH && top + h > ly;
  }

  /** Hides everything at once */
  public clear(): void {
    this._services.motion.kill(this._lights, this._numeral, this._launch, this._flash);
    this._lights.visible = false;
    this._numeral.visible = false;
    this._launch.visible = false;
    this._flash.visible = false;
    this._step = -1;
  }

  /** Lets go of the start atlas's textures before it is freed */
  public unbind(): void {
    this.clear();
    this._scene = null;
    for (const s of [this._lights, this._flash, this._numeral, this._launchPlate]) s.texture = Texture.EMPTY;
  }

  private _lightsKey(): string {
    const s = this._step;

    return s === 0 ? 'lightsGo' : s > 0 ? `lights${4 - s}` : 'lights0';
  }

  private readonly _hideFlash = (): void => {
    this._flash.visible = false;
  };

  private readonly _hideNumeral = (): void => {
    this._numeral.visible = false;
  };
}
