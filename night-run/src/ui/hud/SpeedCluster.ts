import type { Text, Texture } from 'pixi.js';
import { Container, Sprite } from 'pixi.js';

import { SPEED_REDLINE, SPEED_SEGMENTS, speedDialGeometry } from '../art/hud';
import type { HudFrame } from '../contract';
import { DigitReadout } from './DigitReadout';
import type { HudScene, HudServices } from './scene';
import { atAnchor, atFace } from './sprites';
import { hudText, LABEL, place, resize } from './text';

/** km/h that fills the dial */
const FULL_KMH = 200;
const STRIP_SEGMENTS = 12;
const STRIP_REDLINE = 10;

/**
 * Speed and drift charge: the octagonal dial with 24 lit segments on desktop, tablet and landscape, or the phone
 * strip (the number over 12 segments) in portrait, each with a three-chevron charge meter. Segments go white-hot while
 * boosting and dip on a hit; the chevrons fill one after another in blue as a held slide charges the ultra boost, then
 * turn purple and pulse once it's ready.
 */
export class SpeedCluster extends Container {
  private readonly _body = new Container();
  private readonly _plate = new Sprite();
  private readonly _wells: Sprite[] = [];
  private readonly _segments: Sprite[] = [];
  private readonly _speed = new DigitReadout(3);
  private readonly _unit: Text;
  private readonly _chevBase: Sprite[] = [];
  private readonly _chevLit: Sprite[] = [];
  private readonly _services: HudServices;
  private _on: Texture | null = null;
  private _hot: Texture | null = null;
  private _boost: Texture | null = null;
  private _chevOn: Texture | null = null;
  private _chevReady: Texture | null = null;
  private _count = 0;
  private _redline = SPEED_REDLINE;
  private _lit = -1;
  private _white = false;
  /** Chevrons full at the last frame, 0 to 3; 3 is the ultra ready. */
  private _filled = -1;
  private _pulse = 0;
  private _dip = 0;
  private _flash = 0;
  private _chevScale = 1;

  constructor(services: HudServices) {
    super();
    this._services = services;
    this._unit = hudText(LABEL, 13, 0xffffff, 'km/h');
    this._unit.alpha = 0.8;
    this.addChild(this._body);
    this._body.addChild(this._plate);
    for (let i = 0; i < SPEED_SEGMENTS; i++) {
      const well = new Sprite();
      const seg = new Sprite();

      well.anchor.set(0.5);
      seg.anchor.set(0.5);
      well.visible = false;
      seg.visible = false;
      this._wells.push(well);
      this._segments.push(seg);
    }
    this._body.addChild(...this._wells, ...this._segments, this._speed, this._unit);
    for (let t = 0; t < 3; t++) {
      const base = new Sprite();
      const lit = new Sprite();

      base.anchor.set(0.5);
      lit.anchor.set(0.5);
      lit.alpha = 0;
      this._chevBase.push(base);
      this._chevLit.push(lit);
      this._body.addChild(base, lit);
    }
  }

  /**
   * Lays the cluster out.
   * @param scene - The layout.
   * @param cx - Centre x of the dial, or of the strip.
   * @param cy - Centre y of the dial, or the strip's top.
   */
  public layout(scene: HudScene, cx: number, cy: number): void {
    const { hud, spec } = scene;

    this._on = hud.texture('segOn');
    this._hot = hud.texture('segHot');
    this._boost = hud.texture('segBoost');
    this._chevOn = hud.texture('chevOn');
    this._chevReady = hud.texture('chevReady');
    for (let t = 0; t < 3; t++) {
      this._chevBase[t].texture = hud.texture('chevOff');
      this._chevLit[t].texture = this._filled >= 3 ? this._chevReady : this._chevOn;
    }
    if (spec.dial) {
      const size = spec.dial;
      const art = hud.art('dial');
      const left = cx - art.width / 2;
      const top = cy - art.height / 2;
      const geo = speedDialGeometry(size);

      this._plate.texture = hud.texture('dial');
      atAnchor(this._plate, art, cx, cy);
      this._count = SPEED_SEGMENTS;
      this._redline = SPEED_REDLINE;
      for (let i = 0; i < SPEED_SEGMENTS; i++) {
        const seg = this._segments[i];

        seg.position.set(left + geo[i].x, top + geo[i].y);
        seg.rotation = geo[i].rotation;
        this._wells[i].visible = false;
      }
      this._speed.align = 'center';
      this._speed.setFont(scene.heavy, size * 0.36);
      this._speed.position.set(cx, cy - size * 0.24);
      resize(this._unit, Math.max(12, Math.round(size * 0.085)));
      place(this._unit, cx, cy + size * 0.13, 'center');
      const cs = size * 0.13;

      this._chevScale = 1;
      for (let t = 0; t < 3; t++) {
        this._chevBase[t].position.set(cx + (t - 1) * cs * 0.95, cy + size * 0.36);
        this._chevLit[t].position.copyFrom(this._chevBase[t].position);
      }
    } else {
      const art = hud.art('strip');
      const top = cy;

      this._plate.texture = hud.texture('strip');
      atFace(this._plate, art, cx - 66, top);
      this._count = STRIP_SEGMENTS;
      this._redline = STRIP_REDLINE;
      const off = hud.texture('segOff');

      for (let i = 0; i < SPEED_SEGMENTS; i++) {
        const visible = i < STRIP_SEGMENTS;
        const x = cx - (STRIP_SEGMENTS - 1) * 4 + i * 8;

        this._wells[i].texture = off;
        this._wells[i].visible = visible;
        this._wells[i].position.set(x, top + 60);
        this._segments[i].position.set(x, top + 60);
        this._segments[i].rotation = 0;
      }
      this._speed.align = 'right';
      this._speed.setFont(scene.heavy, 40);
      this._speed.position.set(cx + 2, top + 8);
      resize(this._unit, 13);
      place(this._unit, cx + 8, top + 30);
      this._chevScale = 1;
      for (let t = 0; t < 3; t++) {
        this._chevBase[t].position.set(cx + (t - 1) * 14, top + 80);
        this._chevLit[t].position.copyFrom(this._chevBase[t].position);
      }
    }
    // Lit segments still hold the last atlas's textures, freed by now: the next update lights them again.
    for (const seg of this._segments) seg.visible = false;
    this._lit = -1;
  }

