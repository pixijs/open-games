import type { EffectFragment, EffectIO, RenderGraph } from '@pixi/3d';
import { FullscreenPass, PostEffect } from '@pixi/3d';
import { Color, UniformGroup } from 'pixi.js';
import type { ColorSource } from 'pixi.js';

/** Most lens flares one frame draws. */
export const LENS_FLARES = 8;

// The lens and the film, in two passes.
//
// Occlusion: a 2x2 block of texels per flare, so every pixel quad works on one flare and GLSL's implicit-LOD depth
// reads see no derivatives. Each tests a small disc of the depth buffer round its flare's screen point against the
// light's own depth, so a truck sliding in front of a headlight dims its flare smoothly.
//
// The lens pass, in this order:
//
// - distortion: water on the lens, out of focus (soft beads toward the edges and corners that merge where they
//   touch, airflow carrying them outward at speed, a splash's burst of tiny drops that settles, and drops crawling
//   down the sides with trails of droplets) refracts a soft flipped view of the scene; a shockwave ring pushes the
//   image outward, and a heat-haze pocket shimmers it
// - one blur loop of eight jittered taps for both motions: radial streaks away from `uCenter` (the point the shot
//   rushes toward), stronger toward the edges so the subject stays crisp, and a smear along the camera's own turn,
//   faded out round that same centre because the turn is tracking the subject
// - red and blue split along the streaks and across the shockwave ring, none in the middle of the frame and capped,
//   folded into the blur's taps whenever the blur runs
// - the water's look: what it shows defocused by four taps, a little darker, with a gentle rim and a broad
//   specular on the side facing the light
// - anamorphic flares: a soft glow, a white core, a faint halo ring, a blue streak (short and thick plus long and
//   hairline) and ghosts on the axis through the centre
// - a grade: white balance and exposure, saturation, contrast round a pivot, a lift on the blacks, and a split
//   tone that pushes shadows and highlights toward two hues
// - a photo mode that turns the frame to high-contrast silver for the freeze frame, on an orthochromatic film's
//   weights (blind to red, hot in blue)
// - a vignette, animated film grain, and a flash that washes the frame
//
// Each stage is skipped while it is off, so a plain frame costs one tap a pixel plus the eight flare tests.
//
// Positions are content UV with y down, `s`. WGSL's `uv` is already y down; GLSL's is y up, so its taps flip.
// uFx = (blur, aberration, vignette, aspect); uCenter = (x, y, clear radius, _); uGrade = (exposure, contrast, saturation,
// split); uFilm = (grain, time, photo, pivot); uTint = (r, g, b, lift); uShadowTone / uHighlightTone = split-tone
// offsets; uFlash = (r, g, b, amount); uMotion = (x, y, roll, _); uWater = (wetness, spray, flow, world time);
// uShock / uHeat = (x, y, radius in screen heights, strength); uFlareA0/1 = four flares each as columns of
// (x, y, depth, intensity); uFlareB0/1 = (r, g, b, size).

const OCCLUSION_FRAGMENT: EffectFragment = {
  gpu: /* wgsl */ `
const OCCLUSION_TAPS: i32 = 12;

fn effect(uv: vec2<f32>) -> vec4<f32> {
  let i = i32(clamp(floor(uv.x * 8.0), 0.0, 7.0));
  var a = fx.uFlareA1[max(i - 4, 0)];
  if (i < 4) { a = fx.uFlareA0[i]; }
  let margin = 0.15 + a.z * 0.02;
  var visible = 0.0;
  for (var k = 0; k < OCCLUSION_TAPS; k = k + 1) {
    let angle = f32(k) * 2.3999632;
    let r = sqrt((f32(k) + 0.5) / f32(OCCLUSION_TAPS)) * 0.008;
    let s = a.xy + vec2<f32>(cos(angle) * r / fx.uFx.w, sin(angle) * r);
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) {
      visible = visible + 1.0;
    } else if (linearDepth(sampleDepth(s)) > a.z - margin) {
      visible = visible + 1.0;
    }
  }
  return vec4<f32>(visible / f32(OCCLUSION_TAPS) * step(0.0, a.w), 0.0, 0.0, 1.0);
}
`,
  gl: /* glsl */ `
const int OCCLUSION_TAPS = 12;

vec4 effect(vec2 uv) {
  int i = int(clamp(floor(uv.x * 8.0), 0.0, 7.0));
  vec4 a = i < 4 ? uFlareA0[i] : uFlareA1[i - 4];
  float margin = 0.15 + a.z * 0.02;
  float visible = 0.0;
  for (int k = 0; k < OCCLUSION_TAPS; k++) {
    float angle = float(k) * 2.3999632;
    float r = sqrt((float(k) + 0.5) / float(OCCLUSION_TAPS)) * 0.008;
    vec2 s = a.xy + vec2(cos(angle) * r / uFx.w, sin(angle) * r);
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || linearDepth(sampleDepth(vec2(s.x, 1.0 - s.y))) > a.z - margin) {
      visible += 1.0;
    }
  }
  return vec4(visible / float(OCCLUSION_TAPS) * step(0.0, a.w), 0.0, 0.0, 1.0);
}
`,
};

