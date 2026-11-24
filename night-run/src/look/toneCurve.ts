import type { BaseMaterial3D } from '@pixi/3d';

/**
 * Keeps an unlit material off the view's ACES curve, as every unlit material was before `@pixi/3d` 0.1.0.
 *
 * The neon, lamps, flames, rain and fireworks are graded to show as their colours. Under the curve they can't: bright
 * saturated colours roll toward white, and no input reaches the old neon cyan. 0.1.0 dropped the public per-material
 * opt-out (`toneMapped`), so this sets `_skipsToneCurve`, the engine's internal flag for the same thing. The material
 * still takes the view's exposure and the display encode. Call it before the material first draws.
 * @param material - An unlit material.
 * @returns The same material.
 */
export function skipToneCurve<T extends BaseMaterial3D>(material: T): T {
  material._skipsToneCurve = true;

  return material;
}
