import type { Camera3D, Container3D } from '@pixi/3d';
import { Vector3 } from '@pixi/3d';
import type { Texture } from 'pixi.js';

import { ROAD_Y } from '../race/route';
import type { TruckPose } from '../race/truck';
import type { Cell } from '../track/code';
import { WHEEL_LOCAL } from '../race/truck';
import type { LensFx } from './LensFx';
import { Rain } from './weather/Rain';
import { Splashes } from './weather/Splashes';
import { Spray } from './weather/Spray';

const RAIN_CAPACITY = 12000;
/** Screen area, in CSS pixels, that gets the full rain; smaller screens draw proportionally fewer drops. */
const FULL_DENSITY_AREA = 1280 * 720;
const MIN_DENSITY = 0.35;

/** Exposure time of a streak, in seconds. */
const SHUTTER = 0.03;

/** A camera this close behind a spraying truck, low enough to be in its rooster tail, gets water on the lens. */
const LENS_REACH = 2.5;
const LENS_SIDE = 1.4;
const LENS_HEIGHT = 1.6;
/** Lens wetness a full rooster tail behind the truck adds per second. */
const LENS_RATE = 3;
/** A lens this close to the water coming off a rear tyre, as a truck passes it, gets hit hard. */
const WHEEL_REACH = 1.6;
/** Where that water is, behind the tyre's contact patch. */
const WHEEL_SPRAY_BACK = 0.25;
/** Lens wetness a rear tyre right at the lens adds per second. */
const WHEEL_RATE = 12;
const SPRAY_START = 4;
const SPRAY_FULL = 12;

/**
 * The race's weather: rain falling round the camera, the road boiling with splashes, spray and mist off every truck,
 * and water thrown at the lens when the camera rides close behind one.
 *
 * Four draw calls: rain, splashes, droplets and mist. The rain and the splashes are stateless, built in the vertex
 * shader from fixed records round the camera.
 */
export class Weather {
  private readonly _parent: Container3D;
  private readonly _camera: Camera3D;
  private readonly _fx: LensFx;
  private readonly _rain: Rain;
  private readonly _splashes: Splashes;
  private readonly _spray: Spray;
  private readonly _lastCamera = new Vector3();
  private readonly _cameraVelocity = new Vector3();
  private readonly _forward = new Vector3();
  private _cameraKnown = false;
  private _time = 0;

  /**
   * @param parent - Scene root.
   * @param camera - The view's camera; the rain falls round it. Runs after the camera has moved.
   * @param smoke - Soft puff texture, for the mist.
   * @param fx - The lens requests.
   */
  constructor(parent: Container3D, camera: Camera3D, smoke: Texture, fx: LensFx) {
    this._parent = parent;
    this._camera = camera;
    this._fx = fx;
    this._rain = new Rain(parent, RAIN_CAPACITY);
    this._splashes = new Splashes(parent);
    this._spray = new Spray(parent, smoke);
  }

  /**
   * Rain round the camera and water off the trucks.
   * @param dt - Seconds since the last frame.
   * @param trucks - Each truck's pose by slot, or null for an empty slot.
   */
  public update(dt: number, trucks: readonly (Readonly<TruckPose> | null)[]): void {
    const camera = this._camera.position;
    const forward = this._aim();
    const velocity = this._trackCamera(dt);
    const density = this._density();
    const pixel = this._pixel();

    this._time += dt;
    this._rain.update(camera, forward, velocity, this._time, SHUTTER, density, pixel, this._fx.lightning);
    this._splashes.update(camera, forward, this._time, density);
    this._spray.update(this._time, trucks, camera, velocity, SHUTTER, pixel);

    const splash = this._lensSplash(dt, trucks);

    if (splash > 0) this._fx.lensSplash = Math.min(1, this._fx.lensSplash + splash);
  }

  /**
   * Splash on another track's road.
   * @param cells - Its grid cells.
   */
  public setRoad(cells: readonly Cell[]): void {
    this._splashes.setRoad(cells);
  }

  /** Forget the spray in the air and where the camera was, as after a cut to a new place. */
  public reset(): void {
    this._spray.reset();
    this._cameraKnown = false;
  }

  public destroy(): void {
    this._rain.destroy();
    this._splashes.destroy();
    this._spray.destroy();
  }

  /** Lens wetness to add this frame: a rear tyre passing close to the lens, or a rooster tail right in front of it. */
  private _lensSplash(dt: number, trucks: readonly (Readonly<TruckPose> | null)[]): number {
    const camera = this._camera.position;
    const height = camera.y - ROAD_Y;
    let tail = 0;
    let tyres = 0;

    for (let i = 0; i < trucks.length; i++) {
      const truck = trucks[i];

      if (!truck) continue;

      const amount = Math.min(1, (truck.speed - SPRAY_START) / (SPRAY_FULL - SPRAY_START));

      if (amount <= 0) continue;

      const fx = Math.sin(truck.yaw);
      const fz = Math.cos(truck.yaw);

      for (let w = 2; w < 4; w++) {
        const wheel = WHEEL_LOCAL[w];
        const back = wheel[2] - WHEEL_SPRAY_BACK;
        const d = Math.hypot(
          camera.x - (truck.x + wheel[0] * fz + back * fx),
          camera.y - (truck.y + wheel[1]),
          camera.z - (truck.z - wheel[0] * fx + back * fz),
        );

        if (d < WHEEL_REACH) tyres += amount * (1 - d / WHEEL_REACH);
      }

      if (height >= LENS_HEIGHT) continue;

      const dx = camera.x - truck.x;
      const dz = camera.z - truck.z;
      const behind = -(dx * fx + dz * fz);
      const side = Math.abs(dx * fz - dz * fx);

      if (behind < 0.3 || behind > LENS_REACH || side > LENS_SIDE) continue;

      tail += amount * (1 - behind / LENS_REACH) * (1 - side / LENS_SIDE) * (1 - (0.5 * height) / LENS_HEIGHT);
    }

    return (tail * LENS_RATE + tyres * WHEEL_RATE) * dt;
  }

  /** The camera's forward, the -z axis of its rotation. */
  private _aim(): Vector3 {
    const { x, y, z, w } = this._camera.quaternion;

    return this._forward.set(-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y)));
  }

  /**
   * The camera's velocity the streaks are blurred against, from how far it moved since the last call.
   * @param dt - Seconds since the last call; 0 holds the last velocity.
   */
  private _trackCamera(dt: number): Vector3 {
    const camera = this._camera.position;
    const last = this._lastCamera;
    const velocity = this._cameraVelocity;

    if (!this._cameraKnown) {
      velocity.set(0, 0, 0);
    } else if (dt > 0) {
      velocity.set((camera.x - last.x) / dt, (camera.y - last.y) / dt, (camera.z - last.z) / dt);
    }

    last.copyFrom(camera);
    this._cameraKnown = true;

    return velocity;
  }

  /** Share of the drops worth drawing on this screen. */
  private _density(): number {
    const view = this._parent.view3d;

    if (!view) return 1;

    return Math.max(MIN_DENSITY, Math.min(1, (view.width * view.height) / FULL_DENSITY_AREA));
  }

  /** World size of one CSS pixel at unit distance from the camera. */
  private _pixel(): number {
    const view = this._parent.view3d;
    const camera = this._camera;
    const height = view && view.height > 0 ? view.height : 720;

    return (2 * Math.tan((camera.fov / camera.zoom) * (Math.PI / 360))) / height;
  }
}
