import type { Mesh3D, PointLight, Scene3DSource, SpotLight } from '@pixi/3d';
import { Container3D } from '@pixi/3d';
import type { Texture } from 'pixi.js';

import type { Occluders } from '../Occluders';
import type { Route } from '../race/route';
import type { VenuePlan } from '../track/plan';
import type { LensFx } from './LensFx';
import { CollabLockup } from './set/CollabLockup';
import { createHaloTexture, createLamp, createLampTexture, Floodlights } from './set/Floodlights';
import { createSpill, Neon } from './set/Neon';
import { WetTrack } from './set/WetTrack';

/** The set's lights, on every track: six lamps for the floodlight towers, and three neon spills. */
const LAMPS = 6;
const SPILLS = 3;
/** The spot lights on the logos over the arch. */
const LOCKUP_KEYS = 2;

/**
 * The track at night, in the rain: soaked surfaces, floodlight towers with light shafts, neon along the barriers,
 * round the finish arch and in a light tunnel over a straight, and Colyseus × PixiJS on top of the arch.
 *
 * It lasts the page and is built again for each track. Its six spot lights and three point lights, all with finite
 * ranges and no shadows, are made once, as are the logos and their two keys, so they hold the same place in the view's
 * light list ahead of the trucks' whatever track is built; a build puts them on its towers and under its neon, and
 * lights left over stay dark. On a track with more towers than lamps, the lamps move to the towers by the road the
 * camera is about to see. Its canvas art, the same on every track, is drawn once too.
 */
export class NightSet {
  private readonly _parent: Container3D;
  private readonly _fx: LensFx;
  private readonly _lights = new Container3D({ label: 'set-lights' });
  private readonly _lamps: SpotLight[] = [];
  private readonly _spills: PointLight[] = [];
  /** The towers' lamp panels and halos, drawn once: every track's are the same. */
  private readonly _art: { readonly lamp: Texture; readonly halo: Texture };
  private readonly _lockup: CollabLockup;
  private _wet: WetTrack | null = null;
  private _floodlights: Floodlights | null = null;
  private _neon: Neon | null = null;
  private _time = 0;

  /**
   * @param parent - Where the set goes, ahead of the trucks in the scene.
   * @param fx - The lens requests.
   * @param logos - The Colyseus and PixiJS logo models, for the arch.
   * @param logos.colyseus - The Colyseus logo.
   * @param logos.pixi - The PixiJS logo.
   * @param camera - The view's camera, which the logos turn to face.
   */
  constructor(
    parent: Container3D,
    fx: LensFx,
    logos: { readonly colyseus: Scene3DSource; readonly pixi: Scene3DSource },
    camera: Container3D,
  ) {
    for (let i = 0; i < LAMPS; i++) this._lamps.push(this._lights.addChild(createLamp()));
    for (let i = 0; i < SPILLS; i++) this._spills.push(this._lights.addChild(createSpill()));

    this._art = { lamp: createLampTexture(), halo: createHaloTexture() };

    parent.addChild(this._lights);
    this._lockup = new CollabLockup(parent, logos, camera);
    this._parent = parent;
    this._fx = fx;
  }

  /** How many lights the set holds, lit or not. */
  public get lightCount(): number {
    return LAMPS + SPILLS + LOCKUP_KEYS;
  }

  /** The tower each of the set's spot lights is given to, -1 for one left dark. */
  public get lightTowers(): readonly number[] {
    return this._floodlights?.lightTowers ?? this._lamps.map(() => -1);
  }

  /**
   * Dress a track: soak its pieces and the ground, and put up its towers and neon.
   * @param track - The track.
   * @param track.group - Every track piece and decoration.
   * @param track.ground - The ground plane.
   * @param route - Its route, which the towers and neon follow.
   * @param plan - Where the towers and the tunnel go.
   * @param occluders - Receives the towers, gantries and logos, for the cameras to see past.
   */
  public build(
    track: { readonly group: Container3D; readonly ground: Mesh3D },
    route: Route,
    plan: VenuePlan,
    occluders: Occluders,
  ): void {
    this.teardown();
    this._wet = new WetTrack(track.group, track.ground);
    this._floodlights = new Floodlights(this._parent, this._fx, occluders, route, plan.towers, this._lamps, this._art);
    this._neon = new Neon(this._parent, occluders, route, plan.gantries, plan.flickerGantry, this._spills);
    this._lockup.occlude(occluders);
  }

  /**
   * Take the dressing down: the soaking first, while the track's meshes still stand to get their materials back, then
   * the towers and the neon. The lights stay, dark.
   */
  public teardown(): void {
    this._wet?.destroy();
    this._floodlights?.destroy();
    this._neon?.destroy();
    this._wet = null;
    this._floodlights = null;
    this._neon = null;
  }

  /**
   * Move the raindrop rings and the flickering tube on, flare the floodlights near what the camera watches, turn the
   * logos to the camera, and on a track with more towers than lamps, move the lamps toward the road the camera is about
   * to see.
   * @param dt - Seconds since the last frame.
   * @param x - Where the camera's subject is, x.
   * @param z - Where the camera's subject is, z.
   * @param focusS - Route distance of the road the camera is about to see.
   */
  public update(dt: number, x: number, z: number, focusS: number): void {
    this._time += dt;

    if (this._wet) {
      this._wet.time = this._time;
      this._wet.update();
    }

    this._floodlights?.update(dt, x, z, focusS);
    this._neon?.update(this._time);
    this._lockup.update(this._time);
  }

  /** Flare the logos over the arch, as a winner takes the flag. */
  public celebrate(): void {
    this._lockup.celebrate(this._time);
  }

  public destroy(): void {
    this.teardown();
    this._lights.destroy({ children: true });
    this._lockup.destroy();

    for (const texture of Object.values(this._art)) texture.destroy(true);
  }
}
