import type { ShaderBit } from "@pixi/3d"

/**
 * Reveal for a stroke bent along a mesh (u along the swing, v across it): `sweep` = (tail, head, erode, glow).
 * Only u between tail and head shows; `erode` eats it through streaky noise from the tail toward the outer
 * edge, leaving a hot `edge` colour on the eaten border; `glow` scales the colour past 1 for bloom.
 */
export const arcBit: ShaderBit = {
  name: "kuzushiArc",
  textures: ["noise"],
  bindings: { material: { sweep: "vec4<f32>", edge: "vec4<f32>" } },
  gpu: {
    fragment: {
      material: /* wgsl */ `{
  let arcU = input.vUV.x;
  let arcV = input.vUV.y;
  let arcIn = smoothstep(material.sweep.x, material.sweep.x + 0.06, arcU) * (1.0 - smoothstep(material.sweep.y - 0.025, material.sweep.y, arcU));
  let arcNoise = sampleNoise(vec2<f32>(arcU * 1.7 + material.edge.w, arcV * 0.45)).r;
  let arcCut = material.sweep.z * (1.35 - 0.7 * arcU) + arcV * 0.35 * material.sweep.z;
  let arcKeep = smoothstep(arcCut - 0.025, arcCut + 0.025, arcNoise);
  let arcRim = (1.0 - smoothstep(arcCut, arcCut + 0.09, arcNoise)) * step(0.001, material.sweep.z);
  albedo = mix(albedo, decodeColor(material.edge.rgb), arcRim * 0.85) * material.sweep.w;
  alpha = alpha * arcIn * arcKeep;
}`
    }
  },
  gl: {
    fragment: {
      material: /* glsl */ `{
  float arcU = vUV.x;
  float arcV = vUV.y;
  float arcIn = smoothstep(material.sweep.x, material.sweep.x + 0.06, arcU) * (1.0 - smoothstep(material.sweep.y - 0.025, material.sweep.y, arcU));
  float arcNoise = sampleNoise(vec2(arcU * 1.7 + material.edge.w, arcV * 0.45)).r;
  float arcCut = material.sweep.z * (1.35 - 0.7 * arcU) + arcV * 0.35 * material.sweep.z;
  float arcKeep = smoothstep(arcCut - 0.025, arcCut + 0.025, arcNoise);
  float arcRim = (1.0 - smoothstep(arcCut, arcCut + 0.09, arcNoise)) * step(0.001, material.sweep.z);
  albedo = mix(albedo, decodeColor(material.edge.rgb), arcRim * 0.85) * material.sweep.w;
  alpha = alpha * arcIn * arcKeep;
}`
    }
  }
}

/**
 * A telegraph filling as its windup runs: `fill` = (progress, mode, flash, dim). Mode 0 is a line along u from
 * the attacker; mode 1 a ring, filled red from the centre out to `progress`. `flash` whitens it as it fires.
 */
export const telegraphBit: ShaderBit = {
  name: "kuzushiTelegraph",
  bindings: { material: { fill: "vec4<f32>", tint: "vec4<f32>" } },
  gpu: {
    fragment: {
      material: /* wgsl */ `{
  let teleRadius = length(input.vUV - vec2<f32>(0.5)) * 2.0;
  let teleCoord = select(input.vUV.x, teleRadius, material.fill.y > 0.5);
  let teleFront = 1.0 - smoothstep(0.0, 0.05, abs(teleCoord - material.fill.x));
  let teleDone = 1.0 - step(material.fill.x, teleCoord);
  let teleRed = decodeColor(material.tint.rgb);
  if (material.fill.y > 0.5) {
    let teleDisc = teleDone * (1.0 - step(0.97, teleRadius));
    let teleFill = teleDisc * (0.05 + 0.2 * teleRadius * teleRadius * teleRadius) + teleFront * 0.45 * (1.0 - step(0.97, teleRadius));
    albedo = mix(teleRed, albedo, alpha);
    alpha = max(alpha * (0.55 + 0.45 * material.fill.x), teleFill);
  } else {
    alpha = alpha * mix(material.fill.w, 1.0, max(teleDone, teleFront));
    albedo = albedo * (1.0 + teleFront * 0.8);
  }
  albedo = mix(albedo, vec3<f32>(1.0), material.fill.z);
}`
    }
  },
  gl: {
    fragment: {
      material: /* glsl */ `{
  float teleRadius = length(vUV - vec2(0.5)) * 2.0;
  float teleCoord = material.fill.y > 0.5 ? teleRadius : vUV.x;
  float teleFront = 1.0 - smoothstep(0.0, 0.05, abs(teleCoord - material.fill.x));
  float teleDone = 1.0 - step(material.fill.x, teleCoord);
  vec3 teleRed = decodeColor(material.tint.rgb);
  if (material.fill.y > 0.5) {
    float teleDisc = teleDone * (1.0 - step(0.97, teleRadius));
    float teleFill = teleDisc * (0.05 + 0.2 * teleRadius * teleRadius * teleRadius) + teleFront * 0.45 * (1.0 - step(0.97, teleRadius));
    albedo = mix(teleRed, albedo, alpha);
    alpha = max(alpha * (0.55 + 0.45 * material.fill.x), teleFill);
  } else {
    alpha = alpha * mix(material.fill.w, 1.0, max(teleDone, teleFront));
    albedo = albedo * (1.0 + teleFront * 0.8);
  }
  albedo = mix(albedo, vec3(1.0), material.fill.z);
}`
    }
  }
}
