import type { Container3D, PointData3D, ShaderBit } from '@pixi/3d';
import { ParticleContainer3D } from '@pixi/3d';

import { CELL, ROAD_Y } from '../../race/route';
import type { Cell } from '../../track/code';
import { skipToneCurve } from '../toneCurve';
import { lightLoop, lit } from './weatherShaders';

/** Splash cells along each side of the grid round the camera, and their size in world units. */
const GRID = 36;
const CELL_SIZE = 0.3;
/** Each cell splashes once per period of world time, at its own phase; a fifth of the slots stay dry. */
const PERIOD = 0.45;
const RING_LIFE = 0.42;
const CROWN_LIFE = 0.26;
/** Half the crown quad, sized to the droplets' flight so the fragment loop only runs where they can be. */
const CROWN_HALF_WIDTH = 0.065;
const CROWN_HALF_HEIGHT = 0.05;

/** How far ahead of the camera, on the ground, the grid is centred, at most. */
const LEAD = 3.5;

const BASE_BRIGHTNESS = 0.05;
const LIGHT_GAIN = 0.5;

/** Road mask bits a float holds exactly, and how many floats the two mask uniforms hold. */
const MASK_BITS = 24;
const MASK_WORDS = 8;

const HEADER_GPU = /* wgsl */ `
fn wxHash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn wxHash32(p: vec2<f32>) -> vec3<f32> {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// The road's cells as bits over their bounding box, ${MASK_BITS} to a float: box is (min x, min z, width, depth).
fn wxOnRoad(p: vec2<f32>, box: vec4<f32>, road0: vec4<f32>, road1: vec4<f32>) -> bool {
  let g = vec2<i32>(floor(p / ${lit(CELL)})) - vec2<i32>(box.xy);
  let size = vec2<i32>(box.zw);
  if (g.x < 0 || g.y < 0 || g.x >= size.x || g.y >= size.y) { return false; }
  let i = g.x + g.y * size.x;
  let k = i / ${MASK_BITS};
  let words = select(road1, road0, k < 4);
  let c = k % 4;
  let word = select(select(words.w, words.z, c == 2), select(words.y, words.x, c == 0), c < 2);
  return ((u32(word) >> u32(i - k * ${MASK_BITS})) & 1u) == 1u;
}
`;

const HEADER_GL = /* glsl */ `
float wxHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 wxHash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

bool wxOnRoad(vec2 p, vec4 box, vec4 road0, vec4 road1) {
  ivec2 g = ivec2(floor(p / ${lit(CELL)})) - ivec2(box.xy);
  ivec2 size = ivec2(box.zw);
  if (g.x < 0 || g.y < 0 || g.x >= size.x || g.y >= size.y) return false;
  int i = g.x + g.y * size.x;
  int k = i / ${MASK_BITS};
  vec4 words = k < 4 ? road0 : road1;
  int c = k - (k / 4) * 4;
  float word = c < 2 ? (c == 0 ? words.x : words.y) : (c == 2 ? words.z : words.w);
  return ((uint(word) >> uint(i - k * ${MASK_BITS})) & 1u) == 1u;
}
`;

const PHASE = '0.1 + 2.4 * pow(max(dot(sPhaseDir, wxToL), 0.0), sSharp)';

/**
 * One splash per grid cell per period, from a hash of the cell and the period: a ripple ring flat on the road and
 * a crown of droplets that jumps off it. The grid wraps round a point just ahead of the camera, so a world cell
 * always splashes the same way at the same world time, wherever the camera has been.
 *
 * Record: `aPosition` is (cell x, kind, cell z) with kind 0 a ring and 1 a crown; `aParticleSizeRot.y` is the rank
 * the density cuts on.
 *
 * - `uSplashCam` (camera xyz, world time)
 * - `uSplashLook` (density, road height, base brightness, light gain)
 * - `uSplashCenter` (the ground point the grid is centred on, x and z)
 * - `uSplashBox` (the road cells' bounding box: min x, min z, width, depth)
 * - `uSplashRoad0`, `uSplashRoad1` (which cells of the box are road, {@link MASK_BITS} bits to a float), so another
 *   track only writes uniforms and the shader never changes
 */
