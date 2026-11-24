import type { EffectFragment, EffectIO, RenderGraph } from '@pixi/3d';
import { FullscreenPass, PostEffect } from '@pixi/3d';
import { UniformGroup } from 'pixi.js';

// Screen-space reflections on the rain-soaked road, in two passes:
//
// - trace, at one texel per CSS pixel: pixels on the ground plane reflect the view ray off a rain-rippled water
//   normal, march it through the depth buffer, and take the colour where it lands, smeared along the screen
//   vertical into the long light streaks of wet tarmac. A puddle mask by world position makes puddles mirror sharp
//   and the tarmac between them blurrier and dimmer. Alpha is 0 off the ground, and on it 0.5 plus half how much
//   the water darkens the surface under it.
// - composite, at full resolution: blurs the trace a few texels along the vertical, which dissolves the march's
//   per-pixel jitter into the streaks, darkens the puddles and adds the reflection onto the ground pixels, less of it
//   the brighter the surface already is, so a mirrored light on a lit patch of road can't blow it out.
//
// Everything is worked in content UV with y down, `s`, and in true view space (y up), so both backends share one
// formula: WGSL's `uv` is already y down; GLSL's is y up, so its helpers flip on the way in and out.
// uViewToWorld = the camera's world matrix; uGround = (ground y, strength, max ray length, steps);
// uWet = (world time, puddle cover, streak stretch, ripple strength).

const SHARED_WGSL = /* wgsl */ `
fn texUv(s: vec2<f32>) -> vec2<f32> {
  return s;
}

fn viewAt(s: vec2<f32>, lz: f32) -> vec3<f32> {
  return vec3<f32>((s.x * 2.0 - 1.0) * lz / fxh.uFxClip.z, (1.0 - s.y * 2.0) * lz / fxh.uFxClip.w, -lz);
}

fn groundUp() -> vec3<f32> {
  return vec3<f32>(fx.uViewToWorld[0][1], fx.uViewToWorld[1][1], fx.uViewToWorld[2][1]);
}

fn onGround(p: vec3<f32>, lz: f32) -> bool {
  let height = dot(groundUp(), p) + fx.uViewToWorld[3][1] - fx.uGround.x;
  return abs(height) < 0.012 + lz * 0.0015;
}
`;

const SHARED_GLSL = /* glsl */ `
vec2 texUv(vec2 s) {
  return vec2(s.x, 1.0 - s.y);
}

vec3 viewAt(vec2 s, float lz) {
  return vec3((s.x * 2.0 - 1.0) * lz / uFxClip.z, (1.0 - s.y * 2.0) * lz / uFxClip.w, -lz);
}

vec3 groundUp() {
  return vec3(uViewToWorld[0][1], uViewToWorld[1][1], uViewToWorld[2][1]);
}

bool onGround(vec3 p, float lz) {
  float height = dot(groundUp(), p) + uViewToWorld[3][1] - uGround.x;
  return abs(height) < 0.012 + lz * 0.0015;
}
`;

