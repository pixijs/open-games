import type { Text } from 'pixi.js';
import { Container, Sprite } from 'pixi.js';

import type { UiActions } from '../contract';
import { ordinal } from './Callouts';
import { HudButton } from './HudButton';
import type { HudScene, HudServices } from './scene';
import { atFace, faceOf } from './sprites';
import { BODY, BOARD_800, fit, hudText, INK, LABEL, MIST, NAME, place } from './text';

/**
 * What a spectator sees in place of the HUD: the watching chip at the top ("Watching Jun, 1st"), arrows to switch
 * who they watch, and the line saying they race in the next one. The line sits between the arrows at the bottom, under
 * the watched truck; on a phone in landscape, where the truck fills the bottom of a short screen, it goes under the
 * chip instead. A switch whips the name out and slots the new one in.
 */
export class SpectatePanel extends Container {
  private readonly _chip = new Container();
  private readonly _plate = new Sprite();
  private readonly _label: Text;
  private readonly _watching: Text;
  private readonly _back: HudButton;
  private readonly _forward: HudButton;
  private readonly _line: Text;
  private readonly _help: Text;
  private readonly _services: HudServices;
  private _scene: HudScene | null = null;
  private _name = '';
  private _place = 0;
  private _lap = -1;
  private _laps = -1;
  private _touch = false;
  private _textX = 0;
  private _textY = 0;
  private _textMax = 200;

  constructor(services: HudServices, actions: Pick<UiActions, 'spectateNext'>) {
    super();
    this._services = services;
    this._label = hudText(LABEL, 12, MIST, 'Spectating');
    this._watching = hudText(NAME, 19);
    this._chip.addChild(this._plate, this._label, this._watching);
    const next = (): void => actions.spectateNext();

    this._back = new HudButton(next);
    this._forward = new HudButton(next);
    this._back.label = 'previous racer';
    this._forward.label = 'next racer';
    this._line = hudText(BOARD_800, 24, 0xffffff, 'You race in the next one.');
    this._help = hudText(BODY, 14);
    this._help.alpha = 0.85;
    this._help.style.dropShadow = { color: INK, alpha: 0.9, blur: 9, distance: 1, angle: Math.PI / 2 };
    this._help.style.padding = 12;
    this._help.style.align = 'center';
    this.addChild(this._chip, this._back, this._forward, this._line, this._help);
    this.visible = false;
  }

  public layout(scene: HudScene): void {
    this._scene = scene;
    const { box, sizes, hud } = scene;
    const d = box.kind === 'desktop';
    const s = box.safe;
    const W = box.width;
    const art = hud.art('spec');
    const f = faceOf(art);
    const c = art.content ?? f;

    this._plate.texture = hud.texture('spec');
    atFace(this._plate, art, 0, 0);
    this._chip.position.set(d ? (W - sizes.specW) / 2 : s.left, s.top);
    place(this._label, c.x - f.x, d ? 9 : 8);
    this._textX = c.x - f.x;
    this._textY = d ? 26 : 23;
    this._textMax = c.w - 6;
    this._watching.style.fontSize = d ? 19 : 17;
    place(this._watching, this._textX, this._textY);
    const by = box.height - s.bottom - sizes.arrow;
    const bw = sizes.arrow;
    // On desktop the arrows flank the lines between them, with room either side of the 340 px help line
    const spread = 240;

    this._back.setArt(hud.art('back'), hud.texture('back'), hud.texture('backDown'), d ? W / 2 - spread : s.left, by);
    this._forward.setArt(
      hud.art('fwd'),
      hud.texture('fwd'),
      hud.texture('fwdDown'),
      d ? W / 2 + spread - bw : W - s.right - bw - 4,
      by,
    );
    this._help.style.wordWrap = true;
    if (box.kind === 'landscape') {
      const x = s.left + 4;
      const top = s.top + sizes.specH + 10;

      this._line.style.fontSize = 16;
      place(this._line, x, top);
      this._help.style.fontSize = 12;
      this._help.style.align = 'left';
      this._help.style.wordWrapWidth = sizes.specW - 8;
      place(this._help, x, top + 22);
    } else {
      this._line.style.fontSize = d ? 24 : 20;
      place(this._line, W / 2, by + (d ? 4 : 2), 'center');
      this._help.style.fontSize = d ? 14 : 12;
      this._help.style.align = 'center';
      this._help.style.wordWrapWidth = d ? 340 : W - 160;
      place(this._help, W / 2, by + (d ? 34 : 28), 'center');
    }
    this._lap = -1;
    this._name = '';
  }

  /** Shows or hides the panel */
  public setShown(on: boolean): void {
    const motion = this._services.motion;

    if (on === this.visible) return;
    if (on) {
      this.visible = true;
      motion.fadeIn(this);
      if (this._scene) motion.slot(this._chip, this._chip.x, this._chip.y, 0, -30);
    } else motion.fadeOut(this);
  }

  /**
   * Who is being watched and in what place; a new name whips the old one out.
   * @param name - Their name.
   * @param place - Their place.
   * @param animate - A switch rather than the first show.
   */
  public watch(name: string, place: number, animate: boolean): void {
    if (name === this._name && place === this._place) return;
    const switched = animate && this._name !== '' && name !== this._name;

    this._name = name;
    this._place = place;
    const value = place > 0 ? `Watching ${name}, ${ordinal(place)}` : `Watching ${name}`;
    const motion = this._services.motion;
    const t = this._watching;

    if (!switched) {
      fit(t, value, Number(t.style.fontSize), this._textMax);

      return;
    }
    motion.kill(t, t.position, t.skew);
    motion.to(t.position, { x: this._textX - 40, duration: 0.15, ease: 'expo.in' });
    motion.to(t, {
      alpha: 0,
      duration: 0.15,
      onComplete: () => {
        fit(t, value, Number(t.style.fontSize), this._textMax);
        t.alpha = 1;
        motion.slot(t, this._textX, t.y, 30, 0);
      },
    });
  }

  /** The lap line, and how to switch: tap the arrows on touch, click them or press V with a mouse and keys */
  public setLap(lap: number, laps: number, touch: boolean): void {
    if (lap === this._lap && laps === this._laps && touch === this._touch) return;
    this._lap = lap;
    this._laps = laps;
    this._touch = touch;

    this._help.text = `Lap ${Math.max(1, Math.min(lap, laps))} of ${laps}. ${touch ? 'Tap the arrows to switch.' : 'Click the arrows or press V to switch.'}`;
  }
}