const splashBit = {
  name: 'racingSplash',

  interStage: {
    vSplash: 'vec4<f32>',
  },

  bindings: {
    material: {
      uSplashCam: 'vec4<f32>',
      uSplashLook: 'vec4<f32>',
      uSplashCenter: 'vec4<f32>',
      uSplashBox: 'vec4<f32>',
      uSplashRoad0: 'vec4<f32>',
      uSplashRoad1: 'vec4<f32>',
    },
  },

  gpu: {
    header: HEADER_GPU,
    vertex: {
      afterTransform: /* wgsl */ `
  {
    let sCamT = material.uSplashCam;
    let sIdx = position.xz;
    let sCenter = material.uSplashCenter.xy;
    let sGrid = sIdx + ${lit(GRID)} * floor((floor(sCenter / ${lit(CELL_SIZE)}) - sIdx) / ${lit(GRID)} + 0.5);
    let sClock = sCamT.w + wxHash12(sGrid) * ${lit(PERIOD)};
    let sSlot = floor(sClock / ${lit(PERIOD)});
    let sAge = sClock - sSlot * ${lit(PERIOD)};
    let sRand = wxHash32(sGrid * 1.37 + sSlot * vec2<f32>(7.13, 3.71));
    let sXZ = (sGrid + sRand.xy) * ${lit(CELL_SIZE)};
    let sRing = position.y < 0.5;
    let sProg = sAge / select(${lit(CROWN_LIFE)}, ${lit(RING_LIFE)}, sRing);
    let sAt = vec3<f32>(sXZ.x, material.uSplashLook.y + select(${lit(CROWN_HALF_HEIGHT)}, 0.004, sRing), sXZ.y);
    let sToAt = sAt - sCamT.xyz;
    let sView = sToAt / max(length(sToAt), 1e-4);
    let sReach = ${lit(GRID * CELL_SIZE * 0.5)};
    let sAway = length(sXZ - sCenter);
    let sFade = 1.0 - select(
      smoothstep(sReach * 0.3, sReach * 0.55, sAway),
      smoothstep(sReach * 0.55, sReach * 0.95, sAway),
      sRing
    );
    // Rings shine where they mirror a light; crowns where a light is behind them.
    let sPhaseDir = select(sView, reflect(sView, vec3<f32>(0.0, 1.0, 0.0)), sRing);
    let sSharp = select(6.0, 16.0, sRing);
    var sLit = vec3<f32>(0.0);
${lightLoop(true, 'sAt', 'sLit', PHASE)}
    if (sRing) {
      let sSize = 0.07 + 0.08 * sRand.z;
      worldPosition = vec4<f32>(sAt + vec3<f32>(particleCorner.x, 0.0, particleCorner.y) * sSize, 1.0);
    } else {
      let sFlat = vec3<f32>(billboardRight.x, 0.0, billboardRight.z);
      let sRight = sFlat / max(length(sFlat), 1e-5);
      worldPosition = vec4<f32>(
        sAt + sRight * (particleCorner.x * ${lit(2 * CROWN_HALF_WIDTH)}) + vec3<f32>(0.0, particleCorner.y * ${lit(2 * CROWN_HALF_HEIGHT)}, 0.0),
        1.0
      );
    }
    clipPosition = camera.uViewProjectionMatrix * worldPosition;
    particleColor = vec4<f32>(
      (vec3<f32>(0.6, 0.7, 0.85) * material.uSplashLook.z + sLit * material.uSplashLook.w) * sFade,
      1.0
    );
    output.vSplash = vec4<f32>(particleCorner * 2.0, sProg, select(1.0, 0.0, sRing));

    if (sProg >= 1.0 || sRand.z < 0.2 || particleRotation > material.uSplashLook.x || sFade <= 0.0 || !wxOnRoad(sXZ, material.uSplashBox, material.uSplashRoad0, material.uSplashRoad1)) {
      clipPosition = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    }
  }
`,
    },
    fragment: {
      material: /* wgsl */ `
  {
    let sProg = input.vSplash.z;

    if (input.vSplash.w < 0.5) {
      let sR = length(input.vSplash.xy);
      let sRho = 0.12 + 0.88 * sqrt(sProg);
      let sW = 0.07 + 0.08 * sProg;
      let sA = (sR - sRho) / sW;
      let sB = (sR - sRho * 0.58) / (sW * 0.8);
      let sRingShape = exp(-sA * sA) + 0.45 * exp(-sB * sB) * smoothstep(0.1, 0.3, sProg);

      alpha *= sRingShape * (1.0 - sProg) * (1.0 - sProg);
    } else {
      let sT = sProg * ${lit(CROWN_LIFE)};
      let sQ = input.vSplash.xy * vec2<f32>(${lit(CROWN_HALF_WIDTH)}, ${lit(CROWN_HALF_HEIGHT)}) + vec2<f32>(0.0, ${lit(CROWN_HALF_HEIGHT)});
      let sRadius = 0.005 * (1.0 - 0.5 * sProg);
      var sDrops = 0.0;

      for (var k: i32 = 0; k < 5; k++) {
        let f = f32(k) - 2.0;
        let c = vec2<f32>(f * 0.09 * sT, (1.0 - abs(f) * 0.15) * sT - 3.0 * sT * sT);
        sDrops += 1.0 - smoothstep(sRadius * 0.4, sRadius, length(sQ - c));
      }

      alpha *= sDrops * (1.0 - sProg * sProg);
    }
  }
`,
    },
  },

  gl: {
    header: HEADER_GL,
    vertex: {
      afterTransform: /* glsl */ `
  {
    vec4 sCamT = material.uSplashCam;
    vec2 sIdx = position.xz;
    vec2 sCenter = material.uSplashCenter.xy;
    vec2 sGrid = sIdx + ${lit(GRID)} * floor((floor(sCenter / ${lit(CELL_SIZE)}) - sIdx) / ${lit(GRID)} + 0.5);
    float sClock = sCamT.w + wxHash12(sGrid) * ${lit(PERIOD)};
    float sSlot = floor(sClock / ${lit(PERIOD)});
    float sAge = sClock - sSlot * ${lit(PERIOD)};
    vec3 sRand = wxHash32(sGrid * 1.37 + sSlot * vec2(7.13, 3.71));
    vec2 sXZ = (sGrid + sRand.xy) * ${lit(CELL_SIZE)};
    bool sRing = position.y < 0.5;
    float sProg = sAge / (sRing ? ${lit(RING_LIFE)} : ${lit(CROWN_LIFE)});
    vec3 sAt = vec3(sXZ.x, material.uSplashLook.y + (sRing ? 0.004 : ${lit(CROWN_HALF_HEIGHT)}), sXZ.y);
    vec3 sToAt = sAt - sCamT.xyz;
    vec3 sView = sToAt / max(length(sToAt), 1e-4);
    float sReach = ${lit(GRID * CELL_SIZE * 0.5)};
    float sAway = length(sXZ - sCenter);
    float sFade = 1.0 - (sRing
      ? smoothstep(sReach * 0.55, sReach * 0.95, sAway)
      : smoothstep(sReach * 0.3, sReach * 0.55, sAway));
    // Rings shine where they mirror a light; crowns where a light is behind them.
    vec3 sPhaseDir = sRing ? reflect(sView, vec3(0.0, 1.0, 0.0)) : sView;
    float sSharp = sRing ? 16.0 : 6.0;
    vec3 sLit = vec3(0.0);
${lightLoop(false, 'sAt', 'sLit', PHASE)}
    if (sRing) {
      float sSize = 0.07 + 0.08 * sRand.z;
      worldPosition = vec4(sAt + vec3(particleCorner.x, 0.0, particleCorner.y) * sSize, 1.0);
    } else {
      vec3 sFlat = vec3(billboardRight.x, 0.0, billboardRight.z);
      vec3 sRight = sFlat / max(length(sFlat), 1e-5);
      worldPosition = vec4(
        sAt + sRight * (particleCorner.x * ${lit(2 * CROWN_HALF_WIDTH)}) + vec3(0.0, particleCorner.y * ${lit(2 * CROWN_HALF_HEIGHT)}, 0.0),
        1.0
      );
    }
    gl_Position = uProjectionMatrix * uViewMatrix * worldPosition;
    particleColor = vec4((vec3(0.6, 0.7, 0.85) * material.uSplashLook.z + sLit * material.uSplashLook.w) * sFade, 1.0);
    vSplash = vec4(particleCorner * 2.0, sProg, sRing ? 0.0 : 1.0);

    if (sProg >= 1.0 || sRand.z < 0.2 || particleRotation > material.uSplashLook.x || sFade <= 0.0 || !wxOnRoad(sXZ, material.uSplashBox, material.uSplashRoad0, material.uSplashRoad1)) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    }
  }
`,
    },
    fragment: {
      material: /* glsl */ `
  {
    float sProg = vSplash.z;

    if (vSplash.w < 0.5) {
      float sR = length(vSplash.xy);
      float sRho = 0.12 + 0.88 * sqrt(sProg);
      float sW = 0.07 + 0.08 * sProg;
      float sA = (sR - sRho) / sW;
      float sB = (sR - sRho * 0.58) / (sW * 0.8);
      float sRingShape = exp(-sA * sA) + 0.45 * exp(-sB * sB) * smoothstep(0.1, 0.3, sProg);

      alpha *= sRingShape * (1.0 - sProg) * (1.0 - sProg);
    } else {
      float sT = sProg * ${lit(CROWN_LIFE)};
      vec2 sQ = vSplash.xy * vec2(${lit(CROWN_HALF_WIDTH)}, ${lit(CROWN_HALF_HEIGHT)}) + vec2(0.0, ${lit(CROWN_HALF_HEIGHT)});
      float sRadius = 0.005 * (1.0 - 0.5 * sProg);
      float sDrops = 0.0;

      for (int k = 0; k < 5; k++) {
        float f = float(k) - 2.0;
        vec2 c = vec2(f * 0.09 * sT, (1.0 - abs(f) * 0.15) * sT - 3.0 * sT * sT);
        sDrops += 1.0 - smoothstep(sRadius * 0.4, sRadius, length(sQ - c));
      }

      alpha *= sDrops * (1.0 - sProg * sProg);
    }
  }
`,
    },
  },
} satisfies ShaderBit;

