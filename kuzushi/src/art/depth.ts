import type { BaseMaterial3D, ShaderBit } from "@pixi/3d"

/**
 * Draw-order bands for things that must read over the world whatever stands in front of them. A band scales the
 * surface's depth toward the near plane, keeping its own front-to-back order, so with depth testing on, a nearer band
 * covers a farther one: the player (`PLAYER_BAND`) covers the effects drawn over the world (`OVERLAY_BAND`), those
 * cover an enemy seen through a prop (`XRAY_BAND`), and that covers the world, its props and the other enemies.
 * Shadows draw with their own shaders, so they never move.
 */
const band = (name: string, scale: number): ShaderBit => {
  const k = scale.toFixed(3)
  return {
    name,
    gpu: { vertex: { end: /* wgsl */ `clipPosition.z = clipPosition.z * ${k};` } },
    gl: { vertex: { end: /* glsl */ `gl_Position.z = (gl_Position.z + gl_Position.w) * ${k} - gl_Position.w;` } }
  }
}

/** The player's body and rim: drawn over every effect, enemy and prop, as the boards always draw the arrowhead. */
export const PLAYER_BAND = band("kuzushiPlayerBand", 0.3)

/** Effects the low special camera must always see (marks, glows, bursts): over the world, under the player. */
export const OVERLAY_BAND = band("kuzushiOverlayBand", 0.6)

/**
 * An enemy seen through a prop: while `material.xray.x` is 1 its surfaces scale into the band between the world and
 * the effects, so it draws over the pillar or block in front of it and under every effect and the player. 0 leaves
 * it where it stands. Set it with `setXray`.
 */
export const XRAY_BAND: ShaderBit = {
  name: "kuzushiXrayBand",
  bindings: { material: { xray: "vec4<f32>" } },
  gpu: { vertex: { end: /* wgsl */ `clipPosition.z = clipPosition.z * mix(1.0, 0.75, material.xray.x);` } },
  gl: { vertex: { end: /* glsl */ `gl_Position.z = mix(gl_Position.z, (gl_Position.z + gl_Position.w) * 0.75 - gl_Position.w, material.xray.x);` } }
}

/** Turns `XRAY_BAND` on or off on a material built with it. */
export const setXray = (material: BaseMaterial3D, on: boolean): void => {
  material.data.xray = [on ? 1 : 0, 0, 0, 0]
}
