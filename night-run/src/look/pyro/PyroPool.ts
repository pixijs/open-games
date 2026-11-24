import type { Container3D, ParticleBlendMode } from '@pixi/3d';
import { packParticleColor, ParticleContainer3D, particleLifetimeBit } from '@pixi/3d';
import type { Texture } from 'pixi.js';

import { skipToneCurve } from '../toneCurve';
import { getPyroBit } from './pyroBit';

const VERTS = 4;

/** How a {@link PyroPool} looks: its sprite, blend and the shader's per-pool constants. */
export interface PyroPoolOptions {
  readonly label: string;
  readonly texture: Texture;
  readonly capacity: number;
  readonly blendMode: ParticleBlendMode;
  /** Stretch quads along their velocity; see `getPyroBit`. */
  readonly streak?: boolean;
  /** World acceleration each particle feels a share of: gravity, or buoyancy plus wind. */
  readonly gravity: readonly [number, number, number];
  /** Size ease exponent; 1 is linear. */
  readonly growth?: number;
  /** Seconds of fade-in. */
  readonly fadeIn?: number;
  /** Fade-out exponent; higher holds full alpha longer. */
  readonly fadeOut?: number;
  /** How much a long streak dims, as the exponent on `size / length`. */
  readonly streakFade?: number;
  /** World units over which a particle fades out as it nears the lens. */
  readonly nearFade?: number;
  /** Cooling exponent; above 1 a particle holds its heat and cools late in life. */
  readonly cooling?: number;
}

/**
 * A pool of simulated particles on world time: one {@link ParticleContainer3D}, so one draw call, composed with
 * the engine's lifetime bit and the pyro bit.
 *
 * Its clock is the scene's world time itself, so a particle is a pure function of its birth record and the frame's
 * world time: it crawls in slow motion and stops dead in the freeze. Fill the public spawn fields, then call
 * {@link PyroPool.emit}; slots recycle oldest first. Draws nothing once every particle it holds is dead.
 */
export class PyroPool {
  public readonly container: ParticleContainer3D;
  /** The pool's acceleration, which each particle feels {@link PyroPool.gravity} of. */
  public readonly pull: readonly [number, number, number];

  // The next particle's record, filled by the caller before `emit`.
  public x = 0;
  public y = 0;
  public z = 0;
  public vx = 0;
  public vy = 0;
  public vz = 0;
  /** World time of birth; may be in the past (pre-aged) or the future (a trail copy that follows a star). */
  public birth = 0;
  public life = 1;
  public size = 0.1;
  public sizeEnd = 0.1;
  /** Packed tint and alpha; see {@link PyroPool.tint}. */
  public color = 0xffffffff;
  public rotation = 0;
  public spin = 0;
  public heat = 1;
  public heatEnd = 1;
  public drag = 0;
  /** Share of the pool's gravity. */
  public gravity = 1;
  /** Twinkle, 0 to 1. */
  public flicker = 0;
  /** Extra streak, in world seconds of travel. */
  public trail = 0;
  /** Share of the shutter a streak pool's particle streaks over; it takes the place of spin, which a streak lacks. */
  public streak = 1;

  private readonly _f32: Float32Array;
  private readonly _u32: Uint32Array;
  private readonly _stride: number;
  private readonly _iSizeRot: number;
  private readonly _iColor: number;
  private readonly _iBirth: number;
  private readonly _iLife: number;
  private readonly _iVel: number;
  private readonly _iLook: number;
  private readonly _iMotion: number;
  private readonly _capacity: number;
  private readonly _streak: boolean;
  private _cursor = 0;
  private _liveUntil = -1;

