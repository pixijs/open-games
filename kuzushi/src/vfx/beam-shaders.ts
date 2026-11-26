import type { ShaderBit } from "@pixi/3d"

/**
 * The Spiral beam's two shader bits. `beamRibbonBit` draws the beam itself on a strip (u along it, v across): a
 * white-hot core in a red glow whose edges waver with heat. `sweepFloorBit` draws on a square over the dial (u east,
 * v south): the red fan of floor the beam will cross in the next second, a short scorch behind it, and the ground
 * where a pillar hides a player from it, hatched in paper inside a paper rule, so it never reads as a sun shadow.
 */

/** How far a body's centre must stay from the beam's line to be safe: the beam's half width plus the player's radius. */
const SAFE_CLEARANCE = 0.72

const f = (value: number) => value.toFixed(5)

/** The most pillars a beam's cover is drawn for. */
export const COVER_SLOTS = 8

const COVER_NAMES = Array.from({ length: COVER_SLOTS }, (_, index) => `cover${index}`)

/**
 * The share (0 to 1) of a point at angle `a`, distance `d` from the spire that pillar slot `index` keeps out of the
 * beam: a ray that grazes the pillar's side passes at least `SAFE_CLEARANCE` from it. The slot holds the pillar's
 * angle and distance from the spire, its half width in radians, and 1 when it stands. GLSL and WGSL spell it the same.
 */
const safeTerm = (index: number, wgsl: boolean): string => {
  const v = wgsl ? "let" : "float"
  const c = `material.cover${index}`
  return `
    ${v} sweepD${index} = abs(sweepWrap(sweepA - ${c}.x));
    ${v} sweepS${index} = ${c}.w * step(${c}.y, sweepR) * step(sweepD${index}, ${c}.z) * smoothstep(${f(SAFE_CLEARANCE - 0.04)}, ${f(SAFE_CLEARANCE + 0.04)}, sweepR * sin(${c}.z - sweepD${index}));
    sweepSafe = max(sweepSafe, sweepS${index});`
}

/** A cover slot's values for a pillar at (x, z) of `radius`, from a spire at the origin. */
export const coverSlot = (x: number, z: number, radius: number): readonly [number, number, number, number] => {
  const distance = Math.hypot(x, z)
  return [Math.atan2(z, x), distance, Math.asin(Math.min(1, radius / Math.max(distance, radius))), 1]
}

const WRAP_GL = /* glsl */ `float sweepWrap(float a) { return a - 6.2831853 * floor((a + 3.1415927) / 6.2831853); }`
const WRAP_GPU = /* wgsl */ `fn sweepWrap(a: f32) -> f32 { return a - 6.2831853 * floor((a + 3.1415927) / 6.2831853); }`

/**
 * The floor under a sweep. `sweep` = (beam angle, lead angle, fan strength, safe strength) in simulation radians;
 * `dial` = (half size of the square, inner radius, outer radius, scorch strength behind the beam); `cover0` to
 * `cover7` the pillars that shelter ground from it (`coverSlot`), unused slots zero.
 */
