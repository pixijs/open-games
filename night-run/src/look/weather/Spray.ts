import type { Container3D, PointData3D, ShaderBit } from '@pixi/3d';
import { packParticleColor, ParticleContainer3D, particleLifetimeBit, particleMotionBit } from '@pixi/3d';
import type { Texture } from 'pixi.js';

import { ROAD_Y } from '../../race/route';
import type { TruckPose } from '../../race/truck';
import { MAX_RACERS, WHEEL_LOCAL, WHEEL_RADIUS } from '../../race/truck';
import { skipToneCurve } from '../toneCurve';
import { ParticlePool } from './ParticlePool';
import { hashSeed, SeededRandom } from './random';
import { lightLoop, softKnee, streakFragment, streakVertex } from './weatherShaders';

/**
 * Spray is emitted on a fixed grid of world time, each tick drawing its numbers from a hash of the tick, so the
 * water behind a truck is the same however the frames that reach it were stepped.
 */
const TICK = 1 / 120;
/** Most ticks one frame emits; a longer gap (a hitch) only fills its last stretch. */
const MAX_TICKS = 24;

/** Spray starts at this ground speed and is full at `SPRAY_FULL`, world units per second. */
const SPRAY_START = 4;
const SPRAY_FULL = 12;
/** Droplets per rear wheel and mist puffs per truck, per world second at full spray. */
const DROP_RATE = 340;
const MIST_RATE = 34;

const DROP_CAPACITY = 6000;
const MIST_CAPACITY = 640;
const DROP_DRAG = 2.4;
const DROP_GRAVITY = -11;
const MIST_DRAG = 2.2;
const MIST_LIFT = 0.25;

/** How much a droplet's own tint and the scene's lights count. */
const DROP_BASE = 0.35;
const DROP_LIGHT_GAIN = 0.35;
/** A puff grows to this many times its spawn size over its life. */
const MIST_GROWTH = 3;
const MIST_BASE = 0.75;
const MIST_LIGHT_GAIN = 0.2;

const DROP_TINT = 0xd8e6ff;
/** Mist right behind a truck carries the red of its tail lights, then cools to grey. */
const MIST_YOUNG = 0xa88484;
const MIST_OLD: readonly [number, number, number, number] = [0.42, 0.46, 0.52, 1];

/**
 * A droplet streaked along its velocity over the shutter, the rain's streak and bead on the analytic ballistic
 * path `particleMotionBit` gives it. Composed after the lifetime and motion bits; `afterTransform` replaces the
 * billboard, so it repeats the lifetime bit's cull.
 *
 * - `uSprayCam` (camera xyz, shutter in world seconds)
 * - `uSprayLook` (pixel size at unit distance, tint gain, light gain, road height)
 * - `uSprayCamVel` (the camera velocity the streaks are blurred against)
 */
