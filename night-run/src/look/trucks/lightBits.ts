import type { ShaderBit } from '@pixi/3d';

/**
 * The headlight beam's shape in its mesh's frame: an elliptic cone along +z with its apex just behind the lens, cut off
 * at the lens (z = 0) and at `length`. A point is inside when `(x / slopeX)² + (y / slopeY)² <= (z - apex)²`.
 */
export const BEAM_SHAPE = {
  /** Tangent of the half-angle to either side. */
  slopeX: Math.tan((15 * Math.PI) / 180),
  /** Tangent of the half-angle above and below. */
  slopeY: Math.tan((5.5 * Math.PI) / 180),
  /** Where the cone's sides meet, behind the lens, so it leaves the lens about as wide as the lamp. */
  apex: -0.2,
  length: 6,
} as const;

/** Samples along each view ray's chord through the beam. */
const BEAM_STEPS = 6;
/** Samples on a small drawing buffer, where the beam's softness hides the coarser sum. */
const BEAM_STEPS_LITE = 3;
/**
 * Henyey-Greenstein asymmetry of rain: it throws light forward, so a beam brightens as it turns toward the lens. The
 * phase is scaled to 1 seen side-on, so this sets only how much brighter head-on is: about 5x at 0.4.
 */
const BEAM_FORWARD = 0.4;
/** Where one fragment's glow saturates, so a beam shining straight at the lens stays a haze, not a wall of white. */
const BEAM_MAX = 0.6;
/**
 * Rain within this distance of the lens adds nothing, fading in by the clear distance, so a lens inside a beam near its
 * lamp sees the lamp's halo, not a white-out.
 */
const BEAM_NEAR = 0.5;
const BEAM_CLEAR = 2.5;

function f(value: number): string {
  return value.toFixed(5);
}

const BEAM_GPU_HEADER = /* wgsl */ `
const RACING_BEAM_INV_X2: f32 = ${f(1 / BEAM_SHAPE.slopeX ** 2)};
const RACING_BEAM_INV_Y2: f32 = ${f(1 / BEAM_SHAPE.slopeY ** 2)};
const RACING_BEAM_APEX: f32 = ${f(BEAM_SHAPE.apex)};
const RACING_BEAM_LENGTH: f32 = ${f(BEAM_SHAPE.length)};
const RACING_BEAM_G: f32 = ${f(BEAM_FORWARD)};
const RACING_BEAM_SIDE: f32 = ${f(1 + BEAM_FORWARD ** 2)};

fn racingBeamDensity(p: vec3<f32>) -> f32 {
  let depth = max(p.z - RACING_BEAM_APEX, 0.0001);
  let across = sqrt(p.x * p.x * RACING_BEAM_INV_X2 + p.y * p.y * RACING_BEAM_INV_Y2) / depth;
  let u = clamp(p.z / RACING_BEAM_LENGTH, 0.0, 1.0);
  let core = max(1.0 - across * across, 0.0);

  return (1.0 - u) * (1.0 - u) * (0.15 + 0.85 * exp(-4.0 * u)) * core * core;
}
`;

const BEAM_GL_HEADER = /* glsl */ `
#define RACING_BEAM_INV_X2 ${f(1 / BEAM_SHAPE.slopeX ** 2)}
#define RACING_BEAM_INV_Y2 ${f(1 / BEAM_SHAPE.slopeY ** 2)}
#define RACING_BEAM_APEX ${f(BEAM_SHAPE.apex)}
#define RACING_BEAM_LENGTH ${f(BEAM_SHAPE.length)}
#define RACING_BEAM_G ${f(BEAM_FORWARD)}
#define RACING_BEAM_SIDE ${f(1 + BEAM_FORWARD ** 2)}

float racingBeamDensity(vec3 p) {
  float depth = max(p.z - RACING_BEAM_APEX, 0.0001);
  float across = sqrt(p.x * p.x * RACING_BEAM_INV_X2 + p.y * p.y * RACING_BEAM_INV_Y2) / depth;
  float u = clamp(p.z / RACING_BEAM_LENGTH, 0.0, 1.0);
  float core = max(1.0 - across * across, 0.0);

  return (1.0 - u) * (1.0 - u) * (0.15 + 0.85 * exp(-4.0 * u)) * core * core;
}
`;

