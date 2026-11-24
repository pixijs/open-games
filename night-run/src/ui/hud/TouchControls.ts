import type { FederatedPointerEvent, Text, Texture } from 'pixi.js';
import { Container, Point, Rectangle, Sprite } from 'pixi.js';

import type { StickInput, UiActions } from '../contract';
import { HudButton } from './HudButton';
import type { HudScene, HudServices } from './scene';
import { atAnchor } from './sprites';
import { hudText, LABEL, place } from './text';

/** Share of the screen height, from the top, above which the stick zone starts */
const ZONE_TOP = 0.45;
const REST_ALPHA = 0.7;

/**
 * The touch controls: a floating stick for the left thumb, and the camera button
 * for the right. The stick rests in the bottom-left corner, jumps to wherever the left thumb lands in the left half of
 * the lower 55 % of the screen, and slides home when the thumb lifts. It reports the knob's offset
 * as {@link StickInput}: x right, y up the screen, each -1 to 1 over half the base's width.
 */
export class TouchControls extends Container {
  private readonly _zone = new Container();
  private readonly _base = new Sprite();
  private readonly _knob = new Sprite();
  private readonly _camera: HudButton;
  private readonly _cameraLabel: Text;
  private readonly _services: HudServices;
  private readonly _actions: Pick<UiActions, 'cycleCamera'>;
  private readonly _local = new Point();
  private _knobIdle: Texture | null = null;
  private _knobDown: Texture | null = null;
  private _pointer = -1;
  private _restX = 0;
  private _restY = 0;
  private _originX = 0;
  private _originY = 0;
  private _travel = 1;
  private _boxW = 0;
  private _boxH = 0;
  private readonly _stick = { active: false, x: 0, y: 0 };
  private _onTouch: (() => void) | null = null;
  private _label = '';

  constructor(services: HudServices, actions: Pick<UiActions, 'cycleCamera'>) {
    super();
    this._services = services;
    this._actions = actions;
    this._camera = new HudButton(this._onCamera);
    this._camera.label = 'camera';
    this._cameraLabel = hudText(LABEL, 12);
    this._cameraLabel.alpha = 0.8;
    this._zone.eventMode = 'static';
    this._zone.on('pointerdown', this._onDown);
    this._zone.on('globalpointermove', this._onMove);
    this._zone.on('pointerup', this._onUp);
    this._zone.on('pointerupoutside', this._onUp);
    this._zone.on('pointercancel', this._onUp);
    this._base.alpha = REST_ALPHA;
    this._knob.alpha = REST_ALPHA;
    this.addChild(this._zone, this._base, this._knob, this._camera, this._cameraLabel);
  }

  /** The stick's base and the camera button, for keeping name tags off them */
  public get pads(): readonly Container[] {
    return [this._base, this._camera];
  }

  /** What the game's Controls read */
  public get stick(): StickInput {
    return this._stick;
  }

  /** Called on the first touch the stick zone sees, so the HUD can switch to touch mode */
  public set onTouch(fn: (() => void) | null) {
    this._onTouch = fn;
  }

  public layout(scene: HudScene): void {
    const { box, spec, hud } = scene;
    const portrait = box.kind === 'portrait';
    const bs = spec.stick;

    this._boxW = box.width;
    this._boxH = box.height;
    this._zone.hitArea = new Rectangle(0, box.height * ZONE_TOP, box.width / 2, box.height * (1 - ZONE_TOP));
    this._restX = box.safe.left + bs / 2;
    this._restY = box.height - box.safe.bottom - bs / 2 - (portrait ? 6 : 0);
    this._travel = bs / 2;
    this._base.texture = hud.texture('stick');
    this._knobIdle = hud.texture('knob');
    this._knobDown = hud.texture('knobDown');
    this._knob.texture = this._stick.active ? this._knobDown : this._knobIdle;
    atAnchor(this._base, hud.art('stick'), this._restX, this._restY);
    atAnchor(this._knob, hud.art('knob'), this._restX, this._restY);
    if (!this._stick.active) this._home(false);
    const cs = spec.camera;
    const cx = box.width - box.safe.right - cs - (portrait ? 0 : 4);
    const cy = box.height - box.safe.bottom - cs - (portrait ? 6 : 0);

    this._camera.setArt(hud.art('cam'), hud.texture('cam'), hud.texture('camDown'), cx, cy);
    place(this._cameraLabel, cx + cs / 2, cy - 17, 'center');
  }