const dropBit = {
  name: 'racingSprayDrop',

  interStage: {
    vStreak: 'vec4<f32>',
  },

  bindings: {
    material: {
      uSprayCam: 'vec4<f32>',
      uSprayLook: 'vec4<f32>',
      uSprayCamVel: 'vec4<f32>',
    },
  },

  gpu: {
    vertex: {
      afterTransform: /* wgsl */ `
  {
    let dK = material.uDrag;
    let dE = exp(-dK * max(particleAge, 0.0));
    let sVel = input.aVel * dE + material.uGravity * ((1.0 - dE) / dK) - material.uSprayCamVel.xyz;
    let sCam = material.uSprayCam.xyz;
    let sShutter = material.uSprayCam.w;
    let sMid = position.xyz - sVel * (0.5 * sShutter);
    let sBead = particleSize;
    let sWidth = particleSize * 0.5;
    let sPx = material.uSprayLook.x;
${streakVertex(true)}
    let dAlive = particleAge >= 0.0 && particleAge <= input.aLife && position.y > material.uSprayLook.w;
    var dLit = vec3<f32>(0.0);

    if (dAlive) {
${lightLoop(true, 'sMid', 'dLit', '0.15 + 2.4 * pow(max(dot(wxView, wxToL), 0.0), 6.0)')}
    }

    // Water glints whiter than the light that hits it.
    dLit *= material.uSprayLook.z;
    dLit = mix(dLit, vec3<f32>(dot(dLit, vec3<f32>(0.3, 0.5, 0.2))), 0.4);
    ${softKnee(true, 'dLit')}

    let dFade = (1.0 - smoothstep(0.6, 1.0, particleProgress)) * smoothstep(0.15, 0.4, wxDist);

    particleColor = vec4<f32>(
      (particleColor.rgb * material.uSprayLook.y + dLit)
        * (particleColor.a * dFade * sqrt(wxThin) * wxEnergy * (1.0 + 0.8 * wxBeadness)),
      1.0
    );

    if (!dAlive) {
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
    float dK = material.uDrag;
    float dE = exp(-dK * max(particleAge, 0.0));
    vec3 sVel = aVel * dE + material.uGravity * ((1.0 - dE) / dK) - material.uSprayCamVel.xyz;
    vec3 sCam = material.uSprayCam.xyz;
    float sShutter = material.uSprayCam.w;
    vec3 sMid = position.xyz - sVel * (0.5 * sShutter);
    float sBead = particleSize;
    float sWidth = particleSize * 0.5;
    float sPx = material.uSprayLook.x;
${streakVertex(false)}
    bool dAlive = particleAge >= 0.0 && particleAge <= aLife && position.y > material.uSprayLook.w;
    vec3 dLit = vec3(0.0);

    if (dAlive) {
${lightLoop(false, 'sMid', 'dLit', '0.15 + 2.4 * pow(max(dot(wxView, wxToL), 0.0), 6.0)')}
    }

    // Water glints whiter than the light that hits it.
    dLit *= material.uSprayLook.z;
    dLit = mix(dLit, vec3(dot(dLit, vec3(0.3, 0.5, 0.2))), 0.4);
    ${softKnee(false, 'dLit')}

    float dFade = (1.0 - smoothstep(0.6, 1.0, particleProgress)) * smoothstep(0.15, 0.4, wxDist);

    particleColor = vec4(
      (particleColor.rgb * material.uSprayLook.y + dLit)
        * (particleColor.a * dFade * sqrt(wxThin) * wxEnergy * (1.0 + 0.8 * wxBeadness)),
      1.0
    );

    if (!dAlive) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
`,
    },
    fragment: {
      material: streakFragment(false),
    },
  },
} satisfies ShaderBit;

/**
 * A mist puff that grows, turns slowly, fades in and out, cools from its spawn tint to grey, and is lit by the
 * scene's lights, strongest when they are behind it. Composed after the lifetime and motion bits.
 *
 * The light is taken at each corner, not the centre, so it grades across a big puff instead of lighting it as one
 * flat disc, and the corners that dip under the road fade out, so a puff never shows a hard line where it meets it.
 *
 * - `uMistCam` (camera xyz, road height)
 * - `uMistLook` (growth, tint gain, light gain, unused)
 * - `uMistTint` (the grey it cools to)
 */