const TRACE_FRAGMENT: EffectFragment = {
  gpu: /* wgsl */ `${SHARED_WGSL}
const SSR_MAX_STEPS: i32 = 32;
const SSR_REFINE: i32 = 5;
const SMEAR_TAPS: i32 = 8;

fn depthAt(s: vec2<f32>) -> f32 {
  return linearDepth(sampleDepth(s));
}

fn screenOf(p: vec3<f32>) -> vec2<f32> {
  let w = max(-p.z, 1e-4);
  return vec2<f32>(0.5 + 0.5 * p.x * fxh.uFxClip.z / w, 0.5 - 0.5 * p.y * fxh.uFxClip.w / w);
}

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash12(i);
  let b = hash12(i + vec2<f32>(1.0, 0.0));
  let c = hash12(i + vec2<f32>(0.0, 1.0));
  let d = hash12(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// One raindrop ring per cell of a world-space grid, each on its own rate and phase; returns the tilt it adds.
fn rippleLayer(p: vec2<f32>, cell: f32, t: f32, seed: f32) -> vec2<f32> {
  let q = p / cell + seed;
  let id = floor(q);
  let d = fract(q) - 0.5 - (vec2<f32>(hash12(id + 3.7), hash12(id + 9.2)) - 0.5) * 0.24;
  let h = hash12(id + seed);
  let phase = fract(t * (0.8 + h * 0.7) + h * 13.0);
  let r = length(d);
  let x = (r - phase * 0.34) * 26.0;
  let fade = (1.0 - phase) * (1.0 - phase);
  return d / max(r, 1e-3) * (x * exp(-x * x) * fade);
}

fn effect(uv: vec2<f32>) -> vec4<f32> {
  let strength = fx.uGround.y;
  if (strength <= 0.0) { return vec4<f32>(0.0); }
  let raw = sampleDepth(uv);
  if (raw >= 1.0) { return vec4<f32>(0.0); }
  let s = uv;
  let lz = linearDepth(raw);
  let p = viewAt(s, lz);
  if (!onGround(p, lz)) { return vec4<f32>(0.0); }

  let xz = (fx.uViewToWorld * vec4<f32>(p, 1.0)).xz;
  let n = valueNoise(xz * 0.45) * 0.65 + valueNoise(xz * 1.3 + 17.0) * 0.35;
  let puddle = smoothstep(0.56, 0.64, n + (fx.uWet.y - 0.5) * 0.5);
  let t = fx.uWet.x;
  let rings = fx.uWet.w * mix(0.15, 1.0, puddle) * (1.0 - smoothstep(3.0, 12.0, lz));
  let tilt = (rippleLayer(xz, 0.16, t, 0.0) + rippleLayer(xz, 0.11, t * 1.13, 7.31)) * rings;
  let normal = normalize((vec4<f32>(-tilt.x, 1.0, -tilt.y, 0.0) * fx.uViewToWorld).xyz);
  let view = normalize(p);
  let ray = reflect(view, normal);
  let fresnel = 0.08 + 0.92 * pow(1.0 - max(dot(-view, normal), 0.0), 4.0);
  let ground = 0.5 + 0.5 * min(puddle * fresnel * strength, 1.0);

  // March the reflected ray across the screen between where it starts and where it leaves the frame, the near
  // plane or its longest length, interpolating 1/depth so each step's depth is perspective correct.
  let steps = i32(fx.uGround.w);
  let jitter = fract(52.9829189 * fract(dot(uv / texel(), vec2<f32>(0.06711056, 0.00583715))));
  let origin = p + groundUp() * 0.02;
  var rayLen = fx.uGround.z;
  let near = fxh.uFxClip.x * 1.05;
  if (origin.z + ray.z * rayLen > -near) { rayLen = (-near - origin.z) / ray.z; }
  let s0 = screenOf(origin);
  let delta = screenOf(origin + ray * rayLen) - s0;
  var reach = 1.0;
  if (delta.x > 0.0) { reach = min(reach, (1.0 - s0.x) / delta.x); }
  if (delta.x < 0.0) { reach = min(reach, -s0.x / delta.x); }
  if (delta.y > 0.0) { reach = min(reach, (1.0 - s0.y) / delta.y); }
  if (delta.y < 0.0) { reach = min(reach, -s0.y / delta.y); }
  let k0 = -1.0 / origin.z;
  let k1 = -1.0 / (origin.z + ray.z * rayLen);
  var lo = 0.0;
  var hi = -1.0;
  var prevDepth = 1.0 / k0;
  for (var i = 0; i < SSR_MAX_STEPS; i = i + 1) {
    if (i >= steps) { break; }
    let u = reach * (f32(i) + jitter) / f32(steps);
    let rayDepth = 1.0 / mix(k0, k1, u);
    let gap = rayDepth - depthAt(s0 + delta * u);
    if (gap > 0.0) {
      if (gap < abs(rayDepth - prevDepth) + 0.25 + rayDepth * 0.02) { hi = u; }
      break;
    }
    lo = u;
    prevDepth = rayDepth;
  }
  if (hi < 0.0) { return vec4<f32>(0.0, 0.0, 0.0, ground); }

  for (var i = 0; i < SSR_REFINE; i = i + 1) {
    let mid = (lo + hi) * 0.5;
    if (1.0 / mix(k0, k1, mid) - depthAt(s0 + delta * mid) > 0.0) { hi = mid; } else { lo = mid; }
  }
  let hs = s0 + delta * hi;
  let hitDepth = 1.0 / mix(k0, k1, hi);
  let travel = rayLen * hi * k1 / mix(k0, k1, hi);
  let edge = min(hs, 1.0 - hs);
  let fade = smoothstep(0.0, 0.08, min(edge.x, edge.y)) * (1.0 - smoothstep(0.55, 1.0, travel / fx.uGround.z));

  // A sharp core, blurrier on tarmac than in puddles, and a long tapered tail along the screen vertical that only
  // bright lights survive: the streaks of lights on wet asphalt. The tail is a peak hold, so a light keeps its
  // punch down the streak instead of averaging away into the dark around it.
  let footprint = travel * mix(0.006, 0.002, puddle) * fxh.uFxClip.w * 0.5 / max(hitDepth, 0.1);
  let lod = clamp(log2(max(footprint / inputTexel().y, 1.0)) + (1.0 - puddle) * 1.5, 0.0, 6.0);
  let spread = min(footprint * fx.uWet.z * mix(1.0, 0.35, puddle), 0.22);
  var refl = sampleColorLod(texUv(hs), lod).rgb;
  var tail = vec3<f32>(0.0);
  for (var i = 0; i < SMEAR_TAPS; i = i + 1) {
    let o = (f32(i) + jitter) / f32(SMEAR_TAPS) * 2.0 - 1.0;
    let fall = 1.0 - abs(o);
    tail = max(tail, sampleColorLod(texUv(hs + vec2<f32>(0.0, o * spread)), lod + 1.0).rgb * (fall * fall));
  }
  refl = max(refl * mix(0.7, 1.0, puddle), tail * mix(0.85, 0.4, puddle));
  let amount = fresnel * fade * strength;
  return vec4<f32>(refl * amount, ground);
}
`,
  gl: /* glsl */ `${SHARED_GLSL}
const int SSR_MAX_STEPS = 32;
const int SSR_REFINE = 5;
const int SMEAR_TAPS = 8;

float depthAt(vec2 s) {
  return linearDepth(sampleDepth(texUv(s)));
}

vec2 screenOf(vec3 p) {
  float w = max(-p.z, 1e-4);
  return vec2(0.5 + 0.5 * p.x * uFxClip.z / w, 0.5 - 0.5 * p.y * uFxClip.w / w);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 rippleLayer(vec2 p, float cell, float t, float seed) {
  vec2 q = p / cell + seed;
  vec2 id = floor(q);
  vec2 d = fract(q) - 0.5 - (vec2(hash12(id + 3.7), hash12(id + 9.2)) - 0.5) * 0.24;
  float h = hash12(id + seed);
  float phase = fract(t * (0.8 + h * 0.7) + h * 13.0);
  float r = length(d);
  float x = (r - phase * 0.34) * 26.0;
  float fade = (1.0 - phase) * (1.0 - phase);
  return d / max(r, 1e-3) * (x * exp(-x * x) * fade);
}

vec4 effect(vec2 uv) {
  float strength = uGround.y;
  if (strength <= 0.0) return vec4(0.0);
  float raw = sampleDepth(uv);
  if (raw >= 1.0) return vec4(0.0);
  vec2 s = vec2(uv.x, 1.0 - uv.y);
  float lz = linearDepth(raw);
  vec3 p = viewAt(s, lz);
  if (!onGround(p, lz)) return vec4(0.0);

  vec2 xz = (uViewToWorld * vec4(p, 1.0)).xz;
  float n = valueNoise(xz * 0.45) * 0.65 + valueNoise(xz * 1.3 + 17.0) * 0.35;
  float puddle = smoothstep(0.56, 0.64, n + (uWet.y - 0.5) * 0.5);
  float t = uWet.x;
  float rings = uWet.w * mix(0.15, 1.0, puddle) * (1.0 - smoothstep(3.0, 12.0, lz));
  vec2 tilt = (rippleLayer(xz, 0.16, t, 0.0) + rippleLayer(xz, 0.11, t * 1.13, 7.31)) * rings;
  vec3 normal = normalize((vec4(-tilt.x, 1.0, -tilt.y, 0.0) * uViewToWorld).xyz);
  vec3 view = normalize(p);
  vec3 ray = reflect(view, normal);
  float fresnel = 0.08 + 0.92 * pow(1.0 - max(dot(-view, normal), 0.0), 4.0);
  float ground = 0.5 + 0.5 * min(puddle * fresnel * strength, 1.0);

  int steps = int(uGround.w);
  float jitter = fract(52.9829189 * fract(dot(uv / texel(), vec2(0.06711056, 0.00583715))));
  vec3 origin = p + groundUp() * 0.02;
  float rayLen = uGround.z;
  float near = uFxClip.x * 1.05;
  if (origin.z + ray.z * rayLen > -near) rayLen = (-near - origin.z) / ray.z;
  vec2 s0 = screenOf(origin);
  vec2 delta = screenOf(origin + ray * rayLen) - s0;
  float reach = 1.0;
  if (delta.x > 0.0) reach = min(reach, (1.0 - s0.x) / delta.x);
  if (delta.x < 0.0) reach = min(reach, -s0.x / delta.x);
  if (delta.y > 0.0) reach = min(reach, (1.0 - s0.y) / delta.y);
  if (delta.y < 0.0) reach = min(reach, -s0.y / delta.y);
  float k0 = -1.0 / origin.z;
  float k1 = -1.0 / (origin.z + ray.z * rayLen);
  float lo = 0.0;
  float hi = -1.0;
  float prevDepth = 1.0 / k0;
  for (int i = 0; i < SSR_MAX_STEPS; i++) {
    if (i >= steps) break;
    float u = reach * (float(i) + jitter) / float(steps);
    float rayDepth = 1.0 / mix(k0, k1, u);
    float gap = rayDepth - depthAt(s0 + delta * u);
    if (gap > 0.0) {
      if (gap < abs(rayDepth - prevDepth) + 0.25 + rayDepth * 0.02) hi = u;
      break;
    }
    lo = u;
    prevDepth = rayDepth;
  }
  if (hi < 0.0) return vec4(0.0, 0.0, 0.0, ground);

  for (int i = 0; i < SSR_REFINE; i++) {
    float mid = (lo + hi) * 0.5;
    if (1.0 / mix(k0, k1, mid) - depthAt(s0 + delta * mid) > 0.0) hi = mid;
    else lo = mid;
  }
  vec2 hs = s0 + delta * hi;
  float hitDepth = 1.0 / mix(k0, k1, hi);
  float travel = rayLen * hi * k1 / mix(k0, k1, hi);
  vec2 edge = min(hs, 1.0 - hs);
  float fade = smoothstep(0.0, 0.08, min(edge.x, edge.y)) * (1.0 - smoothstep(0.55, 1.0, travel / uGround.z));

  float footprint = travel * mix(0.006, 0.002, puddle) * uFxClip.w * 0.5 / max(hitDepth, 0.1);
  float lod = clamp(log2(max(footprint / inputTexel().y, 1.0)) + (1.0 - puddle) * 1.5, 0.0, 6.0);
  float spread = min(footprint * uWet.z * mix(1.0, 0.35, puddle), 0.22);
  vec3 refl = sampleColorLod(texUv(hs), lod).rgb;
  vec3 tail = vec3(0.0);
  for (int i = 0; i < SMEAR_TAPS; i++) {
    float o = (float(i) + jitter) / float(SMEAR_TAPS) * 2.0 - 1.0;
    float fall = 1.0 - abs(o);
    tail = max(tail, sampleColorLod(texUv(hs + vec2(0.0, o * spread)), lod + 1.0).rgb * (fall * fall));
  }
  refl = max(refl * mix(0.7, 1.0, puddle), tail * mix(0.85, 0.4, puddle));
  float amount = fresnel * fade * strength;
  return vec4(refl * amount, ground);
}
`,
};