function createBeamBit(steps: number): ShaderBit {
  return {
    name: `racingHeadlightBeam${steps}`,
    interStage: {
      vBeamPoint: 'vec3<f32>',
      vBeamCamera: 'vec3<f32>',
    },
    gpu: {
      header: BEAM_GPU_HEADER,
      vertex: {
        end: /* wgsl */ `
  let beamOffset = camera.uCameraPosition - modelMatrix[3].xyz;
  output.vBeamCamera = vec3<f32>(
    dot(modelMatrix3[0], beamOffset) / dot(modelMatrix3[0], modelMatrix3[0]),
    dot(modelMatrix3[1], beamOffset) / dot(modelMatrix3[1], modelMatrix3[1]),
    dot(modelMatrix3[2], beamOffset) / dot(modelMatrix3[2], modelMatrix3[2])
  );
  output.vBeamPoint = position.xyz;
`,
      },
      fragment: {
        material: /* wgsl */ `
  let beamFrom = input.vBeamCamera;
  let beamRay = input.vBeamPoint - beamFrom;
  var beamEnter = 0.0;

  if (abs(beamRay.z) > 0.00001) {
    beamEnter = max(beamEnter, min(-beamFrom.z / beamRay.z, (RACING_BEAM_LENGTH - beamFrom.z) / beamRay.z));
  }

  let beamOz = beamFrom.z - RACING_BEAM_APEX;
  let beamQa = beamRay.x * beamRay.x * RACING_BEAM_INV_X2 + beamRay.y * beamRay.y * RACING_BEAM_INV_Y2 - beamRay.z * beamRay.z;
  let beamQb = 2.0 * (beamFrom.x * beamRay.x * RACING_BEAM_INV_X2 + beamFrom.y * beamRay.y * RACING_BEAM_INV_Y2 - beamOz * beamRay.z);
  let beamQc = beamFrom.x * beamFrom.x * RACING_BEAM_INV_X2 + beamFrom.y * beamFrom.y * RACING_BEAM_INV_Y2 - beamOz * beamOz;

  if (beamQa > 0.000001) {
    beamEnter = max(beamEnter, (-beamQb - sqrt(max(beamQb * beamQb - 4.0 * beamQa * beamQc, 0.0))) / (2.0 * beamQa));
  }

  let beamSpan = max(1.0 - beamEnter, 0.0);
  let beamLength = length(beamRay);
  let beamToCamera = -beamRay / max(beamLength, 0.00001);
  var beamGlow = 0.0;

  for (var i = 0; i < ${steps}; i++) {
    let t = beamEnter + beamSpan * ((f32(i) + 0.5) / f32(${steps}));
    let p = beamFrom + beamRay * t;
    let cosTheta = dot(normalize(vec3<f32>(p.x, p.y, p.z - RACING_BEAM_APEX)), beamToCamera);
    let phase = pow(RACING_BEAM_SIDE / (RACING_BEAM_SIDE - 2.0 * RACING_BEAM_G * cosTheta), 1.5);

    beamGlow += racingBeamDensity(p) * phase * smoothstep(${f(BEAM_NEAR)}, ${f(BEAM_CLEAR)}, t * beamLength);
  }

  alpha *= ${f(BEAM_MAX)} * (1.0 - exp(-beamGlow * beamSpan * beamLength / (f32(${steps}) * ${f(BEAM_MAX)})));
`,
      },
    },
    gl: {
      vertex: {
        header: BEAM_GL_HEADER,
        end: /* glsl */ `
  vec3 beamOffset = uCameraPosition - modelMatrix[3].xyz;
  vBeamCamera = vec3(
    dot(modelMatrix3[0], beamOffset) / dot(modelMatrix3[0], modelMatrix3[0]),
    dot(modelMatrix3[1], beamOffset) / dot(modelMatrix3[1], modelMatrix3[1]),
    dot(modelMatrix3[2], beamOffset) / dot(modelMatrix3[2], modelMatrix3[2])
  );
  vBeamPoint = position.xyz;
`,
      },
      fragment: {
        header: BEAM_GL_HEADER,
        material: /* glsl */ `
  vec3 beamFrom = vBeamCamera;
  vec3 beamRay = vBeamPoint - beamFrom;
  float beamEnter = 0.0;

  if (abs(beamRay.z) > 0.00001) {
    beamEnter = max(beamEnter, min(-beamFrom.z / beamRay.z, (RACING_BEAM_LENGTH - beamFrom.z) / beamRay.z));
  }

  float beamOz = beamFrom.z - RACING_BEAM_APEX;
  float beamQa = beamRay.x * beamRay.x * RACING_BEAM_INV_X2 + beamRay.y * beamRay.y * RACING_BEAM_INV_Y2 - beamRay.z * beamRay.z;
  float beamQb = 2.0 * (beamFrom.x * beamRay.x * RACING_BEAM_INV_X2 + beamFrom.y * beamRay.y * RACING_BEAM_INV_Y2 - beamOz * beamRay.z);
  float beamQc = beamFrom.x * beamFrom.x * RACING_BEAM_INV_X2 + beamFrom.y * beamFrom.y * RACING_BEAM_INV_Y2 - beamOz * beamOz;

  if (beamQa > 0.000001) {
    beamEnter = max(beamEnter, (-beamQb - sqrt(max(beamQb * beamQb - 4.0 * beamQa * beamQc, 0.0))) / (2.0 * beamQa));
  }

  float beamSpan = max(1.0 - beamEnter, 0.0);
  float beamLength = length(beamRay);
  vec3 beamToCamera = -beamRay / max(beamLength, 0.00001);
  float beamGlow = 0.0;

  for (int i = 0; i < ${steps}; i++) {
    float t = beamEnter + beamSpan * ((float(i) + 0.5) / float(${steps}));
    vec3 p = beamFrom + beamRay * t;
    float cosTheta = dot(normalize(vec3(p.x, p.y, p.z - RACING_BEAM_APEX)), beamToCamera);
    float phase = pow(RACING_BEAM_SIDE / (RACING_BEAM_SIDE - 2.0 * RACING_BEAM_G * cosTheta), 1.5);

    beamGlow += racingBeamDensity(p) * phase * smoothstep(${f(BEAM_NEAR)}, ${f(BEAM_CLEAR)}, t * beamLength);
  }

  alpha *= ${f(BEAM_MAX)} * (1.0 - exp(-beamGlow * beamSpan * beamLength / (float(${steps}) * ${f(BEAM_MAX)})));
`,
      },
    },
  };
}