const LENS_FRAGMENT: EffectFragment = {
  gpu: /* wgsl */ `
const BLUR_TAPS: i32 = 8;
// Longest chromatic split, in screen heights.
const MAX_SPLIT: f32 = 0.006;
// Width of the running drops' columns, and the blur radius of what water on the lens shows, in screen heights.
const RUN_CELL: f32 = 0.075;
const DEFOCUS: f32 = 0.01;
const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);
const ORTHO = vec3<f32>(0.12, 0.38, 0.5);

fn tap(s: vec2<f32>) -> vec4<f32> {
  return sampleColor(s);
}

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// One out-of-focus drop of water on the lens: a soft bump that adds into a shared field, so drops that touch merge.
// Returns the refraction offset toward a soft flipped view of what is behind it, its coverage, and its light: a gentle
// rim and a broad specular on the side facing the light, up left.
fn waterDrop(p: vec2<f32>, c: vec2<f32>, radius: f32) -> vec4<f32> {
  let d = (p - c) / radius;
  let rho2 = dot(d, d);
  if (rho2 >= 1.0) { return vec4<f32>(0.0); }
  let k = 1.0 - rho2;
  let g = d - vec2<f32>(-0.35, -0.4);
  let rim = smoothstep(0.3, 0.95, sqrt(rho2)) * max(-0.8 * d.y - 0.3 * d.x, 0.0);
  return vec4<f32>(-d * (k * radius * 2.6), k * k, k * (rim + 0.5 * exp(-dot(g, g) * 6.0)));
}

// Beads on a log-polar grid round the frame centre, at most one per cell. The grid is conformal, so beads stay round,
// and shifting its radial coordinate by drift carries every bead outward, as the airflow at speed does. A cell holds
// a bead while the water there outweighs its hash, and the bead shrinks away as the water falls past it, so drying and
// settling never pop. Beads keep out of the frame's centre third.
fn beadLayer(
  p: vec2<f32>,
  logRadius: f32,
  angle: f32,
  cell: f32,
  wet: f32,
  drift: f32,
  seed: f32,
  small: f32,
  large: f32,
) -> vec4<f32> {
  let around = floor(6.2831853 / cell);
  let id = floor(vec2<f32>((logRadius - drift) / cell, (angle / 6.2831853 + 0.5) * around));
  let h = hash12(id + seed);
  let at = id + 0.5 + (vec2<f32>(hash12(id + seed + 3.1), hash12(id + seed + 7.7)) - 0.5) * 0.5;
  let radial = exp(at.x * cell + drift);
  let theta = (at.y / around - 0.5) * 6.2831853;
  let c = radial * vec2<f32>(cos(theta), sin(theta));
  let here = wet * smoothstep(0.32, 0.75, length(c));
  let size = min(mix(small, large, pow(hash12(id + seed + 5.3), 2.0)), radial * cell * 0.22) * smoothstep(h, h + 0.12, here);
  if (size <= 0.0) { return vec4<f32>(0.0); }
  return waterDrop(p, c, size);
}

// Drops near the frame's sides crawling down, now and then leaving a trail of tiny droplets; drift carries the columns
// outward. The two sides mirror each other with their own seeds.
fn runLayer(p: vec2<f32>, wet: f32, t: f32, drift: f32) -> vec4<f32> {
  let side = select(-1.0, 1.0, p.x > 0.0);
  let sp = vec2<f32>(p.x * side - drift, p.y);
  let column = floor(sp.x / RUN_CELL);
  let key = vec2<f32>(column, side * 17.3);
  let h = hash12(key);
  let x = (column + 0.5 + (hash12(key + 2.9) - 0.5) * 0.3) * RUN_CELL;
  let size = mix(0.008, 0.015, hash12(key + 4.4)) * smoothstep(h, h + 0.1, wet * 0.5 * smoothstep(0.42, 0.65, x + drift));
  if (size <= 0.0) { return vec4<f32>(0.0); }
  let head = fract(t * mix(0.012, 0.035, hash12(key + 1.3)) + h * 7.1) * 1.8 - 0.9;
  var water = waterDrop(sp, vec2<f32>(x, head), size);
  let above = head - sp.y;
  let spacing = size * 1.8;
  let k = floor(above / spacing);
  let hk = hash12(vec2<f32>(column, k) + side * 5.1);
  if (k >= 1.0 && above < 0.3 && hk < 0.5) {
    let at = vec2<f32>(x + (hash12(vec2<f32>(column + 0.7, k)) - 0.5) * size * 0.6, head - (k + 0.5) * spacing);
    water = water + waterDrop(sp, at, size * mix(0.22, 0.42, hk * 2.0) * (1.0 - above / 0.3));
  }
  return vec4<f32>(water.x * side, water.yzw);
}

// Water on the lens, worked in screen heights from the frame centre: running drops at the sides and three bead layers
// (settled beads, smaller ones, and a splash's burst of tiny ones), all sliding slowly down on the world clock.
fn lensWater(s: vec2<f32>, aspect: f32) -> vec4<f32> {
  let wet = fx.uWater.x;
  let flow = fx.uWater.z;
  let t = fx.uWater.w;
  let p = vec2<f32>((s.x - 0.5) * aspect, s.y - 0.5);
  var water = runLayer(p, wet - 0.2, t, flow * 0.05);
  let b = p - vec2<f32>(0.0, t * 0.004);
  let radius = length(b);
  if (radius > 0.25) {
    let logRadius = log(radius);
    let angle = atan2(b.y, b.x);
    water = water + beadLayer(b, logRadius, angle, 0.22, wet * 0.45, flow, 0.0, 0.008, 0.03)
      + beadLayer(b, logRadius, angle, 0.13, wet * 0.5, flow * 1.4, 31.7, 0.005, 0.012)
      + beadLayer(b, logRadius, angle, 0.08, fx.uWater.y * 0.6, flow * 2.0, 57.3, 0.003, 0.007);
  }
  return vec4<f32>(water.x / aspect, water.yzw);
}

fn ghost(s: vec2<f32>, at: vec2<f32>, radius: f32, aspect: f32) -> f32 {
  let d = length(vec2<f32>((s.x - at.x) * aspect, s.y - at.y));
  return (1.0 - smoothstep(radius * 0.7, radius, d)) * (0.45 + 0.55 * smoothstep(0.3 * radius, radius, d));
}

fn flare(s: vec2<f32>, aspect: f32, a: vec4<f32>, b: vec4<f32>, index: i32) -> vec3<f32> {
  if (a.w <= 0.0) { return vec3<f32>(0.0); }
  let amount = a.w * sampleColor2(vec2<f32>((f32(index) + 0.5) / 8.0, 0.5)).r;
  if (amount <= 0.002) { return vec3<f32>(0.0); }
  let size = b.w;
  let to = vec2<f32>((s.x - a.x) * aspect, s.y - a.y);
  let d = length(to);
  var light = b.rgb * (0.6 * exp(-d * 22.0 / size) + 0.15 * exp(-d * 6.0 / size));
  light = light + vec3<f32>(exp(-d * 90.0 / size));
  let halo = d / (0.13 * size) - 1.0;
  light = light + b.rgb * (0.05 * exp(-halo * halo * 60.0));
  let blue = mix(b.rgb, vec3<f32>(0.2, 0.45, 1.0), 0.85);
  let ax = abs(to.x);
  let ay = abs(to.y);
  light = light + blue * (0.55 * exp(-ay * 300.0 / size - ax * 2.2) + 0.3 * exp(-ay * 900.0 / size - ax * 0.7));
  let axis = vec2<f32>(0.5) - a.xy;
  light = light + mix(b.rgb, vec3<f32>(1.0, 0.55, 0.25), 0.5) * (0.16 * ghost(s, a.xy + axis * 0.62, 0.022, aspect));
  light = light + mix(b.rgb, vec3<f32>(0.3, 0.9, 1.0), 0.6) * (0.1 * ghost(s, a.xy + axis * 1.38, 0.055, aspect));
  light = light + mix(b.rgb, vec3<f32>(0.7, 0.4, 1.0), 0.5) * (0.07 * ghost(s, a.xy + axis * 2.05, 0.1, aspect));
  return light * amount;
}

fn grainNoise(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn effect(uv: vec2<f32>) -> vec4<f32> {
  let s = uv;
  let aspect = fx.uFx.w;
  var warp = vec2<f32>(0.0);
  var ring = vec2<f32>(0.0);
  var water = vec4<f32>(0.0);
  var glint = 0.0;

  if (fx.uWater.x + fx.uWater.y > 0.002) {
    water = lensWater(s, aspect);
    warp = water.xy;
  }

  if (fx.uShock.w > 0.001) {
    let to = vec2<f32>((s.x - fx.uShock.x) * aspect, s.y - fx.uShock.y);
    let d = length(to);
    let width = 0.02 + fx.uShock.z * 0.12;
    let x = (d - fx.uShock.z) / width;
    if (abs(x) < 3.0) {
      let wave = x * exp(-x * x * 1.5) * fx.uShock.w;
      let dir = to / max(d, 1e-4);
      warp = warp + vec2<f32>(dir.x / aspect, dir.y) * (wave * width);
      ring = vec2<f32>(dir.x / aspect, dir.y) * (abs(wave) * 0.012);
      glint = glint + exp(-x * x * 2.0) * fx.uShock.w * 0.04;
    }
  }

  if (fx.uHeat.w > 0.001) {
    let radius = max(fx.uHeat.z, 0.01);
    let to = vec2<f32>((s.x - fx.uHeat.x) * aspect, s.y - fx.uHeat.y) / radius;
    let d2 = dot(to, to);
    if (d2 < 1.0) {
      let t = fx.uWater.w;
      let fall = (1.0 - d2) * (1.0 - d2);
      let q = vec2<f32>(s.x * aspect, s.y) / radius;
      let wobble = vec2<f32>(
        sin(q.y * 22.0 + t * 9.0 + sin(q.x * 13.0 + t * 4.0) * 1.7),
        cos(q.x * 19.0 - t * 7.0 + sin((q.y + t * 1.5) * 17.0) * 1.3),
      );
      warp = warp + vec2<f32>(wobble.x / aspect, wobble.y) * (fall * fx.uHeat.w * radius * 0.05);
    }
  }

  let ws = s + warp;
  let dir = ws - fx.uCenter.xy;
  let dist = length(vec2<f32>(dir.x * aspect, dir.y));
  let clear = fx.uCenter.z;
  let streak = fx.uFx.x * smoothstep(clear, 0.8, dist);
  let motion = (fx.uMotion.xy
    + fx.uMotion.z * vec2<f32>((1.0 - 2.0 * s.y) * 0.5 / aspect, (2.0 * s.x - 1.0) * aspect * 0.5))
    * smoothstep(clear, clear + 0.4, dist);
  var split = dir * (fx.uFx.y * dist * smoothstep(0.22, 0.75, dist)) + ring;
  let splitLength = length(vec2<f32>(split.x * aspect, split.y));
  if (splitLength > MAX_SPLIT) { split = split * (MAX_SPLIT / splitLength); }
  var col: vec4<f32>;
  if (streak > 0.002 || dot(motion, motion) > 1e-7) {
    // Each tap also slides from the red end of the split to the blue end and counts toward that hue, so red and blue
    // smear with the rest instead of cutting sharp across the blur. The hue order is a permutation of the tap order,
    // so every channel still covers the whole streak.
    let jitter = fract(52.9829189 * fract(dot(uv / texel(), vec2<f32>(0.06711056, 0.00583715))));
    let chroma = step(1e-10, dot(split, split));
    var sum = vec3<f32>(0.0);
    var weight = vec3<f32>(0.0);
    var alpha = 0.0;
    for (var i = 0; i < BLUR_TAPS; i = i + 1) {
      let k = (f32(i) + jitter) / f32(BLUR_TAPS);
      let hue = fract((f32(i) * 3.0 + jitter) / f32(BLUR_TAPS));
      let c = tap(ws - dir * (streak * k) + motion * (k - 0.5) + split * ((1.0 - 2.0 * hue) * chroma));
      let w = mix(vec3<f32>(1.0), vec3<f32>(1.0 - hue, 1.0 - abs(2.0 * hue - 1.0), hue), chroma);
      sum = sum + c.rgb * w;
      weight = weight + w;
      alpha = alpha + c.a;
    }
    col = vec4<f32>(sum / max(weight, vec3<f32>(1e-4)), alpha / f32(BLUR_TAPS));
  } else {
    col = tap(ws);
    if (dot(split, split) > 1e-10) {
      col = vec4<f32>(tap(ws + split).r, col.g, tap(ws - split).b, col.a);
    }
  }
  let cover = min(water.z, 1.0);
  if (cover > 0.002) {
    // Water on the lens is out of focus: four taps round the refracted point soften what it shows.
    let r = vec2<f32>(DEFOCUS / aspect, DEFOCUS);
    let soft = tap(ws + r).rgb + tap(ws - r).rgb + tap(ws + vec2<f32>(r.x, -r.y)).rgb + tap(ws - vec2<f32>(r.x, -r.y)).rgb;
    col = vec4<f32>(mix(col.rgb, soft * (0.25 + 0.03 * cover), smoothstep(0.0, 0.4, cover)), col.a);
  }
  var rgb = col.rgb * ((1.0 - 0.15 * cover) * (1.0 + 0.5 * water.w)) + vec3<f32>(0.07 * water.w + glint);

  for (var i = 0; i < 4; i = i + 1) {
    rgb = rgb + flare(s, aspect, fx.uFlareA0[i], fx.uFlareB0[i], i) * col.a;
    rgb = rgb + flare(s, aspect, fx.uFlareA1[i], fx.uFlareB1[i], i + 4) * col.a;
  }

  rgb = rgb * fx.uTint.rgb * fx.uGrade.x;
  let luma = dot(rgb, LUMA);
  rgb = mix(vec3<f32>(luma), rgb, fx.uGrade.z);
  let pivot = fx.uFilm.w;
  rgb = (rgb - vec3<f32>(pivot)) * fx.uGrade.y + vec3<f32>(pivot);
  let shadows = 1.0 - smoothstep(0.0, 0.5, luma);
  let highlights = smoothstep(0.45, 1.0, luma);
  rgb = rgb + fx.uTint.w * shadows + fx.uGrade.w * (fx.uShadowTone.rgb * shadows + fx.uHighlightTone.rgb * highlights);

  let photo = fx.uFilm.z;
  if (photo > 0.001) {
    let silver = smoothstep(0.06, 1.0, clamp(dot(rgb, ORTHO), 0.0, 1.0)) * 0.93;
    rgb = mix(rgb, vec3<f32>(silver * 1.02, silver, silver * 0.95), photo);
  }

  let vd = length(vec2<f32>((s.x - 0.5) * aspect, s.y - 0.5));
  rgb = rgb * (1.0 - smoothstep(0.45, 1.15, vd) * fx.uFx.z);

  let grain = fx.uFilm.x + photo * 0.09;
  if (grain > 0.0005) {
    let frame = floor(fx.uFilm.y * 24.0);
    rgb = rgb + (grainNoise(uv / texel() + vec2<f32>(frame * 37.0, frame * 17.0)) - 0.5) * (grain * 2.0);
  }

  rgb = mix(max(rgb, vec3<f32>(0.0)), fx.uFlash.rgb * col.a, fx.uFlash.a);
  return vec4<f32>(rgb, col.a);
}
`,
  gl: /* glsl */ `
const int BLUR_TAPS = 8;
const float MAX_SPLIT = 0.006;
const float RUN_CELL = 0.075;
const float DEFOCUS = 0.01;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const vec3 ORTHO = vec3(0.12, 0.38, 0.5);

vec4 tap(vec2 s) {
  return sampleColor(vec2(s.x, 1.0 - s.y));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 waterDrop(vec2 p, vec2 c, float radius) {
  vec2 d = (p - c) / radius;
  float rho2 = dot(d, d);
  if (rho2 >= 1.0) return vec4(0.0);
  float k = 1.0 - rho2;
  vec2 g = d - vec2(-0.35, -0.4);
  float rim = smoothstep(0.3, 0.95, sqrt(rho2)) * max(-0.8 * d.y - 0.3 * d.x, 0.0);
  return vec4(-d * (k * radius * 2.6), k * k, k * (rim + 0.5 * exp(-dot(g, g) * 6.0)));
}

vec4 beadLayer(vec2 p, float logRadius, float angle, float cell, float wet, float drift, float seed, float small, float large) {
  float around = floor(6.2831853 / cell);
  vec2 id = floor(vec2((logRadius - drift) / cell, (angle / 6.2831853 + 0.5) * around));
  float h = hash12(id + seed);
  vec2 at = id + 0.5 + (vec2(hash12(id + seed + 3.1), hash12(id + seed + 7.7)) - 0.5) * 0.5;
  float radial = exp(at.x * cell + drift);
  float theta = (at.y / around - 0.5) * 6.2831853;
  vec2 c = radial * vec2(cos(theta), sin(theta));
  float here = wet * smoothstep(0.32, 0.75, length(c));
  float size = min(mix(small, large, pow(hash12(id + seed + 5.3), 2.0)), radial * cell * 0.22) * smoothstep(h, h + 0.12, here);
  if (size <= 0.0) return vec4(0.0);
  return waterDrop(p, c, size);
}

vec4 runLayer(vec2 p, float wet, float t, float drift) {
  float side = p.x > 0.0 ? 1.0 : -1.0;
  vec2 sp = vec2(p.x * side - drift, p.y);
  float column = floor(sp.x / RUN_CELL);
  vec2 key = vec2(column, side * 17.3);
  float h = hash12(key);
  float x = (column + 0.5 + (hash12(key + 2.9) - 0.5) * 0.3) * RUN_CELL;
  float size = mix(0.008, 0.015, hash12(key + 4.4)) * smoothstep(h, h + 0.1, wet * 0.5 * smoothstep(0.42, 0.65, x + drift));
  if (size <= 0.0) return vec4(0.0);
  float head = fract(t * mix(0.012, 0.035, hash12(key + 1.3)) + h * 7.1) * 1.8 - 0.9;
  vec4 water = waterDrop(sp, vec2(x, head), size);
  float above = head - sp.y;
  float spacing = size * 1.8;
  float k = floor(above / spacing);
  float hk = hash12(vec2(column, k) + side * 5.1);
  if (k >= 1.0 && above < 0.3 && hk < 0.5) {
    vec2 at = vec2(x + (hash12(vec2(column + 0.7, k)) - 0.5) * size * 0.6, head - (k + 0.5) * spacing);
    water += waterDrop(sp, at, size * mix(0.22, 0.42, hk * 2.0) * (1.0 - above / 0.3));
  }
  return vec4(water.x * side, water.yzw);
}

vec4 lensWater(vec2 s, float aspect) {
  float wet = uWater.x;
  float flow = uWater.z;
  float t = uWater.w;
  vec2 p = vec2((s.x - 0.5) * aspect, s.y - 0.5);
  vec4 water = runLayer(p, wet - 0.2, t, flow * 0.05);
  vec2 b = p - vec2(0.0, t * 0.004);
  float radius = length(b);
  if (radius > 0.25) {
    float logRadius = log(radius);
    float angle = atan(b.y, b.x);
    water += beadLayer(b, logRadius, angle, 0.22, wet * 0.45, flow, 0.0, 0.008, 0.03)
      + beadLayer(b, logRadius, angle, 0.13, wet * 0.5, flow * 1.4, 31.7, 0.005, 0.012)
      + beadLayer(b, logRadius, angle, 0.08, uWater.y * 0.6, flow * 2.0, 57.3, 0.003, 0.007);
  }
  return vec4(water.x / aspect, water.yzw);
}

float ghost(vec2 s, vec2 at, float radius, float aspect) {
  float d = length(vec2((s.x - at.x) * aspect, s.y - at.y));
  return (1.0 - smoothstep(radius * 0.7, radius, d)) * (0.45 + 0.55 * smoothstep(0.3 * radius, radius, d));
}

vec3 flare(vec2 s, float aspect, vec4 a, vec4 b, int index) {
  if (a.w <= 0.0) return vec3(0.0);
  float amount = a.w * sampleColor2(vec2((float(index) + 0.5) / 8.0, 0.5)).r;
  if (amount <= 0.002) return vec3(0.0);
  float size = b.w;
  vec2 to = vec2((s.x - a.x) * aspect, s.y - a.y);
  float d = length(to);
  vec3 light = b.rgb * (0.6 * exp(-d * 22.0 / size) + 0.15 * exp(-d * 6.0 / size));
  light += vec3(exp(-d * 90.0 / size));
  float halo = d / (0.13 * size) - 1.0;
  light += b.rgb * (0.05 * exp(-halo * halo * 60.0));
  vec3 blue = mix(b.rgb, vec3(0.2, 0.45, 1.0), 0.85);
  float ax = abs(to.x);
  float ay = abs(to.y);
  light += blue * (0.55 * exp(-ay * 300.0 / size - ax * 2.2) + 0.3 * exp(-ay * 900.0 / size - ax * 0.7));
  vec2 axis = vec2(0.5) - a.xy;
  light += mix(b.rgb, vec3(1.0, 0.55, 0.25), 0.5) * (0.16 * ghost(s, a.xy + axis * 0.62, 0.022, aspect));
  light += mix(b.rgb, vec3(0.3, 0.9, 1.0), 0.6) * (0.1 * ghost(s, a.xy + axis * 1.38, 0.055, aspect));
  light += mix(b.rgb, vec3(0.7, 0.4, 1.0), 0.5) * (0.07 * ghost(s, a.xy + axis * 2.05, 0.1, aspect));
  return light * amount;
}

float grainNoise(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 effect(vec2 uv) {
  vec2 s = vec2(uv.x, 1.0 - uv.y);
  float aspect = uFx.w;
  vec2 warp = vec2(0.0);
  vec2 ring = vec2(0.0);
  vec4 water = vec4(0.0);
  float glint = 0.0;

  if (uWater.x + uWater.y > 0.002) {
    water = lensWater(s, aspect);
    warp = water.xy;
  }

  if (uShock.w > 0.001) {
    vec2 to = vec2((s.x - uShock.x) * aspect, s.y - uShock.y);
    float d = length(to);
    float width = 0.02 + uShock.z * 0.12;
    float x = (d - uShock.z) / width;
    if (abs(x) < 3.0) {
      float wave = x * exp(-x * x * 1.5) * uShock.w;
      vec2 dir = to / max(d, 1e-4);
      warp += vec2(dir.x / aspect, dir.y) * (wave * width);
      ring = vec2(dir.x / aspect, dir.y) * (abs(wave) * 0.012);
      glint += exp(-x * x * 2.0) * uShock.w * 0.04;
    }
  }

  if (uHeat.w > 0.001) {
    float radius = max(uHeat.z, 0.01);
    vec2 to = vec2((s.x - uHeat.x) * aspect, s.y - uHeat.y) / radius;
    float d2 = dot(to, to);
    if (d2 < 1.0) {
      float t = uWater.w;
      float fall = (1.0 - d2) * (1.0 - d2);
      vec2 q = vec2(s.x * aspect, s.y) / radius;
      vec2 wobble = vec2(
        sin(q.y * 22.0 + t * 9.0 + sin(q.x * 13.0 + t * 4.0) * 1.7),
        cos(q.x * 19.0 - t * 7.0 + sin((q.y + t * 1.5) * 17.0) * 1.3)
      );
      warp += vec2(wobble.x / aspect, wobble.y) * (fall * uHeat.w * radius * 0.05);
    }
  }

  vec2 ws = s + warp;
  vec2 dir = ws - uCenter.xy;
  float dist = length(vec2(dir.x * aspect, dir.y));
  float clear = uCenter.z;
  float streak = uFx.x * smoothstep(clear, 0.8, dist);
  vec2 motion = (uMotion.xy + uMotion.z * vec2((1.0 - 2.0 * s.y) * 0.5 / aspect, (2.0 * s.x - 1.0) * aspect * 0.5))
    * smoothstep(clear, clear + 0.4, dist);
  vec2 split = dir * (uFx.y * dist * smoothstep(0.22, 0.75, dist)) + ring;
  float splitLength = length(vec2(split.x * aspect, split.y));
  if (splitLength > MAX_SPLIT) split *= MAX_SPLIT / splitLength;
  vec4 col;
  if (streak > 0.002 || dot(motion, motion) > 1e-7) {
    float jitter = fract(52.9829189 * fract(dot(uv / texel(), vec2(0.06711056, 0.00583715))));
    float chroma = step(1e-10, dot(split, split));
    vec3 sum = vec3(0.0);
    vec3 weight = vec3(0.0);
    float alpha = 0.0;
    for (int i = 0; i < BLUR_TAPS; i++) {
      float k = (float(i) + jitter) / float(BLUR_TAPS);
      float hue = fract((float(i) * 3.0 + jitter) / float(BLUR_TAPS));
      vec4 c = tap(ws - dir * (streak * k) + motion * (k - 0.5) + split * ((1.0 - 2.0 * hue) * chroma));
      vec3 w = mix(vec3(1.0), vec3(1.0 - hue, 1.0 - abs(2.0 * hue - 1.0), hue), chroma);
      sum += c.rgb * w;
      weight += w;
      alpha += c.a;
    }
    col = vec4(sum / max(weight, vec3(1e-4)), alpha / float(BLUR_TAPS));
  } else {
    col = tap(ws);
    if (dot(split, split) > 1e-10) col = vec4(tap(ws + split).r, col.g, tap(ws - split).b, col.a);
  }
  float cover = min(water.z, 1.0);
  if (cover > 0.002) {
    vec2 r = vec2(DEFOCUS / aspect, DEFOCUS);
    vec3 soft = tap(ws + r).rgb + tap(ws - r).rgb + tap(ws + vec2(r.x, -r.y)).rgb + tap(ws - vec2(r.x, -r.y)).rgb;
    col = vec4(mix(col.rgb, soft * (0.25 + 0.03 * cover), smoothstep(0.0, 0.4, cover)), col.a);
  }
  vec3 rgb = col.rgb * ((1.0 - 0.15 * cover) * (1.0 + 0.5 * water.w)) + vec3(0.07 * water.w + glint);

  for (int i = 0; i < 4; i++) {
    rgb += flare(s, aspect, uFlareA0[i], uFlareB0[i], i) * col.a;
    rgb += flare(s, aspect, uFlareA1[i], uFlareB1[i], i + 4) * col.a;
  }

  rgb *= uTint.rgb * uGrade.x;
  float luma = dot(rgb, LUMA);
  rgb = mix(vec3(luma), rgb, uGrade.z);
  float pivot = uFilm.w;
  rgb = (rgb - pivot) * uGrade.y + pivot;
  float shadows = 1.0 - smoothstep(0.0, 0.5, luma);
  float highlights = smoothstep(0.45, 1.0, luma);
  rgb += uTint.w * shadows + uGrade.w * (uShadowTone.rgb * shadows + uHighlightTone.rgb * highlights);

  float photo = uFilm.z;
  if (photo > 0.001) {
    float silver = smoothstep(0.06, 1.0, clamp(dot(rgb, ORTHO), 0.0, 1.0)) * 0.93;
    rgb = mix(rgb, vec3(silver * 1.02, silver, silver * 0.95), photo);
  }

  float vd = length(vec2((s.x - 0.5) * aspect, s.y - 0.5));
  rgb *= 1.0 - smoothstep(0.45, 1.15, vd) * uFx.z;

  float grain = uFilm.x + photo * 0.09;
  if (grain > 0.0005) {
    float frame = floor(uFilm.y * 24.0);
    rgb += (grainNoise(uv / texel() + vec2(frame * 37.0, frame * 17.0)) - 0.5) * (grain * 2.0);
  }

  rgb = mix(max(rgb, vec3(0.0)), uFlash.rgb * col.a, uFlash.a);
  return vec4(rgb, col.a);
}
`,
};

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
/** How far a split-tone hue pushes at full strength. */
const SPLIT_REACH = 0.12;

