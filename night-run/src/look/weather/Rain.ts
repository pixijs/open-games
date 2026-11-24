import type { Container3D, PointData3D, ShaderBit } from '@pixi/3d';
import { ParticleContainer3D } from '@pixi/3d';

import { ROAD_Y } from '../../race/route';
import { skipToneCurve } from '../toneCurve';
import { SeededRandom } from './random';
import { lightLoop, softKnee, streakFragment, streakVertex } from './weatherShaders';

/** World size of the box of rain that follows the camera. */
const BOX_X = 26;
const BOX_Y = 10;
const BOX_Z = 26;
/** A share of the drops falls in a box this much smaller, so the rain is densest right round the lens. */
const NEAR_SCALE = 0.32;
const NEAR_SHARE = 0.45;
/** How far ahead of the lens, as a share of a box's width, the box is centred; the rain behind the camera is unseen. */
const LEAD = 0.3;

/** Fall speed, world units per world second; each drop varies it by ±15%. */
const FALL_SPEED = 9;
/** Steady wind and the gust on top of it, world units per world second. */
const WIND_X = 1.1;
const WIND_Z = 0.55;
const GUST = 0.6;
const GUST_RATE = 0.7;

/** Diameter of a hanging bead, varied ±40% per drop. */
const BEAD_SIZE = 0.017;
const STREAK_WIDTH = 0.005;

/** Brightness of a drop no light reaches, and how much the scene's lights add. */
const BASE_BRIGHTNESS = 0.09;
const LIGHT_GAIN = 0.4;
/** Extra base brightness at full lightning. */
const LIGHTNING_BRIGHTNESS = 0.7;

const PHASE = '0.12 + 2.6 * pow(max(dot(wxView, wxToL), 0.0), 6.0)';

/**
 * Builds every streak in the vertex shader from a seed record that never changes: the drop's place in its box,
 * advanced by world time and wrapped into a box centred just ahead of the camera, then stretched along its motion
 * relative to the camera over the shutter.
 *
 * Record: `aPosition` is the seed in [0, 1)³, `aParticleSizeRot` is (box scale, rank), and the colour bytes are
 * (bead size, fall speed, brightness) jitter. A drop whose rank is past the density is dropped before it pays for
 * any lighting.
 *
 * - `uRainCam` (camera xyz, world time)
 * - `uRainBox` (box xyz, road height)
 * - `uRainWind` (wind drift so far x and z, wind now x and z)
 * - `uRainShape` (fall speed, shutter in world seconds, bead size, streak width)
 * - `uRainLook` (density, pixel size at unit distance, base brightness, light gain)
 * - `uRainCamVel` (the camera velocity the streaks are blurred against)
 * - `uRainAim` (the camera's forward, and how far ahead of it a box of scale 1 is centred)
 */
