import type { EffectFragment } from "@pixi/3d"

import { TONE_STOPS } from "./tones.ts"

/**
 * The finishing grade's shader, on the picture as it shows (sRGB): outside the Courtyard the Courtyard's red is
 * repainted as the zone's accent; every colour but that accent is locked to the zone's tone ramp by its lightness
 * (src/look/tones.ts); then the whole-frame looks vfx drives (impact frames, flashes, focus, the reveal's outlines),
 * the vignette, paper fibre and film grain that changes on twos. Uniforms are set by `InkGradeEffect` in ./post.ts.
 */

const [, s1, s2, s3, s4] = TONE_STOPS
const stop = (value: number) => value.toFixed(3)

const COMMON_GL = /* glsl */ `
const float IMPACT_LO = 0.28;
const float IMPACT_HI = 0.34;
const float TONE_1 = ${stop(s1)};
const float TONE_2 = ${stop(s2)};
const float TONE_3 = ${stop(s3)};
const float TONE_4 = ${stop(s4)};

float gradeHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float gradeNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gradeHash(i), gradeHash(i + vec2(1.0, 0.0)), u.x), mix(gradeHash(i + vec2(0.0, 1.0)), gradeHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float gradeLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float gradeRedness(vec3 c) { return clamp((c.r - max(c.g, c.b)) * 2.2, 0.0, 1.0); }
float gradeHueNear(vec3 c, float hue) {
  float hi = max(c.r, max(c.g, c.b));
  float chroma = hi - min(c.r, min(c.g, c.b));
  if (chroma < 0.0001) return 0.0;
  float h = hi == c.r ? (c.g - c.b) / chroma : hi == c.g ? (c.b - c.r) / chroma + 2.0 : (c.r - c.g) / chroma + 4.0;
  float d = abs(fract(h / 6.0 - hue + 0.5) - 0.5);
  return 1.0 - smoothstep(0.05, 0.1, d);
}
float gradeAccent(vec3 c, float hue, float on) {
  if (on < 0.5) return gradeRedness(c);
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  return clamp(chroma * 2.2, 0.0, 1.0) * gradeHueNear(c, hue);
}
`

const COMMON_GPU = /* wgsl */ `
const IMPACT_LO = 0.28;
const IMPACT_HI = 0.34;
const TONE_1 = ${stop(s1)};
const TONE_2 = ${stop(s2)};
const TONE_3 = ${stop(s3)};
const TONE_4 = ${stop(s4)};

fn gradeHash(p: vec2<f32>) -> f32 {
  var q = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  q = q + dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
fn gradeNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gradeHash(i), gradeHash(i + vec2<f32>(1.0, 0.0)), u.x), mix(gradeHash(i + vec2<f32>(0.0, 1.0)), gradeHash(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn gradeLuma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn gradeRedness(c: vec3<f32>) -> f32 { return clamp((c.r - max(c.g, c.b)) * 2.2, 0.0, 1.0); }
fn gradeHueNear(c: vec3<f32>, hue: f32) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  let chroma = hi - min(c.r, min(c.g, c.b));
  if (chroma < 0.0001) { return 0.0; }
  var h = (c.r - c.g) / chroma + 4.0;
  if (hi == c.r) { h = (c.g - c.b) / chroma; } else if (hi == c.g) { h = (c.b - c.r) / chroma + 2.0; }
  let d = abs(fract(h / 6.0 - hue + 0.5) - 0.5);
  return 1.0 - smoothstep(0.05, 0.1, d);
}
fn gradeAccent(c: vec3<f32>, hue: f32, on: f32) -> f32 {
  if (on < 0.5) { return gradeRedness(c); }
  let chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  return clamp(chroma * 2.2, 0.0, 1.0) * gradeHueNear(c, hue);
}
`