/**
 * The film's lens in one pass after a tiny occlusion pass: water drops, shockwave and heat distortion, radial and
 * rotational motion blur, chromatic split, anamorphic flares, colour grade, photo mode, vignette, grain and flash,
 * every knob a live uniform.
 *
 * A worked example of a custom {@link PostEffect} that builds its own passes. With every effect off it costs one
 * colour tap a pixel and the eight flare checks.
 */
export class LensEffect extends PostEffect {
  protected override readonly uniforms = new UniformGroup({
    uFx: { value: new Float32Array([0, 0, 0, 1]), type: 'vec4<f32>' },
    uCenter: { value: new Float32Array([0.5, 0.5, 0.08, 0]), type: 'vec4<f32>' },
    uGrade: { value: new Float32Array([1, 1, 1, 0]), type: 'vec4<f32>' },
    uFilm: { value: new Float32Array([0, 0, 0, 0.5]), type: 'vec4<f32>' },
    uTint: { value: new Float32Array([1, 1, 1, 0]), type: 'vec4<f32>' },
    uShadowTone: { value: new Float32Array([-0.02, 0.008, 0.028, 0]), type: 'vec4<f32>' },
    uHighlightTone: { value: new Float32Array([0.05, 0.016, -0.04, 0]), type: 'vec4<f32>' },
    uFlash: { value: new Float32Array(4), type: 'vec4<f32>' },
    uMotion: { value: new Float32Array(4), type: 'vec4<f32>' },
    uWater: { value: new Float32Array(4), type: 'vec4<f32>' },
    uShock: { value: new Float32Array(4), type: 'vec4<f32>' },
    uHeat: { value: new Float32Array(4), type: 'vec4<f32>' },
    uFlareA0: { value: new Float32Array(16), type: 'mat4x4<f32>' },
    uFlareA1: { value: new Float32Array(16), type: 'mat4x4<f32>' },
    uFlareB0: { value: new Float32Array(16), type: 'mat4x4<f32>' },
    uFlareB1: { value: new Float32Array(16), type: 'mat4x4<f32>' },
  });