const rainBit = {
  name: 'racingRain',

  interStage: {
    vStreak: 'vec4<f32>',
  },

  bindings: {
    material: {
      uRainCam: 'vec4<f32>',
      uRainBox: 'vec4<f32>',
      uRainWind: 'vec4<f32>',
      uRainShape: 'vec4<f32>',
      uRainLook: 'vec4<f32>',
      uRainCamVel: 'vec4<f32>',
      uRainAim: 'vec4<f32>',
    },
  },

  gpu: {
    vertex: {
      afterTransform: /* wgsl */ `
  {
    let rCamT = material.uRainCam;
    let sCam = rCamT.xyz;
    let rBox = material.uRainBox.xyz * particleSize;
    let rGround = material.uRainBox.w;
    let rFall = material.uRainShape.x * (0.85 + 0.3 * particleColor.g);
    let sVel = vec3<f32>(material.uRainWind.z, -rFall, material.uRainWind.w) - material.uRainCamVel.xyz;
    let rCenter = sCam + material.uRainAim.xyz * (material.uRainAim.w * particleSize);
    let rOrigin = vec3<f32>(
      rCenter.x - 0.5 * rBox.x,
      max(rCenter.y - 0.5 * rBox.y, rGround - 0.3),
      rCenter.z - 0.5 * rBox.z
    );
    let rFell = position.xyz * rBox + vec3<f32>(material.uRainWind.x, -rFall * rCamT.w, material.uRainWind.y);
    let rLocal = fract((rFell - rOrigin) / rBox);
    let rHead = rOrigin + rLocal * rBox;
    let sShutter = material.uRainShape.y;
    let sMid = rHead - sVel * (0.5 * sShutter);
    let sBead = material.uRainShape.z * (0.6 + 0.8 * particleColor.r);
    let sWidth = material.uRainShape.w;
    let sPx = material.uRainLook.y;
${streakVertex(true)}
    // Fade at the box walls so a drop that wraps never pops, and near the lens: a streak there would cross the whole
    // frame, and a bright bead would read as snow on the glass.
    let rEdge = min(rLocal, vec3<f32>(1.0) - rLocal);
    let rFade = smoothstep(0.0, 0.12, rEdge.x) * smoothstep(0.0, 0.12, rEdge.z)
      * smoothstep(0.0, 0.1, 1.0 - rLocal.y) * smoothstep(0.0, 0.3 / rBox.y, rLocal.y)
      * mix(smoothstep(0.6, 1.8, wxDist), smoothstep(0.7, 1.5, wxDist), wxBeadness);
    let rAlive = particleRotation <= material.uRainLook.x && sMid.y >= rGround && rFade > 0.0;
    var rLit = vec3<f32>(0.0);

    if (rAlive) {
${lightLoop(true, 'sMid', 'rLit', PHASE)}
    }

    rLit *= material.uRainLook.w;
    ${softKnee(true, 'rLit')}

    let rNear = 1.0 - smoothstep(0.5, 3.0, wxDist);
    let rColor = vec3<f32>(0.6, 0.7, 0.85) * material.uRainLook.z + rLit + vec3<f32>(1.0, 0.85, 0.7) * (0.14 * rNear);
    let rAlpha = rFade * sqrt(wxThin) * wxEnergy * (0.55 + 0.9 * particleColor.b) * (1.0 + 0.7 * wxBeadness);

    particleColor = vec4<f32>(rColor * rAlpha, 1.0);

    if (!rAlive) {
      clipPosition = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    }
  }
`,
    },
    fragment: {
      material: streakFragment(true),
    },
  },

  gl: {
    vertex: {
      afterTransform: /* glsl */ `
  {
    vec4 rCamT = material.uRainCam;
    vec3 sCam = rCamT.xyz;
    vec3 rBox = material.uRainBox.xyz * particleSize;
    float rGround = material.uRainBox.w;
    float rFall = material.uRainShape.x * (0.85 + 0.3 * particleColor.g);
    vec3 sVel = vec3(material.uRainWind.z, -rFall, material.uRainWind.w) - material.uRainCamVel.xyz;
    vec3 rCenter = sCam + material.uRainAim.xyz * (material.uRainAim.w * particleSize);
    vec3 rOrigin = vec3(rCenter.x - 0.5 * rBox.x, max(rCenter.y - 0.5 * rBox.y, rGround - 0.3), rCenter.z - 0.5 * rBox.z);
    vec3 rFell = position.xyz * rBox + vec3(material.uRainWind.x, -rFall * rCamT.w, material.uRainWind.y);
    vec3 rLocal = fract((rFell - rOrigin) / rBox);
    vec3 rHead = rOrigin + rLocal * rBox;
    float sShutter = material.uRainShape.y;
    vec3 sMid = rHead - sVel * (0.5 * sShutter);
    float sBead = material.uRainShape.z * (0.6 + 0.8 * particleColor.r);
    float sWidth = material.uRainShape.w;
    float sPx = material.uRainLook.y;
${streakVertex(false)}
    // Fade at the box walls so a drop that wraps never pops, and near the lens: a streak there would cross the whole
    // frame, and a bright bead would read as snow on the glass.
    vec3 rEdge = min(rLocal, 1.0 - rLocal);
    float rFade = smoothstep(0.0, 0.12, rEdge.x) * smoothstep(0.0, 0.12, rEdge.z)
      * smoothstep(0.0, 0.1, 1.0 - rLocal.y) * smoothstep(0.0, 0.3 / rBox.y, rLocal.y)
      * mix(smoothstep(0.6, 1.8, wxDist), smoothstep(0.7, 1.5, wxDist), wxBeadness);
    bool rAlive = particleRotation <= material.uRainLook.x && sMid.y >= rGround && rFade > 0.0;
    vec3 rLit = vec3(0.0);

    if (rAlive) {
${lightLoop(false, 'sMid', 'rLit', PHASE)}
    }

    rLit *= material.uRainLook.w;
    ${softKnee(false, 'rLit')}

    float rNear = 1.0 - smoothstep(0.5, 3.0, wxDist);
    vec3 rColor = vec3(0.6, 0.7, 0.85) * material.uRainLook.z + rLit + vec3(1.0, 0.85, 0.7) * (0.14 * rNear);
    float rAlpha = rFade * sqrt(wxThin) * wxEnergy * (0.55 + 0.9 * particleColor.b) * (1.0 + 0.7 * wxBeadness);

    particleColor = vec4(rColor * rAlpha, 1.0);

    if (!rAlive) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
`,
    },
    fragment: {
      material: streakFragment(false),
    },
  },
} satisfies ShaderBit;