  /** A new race: the next charge seen is taken as it is, without a punch */
  public reset(): void {
    this._filled = -1;
    this._dip = 0;
    this._flash = 0;
  }

  /** Throttle held on GO: the segments flash white for half a second */
  public flash(): void {
    this._flash = 0.5;
  }

  /** A hit: the lit segments dip by `amount` and refill over 0.3 s */
  public dip(amount: number): void {
    this._dip = Math.max(this._dip, Math.min(1, amount));
  }

  /** Per frame: the readout, the segments and the chevrons */
  public update(frame: HudFrame, dt: number): void {
    this._speed.showInt(frame.speedKmh);
    this._dip = Math.max(0, this._dip - dt / 0.3);
    this._flash = Math.max(0, this._flash - dt);
    const fill = Math.min(1, Math.max(0, frame.speedKmh / FULL_KMH)) * (1 - this._dip * 0.6);
    const lit = Math.round(fill * this._count);
    const white = frame.boosting || this._flash > 0;

    if (lit !== this._lit || white !== this._white) {
      this._lit = lit;
      this._white = white;
      for (let i = 0; i < this._count; i++) {
        const seg = this._segments[i];

        seg.visible = i < lit;
        if (i < lit) seg.texture = (white ? this._boost : i >= this._redline ? this._hot : this._on) ?? seg.texture;
      }
    }
    this._charge(frame.charge, dt);
    const motion = this._services.motion;
    const shaking = frame.boosting && !motion.reduced;

    this._body.x = shaking ? Math.sin(performance.now() * 0.09) * 2 : 0;
  }

  /** The meter: each chevron is a third of the charge; a full one punches and ticks, and the third makes it ready */
  private _charge(charge: number, dt: number): void {
    const motion = this._services.motion;
    const filled = Math.min(3, Math.floor(charge * 3 + 1e-6));

    if (filled !== this._filled) {
      const ready = filled >= 3;

      if (this._filled >= 0 && filled > this._filled) {
        motion.punch(this._chevLit[filled - 1], 1.4, 0, this._chevScale);
        if (ready) {
          for (let t = 0; t < 2; t++) motion.punch(this._chevLit[t], 1.25, 0, this._chevScale);
        }
        this._services.sound.play(ready ? 'chargeReady' : 'chargeTick', filled);
      }
      for (let t = 0; t < 3; t++) {
        this._chevLit[t].texture = (ready ? this._chevReady : this._chevOn) ?? this._chevLit[t].texture;
        if (!ready) this._chevLit[t].scale.set(this._chevScale);
      }
      this._filled = filled;
    }
    this._pulse = filled >= 3 ? this._pulse + dt : 0;
    const pulse = filled >= 3 && !motion.reduced ? 1 + 0.12 * Math.max(0, Math.sin(this._pulse * Math.PI * 8)) : 1;

    for (let t = 0; t < 3; t++) {
      const lit = this._chevLit[t];

      lit.alpha = Math.min(1, Math.max(0, charge * 3 - t));
      if (filled >= 3) lit.scale.set(this._chevScale * pulse);
    }
  }
}