  constructor() {
    super({ stage: 'afterToneMapping' });
  }

  public override build(graph: RenderGraph, io: EffectIO): void {
    const occlusion = graph.createColor({
      width: LENS_FLARES * 2,
      height: 2,
      resolution: 1,
      format: 'rgba8unorm',
      label: 'lensFlareOcclusion',
    });

    graph.addPass(
      new FullscreenPass({
        renderer: io.renderer,
        label: 'lens:occlusion',
        fragment: OCCLUSION_FRAGMENT,
        uniforms: this.uniforms,
        reads: { depth: graph.sceneDepth },
        writes: occlusion,
      }),
    );
    graph.addPass(
      new FullscreenPass({
        renderer: io.renderer,
        label: 'lens',
        fragment: LENS_FRAGMENT,
        uniforms: this.uniforms,
        reads: { color: io.input, color2: occlusion, depth: graph.sceneDepth },
        writes: io.output,
      }),
    );
  }

  /** Streak length as a fraction of the distance to the centre */
  public set blur(value: number) {
    this.writeLane(this.uniforms, 'uFx', 0, value);
  }

  /** Red/blue split strength toward the frame's edges; there is none in the middle third and it is capped */
  public set aberration(value: number) {
    this.writeLane(this.uniforms, 'uFx', 1, value);
  }