/**
 * Night rain: thousands of streaks in a box that follows the camera, one draw call and no per-drop CPU work. Each
 * drop is a pure function of world time and the camera, so the shower crawls in slow motion and hangs still in the
 * freeze while the camera flies through it: moving the box only wraps the drops at its walls, where they are faded
 * out. The drops catch every light the view shades, brightest
 * when the light is behind them.
 */
export class Rain {
  public readonly points: ParticleContainer3D;

  private readonly _cam: Float32Array;
  private readonly _wind: Float32Array;
  private readonly _shape: Float32Array;
  private readonly _look: Float32Array;
  private readonly _camVel: Float32Array;
  private readonly _aim: Float32Array;

  /**
   * @param parent - Scene root.
   * @param capacity - Drops at full density.
   */
  constructor(parent: Container3D, capacity: number) {
    const points = new ParticleContainer3D({ label: 'rain', capacity, blendMode: 'add', extraBits: [rainBit] });

    skipToneCurve(points.material);
    const { f32, u32, floatStride, offsets } = points.data;
    const sizeRot = offsets.aParticleSizeRot / 4;
    const color = offsets.aParticleColor / 4;
    const random = new SeededRandom(0x2f6b9d1);

    for (let i = 0; i < capacity; i++) {
      const x = random.next();
      const y = random.next();
      const z = random.next();
      const scale = random.next() < NEAR_SHARE ? NEAR_SCALE : 1;
      // Golden-ratio ranks spread any density cut evenly over the drops.
      const rank = (i * 0.6180339887) % 1;
      const jitter =
        ((random.next() * 255) | ((random.next() * 255) << 8) | ((random.next() * 255) << 16) | (255 << 24)) >>> 0;
      let o = i * 4 * floatStride;

      for (let v = 0; v < 4; v++, o += floatStride) {
        f32[o] = x;
        f32[o + 1] = y;
        f32[o + 2] = z;
        f32[o + sizeRot] = scale;
        f32[o + sizeRot + 1] = rank;
        u32[o + color] = jitter;
      }
    }

    points.markDirty(0, capacity - 1);
    points.upload();

    const uniforms = points.uniforms;

    uniforms.uRainBox = [BOX_X, BOX_Y, BOX_Z, ROAD_Y];
    this._cam = uniforms.uRainCam as Float32Array;
    this._wind = uniforms.uRainWind as Float32Array;
    this._shape = uniforms.uRainShape as Float32Array;
    this._look = uniforms.uRainLook as Float32Array;
    this._camVel = uniforms.uRainCamVel as Float32Array;
    this._aim = uniforms.uRainAim as Float32Array;
    this._aim[3] = BOX_X * LEAD;
    this._shape[0] = FALL_SPEED;
    this._shape[2] = BEAD_SIZE;
    this._shape[3] = STREAK_WIDTH;
    this._look[3] = LIGHT_GAIN;

    this.points = points;
    parent.addChild(points);
  }

  /**
   * Place the shower for this frame.
   * @param camera - Camera position.
   * @param forward - Unit direction the camera looks along.
   * @param cameraVelocity - Camera motion the streaks are blurred against, world units per world second.
   * @param worldTime - World seconds; the drops fall on it.
   * @param shutter - World seconds a streak shows, which collapses it to a bead in slow motion.
   * @param density - Share of the drops drawn, 0 to 1.
   * @param pixel - World size of one pixel at unit distance.
   * @param lightning - Lightning brightness this frame, 0 to 1.
   */
  public update(
    camera: PointData3D,
    forward: PointData3D,
    cameraVelocity: PointData3D,
    worldTime: number,
    shutter: number,
    density: number,
    pixel: number,
    lightning: number,
  ): void {
    const cam = this._cam;
    const wind = this._wind;

    cam[0] = camera.x;
    cam[1] = camera.y;
    cam[2] = camera.z;
    cam[3] = worldTime;
    this._aim[0] = forward.x;
    this._aim[1] = forward.y;
    this._aim[2] = forward.z;
    this._camVel[0] = cameraVelocity.x;
    this._camVel[1] = cameraVelocity.y;
    this._camVel[2] = cameraVelocity.z;
    // The drift is the wind's integral, so the gust bends the shower without making drops jump.
    wind[0] = WIND_X * worldTime - (Math.cos(worldTime * GUST_RATE) * GUST) / GUST_RATE;
    wind[1] = WIND_Z * worldTime;
    wind[2] = WIND_X + Math.sin(worldTime * GUST_RATE) * GUST;
    wind[3] = WIND_Z;
    this._shape[1] = shutter;
    this._look[0] = density;
    this._look[1] = pixel;
    this._look[2] = BASE_BRIGHTNESS + lightning * LIGHTNING_BRIGHTNESS;
    this.points.material.update();
  }

  public destroy(): void {
    this.points.destroy();
  }
}