const COMPOSITE_FRAGMENT: EffectFragment = {
  gpu: /* wgsl */ `${SHARED_WGSL}
const BLUR_STEP: f32 = 0.0025;

fn effect(uv: vec2<f32>) -> vec4<f32> {
  let base = sampleColor(uv);
  if (fx.uGround.y <= 0.0) { return base; }
  let raw = sampleDepth(uv);
  if (raw >= 1.0) { return base; }
  let lz = linearDepth(raw);
  if (!onGround(viewAt(uv, lz), lz)) { return base; }
  var sum = vec3<f32>(0.0);
  var dark = 0.0;
  var count = 0.0;
  for (var i = -2; i <= 2; i = i + 1) {
    let wet = sampleColor2(uv + vec2<f32>(0.0, f32(i) * BLUR_STEP));
    let valid = step(0.25, wet.a);
    sum = sum + wet.rgb * valid;
    dark = dark + (wet.a - 0.5) * 2.0 * valid;
    count = count + valid;
  }
  if (count < 0.5) { return base; }
  let lit = base.rgb * (1.0 - dark / count * 0.45);
  let room = 1.0 - smoothstep(0.15, 0.8, dot(lit, vec3<f32>(0.2126, 0.7152, 0.0722)));
  return vec4<f32>(lit + sum / count * room, base.a);
}
`,
  gl: /* glsl */ `${SHARED_GLSL}
const float BLUR_STEP = 0.0025;

vec4 effect(vec2 uv) {
  vec4 base = sampleColor(uv);
  if (uGround.y <= 0.0) return base;
  float raw = sampleDepth(uv);
  if (raw >= 1.0) return base;
  float lz = linearDepth(raw);
  if (!onGround(viewAt(vec2(uv.x, 1.0 - uv.y), lz), lz)) return base;
  vec3 sum = vec3(0.0);
  float dark = 0.0;
  float count = 0.0;
  for (int i = -2; i <= 2; i++) {
    vec4 wet = sampleColor2(uv + vec2(0.0, float(i) * BLUR_STEP));
    float valid = step(0.25, wet.a);
    sum += wet.rgb * valid;
    dark += (wet.a - 0.5) * 2.0 * valid;
    count += valid;
  }
  if (count < 0.5) return base;
  vec3 lit = base.rgb * (1.0 - dark / count * 0.45);
  float room = 1.0 - smoothstep(0.15, 0.8, dot(lit, vec3(0.2126, 0.7152, 0.0722)));
  return vec4(lit + sum / count * room, base.a);
}
`,
};