  /** Vignette darkness round the frame centre, 0 to 1 */
  public set vignette(value: number) {
    this.writeLane(this.uniforms, 'uFx', 2, value);
  }

  /** Viewport width over height, so the vignette, falloff, drops and flares stay round */
  public set aspect(value: number) {
    this.writeLane(this.uniforms, 'uFx', 3, value);
  }

  /**
   * Radius round the streak centre, in screen heights, that the radial streaks and the turn smear leave sharp; both
   * ramp in from there. 0.08 by default, at most 0.7.
   */
  public set clearRadius(value: number) {
    this.writeLane(this.uniforms, 'uCenter', 2, Math.min(0.7, Math.max(0, value)));
  }

  /** Brightness multiplier before the rest of the grade; 1 leaves the frame alone */
  public set exposure(value: number) {
    this.writeLane(this.uniforms, 'uGrade', 0, value);
  }

  /** Contrast round {@link LensEffect.pivot}; 1 leaves the frame alone */
  public set contrast(value: number) {
    this.writeLane(this.uniforms, 'uGrade', 1, value);
  }

  /** Saturation; 0 is greyscale, 1 leaves the frame alone */
  public set saturation(value: number) {
    this.writeLane(this.uniforms, 'uGrade', 2, value);
  }

  /** Split-tone strength, 0 for none; the hues come from {@link LensEffect.setSplitTone} */
  public set splitTone(value: number) {
    this.writeLane(this.uniforms, 'uGrade', 3, value);
  }