/** GLSL: the tone ramp, the red repaint and the effect itself. Uniform names are those of `InkGradeEffect`. */
const BODY_GL = /* glsl */ `
vec3 gradeTone(float t) {
  if (t < TONE_1) return mix(uTone0.rgb, uTone1.rgb, t / TONE_1);
  if (t < TONE_2) return mix(uTone1.rgb, uTone2.rgb, (t - TONE_1) / (TONE_2 - TONE_1));
  if (t < TONE_3) return mix(uTone2.rgb, uTone3.rgb, (t - TONE_2) / (TONE_3 - TONE_2));
  if (t < TONE_4) return mix(uTone3.rgb, uTone4.rgb, (t - TONE_3) / (TONE_4 - TONE_3));
  return mix(uTone4.rgb, uTone5.rgb, clamp((t - TONE_4) / (1.0 - TONE_4), 0.0, 1.0));
}
vec3 gradeRepaint(vec3 c) {
  if (uRepaint0.w < 0.5) return c;
  float y = gradeLuma(c);
  vec3 d = c - vec3(y);
  float a = dot(d, uRepaint0.xyz);
  float b = dot(d, uRepaint1.xyz);
  float share = clamp(length(vec2(a, b)) / uRepaint2.w, 0.0, 1.0);
  vec2 turned = uRepaint1.w * vec2(a * uRepaint2.x - b * uRepaint2.y, a * uRepaint2.y + b * uRepaint2.x);
  vec3 moved = vec3(y + share * uRepaint2.z) + turned.x * uRepaint0.xyz + turned.y * uRepaint1.xyz;
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  return mix(c, moved, gradeHueNear(c, uFx4.w) * smoothstep(0.01, 0.05, chroma));
}
vec4 effect(vec2 uv) {
  vec2 px = texel();
  float aspect = px.y / px.x;
  vec2 fromMid = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(fromMid) / length(vec2(aspect, 1.0) * 0.5);
  vec2 center = vec2(uCenter.x, 0.5 + (0.5 - uCenter.y) * sign(uFxClip.w));
  float fromCenter = length((uv - center) * vec2(aspect, 1.0)) / length(vec2(aspect, 1.0) * 0.5);
  vec3 ink = uTone0.rgb;
  vec3 paper = uTone5.rgb;
  vec3 accentColor = uAccent.rgb;

  vec3 c;
  if (uFx2.z > 0.001) {
    vec2 toUv = uv - center;
    float jitter = gradeHash(uv / px) / 15.0;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 16; i++) {
      float t = float(i) / 15.0 + jitter;
      float w = 1.0 - t * 0.6;
      sum += sampleColor(center + toUv * (1.0 - uFx2.z * 0.24 * t)).rgb * w;
      total += w;
    }
    c = sum / total;
  } else {
    c = sampleColor(uv).rgb;
  }

  vec2 shift = (uv - 0.5) * uGrade.w * r * r * r * 0.014;
  float ahead = gradeLuma(sampleColor(uv - shift).rgb);
  float fringe = clamp(ahead - gradeLuma(c), 0.0, 1.0);
  c += vec3(fringe * 0.5, -fringe * 0.15, -fringe * 0.12);
  c = gradeRepaint(c);

  float keep = max(gradeAccent(c, uAccent.w, uFx3.z), uFx4.z * clamp((max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))) * 2.2, 0.0, 1.0) * gradeHueNear(c, uFx4.y));
  float l = clamp(gradeLuma(c), 0.0, 1.0);
  float s = l * l * (3.0 - 2.0 * l);
  vec3 grey = gradeTone(pow(mix(l, s, uGrade.x), 1.06));
  c = mix(grey, c, keep);
  c = mix(c, mix(c * 0.9, c * c * 1.35, 0.4), uFx3.y);

  float luma = gradeLuma(c);
  c = mix(c, vec3(luma), uFx2.y);
  c = mix(c, floor(c * 4.0 + 0.5) / 4.0, uFx1.y);
  vec3 shade = mix(ink, accentColor, uFx3.x);
  vec3 lit = mix(accentColor, ink, uFx3.x);
  vec3 stark = mix(mix(shade, paper, smoothstep(IMPACT_LO, IMPACT_HI, luma)), lit, smoothstep(0.25, 0.35, gradeAccent(c, uAccent.w, uFx3.z)));
  c = mix(c, stark, uFx1.z);
  vec3 inverted = mix(ink + paper - c, c, step(0.3, gradeAccent(c, uAccent.w, uFx3.z)));
  c = mix(c, inverted, uFx1.x);
  c = mix(c, accentColor * (0.18 + 0.95 * gradeLuma(c)), uFx1.w);
  c = mix(c, paper, uFx2.x);

  if (uFx4.x > 0.001) {
    float east = gradeLuma(sampleColor(uv + vec2(px.x * 1.5, 0.0)).rgb);
    float west = gradeLuma(sampleColor(uv - vec2(px.x * 1.5, 0.0)).rgb);
    float south = gradeLuma(sampleColor(uv + vec2(0.0, px.y * 1.5)).rgb);
    float north = gradeLuma(sampleColor(uv - vec2(0.0, px.y * 1.5)).rgb);
    float edge = smoothstep(0.035, 0.11, length(vec2(east - west, south - north)));
    vec3 drawn = mix(ink, mix(paper, accentColor, step(0.3, keep)), edge);
    c = mix(c, drawn, uFx4.x);
  }

  float vignette = smoothstep(0.42, 1.2, r) * uGrade.z * (1.0 - max(uFx1.z, uFx2.x)) + smoothstep(0.15, 0.95, fromCenter) * uFx2.w;
  c = mix(c, ink, clamp(vignette, 0.0, 1.0));

  vec2 pixel = uv / px;
  float fibre = gradeNoise(pixel * vec2(0.011, 0.023)) * 0.45 + gradeNoise(pixel * 0.045 + 7.3) * 0.35 + gradeNoise(pixel * 0.0035) * 0.2;
  c *= 1.0 - (fibre - 0.5) * uCenter.w;
  float grain = gradeHash(floor(pixel) + uCenter.z * vec2(37.0, 91.0)) - 0.5;
  float mid = 1.0 - abs(gradeLuma(c) - 0.45) * 1.6;
  c += grain * uGrade.y * (0.35 + 0.65 * clamp(mid, 0.0, 1.0));
  return vec4(clamp(c, 0.0, 1.0), 1.0);
}
`