/**
 * Screen-space reflections on a wet ground plane: rippled puddles, streaky tarmac.
 *
 * The trace runs at one texel per CSS pixel and only marches pixels that lie on the plane, so its cost follows how
 * much road is on screen. Feed it the camera each frame with {@link WetReflection.setView}.
 */
export class WetReflection extends PostEffect {
  /** The smear samples a blurred level of the scene for the tarmac's width. */
  public override readonly inputMips = true;

  private readonly _uniforms = new UniformGroup({
    uViewToWorld: { value: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), type: 'mat4x4<f32>' },
    uGround: { value: new Float32Array([0, 1, 40, 20]), type: 'vec4<f32>' },
    uWet: { value: new Float32Array([0, 0.5, 6, 0.15]), type: 'vec4<f32>' },
  });

  /**
   * @param groundY - World height of the wet plane.
   */
  constructor(groundY: number) {
    super({ stage: 'afterToneMapping' });
    this.writeLane(this._uniforms, 'uGround', 0, groundY);
  }

  public override build(graph: RenderGraph, io: EffectIO): void {
    const wet = graph.createColor({ resolution: 1, format: 'rgba8unorm', label: 'wetReflection' });

    graph.addPass(
      new FullscreenPass({
        renderer: io.renderer,
        label: 'wetReflection:trace',
        fragment: TRACE_FRAGMENT,
        uniforms: this._uniforms,
        reads: { color: io.input, depth: graph.sceneDepth },
        writes: wet,
      }),
    );
    graph.addPass(
      new FullscreenPass({
        renderer: io.renderer,
        label: 'wetReflection:composite',
        fragment: COMPOSITE_FRAGMENT,
        uniforms: this._uniforms,
        reads: { color: io.input, color2: wet, depth: graph.sceneDepth },
        writes: io.output,
      }),
    );
  }

  /** Overall reflection strength; 0 turns the reflections off at the cost of one depth tap a pixel. */
  public set strength(value: number) {
    this.writeLane(this._uniforms, 'uGround', 1, value);
  }

  /** Longest reflected ray, in world units. */
  public set maxDistance(value: number) {
    this.writeLane(this._uniforms, 'uGround', 2, value);
  }

  /** March steps per ray, up to 32; the binary refine adds five more. */
  public set steps(value: number) {
    this.writeLane(this._uniforms, 'uGround', 3, value);
  }

  /** World seconds the rain ripples animate by; hold it and the ripples freeze. */
  public set time(value: number) {
    this.writeLane(this._uniforms, 'uWet', 0, value);
  }

  /** How much of the road is puddle, 0 to 1. */
  public set puddles(value: number) {
    this.writeLane(this._uniforms, 'uWet', 1, value);
  }

  /** How many times longer than wide the tarmac's light streaks run. */
  public set stretch(value: number) {
    this.writeLane(this._uniforms, 'uWet', 2, value);
  }

  /** Tilt of the rain rings on the water surface. */
  public set ripples(value: number) {
    this.writeLane(this._uniforms, 'uWet', 3, value);
  }

  /**
   * Place the camera the reflections are traced from.
   * @param position - World position, x, y, z.
   * @param quaternion - World rotation, x, y, z, w.
   */
  public setView(position: ArrayLike<number>, quaternion: ArrayLike<number>): void {
    const m = this._uniforms.uniforms.uViewToWorld as Float32Array;
    const x = quaternion[0];
    const y = quaternion[1];
    const z = quaternion[2];
    const w = quaternion[3];

    m[0] = 1 - 2 * (y * y + z * z);
    m[1] = 2 * (x * y + z * w);
    m[2] = 2 * (x * z - y * w);
    m[4] = 2 * (x * y - z * w);
    m[5] = 1 - 2 * (x * x + z * z);
    m[6] = 2 * (y * z + x * w);
    m[8] = 2 * (x * z + y * w);
    m[9] = 2 * (y * z - x * w);
    m[10] = 1 - 2 * (x * x + y * y);
    m[12] = position[0];
    m[13] = position[1];
    m[14] = position[2];
    this._uniforms.update();
  }
}