  /** Film grain amplitude, about 0.02 to 0.05 */
  public set grain(value: number) {
    this.writeLane(this.uniforms, 'uFilm', 0, value);
  }

  /** Take seconds the grain and the running drops animate by; the grain steps at 24 frames a second */
  public set time(value: number) {
    this.writeLane(this.uniforms, 'uFilm', 1, value);
  }

  /** Photo-finish look, 0 to 1: high-contrast silver monochrome with heavy grain */
  public set photo(value: number) {
    this.writeLane(this.uniforms, 'uFilm', 2, value);
  }

  /** The grey contrast pivots round, 0.5 by default; lower it for a night look so contrast deepens the blacks */
  public set pivot(value: number) {
    this.writeLane(this.uniforms, 'uFilm', 3, value);
  }

  /** Added to the shadows after contrast; negative crushes them */
  public set lift(value: number) {
    this.writeLane(this.uniforms, 'uTint', 3, value);
  }

  /** World seconds the heat haze shimmers and the water on the lens slides by; hold it and both freeze */
  public set worldTime(value: number) {
    this.writeLane(this.uniforms, 'uWater', 3, value);
  }

  /**
   * Point the streaks radiate from, in content UV
   * @param x - Horizontal UV, 0 at the left.
   * @param y - Vertical UV, 0 at the top.
   */
  public setCenter(x: number, y: number): void {
    const center = this.uniforms.uniforms.uCenter as Float32Array;

    center[0] = x;
    center[1] = y;
    this.uniforms.update();
  }

