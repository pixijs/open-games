import type { ShaderBit } from '@pixi/3d';

/**
 * The look of every simulated pyro particle, composed after `particleLifetimeBit`:
 *
 * - **motion**: ballistic flight with linear drag in closed form, like `particleMotionBit`, but with the drag and
 *   the share of the pool's `uGravity` per particle (`aMotion.xy`), so sparks, floating embers and firework stars
 *   that brake hard share one pool and one draw.
 * - **fire colour**: the tint times a black-body ramp of a heat that runs from `aLook.x` to `aLook.y` over the
 *   particle's life, along `progress ^ uCooling` (above 1 holds the heat, then cools late): 1 and up is the tint itself (white-hot for a white tint), 0.75 yellow, 0.55 orange, 0.35 deep
 *   red, 0 black. A spark cools from white to red by giving it a falling heat; a coloured star keeps its colour at
 *   a heat of 1.
 * - **size, spin and alpha**: size eases from the spawn size to `aLook.z` (`uGrowth` above 1 swells fast, then
 *   settles, like a fireball), spin at `aLook.w` radians per second, alpha fades in over `uFadeIn` seconds and out
 *   along `1 - progress ^ uFadeOut`, and `aMotion.z` makes a particle twinkle on world time.
 *
 * Both fade a particle out over its last `uNearFade` world units to the lens, so a camera flying past the fire is not
 * swallowed by it.
 *
 * The streak variant also stretches each quad along its velocity across the view plane, by the distance it covers
 * in `aLook.w` of `uShutter` world seconds plus `aMotion.w`, never past where it was launched. A streak doesn't spin,
 * so it takes `aLook.w` for its share of the shutter. The look sets the shutter from the
 * time warp, so streaks shrink to beads in slow motion and stop as points in the freeze, while `aMotion.w` gives a
 * firework star a trail that stays in the frozen sky.
 */
export function getPyroBit(streak: boolean): ShaderBit {
  return streak ? STREAK_BIT : PLAIN_BIT;
}

const BEFORE_GPU = /* wgsl */ `
  let pyroT = max(particleAge, 0.0);
  let pyroDrag = input.aMotion.x;
  var pyroA = pyroT;
  var pyroB = pyroT * pyroT * 0.5;
  var pyroDecay = 1.0;

  if (pyroDrag > 1e-3) {
    pyroDecay = exp(-pyroDrag * pyroT);
    pyroA = (1.0 - pyroDecay) / pyroDrag;
    pyroB = (pyroT - pyroA) / pyroDrag;
  }

  let pyroAccel = material.uGravity * input.aMotion.y;
  let pyroVelocity = input.aVel * pyroDecay + pyroAccel * pyroA;
  let pyroTravel = input.aVel * pyroA + pyroAccel * pyroB;

  position = vec4<f32>(position.xyz + pyroTravel, 1.0);
  particleSize = mix(particleSize, input.aLook.z, 1.0 - pow(1.0 - particleProgress, material.uGrowth));
  particleRotation = particleRotation + input.aLook.w * pyroT;

  let pyroHeat = mix(input.aLook.x, input.aLook.y, pow(particleProgress, material.uCooling));
  let pyroFire = clamp(
    vec3<f32>(pyroHeat * 2.5, (pyroHeat - 0.32) * 1.5, (pyroHeat - 0.72) * 3.6),
    vec3<f32>(0.0),
    vec3<f32>(1.0)
  );
  var pyroAlpha = clamp(pyroT / material.uFadeIn, 0.0, 1.0) * (1.0 - pow(particleProgress, material.uFadeOut));

  if (input.aMotion.z > 0.0) {
    let pyroSeed = fract(dot(input.aVel, vec3<f32>(0.1031, 0.1173, 0.0973)) + floor(material.uParticleTime * 30.0) * 0.618034);
    pyroAlpha = pyroAlpha * (1.0 - input.aMotion.z * fract(pyroSeed * 97.31));
  }

  particleColor = vec4<f32>(particleColor.rgb * pyroFire, particleColor.a * pyroAlpha);
`;

const BEFORE_GL = /* glsl */ `
  float pyroT = max(particleAge, 0.0);
  float pyroDrag = aMotion.x;
  float pyroA = pyroT;
  float pyroB = pyroT * pyroT * 0.5;
  float pyroDecay = 1.0;

  if (pyroDrag > 1e-3) {
    pyroDecay = exp(-pyroDrag * pyroT);
    pyroA = (1.0 - pyroDecay) / pyroDrag;
    pyroB = (pyroT - pyroA) / pyroDrag;
  }

  vec3 pyroAccel = material.uGravity * aMotion.y;
  vec3 pyroVelocity = aVel * pyroDecay + pyroAccel * pyroA;
  vec3 pyroTravel = aVel * pyroA + pyroAccel * pyroB;

  position = vec4(position.xyz + pyroTravel, 1.0);
  particleSize = mix(particleSize, aLook.z, 1.0 - pow(1.0 - particleProgress, material.uGrowth));
  particleRotation += aLook.w * pyroT;

  float pyroHeat = mix(aLook.x, aLook.y, pow(particleProgress, material.uCooling));
  vec3 pyroFire = clamp(vec3(pyroHeat * 2.5, (pyroHeat - 0.32) * 1.5, (pyroHeat - 0.72) * 3.6), 0.0, 1.0);
  float pyroAlpha = clamp(pyroT / material.uFadeIn, 0.0, 1.0) * (1.0 - pow(particleProgress, material.uFadeOut));

  if (aMotion.z > 0.0) {
    float pyroSeed = fract(dot(aVel, vec3(0.1031, 0.1173, 0.0973)) + floor(material.uParticleTime * 30.0) * 0.618034);
    pyroAlpha *= 1.0 - aMotion.z * fract(pyroSeed * 97.31);
  }

  particleColor = vec4(particleColor.rgb * pyroFire, particleColor.a * pyroAlpha);
`;

