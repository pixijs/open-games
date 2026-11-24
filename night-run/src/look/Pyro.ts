import { Container3D } from '@pixi/3d';
import { Texture } from 'pixi.js';

import { createGlowTexture } from '../Particles';
import type { LensFx } from './LensFx';
import { LIGHT_BUDGET } from './LensFx';
import { Fireworks } from './pyro/Fireworks';
import type { PyroKit } from './pyro/PyroKit';
import { PyroLights } from './pyro/PyroKit';
import { PyroPool } from './pyro/PyroPool';
import { PyroRandom } from './pyro/PyroRandom';
import { SpritePool } from './pyro/SpritePool';

/** Seconds of exposure a streak covers. */
const SHUTTER = 1 / 40;
/** Screens at least this many CSS pixels get every particle; smaller ones scale down to {@link MIN_DENSITY}. */
const FULL_DENSITY_PIXELS = 1.4e6;
const MIN_DENSITY = 0.4;

/**
 * The podium's fireworks and confetti.
 *
 * Four particle draws at most, each shown only while it has something alive, and up to {@link LIGHT_BUDGET}.pyro point
 * lights. Particles carry their birth on the game clock and the shader evaluates them at the frame's time.
 */
export class Pyro {
  public readonly fireworks: Fireworks;

  private readonly _root = new Container3D({ label: 'pyro' });
  private readonly _hotGlow: Texture;
  private readonly _softGlow: Texture;
  private readonly _kit: PyroKit;
  private readonly _pools: readonly PyroPool[];
  private _time = 0;

  /**
   * @param parent - Scene root.
   * @param fx - The lens requests.
   */
  constructor(parent: Container3D, fx: LensFx) {
    this._hotGlow = createGlowTexture(true);
    this._softGlow = createGlowTexture();

    const density = screenDensity();
    const scale = (n: number) => Math.round(n * density);
    const root = this._root;

    this._kit = {
      confetti: new PyroPool(root, {
        label: 'pyro-confetti',
        texture: Texture.WHITE,
        capacity: scale(640),
        blendMode: 'normal',
        gravity: [0.3, -4.5, 0],
        fadeOut: 6,
        nearFade: 1.5,
      }),
      sparks: new PyroPool(root, {
        label: 'pyro-sparks',
        texture: this._hotGlow,
        capacity: scale(1200),
        blendMode: 'add',
        streak: true,
        gravity: [0, -12, 0],
        fadeOut: 3,
        streakFade: 0.35,
        nearFade: 1.5,
      }),
      stars: new PyroPool(root, {
        label: 'pyro-stars',
        texture: this._hotGlow,
        capacity: scale(4400),
        blendMode: 'add',
        streak: true,
        gravity: [0, -9.8, 0],
        fadeOut: 4,
        streakFade: 0.25,
      }),
      glows: new SpritePool(root, 'pyro-glows', this._softGlow, 64, 'spherical'),
      lights: new PyroLights(root, LIGHT_BUDGET.pyro),
      fx,
      rng: new PyroRandom(),
      density,
    };

    const kit = this._kit;

    this._pools = [kit.confetti, kit.sparks, kit.stars];
    this.fireworks = new Fireworks(kit);
    parent.addChild(root);
  }

  /**
   * Advance one frame.
   * @param dt - Seconds since the last frame.
   */
  public update(dt: number): void {
    const from = this._time;
    const to = from + dt;

    this._time = to;
    this.fireworks.update(from, to);

    for (let i = 0; i < this._pools.length; i++) this._pools[i].update(to, SHUTTER, true, true);

    this._kit.glows.flush(true, true);
    this._kit.lights.flush();
  }

  /**
   * Start the fireworks over a place, now.
   * @param x - Where the show centres, x.
   * @param z - Where the show centres, z.
   */
  public celebrate(x: number, z: number): void {
    this.fireworks.play(this._time, x, z);
  }

  /** Stop launching; what's in the air finishes. */
  public stop(): void {
    this.fireworks.stop();
  }

  public destroy(): void {
    for (const pool of this._pools) pool.destroy();

    this._kit.glows.destroy();
    this._kit.lights.destroy();
    this._root.destroy();
    this._hotGlow.destroy(true);
    this._softGlow.destroy(true);
  }
}

/** Particle count scale for this screen: full on a desktop, down to {@link MIN_DENSITY} on a phone. */
function screenDensity(): number {
  const pixels = window.innerWidth * window.innerHeight;

  return Math.min(1, Math.max(MIN_DENSITY, pixels / FULL_DENSITY_PIXELS));
}