  /**
   * White balance: multiply the frame by a colour before the grade
   * @param color - Tint; white leaves the frame alone.
   */
  public setTint(color: ColorSource): void {
    const tint = this.uniforms.uniforms.uTint as Float32Array;
    const c = Color.shared.setValue(color);

    tint[0] = c.red;
    tint[1] = c.green;
    tint[2] = c.blue;
    this.uniforms.update();
  }

  /**
   * The hues the split tone pushes shadows and highlights toward, keeping their brightness
   * @param shadow - Shadow hue.
   * @param highlight - Highlight hue.
   */
  public setSplitTone(shadow: ColorSource, highlight: ColorSource): void {
    writeHue(this.uniforms.uniforms.uShadowTone as Float32Array, shadow);
    writeHue(this.uniforms.uniforms.uHighlightTone as Float32Array, highlight);
    this.uniforms.update();
  }

  /**
   * Wash the frame toward a colour
   * @param color - Flash colour.
   * @param amount - Mix amount, 0 for none.
   */
  public setFlash(color: ColorSource, amount: number): void {
    const flash = this.uniforms.uniforms.uFlash as Float32Array;
    const c = Color.shared.setValue(color);

    flash[0] = c.red;
    flash[1] = c.green;
    flash[2] = c.blue;
    flash[3] = amount;
    this.uniforms.update();
  }

