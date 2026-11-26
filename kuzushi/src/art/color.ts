import { srgbToLinear } from "@pixi/3d"

/** A colour in linear RGB, for material values that take it so. Apart from palette.ts so pure modules can read colours without loading @pixi/3d. */
export const linearOf = (color: number): readonly [number, number, number] =>
  [srgbToLinear(((color >> 16) & 255) / 255), srgbToLinear(((color >> 8) & 255) / 255), srgbToLinear((color & 255) / 255)]
