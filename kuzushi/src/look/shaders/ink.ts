import { BaseMaterial3D, createLightingBit, mathConstantsBit } from "@pixi/3d"
import type { ShaderBit } from "@pixi/3d"
import type { Texture } from "pixi.js"

import { linearOf } from "../../art/color.ts"
import { PALETTE } from "../../art/palette.ts"
import { ARENA } from "../../sim/index.ts"
import type { ZoneId } from "../../sim/index.ts"
import { noiseBit } from "./noise.ts"

/**
 * The ink-and-paper material of every stage: stepped light with a hard terminator, dry-brush darkening in shadow,
 * concrete grain mapped in world space, worn edges and ambient occlusion on props, red light thrown by a stage's own
 * light source (the Spiral's spire, the Void's column), and a fade into the ink-black void beyond the stage.
 */

const glslVec3 = ([r, g, b]: readonly [number, number, number]) => `vec3(${r.toFixed(5)}, ${g.toFixed(5)}, ${b.toFixed(5)})`
const wgslVec3 = ([r, g, b]: readonly [number, number, number]) => `vec3<f32>(${r.toFixed(5)}, ${g.toFixed(5)}, ${b.toFixed(5)})`

const INK = linearOf(PALETTE.ink)
const RED = linearOf(PALETTE.red)

