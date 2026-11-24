import type { Container3D, ParticleBillboardMode } from '@pixi/3d';
import { packParticleColor, ParticleContainer3D } from '@pixi/3d';
import type { Texture } from 'pixi.js';

import { skipToneCurve } from '../toneCurve';

/**
 * Camera-facing sprites placed afresh every frame, for light that is a function of the moment rather than a
 * simulation: muzzle flashes, the boost jet and its shock diamonds, a burst's flash, the glow round a burning tyre.
 * One {@link ParticleContainer3D}, written and uploaded once a frame.
 */
export class SpritePool {
  public readonly container: ParticleContainer3D;

  private readonly _capacity: number;
  private _count = 0;
  private _last = 0;

  constructor(
    parent: Container3D,
    label: string,
    texture: Texture,
    capacity: number,
    billboard: ParticleBillboardMode,
  ) {
    this.container = new ParticleContainer3D({ label, texture, capacity, blendMode: 'add', billboard });
    skipToneCurve(this.container.material);
    this.container.visible = false;
    this._capacity = capacity;
    parent.addChild(this.container);
  }

  /**
   * Draw one sprite this frame.
   * @param x - World x.
   * @param y - World y.
   * @param z - World z.
   * @param size - World diameter.
   * @param color - Display-space `0xRRGGBB`.
   * @param alpha - Opacity; additive, so this is brightness.
   * @param rotation - Spin about the view axis, in radians.
   */
  public add(x: number, y: number, z: number, size: number, color: number, alpha: number, rotation = 0): void {
    if (this._count === this._capacity || size <= 0 || alpha <= 0.002) return;

    this.container.writePacked(this._count++, x, y, z, size, rotation, packParticleColor(color, alpha));
  }

  /**
   * Hide last frame's leftovers, upload, and show the pool if it drew anything.
   * @param active - Whether the scene is showing.
   * @param upload - Whether this frame is drawn; see `PyroPool.update`.
   */
  public flush(active: boolean, upload: boolean): void {
    const container = this.container;

    for (let i = this._count; i < this._last; i++) container.writePacked(i, 0, 0, 0, 0, 0, 0);

    if (upload) container.upload();
    container.visible = active && this._count > 0;
    this._last = this._count;
    this._count = 0;
  }

  public clear(): void {
    this._count = 0;
    this.flush(false, false);
  }

  public destroy(): void {
    this.container.destroy();
  }
}
