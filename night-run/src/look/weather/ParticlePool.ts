import type { ParticleContainer3D } from '@pixi/3d';

/** A ring buffer of particle records written straight into a container's vertex data. */
export class ParticlePool {
  public readonly points: ParticleContainer3D;

  private readonly _stride: number = 0;
  private readonly _sizeRot: number = 0;
  private readonly _color: number = 0;
  private readonly _birth: number = 0;
  private readonly _life: number = 0;
  private readonly _vel: number = 0;
  private _cursor = 0;

  /** @param points - A container composed with the lifetime and motion bits. */
  constructor(points: ParticleContainer3D) {
    const offsets = points.data.offsets;

    this.points = points;
    this._stride = points.data.floatStride;
    this._sizeRot = offsets.aParticleSizeRot / 4;
    this._color = offsets.aParticleColor / 4;
    this._birth = offsets.aBirth / 4;
    this._life = offsets.aLife / 4;
    this._vel = offsets.aVel / 4;
  }

  /**
   * Write the next particle, overwriting the oldest once the pool is full.
   * @param x - Launch x.
   * @param y - Launch y.
   * @param z - Launch z.
   * @param vx - Launch velocity x.
   * @param vy - Launch velocity y.
   * @param vz - Launch velocity z.
   * @param birth - World time of the launch.
   * @param life - World seconds it lives.
   * @param size - Diameter.
   * @param rotation - Spin, in radians.
   * @param color - Tint and opacity, from `packParticleColor`.
   */
  public write(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    birth: number,
    life: number,
    size: number,
    rotation: number,
    color: number,
  ): void {
    const points = this.points;
    const index = this._cursor;
    const stride = this._stride;
    const { f32, u32 } = points.data;
    let o = index * 4 * stride;

    this._cursor = index + 1 === points.capacity ? 0 : index + 1;

    for (let v = 0; v < 4; v++, o += stride) {
      f32[o] = x;
      f32[o + 1] = y;
      f32[o + 2] = z;
      f32[o + this._sizeRot] = size;
      f32[o + this._sizeRot + 1] = rotation;
      u32[o + this._color] = color;
      f32[o + this._birth] = birth;
      f32[o + this._life] = life;
      f32[o + this._vel] = vx;
      f32[o + this._vel + 1] = vy;
      f32[o + this._vel + 2] = vz;
    }

    points.markDirty(index, index);
  }

  public clear(): void {
    this.points.clear();
    this._cursor = 0;
  }
}