/**
 * Volumetric headlight beams for an unlit additive material on a cone mesh that shows only its inside.
 *
 * Every fragment is where a view ray leaves the beam. The shader works in the mesh's frame: it finds where the ray
 * came in (through the cone's side, its open end, or at the lens if the camera is inside), then sums lit rain along
 * that chord. Rain scatters light mostly forward, so the sum is weighted by how nearly each point's light heads
 * straight for the camera: a beam seen from the side is a soft fan, one shining into the lens a glare. The rain
 * thins out along the beam and toward its edges, so it never shows a hard rim.
 */
export const headlightBeamBit = createBeamBit(BEAM_STEPS);

/** {@link headlightBeamBit} with fewer samples per ray, for small drawing buffers. */
export const headlightBeamLiteBit = createBeamBit(BEAM_STEPS_LITE);

/** Trails fade out within this distance of the lens. */
const TRAIL_NEAR = '1.0';
const TRAIL_CLEAR = '4.0';
/** How far a trail's core whitens, like an overexposed light streak. */
const TRAIL_CORE = '0.25';

/**
 * Camera-facing light-trail ribbons for an unlit additive material.
 *
 * Each vertex sits on the trail's centreline. `aNormal` carries the trail's direction there and `aUV` the side
 * (`x`, -1 or 1) and the half width (`y`); the vertex stage pushes it sideways, square to both the trail and the
 * camera, so the ribbon always shows its face. The fragment stage shapes a soft profile across it with a hot core.
 */
export const lightTrailBit: ShaderBit = {
  name: 'racingLightTrail',
  gpu: {
    vertex: {
      afterTransform: /* wgsl */ `
  let trailToCamera = camera.uCameraPosition - worldPosition.xyz;
  let trailSide = cross(worldNormal, trailToCamera);
  let trailOffset = trailSide * (uv.x * uv.y * inverseSqrt(max(dot(trailSide, trailSide), 1e-12)));
  worldPosition = vec4<f32>(worldPosition.xyz + trailOffset, 1.0);
  clipPosition = camera.uViewProjectionMatrix * worldPosition;
`,
    },
    fragment: {
      material: /* wgsl */ `
  let trailAcross = max(1.0 - input.vUV.x * input.vUV.x, 0.0);
  let trailCore = trailAcross * trailAcross;
  albedo = mix(albedo, vec3<f32>(1.0), trailCore * trailCore * ${TRAIL_CORE});
  alpha *= trailAcross * smoothstep(${TRAIL_NEAR}, ${TRAIL_CLEAR}, distance(input.vPosition, camera.uCameraPosition));
`,
    },
  },
  gl: {
    vertex: {
      afterTransform: /* glsl */ `
  vec3 trailToCamera = uCameraPosition - worldPosition.xyz;
  vec3 trailSide = cross(worldNormal, trailToCamera);
  vec3 trailOffset = trailSide * (uv.x * uv.y * inversesqrt(max(dot(trailSide, trailSide), 1e-12)));
  worldPosition = vec4(worldPosition.xyz + trailOffset, 1.0);
  gl_Position = uViewProjectionMatrix * worldPosition;
`,
    },
    fragment: {
      material: /* glsl */ `
  float trailAcross = max(1.0 - vUV.x * vUV.x, 0.0);
  float trailCore = trailAcross * trailAcross;
  albedo = mix(albedo, vec3(1.0), trailCore * trailCore * ${TRAIL_CORE});
  alpha *= trailAcross * smoothstep(${TRAIL_NEAR}, ${TRAIL_CLEAR}, distance(vPosition, uCameraPosition));
`,
    },
  },
};