const NEAR_GPU = /* wgsl */ `
  particleColor.a = particleColor.a * clamp((clipPosition.w - 0.3) / material.uNearFade, 0.0, 1.0);
`;

const NEAR_GL = /* glsl */ `
  particleColor.a *= clamp((gl_Position.w - 0.3) / material.uNearFade, 0.0, 1.0);
`;

// Rebuilds the quad the particle bit expanded, so it re-applies the lifetime bit's cull of unborn and dead particles.
const STREAK_GPU = /* wgsl */ `
  {
    let streakFlat = vec2<f32>(dot(pyroVelocity, billboardRight), dot(pyroVelocity, billboardUp));
    let streakSpeed = length(streakFlat);
    let streakReach = min(streakSpeed * (material.uShutter * input.aLook.w + input.aMotion.w), length(pyroTravel));
    var streakDir = vec2<f32>(0.0, 1.0);

    if (streakSpeed > 1e-5) {
      streakDir = streakFlat / streakSpeed;
    }

    let streakAxis = billboardRight * streakDir.x + billboardUp * streakDir.y;
    let streakSide = billboardUp * streakDir.x - billboardRight * streakDir.y;
    let streakSpan = particleSize + streakReach;

    worldPosition = vec4<f32>(
      position.xyz + streakAxis * (particleCorner.y * streakSpan - streakReach * 0.5) + streakSide * (particleCorner.x * particleSize),
      1.0
    );
    clipPosition = camera.uViewProjectionMatrix * worldPosition;
    particleColor.a = particleColor.a * pow(particleSize / streakSpan, material.uStreakFade);

    if (particleAge < 0.0 || particleAge > input.aLife) {
      clipPosition = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    }
  }
`;

const STREAK_GL = /* glsl */ `
  {
    vec2 streakFlat = vec2(dot(pyroVelocity, billboardRight), dot(pyroVelocity, billboardUp));
    float streakSpeed = length(streakFlat);
    float streakReach = min(streakSpeed * (material.uShutter * aLook.w + aMotion.w), length(pyroTravel));
    vec2 streakDir = streakSpeed > 1e-5 ? streakFlat / streakSpeed : vec2(0.0, 1.0);
    vec3 streakAxis = billboardRight * streakDir.x + billboardUp * streakDir.y;
    vec3 streakSide = billboardUp * streakDir.x - billboardRight * streakDir.y;
    float streakSpan = particleSize + streakReach;

    worldPosition = vec4(
      position.xyz + streakAxis * (particleCorner.y * streakSpan - streakReach * 0.5) + streakSide * (particleCorner.x * particleSize),
      1.0
    );
    gl_Position = uViewProjectionMatrix * worldPosition;
    particleColor.a *= pow(particleSize / streakSpan, material.uStreakFade);

    if (particleAge < 0.0 || particleAge > aLife) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    }
  }
`;

const ATTRIBUTES = {
  aVel: 'float32x3',
  /** Heat at birth, heat at death, end size, spin. */
  aLook: 'float32x4',
  /** Drag, share of the pool's gravity, twinkle, extra streak seconds. */
  aMotion: 'float32x4',
} as const;

const MATERIAL = {
  uGravity: 'vec3<f32>',
  uGrowth: 'f32',
  uFadeIn: 'f32',
  uFadeOut: 'f32',
  uNearFade: 'f32',
  uCooling: 'f32',
} as const;

const PLAIN_BIT = {
  name: 'pyro',
  attributes: ATTRIBUTES,
  bindings: { material: MATERIAL },
  gpu: { vertex: { beforeTransform: BEFORE_GPU, afterTransform: NEAR_GPU } },
  gl: { vertex: { beforeTransform: BEFORE_GL, afterTransform: NEAR_GL } },
} satisfies ShaderBit;

const STREAK_BIT = {
  name: 'pyroStreak',
  attributes: ATTRIBUTES,
  bindings: { material: { ...MATERIAL, uShutter: 'f32', uStreakFade: 'f32' } },
  gpu: { vertex: { beforeTransform: BEFORE_GPU, afterTransform: STREAK_GPU + NEAR_GPU } },
  gl: { vertex: { beforeTransform: BEFORE_GL, afterTransform: STREAK_GL + NEAR_GL } },
} satisfies ShaderBit;
