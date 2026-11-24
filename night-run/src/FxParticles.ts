import type { ParticleSpawnOverrides, ParticleSystem3DOptions } from '@pixi/3d/extras';
import { ParticleSystem3D } from '@pixi/3d/extras';
import type { Ticker } from 'pixi.js';

import { skipToneCurve } from './look/toneCurve';

/**
 * A manually stepped particle system that skips its draw call once nothing it spawned can still be alive, so an
 * idle effect costs nothing on the GPU.
 */
export class FxParticles extends ParticleSystem3D {
  private readonly _maxLife: number;
  private _liveUntil = 0;

  /**
   * @param options - System options; emission is always manual.
   * @param maxLife - Longest life any spawn asks for, in system seconds.
   */
  constructor(options: ParticleSystem3DOptions, maxLife: number) {
    super({ ...options, autoUpdate: false, emitRate: 0 });
    this._maxLife = maxLife;
    skipToneCurve(this.material);
    this.visible = false;
  }

  public override spawn(count: number, overrides?: ParticleSpawnOverrides): void {
    super.spawn(count, overrides);
    this._liveUntil = this.time + this._maxLife;
    this.visible = true;
  }

  public override update(ticker?: Ticker): void {
    super.update(ticker);
    if (this.time >= this._liveUntil) this.visible = false;
  }

  public override clear(): void {
    super.clear();
    this._liveUntil = 0;
    this.visible = false;
  }
}