export const sweepFloorBit: ShaderBit = {
  name: "kuzushiSweepFloor",
  bindings: { material: { sweep: "vec4<f32>", dial: "vec4<f32>", sweepRed: "vec4<f32>", sweepCover: "vec4<f32>", ...Object.fromEntries(COVER_NAMES.map((name) => [name, "vec4<f32>"])) } },
  gpu: {
    header: WRAP_GPU,
    fragment: {
      material: /* wgsl */ `{
  let sweepP = (input.vUV - vec2<f32>(0.5)) * 2.0 * material.dial.x;
  let sweepR = length(sweepP);
  let sweepA = atan2(sweepP.y, sweepP.x);
  var sweepSafe = 0.0;
  ${COVER_NAMES.map((_, index) => safeTerm(index, true)).join("")}
  let sweepOn = step(material.dial.y, sweepR) * (1.0 - smoothstep(material.dial.z - 0.3, material.dial.z, sweepR));
  let sweepFan = material.sweep.y - material.sweep.x;
  let sweepAhead = sweepWrap(sweepA - material.sweep.x - 3.1415927) + 3.1415927;
  let sweepIn = step(sweepAhead, sweepFan) * (1.0 - sweepAhead / max(sweepFan, 0.001));
  let sweepBehind = max(0.0, 1.0 - (6.2831853 - sweepAhead) / 0.3) * step(sweepFan, sweepAhead);
  let sweepHatch = smoothstep(0.62, 0.7, fract((sweepP.x - sweepP.y) * 2.2)) * (1.0 - smoothstep(0.86, 0.94, fract((sweepP.x - sweepP.y) * 2.2)));
  let sweepRedA = (sweepIn * sweepIn * material.sweep.z + sweepBehind * material.dial.w) * (1.0 - sweepSafe);
  let sweepCoverA = sweepSafe * material.sweep.w * max(sweepHatch, 0.25) * (0.7 + 0.3 * step(0.001, sweepIn));
  albedo = select(decodeColor(material.sweepCover.rgb), decodeColor(material.sweepRed.rgb), sweepRedA > sweepCoverA);
  alpha = max(sweepRedA, sweepCoverA) * sweepOn;
}`
    }
  },
  gl: {
    header: WRAP_GL,
    fragment: {
      material: /* glsl */ `{
  vec2 sweepP = (vUV - vec2(0.5)) * 2.0 * material.dial.x;
  float sweepR = length(sweepP);
  float sweepA = atan(sweepP.y, sweepP.x);
  float sweepSafe = 0.0;
  ${COVER_NAMES.map((_, index) => safeTerm(index, false)).join("")}
  float sweepOn = step(material.dial.y, sweepR) * (1.0 - smoothstep(material.dial.z - 0.3, material.dial.z, sweepR));
  float sweepFan = material.sweep.y - material.sweep.x;
  float sweepAhead = sweepWrap(sweepA - material.sweep.x - 3.1415927) + 3.1415927;
  float sweepIn = step(sweepAhead, sweepFan) * (1.0 - sweepAhead / max(sweepFan, 0.001));
  float sweepBehind = max(0.0, 1.0 - (6.2831853 - sweepAhead) / 0.3) * step(sweepFan, sweepAhead);
  float sweepHatch = smoothstep(0.62, 0.7, fract((sweepP.x - sweepP.y) * 2.2)) * (1.0 - smoothstep(0.86, 0.94, fract((sweepP.x - sweepP.y) * 2.2)));
  float sweepRedA = (sweepIn * sweepIn * material.sweep.z + sweepBehind * material.dial.w) * (1.0 - sweepSafe);
  float sweepCoverA = sweepSafe * material.sweep.w * max(sweepHatch, 0.25) * (0.7 + 0.3 * step(0.001, sweepIn));
  albedo = sweepRedA > sweepCoverA ? decodeColor(material.sweepRed.rgb) : decodeColor(material.sweepCover.rgb);
  alpha = max(sweepRedA, sweepCoverA) * sweepOn;
}`
    }
  }
}

/**
 * The beam on a strip. `ribbon` = (core width, glow width, boost, heat) as shares of the strip's width; `ribbonRed`
 * the glow's colour. Its edges waver with the time, on twos.
 */
export const beamRibbonBit: ShaderBit = {
  name: "kuzushiBeamRibbon",
  bindings: { material: { ribbon: "vec4<f32>", ribbonRed: "vec4<f32>", ribbonTime: "vec4<f32>" } },
  gpu: {
    fragment: {
      material: /* wgsl */ `{
  let ribT = material.ribbonTime.x;
  let ribU = input.vUV.x;
  let ribWave = sin(ribU * 37.0 - ribT * 23.0) * 0.5 + sin(ribU * 91.0 + ribT * 41.0) * 0.3 + sin(ribU * 13.0 - ribT * 7.0) * 0.2;
  let ribV = abs(input.vUV.y - 0.5) * 2.0 + ribWave * material.ribbon.w;
  let ribCore = 1.0 - smoothstep(material.ribbon.x * 0.6, material.ribbon.x, ribV);
  let ribGlow = 1.0 - smoothstep(0.0, material.ribbon.y, ribV);
  let ribEnds = smoothstep(0.0, 0.015, ribU) * (1.0 - smoothstep(0.985, 1.0, ribU));
  albedo = mix(decodeColor(material.ribbonRed.rgb), vec3<f32>(1.0), ribCore) * material.ribbon.z;
  alpha = max(ribCore, ribGlow * ribGlow * 0.8) * ribEnds;
}`
    }
  },
  gl: {
    fragment: {
      material: /* glsl */ `{
  float ribT = material.ribbonTime.x;
  float ribU = vUV.x;
  float ribWave = sin(ribU * 37.0 - ribT * 23.0) * 0.5 + sin(ribU * 91.0 + ribT * 41.0) * 0.3 + sin(ribU * 13.0 - ribT * 7.0) * 0.2;
  float ribV = abs(vUV.y - 0.5) * 2.0 + ribWave * material.ribbon.w;
  float ribCore = 1.0 - smoothstep(material.ribbon.x * 0.6, material.ribbon.x, ribV);
  float ribGlow = 1.0 - smoothstep(0.0, material.ribbon.y, ribV);
  float ribEnds = smoothstep(0.0, 0.015, ribU) * (1.0 - smoothstep(0.985, 1.0, ribU));
  albedo = mix(decodeColor(material.ribbonRed.rgb), vec3(1.0), ribCore) * material.ribbon.z;
  alpha = max(ribCore, ribGlow * ribGlow * 0.8) * ribEnds;
}`
    }
  }
}