  /** The camera's name by its button */
  public setCameraLabel(label: string): void {
    if (label === this._label) return;
    this._label = label;
    this._cameraLabel.text = label;
  }

  /** Shows or hides the drawn controls; the stick zone keeps listening so a touch can bring them back */
  public setShown(shown: boolean): void {
    this._base.visible = shown;
    this._knob.visible = shown;
    this._camera.visible = shown;
    this._cameraLabel.visible = shown;
    if (!shown) this.release();
  }

  /** Lets go of the stick */
  public release(): void {
    if (this._pointer < 0) return;
    this._pointer = -1;
    this._stick.active = false;
    this._stick.x = 0;
    this._stick.y = 0;
    if (this._knobIdle) this._knob.texture = this._knobIdle;
    this._home(true);
  }

  public override destroy(): void {
    this._zone.off('pointerdown', this._onDown);
    this._zone.off('globalpointermove', this._onMove);
    this._zone.off('pointerup', this._onUp);
    this._zone.off('pointerupoutside', this._onUp);
    this._zone.off('pointercancel', this._onUp);
    this._onTouch = null;
    super.destroy({ children: true });
  }

  private _home(animate: boolean): void {
    const motion = this._services.motion;

    motion.kill(this._base.position, this._knob.position, this._base, this._knob);
    if (animate && !motion.reduced) {
      motion.to(this._base.position, { x: this._restX, y: this._restY, duration: 0.18, ease: 'power2.out' });
      motion.to(this._knob.position, { x: this._restX, y: this._restY, duration: 0.18, ease: 'power2.out' });
      motion.to(this._base, { alpha: REST_ALPHA, duration: 0.18 });
      motion.to(this._knob, { alpha: REST_ALPHA, duration: 0.18 });
    } else {
      this._base.position.set(this._restX, this._restY);
      this._knob.position.set(this._restX, this._restY);
      this._base.alpha = REST_ALPHA;
      this._knob.alpha = REST_ALPHA;
    }
  }

  private readonly _onDown = (e: FederatedPointerEvent): void => {
    if (this._pointer >= 0) return;
    if (e.pointerType !== 'touch' && !this._base.visible) return;
    this._onTouch?.();
    this._pointer = e.pointerId;
    this.toLocal(e.global, undefined, this._local);
    const r = this._travel;

    this._originX = Math.min(this._boxW / 2 - r, Math.max(r + 4, this._local.x));
    this._originY = Math.min(this._boxH - r - 4, Math.max(this._boxH * ZONE_TOP + r * 0.5, this._local.y));
    const motion = this._services.motion;

    motion.kill(this._base.position, this._knob.position, this._base, this._knob);
    this._base.position.set(this._originX, this._originY);
    this._base.alpha = 1;
    this._knob.alpha = 1;
    if (this._knobDown) this._knob.texture = this._knobDown;
    this._stick.active = true;
    this._follow();
  };

  private readonly _onMove = (e: FederatedPointerEvent): void => {
    if (e.pointerId !== this._pointer) return;
    this.toLocal(e.global, undefined, this._local);
    this._follow();
  };

  private readonly _onUp = (e: FederatedPointerEvent): void => {
    if (e.pointerId !== this._pointer) return;
    this.release();
  };

  private _follow(): void {
    let dx = (this._local.x - this._originX) / this._travel;
    let dy = (this._local.y - this._originY) / this._travel;
    const mag = Math.sqrt(dx * dx + dy * dy);

    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    this._stick.x = dx;
    this._stick.y = -dy;
    this._knob.position.set(this._originX + dx * this._travel, this._originY + dy * this._travel);
  }

  private readonly _onCamera = (): void => {
    this._actions.cycleCamera();
    this._services.sound.play('tick');
  };
}
