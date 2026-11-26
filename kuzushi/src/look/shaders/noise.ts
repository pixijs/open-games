import type { ShaderBit } from "@pixi/3d"

/** Hash, value noise and fbm for world-space paper grain, wear and brush strokes. */
export const noiseBit: ShaderBit = {
  name: "kuzushiNoise",
  gpu: {
    header: /* wgsl */ `
fn inkHash(q: vec2<f32>) -> f32 {
  var p = fract(q * vec2<f32>(123.34, 456.21));
  p = p + dot(p, p + 45.32);
  return fract(p.x * p.y);
}
fn inkNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = inkHash(i);
  let b = inkHash(i + vec2<f32>(1.0, 0.0));
  let c = inkHash(i + vec2<f32>(0.0, 1.0));
  let d = inkHash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn inkFbm(q: vec2<f32>) -> f32 {
  var p = q;
  var amplitude = 0.5;
  var sum = 0.0;
  for (var i = 0; i < 4; i++) {
    sum += amplitude * inkNoise(p);
    p = p * 2.03 + vec2<f32>(17.1, 9.3);
    amplitude *= 0.5;
  }
  return sum / 0.9375;
}
`
  },
  gl: {
    header: /* glsl */ `
float inkHash(vec2 q) {
  vec2 p = fract(q * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float inkNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = inkHash(i);
  float b = inkHash(i + vec2(1.0, 0.0));
  float c = inkHash(i + vec2(0.0, 1.0));
  float d = inkHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float inkFbm(vec2 q) {
  vec2 p = q;
  float amplitude = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * inkNoise(p);
    p = p * 2.03 + vec2(17.1, 9.3);
    amplitude *= 0.5;
  }
  return sum / 0.9375;
}
`
  }
}
