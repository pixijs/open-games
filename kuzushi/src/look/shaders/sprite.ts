import { FlatMaterial } from "@pixi/3d"
import type { ShaderBit } from "@pixi/3d"
import type { Texture } from "pixi.js"

const boostBit: ShaderBit = {
  name: "kuzushiBoost",
  bindings: { material: { boost: "f32" } },
  gpu: { fragment: { material: "albedo *= material.boost;" } },
  gl: { fragment: { material: "albedo *= material.boost;" } }
}

/**
 * An unlit sprite material: its texture times `color`, times `boost` (past 1 it blooms). `add` blends it additively,
 * for light; otherwise it is laid over what is behind. `bits` add to it, such as a draw-order band (src/art/depth.ts);
 * `doubleSided` keeps it drawn when a mirrored room lays it with a negative scale.
 */
export const spriteMaterial = (texture: Texture, color: number, boost: number, blend: "add" | "normal", bits: ReadonlyArray<ShaderBit> = [], doubleSided = false): FlatMaterial => {
  const material = new FlatMaterial({ baseColor: color, baseColorTexture: texture, alphaMode: "blend", extraBits: [boostBit, ...bits], doubleSided })
  material.data.boost = boost
  if (blend === "add") material.state.blendMode = "add"
  return material
}

/** An unlit solid in `color` times `boost`: lamps, glowing bands and slits that bloom past 1. */
export const lampMaterial = (color: number, boost: number, doubleSided = false): FlatMaterial => {
  const material = new FlatMaterial({ baseColor: color, extraBits: [boostBit], doubleSided })
  material.data.boost = boost
  return material
}