const surfaceBit: ShaderBit = {
  name: "kuzushiInkSurface",
  textures: ["surface", "grain"],
  requires: [noiseBit],
  bindings: {
    material: {
      baseColor: "vec4<f32>",
      inkRect: "vec4<f32>",
      inkShape: "vec4<f32>",
      inkSize: "vec4<f32>",
      inkGrain: "vec4<f32>",
      inkShade: "vec4<f32>",
      inkFill: "vec4<f32>",
      inkFade: "vec4<f32>",
      inkFadeRange: "vec4<f32>",
      inkGlow: "vec4<f32>",
      inkGlowAmount: "vec4<f32>",
      inkCut: "vec4<f32>"
    }
  },
  gpu: {
    fragment: {
      material: /* wgsl */ `
  let inkP = input.vPosition;
  var inkAo = 1.0;
  {
    albedo *= material.baseColor.rgb;
    let inkUv = (inkP.xz - material.inkRect.xy) * material.inkRect.zw;
    let inkTex = sampleSurface(inkUv);
    albedo *= pow(inkTex.rgb / max(inkTex.a, 0.001), vec3<f32>(2.2));

    var inkW = abs(normal);
    inkW = inkW / (inkW.x + inkW.y + inkW.z);
    let inkS = material.inkGrain.x;
    let inkS2 = inkS * 0.31;
    let inkG1 = sampleGrain(inkP.zy * inkS).r * inkW.x + sampleGrain(inkP.xz * inkS).r * inkW.y + sampleGrain(inkP.xy * inkS).r * inkW.z;
    let inkG2 = sampleGrain(inkP.yz * inkS2 + 0.37).r * inkW.x + sampleGrain(inkP.zx * inkS2 + 0.61).r * inkW.y + sampleGrain(inkP.yx * inkS2 + 0.13).r * inkW.z;
    let inkG = 0.5 + (inkG1 + inkG2 - 1.0) * 0.72;
    albedo *= mix(1.0, inkG * 2.0, material.inkGrain.y);
    let inkM = inkP.xz * 0.35 + vec2<f32>(inkP.y * 0.21, inkP.y * 0.17);
    albedo *= 1.0 + (inkFbm(inkM) - 0.5) * material.inkGrain.z;

    let inkKind = material.inkShape.w;
    if (inkKind > 0.5) {
      let inkL = inkP - material.inkShape.xyz;
      let inkH = material.inkSize.xyz;
      var inkEdge = 0.0;
      if (inkKind < 1.5) {
        var d = inkH - abs(inkL);
        d.y = inkH.y - inkL.y;
        let lo = min(d.x, min(d.y, d.z));
        let hi = max(d.x, max(d.y, d.z));
        inkEdge = d.x + d.y + d.z - lo - hi;
      } else {
        inkEdge = select(inkH.y - inkL.y, inkH.x - length(inkL.xz), normal.y > 0.5);
      }
      let inkWearUv = vec2<f32>(inkP.x + inkP.z * 0.7, inkP.y + inkP.z * 0.3);
      let inkN = inkNoise(inkWearUv * 9.0);
      let inkWear = 1.0 - smoothstep(0.0, material.inkSize.w * (0.4 + inkN), inkEdge);
      albedo = mix(albedo, albedo * 1.8 + vec3<f32>(0.015), inkWear * 0.85);
      let inkChip = smoothstep(0.7, 0.8, inkNoise(inkWearUv * 4.0 + 3.1)) * (1.0 - smoothstep(0.02, 0.16, inkEdge));
      albedo *= 1.0 - inkChip * 0.6;
      if (normal.y < 0.5) {
        let inkStreak = inkNoise(vec2<f32>((inkP.x + inkP.z) * 5.0, inkP.y * 0.4));
        let inkTopness = smoothstep(-inkH.y, inkH.y, inkL.y);
        albedo *= 1.0 - smoothstep(0.55, 0.95, inkStreak) * material.inkGrain.w * inkTopness;
        inkAo = mix(material.inkShade.y, 1.0, smoothstep(0.0, 1.2, inkP.y));
      }
    }
    if (material.inkCut.x > 0.0) {
      let inkDither = fract(52.9829189 * fract(dot(input.position.xy, vec2<f32>(0.06711056, 0.00583715))));
      if (inkDither < material.inkCut.x) { discard; }
    }
  }
`
    }
  },
  gl: {
    fragment: {
      material: /* glsl */ `
  vec3 inkP = vPosition;
  float inkAo = 1.0;
  {
    albedo *= material.baseColor.rgb;
    vec2 inkUv = (inkP.xz - material.inkRect.xy) * material.inkRect.zw;
    vec4 inkTex = sampleSurface(inkUv);
    albedo *= pow(inkTex.rgb / max(inkTex.a, 0.001), vec3(2.2));

    vec3 inkW = abs(normal);
    inkW = inkW / (inkW.x + inkW.y + inkW.z);
    float inkS = material.inkGrain.x;
    float inkS2 = inkS * 0.31;
    float inkG1 = sampleGrain(inkP.zy * inkS).r * inkW.x + sampleGrain(inkP.xz * inkS).r * inkW.y + sampleGrain(inkP.xy * inkS).r * inkW.z;
    float inkG2 = sampleGrain(inkP.yz * inkS2 + 0.37).r * inkW.x + sampleGrain(inkP.zx * inkS2 + 0.61).r * inkW.y + sampleGrain(inkP.yx * inkS2 + 0.13).r * inkW.z;
    float inkG = 0.5 + (inkG1 + inkG2 - 1.0) * 0.72;
    albedo *= mix(1.0, inkG * 2.0, material.inkGrain.y);
    vec2 inkM = inkP.xz * 0.35 + vec2(inkP.y * 0.21, inkP.y * 0.17);
    albedo *= 1.0 + (inkFbm(inkM) - 0.5) * material.inkGrain.z;

    float inkKind = material.inkShape.w;
    if (inkKind > 0.5) {
      vec3 inkL = inkP - material.inkShape.xyz;
      vec3 inkH = material.inkSize.xyz;
      float inkEdge = 0.0;
      if (inkKind < 1.5) {
        vec3 d = inkH - abs(inkL);
        d.y = inkH.y - inkL.y;
        float lo = min(d.x, min(d.y, d.z));
        float hi = max(d.x, max(d.y, d.z));
        inkEdge = d.x + d.y + d.z - lo - hi;
      } else {
        inkEdge = normal.y > 0.5 ? inkH.x - length(inkL.xz) : inkH.y - inkL.y;
      }
      vec2 inkWearUv = vec2(inkP.x + inkP.z * 0.7, inkP.y + inkP.z * 0.3);
      float inkN = inkNoise(inkWearUv * 9.0);
      float inkWear = 1.0 - smoothstep(0.0, material.inkSize.w * (0.4 + inkN), inkEdge);
      albedo = mix(albedo, albedo * 1.8 + vec3(0.015), inkWear * 0.85);
      float inkChip = smoothstep(0.7, 0.8, inkNoise(inkWearUv * 4.0 + 3.1)) * (1.0 - smoothstep(0.02, 0.16, inkEdge));
      albedo *= 1.0 - inkChip * 0.6;
      if (normal.y < 0.5) {
        float inkStreak = inkNoise(vec2((inkP.x + inkP.z) * 5.0, inkP.y * 0.4));
        float inkTopness = smoothstep(-inkH.y, inkH.y, inkL.y);
        albedo *= 1.0 - smoothstep(0.55, 0.95, inkStreak) * material.inkGrain.w * inkTopness;
        inkAo = mix(material.inkShade.y, 1.0, smoothstep(0.0, 1.2, inkP.y));
      }
    }
    if (material.inkCut.x > 0.0) {
      float inkDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (inkDither < material.inkCut.x) discard;
    }
  }
`
    }
  }
}