const BODY_GPU = /* wgsl */ `
fn gradeTone(t: f32) -> vec3<f32> {
  if (t < TONE_1) { return mix(fx.uTone0.rgb, fx.uTone1.rgb, vec3<f32>(t / TONE_1)); }
  if (t < TONE_2) { return mix(fx.uTone1.rgb, fx.uTone2.rgb, vec3<f32>((t - TONE_1) / (TONE_2 - TONE_1))); }
  if (t < TONE_3) { return mix(fx.uTone2.rgb, fx.uTone3.rgb, vec3<f32>((t - TONE_2) / (TONE_3 - TONE_2))); }
  if (t < TONE_4) { return mix(fx.uTone3.rgb, fx.uTone4.rgb, vec3<f32>((t - TONE_3) / (TONE_4 - TONE_3))); }
  return mix(fx.uTone4.rgb, fx.uTone5.rgb, vec3<f32>(clamp((t - TONE_4) / (1.0 - TONE_4), 0.0, 1.0)));
}
fn gradeRepaint(c: vec3<f32>) -> vec3<f32> {
  if (fx.uRepaint0.w < 0.5) { return c; }
  let y = gradeLuma(c);
  let d = c - vec3<f32>(y);
  let a = dot(d, fx.uRepaint0.xyz);
  let b = dot(d, fx.uRepaint1.xyz);
  let share = clamp(length(vec2<f32>(a, b)) / fx.uRepaint2.w, 0.0, 1.0);
  let turned = fx.uRepaint1.w * vec2<f32>(a * fx.uRepaint2.x - b * fx.uRepaint2.y, a * fx.uRepaint2.y + b * fx.uRepaint2.x);
  let moved = vec3<f32>(y + share * fx.uRepaint2.z) + turned.x * fx.uRepaint0.xyz + turned.y * fx.uRepaint1.xyz;
  let chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  return mix(c, moved, vec3<f32>(gradeHueNear(c, fx.uFx4.w) * smoothstep(0.01, 0.05, chroma)));
}
fn effect(uv: vec2<f32>) -> vec4<f32> {
  let px = texel();
  let aspect = px.y / px.x;
  let fromMid = (uv - 0.5) * vec2<f32>(aspect, 1.0);
  let r = length(fromMid) / length(vec2<f32>(aspect, 1.0) * 0.5);
  let center = vec2<f32>(fx.uCenter.x, 0.5 + (0.5 - fx.uCenter.y) * sign(fxh.uFxClip.w));
  let fromCenter = length((uv - center) * vec2<f32>(aspect, 1.0)) / length(vec2<f32>(aspect, 1.0) * 0.5);
  let ink = fx.uTone0.rgb;
  let paper = fx.uTone5.rgb;
  let accentColor = fx.uAccent.rgb;

  var c = sampleColor(uv).rgb;
  if (fx.uFx2.z > 0.001) {
    let toUv = uv - center;
    let jitter = gradeHash(uv / px) / 15.0;
    var sum = vec3<f32>(0.0);
    var total = 0.0;
    for (var i = 0; i < 16; i++) {
      let t = f32(i) / 15.0 + jitter;
      let w = 1.0 - t * 0.6;
      sum += sampleColor(center + toUv * (1.0 - fx.uFx2.z * 0.24 * t)).rgb * w;
      total += w;
    }
    c = sum / total;
  }

  let shift = (uv - 0.5) * fx.uGrade.w * r * r * r * 0.014;
  let ahead = gradeLuma(sampleColor(uv - shift).rgb);
  let fringe = clamp(ahead - gradeLuma(c), 0.0, 1.0);
  c += vec3<f32>(fringe * 0.5, -fringe * 0.15, -fringe * 0.12);
  c = gradeRepaint(c);

  let keep = max(gradeAccent(c, fx.uAccent.w, fx.uFx3.z), fx.uFx4.z * clamp((max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))) * 2.2, 0.0, 1.0) * gradeHueNear(c, fx.uFx4.y));
  let l = clamp(gradeLuma(c), 0.0, 1.0);
  let s = l * l * (3.0 - 2.0 * l);
  let grey = gradeTone(pow(mix(l, s, fx.uGrade.x), 1.06));
  c = mix(grey, c, vec3<f32>(keep));
  c = mix(c, mix(c * 0.9, c * c * 1.35, 0.4), fx.uFx3.y);

  let luma = gradeLuma(c);
  c = mix(c, vec3<f32>(luma), fx.uFx2.y);
  c = mix(c, floor(c * 4.0 + 0.5) / 4.0, fx.uFx1.y);
  let shade = mix(ink, accentColor, vec3<f32>(fx.uFx3.x));
  let lit = mix(accentColor, ink, vec3<f32>(fx.uFx3.x));
  let stark = mix(mix(shade, paper, vec3<f32>(smoothstep(IMPACT_LO, IMPACT_HI, luma))), lit, vec3<f32>(smoothstep(0.25, 0.35, gradeAccent(c, fx.uAccent.w, fx.uFx3.z))));
  c = mix(c, stark, fx.uFx1.z);
  let inverted = mix(ink + paper - c, c, vec3<f32>(step(0.3, gradeAccent(c, fx.uAccent.w, fx.uFx3.z))));
  c = mix(c, inverted, fx.uFx1.x);
  c = mix(c, accentColor * (0.18 + 0.95 * gradeLuma(c)), fx.uFx1.w);
  c = mix(c, paper, fx.uFx2.x);

  if (fx.uFx4.x > 0.001) {
    let east = gradeLuma(sampleColor(uv + vec2<f32>(px.x * 1.5, 0.0)).rgb);
    let west = gradeLuma(sampleColor(uv - vec2<f32>(px.x * 1.5, 0.0)).rgb);
    let south = gradeLuma(sampleColor(uv + vec2<f32>(0.0, px.y * 1.5)).rgb);
    let north = gradeLuma(sampleColor(uv - vec2<f32>(0.0, px.y * 1.5)).rgb);
    let edge = smoothstep(0.035, 0.11, length(vec2<f32>(east - west, south - north)));
    let drawn = mix(ink, mix(paper, accentColor, vec3<f32>(step(0.3, keep))), vec3<f32>(edge));
    c = mix(c, drawn, vec3<f32>(fx.uFx4.x));
  }

  let vignette = smoothstep(0.42, 1.2, r) * fx.uGrade.z * (1.0 - max(fx.uFx1.z, fx.uFx2.x)) + smoothstep(0.15, 0.95, fromCenter) * fx.uFx2.w;
  c = mix(c, ink, vec3<f32>(clamp(vignette, 0.0, 1.0)));

  let pixel = uv / px;
  let fibre = gradeNoise(pixel * vec2<f32>(0.011, 0.023)) * 0.45 + gradeNoise(pixel * 0.045 + 7.3) * 0.35 + gradeNoise(pixel * 0.0035) * 0.2;
  c *= 1.0 - (fibre - 0.5) * fx.uCenter.w;
  let grain = gradeHash(floor(pixel) + fx.uCenter.z * vec2<f32>(37.0, 91.0)) - 0.5;
  let mid = 1.0 - abs(gradeLuma(c) - 0.45) * 1.6;
  c += grain * fx.uGrade.y * (0.35 + 0.65 * clamp(mid, 0.0, 1.0));
  return vec4<f32>(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`

export const GRADE: EffectFragment = {
  gl: `${COMMON_GL}${BODY_GL}`,
  gpu: `${COMMON_GPU}${BODY_GPU}`
}
