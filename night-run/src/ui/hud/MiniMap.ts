import type { Texture } from 'pixi.js';
import { Container, Sprite } from 'pixi.js';

import { minimapFit, minimapTrackSvg } from '../art/hud';
import type { Pt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';
import type { HudFrame, TrackOutline } from '../contract';
import { ArtTexture } from './ArtTexture';
import { mapWidth } from './layout';
import type { HudScene } from './scene';
import { atFace } from './sprites';

/** A world x, z turned `rot` quarter turns clockwise, as the track's author's board turned it. */
function turnBy(x: number, z: number, rot: number): [number, number] {
  switch (rot) {
    case 1:
      return [-z, x];
    case 2:
      return [-x, -z];
    case 3:
      return [z, -x];
    default:
      return [x, z];
  }
}

/**
 * The mini-map: the track fitted into a smoked frame, the others as discs with their place digit, you as an arrow in a
 * cyan ring turned to your heading. A custom track is turned the way its author's board drew it (`TrackOutline.rot`),
 * so it looks as it does in the editor and on its card; Night Run turns a quarter when that fills the tall frame
 * better. The view stays a true top-down one, never mirrored, so a left-hander bends left.
 */
export class MiniMap extends Container {
  private readonly _frame = new Sprite();
  private readonly _track = new Sprite();
  private readonly _dots: Sprite[] = [];
  private readonly _dotTextures: Texture[][] = [[], [], [], []];
  private readonly _youTextures: Texture[] = [];
  private readonly _trackTexture: ArtTexture;
  private readonly _shownPlace = new Int8Array(4);
  private readonly _shownCar = new Int8Array(4);
  private _points: Pt[] | null = null;
  private _rotate = false;
  /** The author's board turn, applied before the fit's. */
  private _rot = 0;
  private _trackScale = 1;
  private _fitX = 0;
  private _fitY = 0;
  private _fitScale = 1;
  private _faceX = 0;
  private _faceY = 0;
  private _width = 0;
  private _height = 0;

  /** @param textures - Draws the track art. */
  constructor(textures: SvgTextures) {
    super();
    this._trackTexture = new ArtTexture(textures, this._track);
    this.addChild(this._frame, this._track);
    for (let i = 0; i < 4; i++) {
      const dot = new Sprite();

      dot.anchor.set(0.5);
      dot.visible = false;
      this._dots.push(dot);
      this.addChild(dot);
    }
  }

  /** Box px of the frame's face, for the parts placed beside it */
  public get faceX(): number {
    return this._faceX;
  }

  public get faceY(): number {
    return this._faceY;
  }

  /**
   * Lays the map out with its frame's face top-left at x, y.
   * @param scene - The layout.
   * @param x - Face left in box px.
   * @param y - Face top in box px.
   */
  public layout(scene: HudScene, x: number, y: number): void {
    const { hud, spec } = scene;
    const art = hud.art('frame');

    this._faceX = x;
    this._faceY = y;
    this._frame.texture = hud.texture('frame');
    atFace(this._frame, art, x, y);
    for (let c = 0; c < 4; c++) {
      this._youTextures[c] = hud.texture(`you${c}`);
      for (let p = 1; p <= 4; p++) this._dotTextures[c][p - 1] = hud.texture(`dot${c}${p}`);
    }
    // The dots still hold the last atlas's textures, freed by now: hide them until the next update paints them again.
    for (const dot of this._dots) dot.visible = false;
    this._shownPlace.fill(0);
    this._shownCar.fill(-1);
    const w = mapWidth(spec.map);
    const h = spec.map;

    const density = Math.max(1, scene.box.scale);

    if (w !== this._width || h !== this._height || density !== this._trackScale) {
      this._width = w;
      this._height = h;
      this._trackScale = density;
      this._drawTrack();
    }
    this._track.position.set(x, y);
  }

  /** The track to draw; points are the centreline from the outline's finish index */
  public setTrack(outline: TrackOutline): void {
    const src = outline.points;
    const count = src.length / 2;
    const plain: Pt[] = [];
    const turned: Pt[] = [];

    this._rot = outline.rot ?? 0;

    for (let i = 0; i < count; i++) {
      const j = ((i + outline.finishIndex) % count) * 2;
      const [x, y] = turnBy(src[j], src[j + 1], this._rot);

      plain.push({ x, y });
      turned.push({ x: -y, y: x });
    }
    const w = this._width || 100;
    const h = this._height || 128;

    // A custom track is drawn as its author's board drew it, as the library and the editor show it; Night Run, with no
    // turn of its own, turns a quarter when that fills the tall frame better.
    this._rotate = outline.rot === undefined && minimapFit(turned, w, h).scale > minimapFit(plain, w, h).scale * 1.05;
    this._points = this._rotate ? turned : plain;
    this._drawTrack();
  }

  /** Per frame: every racer's dot */
  public update(frame: HudFrame): void {
    for (let i = 0; i < 4; i++) {
      const dot = this._dots[i];
      const r = frame.racers[i];

      if (!this._points || !r || !r.active || !this._dotTextures[0][0]) {
        dot.visible = false;
        continue;
      }
      dot.visible = true;
      if (r.isYou) {
        if (this._shownPlace[i] !== -1 || this._shownCar[i] !== r.car) {
          dot.texture = this._youTextures[r.car];
          this._shownPlace[i] = -1;
          this._shownCar[i] = r.car;
        }
        const [hx, hz] = turnBy(Math.sin(r.yaw), Math.cos(r.yaw), this._rot);
        const fx = this._rotate ? -hz : hx;
        const fy = this._rotate ? hx : hz;

        dot.rotation = Math.atan2(fx, -fy);
      } else {
        const place = Math.min(4, Math.max(1, r.place));

        if (this._shownPlace[i] !== place || this._shownCar[i] !== r.car) {
          dot.texture = this._dotTextures[r.car][place - 1];
          this._shownPlace[i] = place;
          this._shownCar[i] = r.car;
        }
        dot.rotation = 0;
      }
      const [ux, uz] = turnBy(r.x, r.z, this._rot);
      const mx = this._rotate ? -uz : ux;
      const my = this._rotate ? ux : uz;

      dot.position.set(this._faceX + this._fitX + mx * this._fitScale, this._faceY + this._fitY + my * this._fitScale);
    }
    const you = this._youIndex(frame);

    if (you >= 0 && this.children[this.children.length - 1] !== this._dots[you]) {
      this.addChild(this._dots[you]);
    }
  }

  public override destroy(): void {
    this._trackTexture.clear();
    this._points = null;
    super.destroy({ children: true });
  }

  private _youIndex(frame: HudFrame): number {
    for (let i = 0; i < 4; i++) if (frame.racers[i]?.active && frame.racers[i].isYou) return i;

    return -1;
  }

  private _drawTrack(): void {
    if (!this._points || !this._width) return;
    const art = minimapTrackSvg(this._points, this._width, this._height);
    const fit = minimapFit(this._points, this._width, this._height);

    this._fitX = fit.x;
    this._fitY = fit.y;
    this._fitScale = fit.scale;
    void this._trackTexture.set(art, this._trackScale);
  }
}
