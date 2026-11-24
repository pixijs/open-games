import type { Container3D } from '@pixi/3d';
import { PointLight } from '@pixi/3d';

import type { LensFx } from '../LensFx';
import type { PyroPool } from './PyroPool';
import type { PyroRandom } from './PyroRandom';
import type { SpritePool } from './SpritePool';

/** What the fireworks draw with. */
export interface PyroKit {
  /** Additive streaks: the shells' tails. */
  readonly sparks: PyroPool;
  /** Additive streaks for the firework bursts. */
  readonly stars: PyroPool;
  /** Blended paper squares. */
  readonly confetti: PyroPool;
  /** Additive sprites placed every frame. */
  readonly glows: SpritePool;
  readonly lights: PyroLights;
  readonly fx: LensFx;
  readonly rng: PyroRandom;
  /** Count scale for particles on this screen, 0.4 on a phone to 1 on a desktop. */
  readonly density: number;
}

/**
 * The pool of point lights the fireworks share, at most `LIGHT_BUDGET.pyro`. Bursts ask for lights in priority
 * order each frame; a light nobody asked for is hidden, which also takes it out of the engine's light list.
 */
export class PyroLights {
  private readonly _lights: PointLight[] = [];
  private _used = 0;

  constructor(parent: Container3D, count: number) {
    for (let i = 0; i < count; i++) {
      const light = new PointLight({ label: `pyro-light-${i}`, intensity: 0, range: 1 });

      light.visible = false;
      this._lights.push(light);
      parent.addChild(light);
    }
  }

  /**
   * Light the scene from a point this frame.
   * @param x - World x.
   * @param y - World y.
   * @param z - World z.
   * @param color - Display-space colour.
   * @param intensity - Light intensity; the falloff is inverse-square.
   * @param range - Reach, past which the light is culled.
   */
  public set(x: number, y: number, z: number, color: number, intensity: number, range: number): void {
    if (this._used === this._lights.length || intensity <= 0.05) return;

    const light = this._lights[this._used++];

    light.position.set(x, y, z);
    light.color.setValue(color);
    light.intensity = intensity;
    light.range = range;
    light.visible = true;
  }

  /** Hide the lights nobody asked for this frame. */
  public flush(): void {
    const lights = this._lights;

    for (let i = this._used; i < lights.length; i++) lights[i].visible = false;

    this._used = 0;
  }

  public destroy(): void {
    for (const light of this._lights) light.destroy();
    this._lights.length = 0;
  }
}