/**
 * The road boiling with rain round the camera: ripple rings and droplet crowns, one draw call, placed entirely in
 * the vertex shader on world time, so they freeze mid-splash with the rest of the world.
 */
export class Splashes {
  public readonly points: ParticleContainer3D;

  private readonly _cam: Float32Array;
  private readonly _look: Float32Array;
  private readonly _center: Float32Array;
  private readonly _box: Float32Array;
  private readonly _road: [Float32Array, Float32Array];

  /** @param parent - Scene root; no splash lands until {@link Splashes.setRoad} says where the road is. */
  constructor(parent: Container3D) {
    const capacity = GRID * GRID * 2;
    const points = new ParticleContainer3D({
      label: 'rain-splashes',
      capacity,
      blendMode: 'add',
      extraBits: [splashBit],
    });

    skipToneCurve(points.material);
    const { f32, floatStride, offsets } = points.data;
    const sizeRot = offsets.aParticleSizeRot / 4;

    for (let i = 0; i < capacity; i++) {
      const cell = i >> 1;
      const rank = (cell * 0.6180339887) % 1;
      let o = i * 4 * floatStride;

      for (let v = 0; v < 4; v++, o += floatStride) {
        f32[o] = cell % GRID;
        f32[o + 1] = i & 1;
        f32[o + 2] = Math.floor(cell / GRID);
        f32[o + sizeRot] = 1;
        f32[o + sizeRot + 1] = rank;
      }
    }

    points.markDirty(0, capacity - 1);
    points.upload();

    const uniforms = points.uniforms;

    this._cam = uniforms.uSplashCam as Float32Array;
    this._look = uniforms.uSplashLook as Float32Array;
    this._center = uniforms.uSplashCenter as Float32Array;
    this._box = uniforms.uSplashBox as Float32Array;
    this._road = [uniforms.uSplashRoad0 as Float32Array, uniforms.uSplashRoad1 as Float32Array];
    this._look[1] = ROAD_Y;
    this._look[2] = BASE_BRIGHTNESS;
    this._look[3] = LIGHT_GAIN;

    this.points = points;
    parent.addChild(points);
  }