const mistBit = {
  name: 'racingSprayMist',

  bindings: {
    material: {
      uMistCam: 'vec4<f32>',
      uMistLook: 'vec4<f32>',
      uMistTint: 'vec4<f32>',
    },
  },

  gpu: {
    vertex: {
      beforeTransform: /* wgsl */ `
  {
    let mP = particleProgress;
    let mTint = mix(particleColor.rgb, material.uMistTint.rgb, smoothstep(0.0, 0.5, mP));

    particleSize *= 1.0 + material.uMistLook.x * sqrt(mP);
    particleRotation += particleAge * 0.35;
    particleColor = vec4<f32>(
      mTint * material.uMistLook.y,
      particleColor.a * smoothstep(0.0, 0.1, mP) * (1.0 - mP) * (1.0 - mP)
    );
  }
`,
      afterTransform: /* wgsl */ `
  {
    let mAt = worldPosition.xyz;
    let mToAt = mAt - material.uMistCam.xyz;
    let mView = normalize(mToAt);
    // A puff that drifts into the lens would fill the frame; it thins out first.
    let mNear = smoothstep(0.6, 1.6, length(mToAt));
    let mGround = smoothstep(material.uMistCam.w - 0.1, material.uMistCam.w + 0.3 * particleSize, mAt.y);
    var mLit = vec3<f32>(0.0);

    if (particleAge >= 0.0 && particleAge <= input.aLife) {
${lightLoop(true, 'mAt', 'mLit', '0.3 + 1.5 * pow(max(dot(mView, wxToL), 0.0), 3.0)')}
    }

    mLit *= material.uMistLook.z;
    ${softKnee(true, 'mLit')}

    particleColor = vec4<f32>(particleColor.rgb + mLit, particleColor.a * mNear * mGround);
  }
`,
    },
  },

  gl: {
    vertex: {
      beforeTransform: /* glsl */ `
  {
    float mP = particleProgress;
    vec3 mTint = mix(particleColor.rgb, material.uMistTint.rgb, smoothstep(0.0, 0.5, mP));

    particleSize *= 1.0 + material.uMistLook.x * sqrt(mP);
    particleRotation += particleAge * 0.35;
    particleColor = vec4(mTint * material.uMistLook.y, particleColor.a * smoothstep(0.0, 0.1, mP) * (1.0 - mP) * (1.0 - mP));
  }
`,
      afterTransform: /* glsl */ `
  {
    vec3 mAt = worldPosition.xyz;
    vec3 mToAt = mAt - material.uMistCam.xyz;
    vec3 mView = normalize(mToAt);
    // A puff that drifts into the lens would fill the frame; it thins out first.
    float mNear = smoothstep(0.6, 1.6, length(mToAt));
    float mGround = smoothstep(material.uMistCam.w - 0.1, material.uMistCam.w + 0.3 * particleSize, mAt.y);
    vec3 mLit = vec3(0.0);

    if (particleAge >= 0.0 && particleAge <= aLife) {
${lightLoop(false, 'mAt', 'mLit', '0.3 + 1.5 * pow(max(dot(mView, wxToL), 0.0), 3.0)')}
    }

    mLit *= material.uMistLook.z;
    ${softKnee(false, 'mLit')}

    particleColor = vec4(particleColor.rgb + mLit, particleColor.a * mNear * mGround);
  }
`,
    },
  },
} satisfies ShaderBit;

/** Per truck in the last frame: x, y, z, yaw, heading, speed, and 1 when it was there. */
const STATE_FLOATS = 7;

/**
 * Water off the trucks: rooster tails of droplets from both rear wheels and a mist cloud trailing each truck while
 * it is fast.
 *
 * Two draw calls. The droplets are motion-stretched like the rain, so they streak at speed; both systems move in the
 * vertex shader on the game clock from a record written once at launch.
 */
export class Spray {
  private readonly _drops: ParticlePool;
  private readonly _mist: ParticlePool;
  private readonly _dropCam: Float32Array;
  private readonly _dropLook: Float32Array;
  private readonly _dropCamVel: Float32Array;
  private readonly _mistCam: Float32Array;
  private readonly _random = new SeededRandom();
  private readonly _last = new Float32Array(MAX_RACERS * STATE_FLOATS);
  private readonly _dropTint = packParticleColor(DROP_TINT, 1);
  private readonly _dropDim = packParticleColor(DROP_TINT, 0.55);
  private readonly _mistYoung = packParticleColor(MIST_YOUNG, 0.28);
  private readonly _mistYoungFaint = packParticleColor(MIST_YOUNG, 0.18);
  private _lastTime = -1;

  /**
   * @param parent - Scene root.
   * @param smoke - Soft puff texture for the mist.
   */
  constructor(parent: Container3D, smoke: Texture) {
    const drops = new ParticleContainer3D({
      label: 'spray-drops',
      capacity: DROP_CAPACITY,
      blendMode: 'add',
      extraBits: [particleLifetimeBit, particleMotionBit, dropBit],
    });
    const mist = new ParticleContainer3D({
      label: 'spray-mist',
      texture: smoke,
      capacity: MIST_CAPACITY,
      blendMode: 'normal',
      extraBits: [particleLifetimeBit, particleMotionBit, mistBit],
    });

    skipToneCurve(drops.material);
    skipToneCurve(mist.material);
    drops.uniforms.uDrag = DROP_DRAG;
    drops.uniforms.uGravity = [0, DROP_GRAVITY, 0];
    mist.uniforms.uDrag = MIST_DRAG;
    mist.uniforms.uGravity = [0, MIST_LIFT, 0];
    mist.uniforms.uMistLook = [MIST_GROWTH, MIST_BASE, MIST_LIGHT_GAIN, 0];
    mist.uniforms.uMistTint = MIST_OLD;

    this._dropCam = drops.uniforms.uSprayCam as Float32Array;
    this._dropLook = drops.uniforms.uSprayLook as Float32Array;
    this._dropCamVel = drops.uniforms.uSprayCamVel as Float32Array;
    this._dropLook[1] = DROP_BASE;
    this._dropLook[2] = DROP_LIGHT_GAIN;
    this._dropLook[3] = ROAD_Y - 0.02;
    this._mistCam = mist.uniforms.uMistCam as Float32Array;
    this._mistCam[3] = ROAD_Y;

    this._drops = new ParticlePool(drops);
    this._mist = new ParticlePool(mist);

    parent.addChild(mist, drops);
  }