  /**
   * Smear the frame along the camera's own turn, centred on each pixel
   * @param x - Sideways smear, in content UV.
   * @param y - Vertical smear, in content UV, y down.
   * @param roll - Roll about the frame centre, in radians.
   */
  public setMotion(x: number, y: number, roll: number): void {
    const motion = this.uniforms.uniforms.uMotion as Float32Array;

    motion[0] = x;
    motion[1] = y;
    motion[2] = roll;
    this.uniforms.update();
  }

  /**
   * The water on the lens
   * @param wetness - Settled beads: 0 is dry, about 0.05 a few from the rain, 1 freshly splashed.
   * @param spray - A splash's burst of tiny drops, 0 to about 1; it settles fast.
   * @param flow - How far airflow has carried the beads outward, in log screen radius; it only grows.
   */
  public setWater(wetness: number, spray: number, flow: number): void {
    const water = this.uniforms.uniforms.uWater as Float32Array;

    water[0] = wetness;
    water[1] = spray;
    water[2] = flow;
    this.uniforms.update();
  }

  /**
   * Place the shockwave ring
   * @param x - Centre's horizontal UV.
   * @param y - Centre's vertical UV, y down.
   * @param radius - Ring radius, in screen heights.
   * @param strength - 0 to 1; 0 turns it off.
   */
  public setShockwave(x: number, y: number, radius: number, strength: number): void {
    writeVec4(this.uniforms.uniforms.uShock as Float32Array, x, y, radius, strength);
    this.uniforms.update();
  }

  /**
   * Place the heat-haze pocket
   * @param x - Centre's horizontal UV.
   * @param y - Centre's vertical UV, y down.
   * @param radius - Pocket radius, in screen heights.
   * @param strength - 0 to 1; 0 turns it off.
   */
  public setHeat(x: number, y: number, radius: number, strength: number): void {
    writeVec4(this.uniforms.uniforms.uHeat as Float32Array, x, y, radius, strength);
    this.uniforms.update();
  }

  /**
   * Set one lens flare
   * @param index - Slot, 0 to {@link LENS_FLARES} - 1.
   * @param x - Light's horizontal UV.
   * @param y - Light's vertical UV, y down.
   * @param depth - Light's view depth, which the occlusion test compares the depth buffer against.
   * @param intensity - 0 to about 2.
   * @param r - Linear red, 0 to 1.
   * @param g - Linear green.
   * @param b - Linear blue.
   * @param size - Glow and streak scale; 1 is a headlight at a few units.
   */
  public setFlare(
    index: number,
    x: number,
    y: number,
    depth: number,
    intensity: number,
    r: number,
    g: number,
    b: number,
    size: number,
  ): void {
    const u = this.uniforms.uniforms;
    const lane = (index & 3) * 4;

    writeVec4(index < 4 ? (u.uFlareA0 as Float32Array) : (u.uFlareA1 as Float32Array), x, y, depth, intensity, lane);
    writeVec4(index < 4 ? (u.uFlareB0 as Float32Array) : (u.uFlareB1 as Float32Array), r, g, b, size, lane);
    this.uniforms.update();
  }

  /**
   * Turn off every flare from a slot on
   * @param from - First slot to clear.
   */
  public clearFlares(from: number): void {
    const u = this.uniforms.uniforms;

    for (let i = from; i < LENS_FLARES; i++) {
      (i < 4 ? (u.uFlareA0 as Float32Array) : (u.uFlareA1 as Float32Array))[(i & 3) * 4 + 3] = 0;
    }

    this.uniforms.update();
  }
}

function writeVec4(out: Float32Array, x: number, y: number, z: number, w: number, offset = 0): void {
  out[offset] = x;
  out[offset + 1] = y;
  out[offset + 2] = z;
  out[offset + 3] = w;
}

function writeHue(out: Float32Array, color: ColorSource): void {
  const c = Color.shared.setValue(color);
  const luma = c.red * LUMA_R + c.green * LUMA_G + c.blue * LUMA_B;

  out[0] = (c.red - luma) * SPLIT_REACH;
  out[1] = (c.green - luma) * SPLIT_REACH;
  out[2] = (c.blue - luma) * SPLIT_REACH;
}