  /**
   * Splash only on these cells: a track's road.
   * @param cells - The road's grid cells; their bounding box holds at most {@link MASK_WORDS} x {@link MASK_BITS}.
   */
  public setRoad(cells: readonly Cell[]): void {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (const [x, z] of cells) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }

    const width = maxX - minX + 1;
    const depth = maxZ - minZ + 1;

    if (width * depth > MASK_WORDS * MASK_BITS) throw new Error('[Splashes] the road is too big for its mask');

    const words = new Array<number>(MASK_WORDS).fill(0);

    for (const [x, z] of cells) {
      const i = x - minX + (z - minZ) * width;

      words[Math.floor(i / MASK_BITS)] += 2 ** (i % MASK_BITS);
    }

    this._box.set([minX, minZ, width, depth]);
    this._road[0].set(words.slice(0, 4));
    this._road[1].set(words.slice(4));
    this.points.material.update();
  }

  /**
   * Place this frame's splashes.
   * @param camera - Camera position.
   * @param forward - Unit direction the camera looks along; the grid leads it, less so the steeper it looks down.
   * @param worldTime - World seconds.
   * @param density - Share of the cells that splash, 0 to 1.
   */
  public update(camera: PointData3D, forward: PointData3D, worldTime: number, density: number): void {
    const cam = this._cam;

    this._center[0] = camera.x + forward.x * LEAD;
    this._center[1] = camera.z + forward.z * LEAD;

    cam[0] = camera.x;
    cam[1] = camera.y;
    cam[2] = camera.z;
    cam[3] = worldTime;
    this._look[0] = density;
    this.points.material.update();
  }

  public destroy(): void {
    this.points.destroy();
  }
}