  /**
   * Emit this frame's water and move both systems to the game clock.
   * @param time - Game clock, seconds.
   * @param trucks - Each truck's pose this frame by its slot, or null for an empty slot.
   * @param camera - Camera position.
   * @param cameraVelocity - Camera motion the streaks are blurred against, world units per second.
   * @param shutter - Seconds a droplet's streak shows.
   * @param pixel - World size of one pixel at unit distance.
   */
  public update(
    time: number,
    trucks: readonly (Readonly<TruckPose> | null)[],
    camera: PointData3D,
    cameraVelocity: PointData3D,
    shutter: number,
    pixel: number,
  ): void {
    if (this._lastTime < 0) this._lastTime = time;

    const span = time - this._lastTime;

    if (span > 0) {
      let first = Math.floor(this._lastTime / TICK) + 1;
      const last = Math.floor(time / TICK);

      if (last - first >= MAX_TICKS) first = last - MAX_TICKS + 1;

      for (let k = first; k <= last; k++) {
        const t = k * TICK;
        const f = (t - this._lastTime) / span;

        for (let i = 0; i < trucks.length; i++) {
          const truck = trucks[i];

          if (truck) this._emit(truck, i, f, k, t);
        }
      }
    }

    this._remember(trucks, time);

    const drops = this._drops.points;
    const mist = this._mist.points;

    drops.uniforms.uParticleTime = time;
    mist.uniforms.uParticleTime = time;
    this._dropCam[0] = camera.x;
    this._dropCam[1] = camera.y;
    this._dropCam[2] = camera.z;
    this._dropCam[3] = shutter;
    this._dropLook[0] = pixel;
    this._dropCamVel[0] = cameraVelocity.x;
    this._dropCamVel[1] = cameraVelocity.y;
    this._dropCamVel[2] = cameraVelocity.z;
    this._mistCam[0] = camera.x;
    this._mistCam[1] = camera.y;
    this._mistCam[2] = camera.z;
    drops.material.update();
    mist.material.update();
    drops.upload();
    mist.upload();
  }

  public reset(): void {
    this._drops.clear();
    this._mist.clear();
    this._last.fill(0);
    this._lastTime = -1;
  }

  public set visible(value: boolean) {
    this._drops.points.visible = value;
    this._mist.points.visible = value;
  }

  public destroy(): void {
    this._drops.points.destroy();
    this._mist.points.destroy();
  }

  private _remember(trucks: readonly (Readonly<TruckPose> | null)[], time: number): void {
    const last = this._last;

    for (let i = 0; i < trucks.length; i++) {
      const truck = trucks[i];
      const o = i * STATE_FLOATS;

      if (!truck) {
        last[o + 6] = 0;
        continue;
      }

      last[o] = truck.x;
      last[o + 1] = truck.y;
      last[o + 2] = truck.z;
      last[o + 3] = truck.yaw;
      last[o + 4] = truck.heading;
      last[o + 5] = truck.speed;
      last[o + 6] = 1;
    }

    this._lastTime = time;
  }