/** Three steps of light (0.62, 0.85, 1) with a hard terminator, so cylinders read as drawn bands. */
const stepGl = /* glsl */ `
    float inkLit = nDotL * shadow;
    float inkOn = smoothstep(0.02, 0.06, inkLit);
    inkDirect += light.color * attenuation * inkOn * (0.62 + 0.23 * smoothstep(0.3, 0.34, inkLit) + 0.15 * smoothstep(0.62, 0.66, inkLit));
    inkSun = max(inkSun, inkOn);
`

const lightingBit = createLightingBit({
  name: "kuzushiInkLighting",
  requires: [mathConstantsBit, noiseBit],
  preLighting: {
    gpu: "var inkDirect = vec3<f32>(0.0);\n  var inkSun = 0.0;",
    gl: "vec3 inkDirect = vec3(0.0);\n  float inkSun = 0.0;"
  },
  perLight: {
    gpu: stepGl.replace("float inkLit", "let inkLit").replace("float inkOn", "let inkOn"),
    gl: stepGl
  },
  postLighting: {
    gpu: /* wgsl */ `
  {
    let inkShadow = 1.0 - inkSun;
    let inkFillLight = material.inkFill.rgb * (0.7 + 0.3 * max(normal.y, 0.0));
    let inkB = select(vec2<f32>(inkP.x - inkP.z, inkP.y), inkP.xz, abs(normal.y) > 0.5);
    let inkR = vec2<f32>(dot(inkB, vec2<f32>(0.83, 0.55)), dot(inkB, vec2<f32>(-0.55, 0.83)));
    let inkBrush = smoothstep(0.5, 0.8, inkFbm(vec2<f32>(inkR.x * 0.45, inkR.y * 7.0)));
    let inkDark = inkShadow * (material.inkShade.z + material.inkShade.x * inkBrush);
    finalColor = albedo * (inkFillLight + inkDirect * INV_PI) * inkAo * (1.0 - inkDark);
    let inkToGlow = material.inkGlow.xyz - inkP;
    let inkColumn = material.inkGlowAmount.y > 0.5;
    let inkGlowAcross = length(inkToGlow.xz);
    let inkGlowDir = select(inkToGlow, vec3<f32>(inkToGlow.x, max(inkGlowAcross, 1.0), inkToGlow.z), inkColumn);
    let inkGlowNear = 1.0 - smoothstep(0.0, material.inkGlow.w, select(length(inkToGlow), inkGlowAcross, inkColumn));
    let inkGlowFace = 0.3 + 0.7 * max(dot(normal, normalize(inkGlowDir + vec3<f32>(0.0, 0.001, 0.0))), 0.0);
    finalColor += ${wgslVec3(RED)} * (albedo + 0.04) * inkGlowNear * inkGlowNear * inkGlowFace * material.inkGlowAmount.x;
    let inkQ = abs(inkP.xz) - material.inkFade.xy + vec2<f32>(material.inkFade.z);
    let inkOut = max(length(max(inkQ, vec2<f32>(0.0))) - material.inkFade.z, 0.0);
    let inkVoid = smoothstep(material.inkFadeRange.x, material.inkFadeRange.y, inkOut + max(-inkP.y, 0.0) * material.inkFadeRange.z) * mix(1.0, material.inkFadeRange.w, smoothstep(0.5, 9.0, inkP.y));
    finalColor = mix(finalColor, ${wgslVec3(INK)}, inkVoid * material.inkFade.w);
  }
`,
    gl: /* glsl */ `
  {
    float inkShadow = 1.0 - inkSun;
    vec3 inkFillLight = material.inkFill.rgb * (0.7 + 0.3 * max(normal.y, 0.0));
    vec2 inkB = abs(normal.y) > 0.5 ? inkP.xz : vec2(inkP.x - inkP.z, inkP.y);
    vec2 inkR = vec2(dot(inkB, vec2(0.83, 0.55)), dot(inkB, vec2(-0.55, 0.83)));
    float inkBrush = smoothstep(0.5, 0.8, inkFbm(vec2(inkR.x * 0.45, inkR.y * 7.0)));
    float inkDark = inkShadow * (material.inkShade.z + material.inkShade.x * inkBrush);
    finalColor = albedo * (inkFillLight + inkDirect * INV_PI) * inkAo * (1.0 - inkDark);
    vec3 inkToGlow = material.inkGlow.xyz - inkP;
    bool inkColumn = material.inkGlowAmount.y > 0.5;
    float inkGlowAcross = length(inkToGlow.xz);
    vec3 inkGlowDir = inkColumn ? vec3(inkToGlow.x, max(inkGlowAcross, 1.0), inkToGlow.z) : inkToGlow;
    float inkGlowNear = 1.0 - smoothstep(0.0, material.inkGlow.w, inkColumn ? inkGlowAcross : length(inkToGlow));
    float inkGlowFace = 0.3 + 0.7 * max(dot(normal, normalize(inkGlowDir + vec3(0.0, 0.001, 0.0))), 0.0);
    finalColor += ${glslVec3(RED)} * (albedo + 0.04) * inkGlowNear * inkGlowNear * inkGlowFace * material.inkGlowAmount.x;
    vec2 inkQ = abs(inkP.xz) - material.inkFade.xy + vec2(material.inkFade.z);
    float inkOut = max(length(max(inkQ, vec2(0.0))) - material.inkFade.z, 0.0);
    float inkVoid = smoothstep(material.inkFadeRange.x, material.inkFadeRange.y, inkOut + max(-inkP.y, 0.0) * material.inkFadeRange.z) * mix(1.0, material.inkFadeRange.w, smoothstep(0.5, 9.0, inkP.y));
    finalColor = mix(finalColor, ${glslVec3(INK)}, inkVoid * material.inkFade.w);
  }
`
  }
})

