/**
 * What the effects ask of the lens each frame. Effects that run before the look write here: bright points that flare,
 * water thrown at the lens, flashes, lightning. The look reads it all, applies it to its post chain, and clears the
 * per-frame lists.
 *
 * It is a plain blackboard, so the effect modules only share this file, never each other.
 */

import type { ColorSource } from 'pixi.js';
import { Color } from 'pixi.js';

/** Most lights that flare the lens in one frame; extra requests are dropped, dimmest first. */
export const MAX_FLARES = 8;

/** A bright world-space point that streaks the lens: a headlight, a fireball, a boost flame. */
export interface Flare {
  x: number;
  y: number;
  z: number;
  /** Linear 0..1 colour. */
  r: number;
  g: number;
  b: number;
  /** 0 to about 2; 1 is a headlight seen head-on. */
  intensity: number;
  /** Unit direction the light shines along, for a beam that only flares when it points at the lens. */
  dx: number;
  dy: number;
  dz: number;
  /** Cosine of the beam's half-angle; -1 shines every way. */
  cone: number;
}

/** An expanding ring of refraction round a world point. */
export interface Shockwave {
  x: number;
  y: number;
  z: number;
  /** Ring radius in world units this frame. */
  radius: number;
  /** 0..1; 0 is off. */
  strength: number;
}

/** A pocket of shimmering air round a world point. */
export interface Heat {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 0..1; 0 is off. */
  strength: number;
}

/**
 * The light budget. The engine shades at most 32 lights (directional, point and spot together) and drops any past
 * that, so every module keeps to its share. Give every point and spot light a finite `range`, which is what lets the
 * tiled lighting skip it outside its reach.
 */
export const LIGHT_BUDGET = {
  /** Moonlight (casts the cascaded shadows) and the lightning. */
  look: 2,
  /** Floodlights and neon spill. */
  set: 10,
  /** The keys on the logos over the finish arch. */
  logos: 2,
  /** Headlights and tail lights on the four trucks. */
  trucks: 8,
  /** The fireworks. */
  pyro: 7,
} as const;

export class LensFx {
  public readonly flares: Flare[] = Array.from({ length: MAX_FLARES }, () => ({
    x: 0,
    y: 0,
    z: 0,
    r: 0,
    g: 0,
    b: 0,
    intensity: 0,
    dx: 0,
    dy: 0,
    dz: 0,
    cone: -1,
  }));
  /** Flares written this frame. */
  public flareCount = 0;

  public readonly shockwave: Shockwave = { x: 0, y: 0, z: 0, radius: 0, strength: 0 };
  public readonly heat: Heat = { x: 0, y: 0, z: 0, radius: 0, strength: 0 };

  /** Water thrown at the lens this frame, 0..1; the look adds it to the lens's wetness, which then dries off. */
  public lensSplash = 0;
  /** Sky brightness from lightning this frame, 0..1. */
  public lightning = 0;

  /** The strongest flash asked for this frame. */
  public flashAmount = 0;
  public readonly flashColor = new Color(0xffffff);
  /** How fast the flash fades, per second. */
  public flashDecay = 7;

  /**
   * Ask for a lens flare from a world point that shines every way: a fireball, a firework, a lamp.
   * @param x - World x.
   * @param y - World y.
   * @param z - World z.
   * @param color - Flare colour.
   * @param intensity - 0 to about 2.
   */
  public flare(x: number, y: number, z: number, color: ColorSource, intensity: number): void {
    this.beam(x, y, z, color, intensity, 0, 0, 0, -1);
  }

  /**
   * Ask for a lens flare from a light that shines one way, such as a headlight; the look fades it by how squarely
   * it points at the lens.
   * @param x - World x.
   * @param y - World y.
   * @param z - World z.
   * @param color - Flare colour.
   * @param intensity - 0 to about 2, seen head-on.
   * @param dx - Unit direction it shines along, x.
   * @param dy - Unit direction, y.
   * @param dz - Unit direction, z.
   * @param cone - Cosine of the beam's half-angle.
   */
  public beam(
    x: number,
    y: number,
    z: number,
    color: ColorSource,
    intensity: number,
    dx: number,
    dy: number,
    dz: number,
    cone: number,
  ): void {
    if (intensity <= 0) return;

    let slot: Flare | null = null;

    if (this.flareCount < MAX_FLARES) {
      slot = this.flares[this.flareCount++];
    } else {
      for (let i = 0; i < MAX_FLARES; i++) {
        if (this.flares[i].intensity < intensity && (!slot || this.flares[i].intensity < slot.intensity)) {
          slot = this.flares[i];
        }
      }
    }

    if (!slot) return;

    const c = Color.shared.setValue(color);

    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.r = c.red;
    slot.g = c.green;
    slot.b = c.blue;
    slot.intensity = intensity;
    slot.dx = dx;
    slot.dy = dy;
    slot.dz = dz;
    slot.cone = cone;
  }

  /**
   * Flash the frame toward a colour; a weaker flash than one already asked for this frame is ignored.
   * @param amount - Mix amount, 0 to 1.
   * @param color - Flash colour.
   * @param decay - How fast it fades, per second.
   */
  public flash(amount: number, color: ColorSource = 0xffffff, decay = 7): void {
    if (amount <= this.flashAmount) return;

    this.flashAmount = amount;
    this.flashColor.setValue(color);
    this.flashDecay = decay;
  }

  /** Clear this frame's requests; the look calls it once it has read them. */
  public clear(): void {
    this.flareCount = 0;
    this.shockwave.strength = 0;
    this.heat.strength = 0;
    this.lensSplash = 0;
    this.lightning = 0;
    this.flashAmount = 0;
  }
}