  constructor(parent: Container3D, options: PyroPoolOptions) {
    const streak = options.streak ?? false;
    const container = new ParticleContainer3D({
      label: options.label,
      texture: options.texture,
      capacity: options.capacity,
      blendMode: options.blendMode,
      billboard: 'spherical',
      extraBits: [particleLifetimeBit, getPyroBit(streak)],
    });

    skipToneCurve(container.material);
    const { f32, u32, floatStride, offsets } = container.data;
    const uniforms = container.uniforms;

    uniforms.uGravity = options.gravity;
    uniforms.uGrowth = options.growth ?? 1;
    uniforms.uFadeIn = Math.max(1e-3, options.fadeIn ?? 0.001);
    uniforms.uFadeOut = options.fadeOut ?? 1;
    uniforms.uNearFade = options.nearFade ?? 0.8;
    uniforms.uCooling = options.cooling ?? 1;
    uniforms.uParticleTime = 0;

    if (streak) {
      uniforms.uShutter = 0;
      uniforms.uStreakFade = options.streakFade ?? 0.4;
    }

    this.container = container;
    this.pull = options.gravity;
    this._f32 = f32;
    this._u32 = u32;
    this._stride = floatStride;
    this._iSizeRot = offsets.aParticleSizeRot / 4;
    this._iColor = offsets.aParticleColor / 4;
    this._iBirth = offsets.aBirth / 4;
    this._iLife = offsets.aLife / 4;
    this._iVel = offsets.aVel / 4;
    this._iLook = offsets.aLook / 4;
    this._iMotion = offsets.aMotion / 4;
    this._capacity = options.capacity;
    this._streak = streak;
    container.visible = false;
    parent.addChild(container);
  }

  /**
   * Set the spawn tint.
   * @param color - Display-space `0xRRGGBB`.
   * @param alpha - Opacity at birth.
   */
  public tint(color: number, alpha: number): void {
    this.color = packParticleColor(color, alpha);
  }

  /** Write the spawn fields into the next slot. */
  public emit(): void {
    const index = this._cursor;
    const f32 = this._f32;
    const stride = this._stride;
    let o = index * VERTS * stride;

    for (let v = 0; v < VERTS; v++, o += stride) {
      f32[o] = this.x;
      f32[o + 1] = this.y;
      f32[o + 2] = this.z;
      f32[o + this._iSizeRot] = this.size;
      f32[o + this._iSizeRot + 1] = this.rotation;
      this._u32[o + this._iColor] = this.color;
      f32[o + this._iBirth] = this.birth;
      f32[o + this._iLife] = this.life;

      const vel = o + this._iVel;

      f32[vel] = this.vx;
      f32[vel + 1] = this.vy;
      f32[vel + 2] = this.vz;

      const look = o + this._iLook;

      f32[look] = this.heat;
      f32[look + 1] = this.heatEnd;
      f32[look + 2] = this.sizeEnd;
      f32[look + 3] = this._streak ? this.streak : this.spin;

      const motion = o + this._iMotion;

      f32[motion] = this.drag;
      f32[motion + 1] = this.gravity;
      f32[motion + 2] = this.flicker;
      f32[motion + 3] = this.trail;
    }

    this.container.markDirty(index, index);
    this._cursor = index + 1 === this._capacity ? 0 : index + 1;

    const end = this.birth + this.life;

    if (end > this._liveUntil) this._liveUntil = end;
  }

  /**
   * Show the pool at a world time and upload what was emitted.
   * @param worldTime - The frame's world time.
   * @param shutter - Streak exposure, in world seconds.
   * @param active - Whether the scene is showing.
   * @param upload - Whether this frame is drawn. WebGL uploads only the last range handed over before a draw, so
   *   frames stepped through without drawing leave their writes pending, and the drawn frame uploads them all.
   */
  public update(worldTime: number, shutter: number, active: boolean, upload: boolean): void {
    const uniforms = this.container.uniforms;

    uniforms.uParticleTime = worldTime;
    if (this._streak) uniforms.uShutter = shutter;
    if (upload) this.container.upload();
    this.container.visible = active && worldTime <= this._liveUntil;
  }

  /** Kill every particle; the next drawn frame uploads it. */
  public clear(): void {
    this.container.clear();
    this.container.visible = false;
    this._cursor = 0;
    this._liveUntil = -1;
  }

  public destroy(): void {
    this.container.destroy();
  }
}
