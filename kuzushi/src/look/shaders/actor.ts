import { BaseMaterial3D, createLightingBit, FlatMaterial, mathConstantsBit } from "@pixi/3d"
import type { ShaderBit } from "@pixi/3d"
import type { Texture } from "pixi.js"

/**
 * Actor bodies: the top face shows its glyph art and glows (above 1, so bloom picks it up), the sides take a hard two
 * step light, a rim light lifts the silhouette, `flash` burns the whole body white for a hit, and `body` dims the
 * body under its rim light, for a ghost that still reads as an outline.
 */

const surfaceBit: ShaderBit = {
  name: "kuzushiActorSurface",
  textures: ["glyph"],
  bindings: { material: { actSide: "vec4<f32>", actFx: "vec4<f32>", actRim: "vec4<f32>", actFill: "vec4<f32>" } },
  gpu: {
    fragment: {
      material: /* wgsl */ `
  let actView = normalize(camera.uCameraPosition.xyz - input.vPosition);
  let actTop = smoothstep(0.6, 0.8, normal.y);
  {
    let actTex = sampleGlyph(input.vUV);
    let actArt = pow(actTex.rgb / max(actTex.a, 0.001), vec3<f32>(2.2));
    albedo = mix(material.actSide.rgb, actArt, actTop);
  }
`
    }
  },
  gl: {
    fragment: {
      material: /* glsl */ `
  vec3 actView = normalize(uCameraPosition.xyz - vPosition);
  float actTop = smoothstep(0.6, 0.8, normal.y);
  {
    vec4 actTex = sampleGlyph(vUV);
    vec3 actArt = pow(actTex.rgb / max(actTex.a, 0.001), vec3(2.2));
    albedo = mix(material.actSide.rgb, actArt, actTop);
  }
`
    }
  }
}

const perLight = "actLight += light.color * attenuation * (0.4 + 0.6 * smoothstep(0.02, 0.08, nDotL * shadow));"

const lightingBit = createLightingBit({
  name: "kuzushiActorLighting",
  requires: [mathConstantsBit],
  preLighting: { gpu: "var actLight = vec3<f32>(0.0);", gl: "vec3 actLight = vec3(0.0);" },
  perLight: { gpu: perLight, gl: perLight },
  postLighting: {
    gpu: /* wgsl */ `
  {
    let actRimAmount = pow(1.0 - max(dot(normal, actView), 0.0), 2.5);
    let actLit = albedo * (material.actFill.rgb + actLight * INV_PI);
    finalColor = mix(actLit, albedo * material.actFx.x, actTop * material.actFx.w) * material.actFill.w;
    finalColor += material.actRim.rgb * actRimAmount * material.actFx.z;
    finalColor = mix(finalColor, vec3<f32>(2.6), material.actFx.y);
  }
`,
    gl: /* glsl */ `
  {
    float actRimAmount = pow(1.0 - max(dot(normal, actView), 0.0), 2.5);
    vec3 actLit = albedo * (material.actFill.rgb + actLight * INV_PI);
    finalColor = mix(actLit, albedo * material.actFx.x, actTop * material.actFx.w) * material.actFill.w;
    finalColor += material.actRim.rgb * actRimAmount * material.actFx.z;
    finalColor = mix(finalColor, vec3(2.6), material.actFx.y);
  }
`
  }
})

export interface ActorLook {
  readonly glyph: Texture
  /** Linear colour of the sides. */
  readonly side: readonly [number, number, number]
  /** Linear rim light colour. */
  readonly rim: readonly [number, number, number]
  /** How bright the top glows: past 1 blooms. */
  readonly glow: number
  /** How much of the top glows rather than takes light, 0 to 1. */
  readonly emissive: number
  readonly rimStrength: number
}

/** The fields `ActorMaterial.data` animates per actor. */
export interface ActorFx {
  glow: number
  flash: number
  /** How much of the body shows under the rim light: 1 solid, lower a ghost. 1 when left out. */
  body?: number
}

const FILL = [0.22, 0.22, 0.24] as const

/** `extra` adds bits after the actor's own, such as a draw-order band. */
export const actorMaterial = (look: ActorLook, extra: ReadonlyArray<ShaderBit> = []): BaseMaterial3D => {
  const bits = [surfaceBit, lightingBit, ...extra]
  const material = new BaseMaterial3D({
    descriptor: { bitsGpu: bits, bitsGl: bits },
    textures: { glyph: look.glyph }
  })
  material.data.actSide = [...look.side, 1]
  material.data.actFx = [look.glow, 0, look.rimStrength, look.emissive]
  material.data.actRim = [...look.rim, 1]
  material.data.actFill = [...FILL, 1]
  return material
}

/** Scratch lanes `setActorFx` writes through: the material copies them, so one pair serves every actor. */
const FX: [number, number, number, number] = [0, 0, 0, 0]
const BODY: [number, number, number, number] = [...FILL, 1]

/** Writes this frame's glow, hit flash and body; the rest stays as built. */
export const setActorFx = (material: BaseMaterial3D, look: ActorLook, fx: ActorFx): void => {
  FX[0] = fx.glow
  FX[1] = fx.flash
  FX[2] = look.rimStrength
  FX[3] = look.emissive
  material.data.actFx = FX
  BODY[3] = fx.body ?? 1
  material.data.actFill = BODY
}

const barBit: ShaderBit = {
  name: "kuzushiBar",
  bindings: { material: { bar: "vec4<f32>", barFront: "vec4<f32>" } },
  gpu: {
    fragment: {
      material: /* wgsl */ `{
    let barEdge = step(0.06, input.vUV.y) * step(input.vUV.y, 0.94) * step(0.012, input.vUV.x) * step(input.vUV.x, 0.988);
    let barFill = step(input.vUV.x, material.bar.x) * barEdge;
    let barChip = step(input.vUV.x, material.bar.y) * barEdge * (1.0 - barFill);
    albedo = mix(mix(vec3<f32>(0.004), vec3<f32>(2.0), barChip), material.barFront.rgb, barFill);
    alpha = mix(0.82, 1.0, max(barFill, barChip)) * material.bar.z;
  }`
    }
  },
  gl: {
    fragment: {
      material: /* glsl */ `{
    float barEdge = step(0.06, vUV.y) * step(vUV.y, 0.94) * step(0.012, vUV.x) * step(vUV.x, 0.988);
    float barFill = step(vUV.x, material.bar.x) * barEdge;
    float barChip = step(vUV.x, material.bar.y) * barEdge * (1.0 - barFill);
    albedo = mix(mix(vec3(0.004), vec3(2.0), barChip), material.barFront.rgb, barFill);
    alpha = mix(0.82, 1.0, max(barFill, barChip)) * material.bar.z;
  }`
    }
  }
}

/** A health bar: ink back, glowing red fill to `fill`, a white chip of what was just lost back to `chip`. */
export const barMaterial = (front: readonly [number, number, number]): FlatMaterial => {
  const material = new FlatMaterial({ alphaMode: "blend", extraBits: [barBit] })
  material.data.bar = [1, 1, 1, 0]
  material.data.barFront = [...front, 1]
  return material
}

export const setBar = (material: FlatMaterial, fill: number, chip: number, opacity: number): void => {
  material.data.bar = [fill, chip, opacity, 0]
}