/** Edge wear and occlusion follow this solid's shape: the box or cylinder centred at (x, y, z) with these half sizes. */
export type InkShape =
  | { readonly kind: "none" }
  | { readonly kind: "box"; readonly x: number; readonly y: number; readonly z: number; readonly halfWidth: number; readonly halfHeight: number; readonly halfDepth: number }
  | { readonly kind: "cylinder"; readonly x: number; readonly y: number; readonly z: number; readonly radius: number; readonly halfHeight: number }

export interface InkOptions {
  readonly color: number
  readonly grain: Texture
  /** Grain texture repeats per world unit. */
  readonly grainScale?: number
  readonly grainAmount?: number
  readonly mottling?: number
  /** Vertical weathering streaks on the sides of props. */
  readonly streaks?: number
  /** A texture laid flat over a ground rectangle (x0, z0, width, depth), such as the floor tiles. */
  readonly surface?: { readonly texture: Texture; readonly x: number; readonly z: number; readonly width: number; readonly depth: number }
  readonly shape?: InkShape
  /** How wide the light worn band along top edges is, in units. */
  readonly wear?: number
  /** How dark dry-brush strokes make the shadowed side. */
  readonly brush?: number
  /** Flat darkening of everything in shadow. */
  readonly shade?: number
  /** Occlusion at the foot of a prop: 1 none, lower darker. */
  readonly occlusion?: number
  /** Linear fill light on the shadowed side. */
  readonly fill?: readonly [number, number, number]
  /** Where this surface fades into the ink-black void; the Courtyard's walls when left out. */
  readonly fade?: InkFade
  /** Red light thrown on this surface by the stage's light source; none when left out. */
  readonly glow?: InkGlow
}

/**
 * The void fade: surfaces fade to ink by their distance outside a rounded box on the ground (half sizes, corner
 * radius; a circle when the radius equals both), plus `depth` times how far below the floor they are, between
 * `start` and `end`. Surfaces high up keep `high` of the fade.
 */
export interface InkFade {
  readonly halfWidth: number
  readonly halfDepth: number
  readonly corner: number
  readonly start: number
  readonly end: number
  readonly depth: number
  readonly high: number
  readonly strength: number
}

/** A red light at (x, y, z) reaching `radius`; a `column` lights by ground distance alone, like a shaft of light. */
export interface InkGlow {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly radius: number
  readonly strength: number
  readonly column: boolean
}