  /**
   * One tick of spray from one truck, its pose blended between the last frame and this one.
   * @param truck - The truck, as of this frame.
   * @param slot - Its slot, which keys its last frame and its seed.
   * @param f - Where the tick falls between the last frame (0) and this one (1).
   * @param tick - Tick index, the seed.
   * @param birth - Game time of the tick.
   */
  private _emit(truck: Readonly<TruckPose>, slot: number, f: number, tick: number, birth: number): void {
    const o = slot * STATE_FLOATS;
    const last = this._last;

    // A truck that just arrived, or was just put somewhere, starts from here.
    if (last[o + 6] === 0 || Math.abs(last[o] - truck.x) + Math.abs(last[o + 2] - truck.z) > 3) f = 1;

    const speed = last[o + 5] + (truck.speed - last[o + 5]) * f;
    const amount = Math.min(1, (speed - SPRAY_START) / (SPRAY_FULL - SPRAY_START));

    if (amount <= 0) return;

    const random = this._random;
    const px = last[o] + (truck.x - last[o]) * f;
    const py = last[o + 1] + (truck.y - last[o + 1]) * f;
    const pz = last[o + 2] + (truck.z - last[o + 2]) * f;
    const yaw = blendAngle(last[o + 3], truck.yaw, f);
    const heading = blendAngle(last[o + 4], truck.heading, f);
    // Body frame: forward, and the truck's left, which is local +x.
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const lx = fz;
    const lz = -fx;
    // Travel direction, which the water follows.
    const tx = Math.sin(heading) * speed;
    const tz = Math.cos(heading) * speed;

    for (let w = 2; w < 4; w++) {
      const wheel = WHEEL_LOCAL[w];
      const side = wheel[0] > 0 ? 1 : -1;

      random.seed(hashSeed(tick, slot, w));

      const count = Math.floor(DROP_RATE * TICK * amount + random.next());

      for (let j = 0; j < count; j++) {
        // Mostly off the low back of the tyre, where the tread turns upward.
        const arc = random.next() * random.next();

        tread(arc * 1.1 - 0.35, random.range(0.1, 0.28), random.range(0.3, 0.55), speed);

        const sx = wheel[0] + side * random.range(-0.04, 0.05);
        const sz = wheel[2] + _tread.back;
        const out = side * speed * random.range(-0.02, 0.09);

        this._drops.write(
          px + sx * lx + sz * fx,
          py + wheel[1] + _tread.up,
          pz + sx * lz + sz * fz,
          tx * _tread.carry + fx * _tread.forward + lx * out,
          _tread.rise,
          tz * _tread.carry + fz * _tread.forward + lz * out,
          birth,
          random.range(0.35, 0.7),
          random.range(0.02, 0.036),
          0,
          random.next() < 0.5 ? this._dropTint : this._dropDim,
        );
      }
    }

    random.seed(hashSeed(tick, slot, 7));

    const puffs = Math.floor(MIST_RATE * TICK * amount + random.next());

    for (let j = 0; j < puffs; j++) {
      const sx = random.range(-0.32, 0.32);
      const sz = -random.range(0.6, 0.9);
      const out = random.range(-0.6, 0.6);

      this._mist.write(
        px + sx * lx + sz * fx,
        py + random.range(0.08, 0.32),
        pz + sx * lz + sz * fz,
        tx * random.range(0.4, 0.65) + lx * out,
        random.range(0.2, 0.7),
        tz * random.range(0.4, 0.65) + lz * out,
        birth,
        random.range(0.9, 1.5),
        random.range(0.5, 0.8),
        random.range(0, Math.PI * 2),
        random.next() < 0.5 ? this._mistYoung : this._mistYoungFaint,
      );
    }
  }
}

/** Where a droplet leaves a tyre, from the axle, and how fast; written by {@link tread}. */
const _tread = { back: 0, up: 0, forward: 0, rise: 0, carry: 0 };

/**
 * Water leaving a rolling tyre's tread, in the truck's frame. The tread runs straight up at the back of the tyre and
 * forward over the top, so water flung off the back climbs and water off the top is thrown ahead.
 * @param angle - Where it leaves, in radians round from the back of the axle (0) toward the top (π/2); negative is
 *   below the axle, toward the contact patch.
 * @param fling - Share of the tread speed the water leaves with.
 * @param carry - Share of the truck's own travel it keeps.
 * @param speed - The truck's ground speed, which is also the tread's speed round the axle.
 */
function tread(angle: number, fling: number, carry: number, speed: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  _tread.back = -c * WHEEL_RADIUS;
  _tread.up = s * WHEEL_RADIUS;
  _tread.forward = s * fling * speed;
  _tread.rise = c * fling * speed;
  _tread.carry = carry;
}

/** Blend two angles the short way round. */
function blendAngle(from: number, to: number, f: number): number {
  const d = to - from;

  return from + Math.atan2(Math.sin(d), Math.cos(d)) * f;
}