const COURTYARD_FADE: InkFade = {
  halfWidth: ARENA.halfWidth + ARENA.wall,
  halfDepth: ARENA.halfDepth + ARENA.wall,
  corner: 0,
  start: 1,
  end: 15,
  depth: 2,
  high: 0.6,
  strength: 0.94
}

const KIND = { none: 0, box: 1, cylinder: 2 } as const

const shapeLanes = (shape: InkShape, wear: number): { readonly center: Array<number>; readonly size: Array<number> } => {
  switch (shape.kind) {
    case "none": return { center: [0, 0, 0, KIND.none], size: [1, 1, 1, wear] }
    case "box": return { center: [shape.x, shape.y, shape.z, KIND.box], size: [shape.halfWidth, shape.halfHeight, shape.halfDepth, wear] }
    case "cylinder": return { center: [shape.x, shape.y, shape.z, KIND.cylinder], size: [shape.radius, shape.halfHeight, shape.radius, wear] }
  }
}

/** Each zone's linear fill light on the shadowed side; a material without its own `fill` takes the Courtyard's. */
export const ZONE_FILL = { courtyard: [0.2, 0.205, 0.22], spiral: [0.14, 0.14, 0.16], void: [0.15, 0.15, 0.17] } as const satisfies Record<ZoneId, readonly [number, number, number]>

export const inkMaterial = (options: InkOptions): BaseMaterial3D => {
  const material = new BaseMaterial3D({
    baseColor: options.color,
    descriptor: { bitsGpu: [surfaceBit, lightingBit], bitsGl: [surfaceBit, lightingBit] },
    textures: { grain: options.grain, surface: options.surface?.texture }
  })
  const surface = options.surface
  const lanes = shapeLanes(options.shape ?? { kind: "none" }, options.wear ?? 0.08)
  material.data.inkRect = surface === undefined ? [0, 0, 0, 0] : [surface.x, surface.z, 1 / surface.width, 1 / surface.depth]
  material.data.inkShape = lanes.center
  material.data.inkSize = lanes.size
  material.data.inkGrain = [options.grainScale ?? 0.5, options.grainAmount ?? 0.5, options.mottling ?? 0.25, options.streaks ?? 0.3]
  material.data.inkShade = [options.brush ?? 0.3, options.occlusion ?? 0.55, options.shade ?? 0.08, 0]
  material.data.inkFill = [...(options.fill ?? ZONE_FILL.courtyard), 1]
  const fade = options.fade ?? COURTYARD_FADE
  material.data.inkFade = [fade.halfWidth, fade.halfDepth, fade.corner, fade.strength]
  material.data.inkFadeRange = [fade.start, fade.end, fade.depth, fade.high]
  material.data.inkCut = [0, 0, 0, 0]
  setInkGlow(material, options.glow)
  return material
}

/**
 * Thins a surface to `amount` (0 solid, 1 gone) by dropping pixels in a fine dither, so what stands behind it shows
 * through: a tall prop between the camera and the action. Its shadow stays whole.
 */
export const setInkCut = (material: BaseMaterial3D, amount: number): void => {
  material.data.inkCut = [amount, 0, 0, 0]
}

/** Moves or changes the red light on an ink material; none when left out. */
export const setInkGlow = (material: BaseMaterial3D, glow?: InkGlow): void => {
  material.data.inkGlow = glow === undefined ? [0, 0, 0, 1] : [glow.x, glow.y, glow.z, glow.radius]
  material.data.inkGlowAmount = glow === undefined ? [0, 0, 0, 0] : [glow.strength, glow.column ? 1 : 0, 0, 0]
}

/**
 * Moves an ink material built with a `surface` and a `shape` by (dx, dy, dz) from where it was built, for a prop that
 * moves (a Void slab shaking or falling): its ground texture slides with it and its edges wear where they now are.
 */
export const shiftInk = (material: BaseMaterial3D, options: Pick<InkOptions, "surface" | "shape">, dx: number, dy: number, dz: number): void => {
  const surface = options.surface
  if (surface !== undefined) material.data.inkRect = [surface.x + dx, surface.z + dz, 1 / surface.width, 1 / surface.depth]
  const shape = options.shape
  if (shape !== undefined && shape.kind !== "none") material.data.inkShape = [shape.x + dx, shape.y + dy, shape.z + dz, KIND[shape.kind]]
}
