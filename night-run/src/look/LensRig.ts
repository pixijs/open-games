import type { CameraState } from '@kvvasuu/klipp';
import { Color } from 'pixi.js';

import { ROAD_Y } from '../race/route';
import { LensEffect } from './LensEffect';
import type { LensFx } from './LensFx';
import { WetReflection } from './WetReflection';

const DEG_TO_RAD = Math.PI / 180;

/** Lens wetness that never dries off: a few beads from the rain. */
const BASE_WETNESS = 0.06;
/** Splashed water past this is running off the lens anyway. */
const MAX_WETNESS = 1.3;
/** How much of a splash stays on the lens as settled beads; the rest is the spray's burst of tiny drops. */
const SPLASH_BEADS = 0.6;
/**
 * How fast settled beads dry off and the spray's tiny drops settle, per world second; airflow at speed dries the beads
 * up to this much faster again.
 */
const DRY_RATE = 0.6;
const SPRAY_SETTLE = 2.5;
const AIRFLOW_DRYING = 1.5;
/** Camera speeds, world units per real second, over which the airflow on the lens builds. */
const AIRFLOW_FROM = 5;
const AIRFLOW_TO = 16;
/** How fast full airflow carries the beads outward, in log screen radius per world second. */
const FLOW_RATE = 0.3;

/** Seconds of camera turn one frame's smear covers: a 180° shutter at 60 frames a second. */
const SHUTTER = 1 / 120;
/** Longest turn smear, in screen heights, and the most roll smear, in radians. */
const MAX_MOTION = 0.03;
const MAX_ROLL = 0.04;
/** A turn this sharp in one frame is a cut, not a pan, and gets no smear. */
const CUT_ANGLE = 0.35;

/** Lights closer to the lens plane than this don't flare. */
const FLARE_NEAR = 0.2;

/** Screens at least this many CSS pixels trace the full reflection; smaller ones march fewer steps. */
const REFLECTION_FULL_PIXELS = 0.8e6;
const REFLECTION_STEPS = 28;
const REFLECTION_STEPS_SMALL = 16;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

  return t * t * (3 - 2 * t);
}

/**
 * Drives the lens from the effects' requests each frame: flares, shockwave, heat haze, water on the lens, flashes,
 * and blur from the camera's own turning; and traces the wet road's reflections from the same shot.
 *
 * Its state only advances with the clocks it is handed: the flash and last frame's camera by `realDt`, the water on
 * the lens by world time, so the water holds still in a freeze. A reset and a replay from the first frame rebuild any
 * frame exactly.
 */
export class LensRig {
  /** The lens pass: streaks, flares, droplets, distortion, grade and film; last in the chain. */
  public readonly effect = new LensEffect();
  /** Screen-space reflections on the wet road; first in the chain. */
  public readonly reflection = new WetReflection(ROAD_Y);

  private _aspect = 16 / 9;
  /** `1 / tan(fov / 2)` this frame: projection's vertical scale. */
  private _focal = 1;
  private _wetness = 0;
  private _spray = 0;
  private _flow = 0;
  private _flash = 0;
  private readonly _flashColor = new Color(0xffffff);
  private _flashDecay = 7;

  private _hasLast = false;
  private _lastWorldTime = 0;
  private readonly _lastPosition = new Float64Array(3);
  private readonly _lastQuaternion = new Float64Array(4);
  /** Camera-space point from {@link LensRig._toCamera}. */
  private readonly _cam = new Float64Array(3);
  /** Content UV (y down) from {@link LensRig._project}. */
  private readonly _uv = new Float64Array(2);

  constructor() {
    const reflection = this.reflection;

    reflection.strength = 1;
    reflection.maxDistance = 40;
    reflection.steps = REFLECTION_STEPS;
    reflection.puddles = 0.6;
    reflection.stretch = 24;
    reflection.ripples = 0.15;
    this.effect.aspect = this._aspect;
    this.effect.setWater(BASE_WETNESS, 0, 0);
  }

  /**
   * Match the screen.
   * @param width - Screen width in CSS pixels.
   * @param height - Screen height in CSS pixels.
   * @param _resolution - The display's resolution; the reflection traces at one texel per CSS pixel whatever it is.
   */
  public layout(width: number, height: number, _resolution: number): void {
    if (width <= 0 || height <= 0) return;

    this._aspect = width / height;
    this.effect.aspect = this._aspect;
    this.reflection.steps = width * height >= REFLECTION_FULL_PIXELS ? REFLECTION_STEPS : REFLECTION_STEPS_SMALL;
  }

  /**
   * Apply this frame's requests; call after the camera has moved and before rendering.
   * @param realDt - Real seconds this frame covers; 0 while frozen.
   * @param time - Take time, or the game's clock.
   * @param shot - The camera this frame.
   * @param fx - This frame's requests; the rig reads it but does not clear it.
   * @param worldTime - Story time the rain ripples, heat haze and the water on the lens run on, so they freeze with
   *   the world.
   */
  public update(realDt: number, time: number, shot: CameraState, fx: LensFx, worldTime = time): void {
    const effect = this.effect;

    this._focal = 1 / Math.tan(shot.fov * DEG_TO_RAD * 0.5);
    this._flares(shot, fx);
    this._shockwave(shot, fx);
    this._heat(shot, fx);

    const worldDt = this._hasLast ? Math.max(0, worldTime - this._lastWorldTime) : 0;
    const airflow = this._motion(realDt, shot);

    this._lastWorldTime = worldTime;
    this._wetness = Math.min(
      MAX_WETNESS,
      this._wetness * Math.exp(-worldDt * DRY_RATE * (1 + airflow * AIRFLOW_DRYING)) + fx.lensSplash * SPLASH_BEADS,
    );
    this._spray = Math.min(1, this._spray * Math.exp(-worldDt * SPRAY_SETTLE) + fx.lensSplash);
    this._flow += airflow * worldDt * FLOW_RATE;
    effect.setWater(BASE_WETNESS + this._wetness, this._spray, this._flow);

    this._flash *= Math.exp(-realDt * this._flashDecay);

    if (fx.flashAmount >= this._flash && fx.flashAmount > 0) {
      this._flash = fx.flashAmount;
      this._flashColor.setValue(fx.flashColor);
      this._flashDecay = fx.flashDecay;
    }

    effect.setFlash(this._flashColor, this._flash);
    effect.time = time;
    effect.worldTime = worldTime;
    this.reflection.setView(shot.position, shot.quaternion);
    this.reflection.time = worldTime;
  }

  public reset(): void {
    this._wetness = 0;
    this._spray = 0;
    this._flow = 0;
    this._flash = 0;
    this._hasLast = false;
    this.effect.setWater(BASE_WETNESS, 0, 0);
    this.effect.setFlash(this._flashColor, 0);
    this.effect.setMotion(0, 0, 0);
    this.effect.setShockwave(0.5, 0.5, 0, 0);
    this.effect.setHeat(0.5, 0.5, 0, 0);
    this.effect.clearFlares(0);
  }

  public destroy(): void {
    this.effect.destroy();
    this.reflection.destroy();
  }

  /** Project the requested flares, fade beams by how squarely they face the lens, and pack the brightest. */
  private _flares(shot: CameraState, fx: LensFx): void {
    const effect = this.effect;
    const p = shot.position;
    let count = 0;

    for (let i = 0; i < fx.flareCount; i++) {
      const f = fx.flares[i];
      const dx = f.x - p[0];
      const dy = f.y - p[1];
      const dz = f.z - p[2];

      this._toCamera(shot, dx, dy, dz);

      const depth = -this._cam[2];

      if (depth < FLARE_NEAR) continue;

      this._project(depth);

      const u = this._uv[0];
      const v = this._uv[1];
      const outside = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) - 0.5;
      let intensity = f.intensity * (1 - smoothstep(0, 0.25, outside));

      if (f.cone > -1) {
        const facing = -(f.dx * dx + f.dy * dy + f.dz * dz) / Math.hypot(dx, dy, dz);

        intensity *= smoothstep(f.cone, f.cone + (1 - f.cone) * 0.6, facing);
      }

      if (intensity < 0.01) continue;

      const size = Math.min(1.4, Math.max(0.4, 1.6 / Math.sqrt(depth)));

      effect.setFlare(count++, u, v, depth, intensity, f.r, f.g, f.b, size);
    }

    effect.clearFlares(count);
  }

  /** Project the shockwave sphere to a ring; it fades as the lens enters it. */
  private _shockwave(shot: CameraState, fx: LensFx): void {
    const wave = fx.shockwave;
    const p = shot.position;

    if (wave.strength > 0) {
      const dx = wave.x - p[0];
      const dy = wave.y - p[1];
      const dz = wave.z - p[2];

      this._toCamera(shot, dx, dy, dz);

      const depth = -this._cam[2];
      const clear = (Math.hypot(dx, dy, dz) - wave.radius) / Math.max(wave.radius, 0.5);

      if (depth > 0.3 && clear > 0) {
        this._project(depth);
        this.effect.setShockwave(
          this._uv[0],
          this._uv[1],
          Math.min(1.5, (wave.radius * this._focal * 0.5) / depth),
          wave.strength * smoothstep(0, 0.6, clear),
        );

        return;
      }
    }

    this.effect.setShockwave(0.5, 0.5, 0, 0);
  }

  private _heat(shot: CameraState, fx: LensFx): void {
    const heat = fx.heat;
    const p = shot.position;

    if (heat.strength > 0) {
      this._toCamera(shot, heat.x - p[0], heat.y - p[1], heat.z - p[2]);

      const depth = -this._cam[2];

      if (depth > 0.3) {
        this._project(depth);
        this.effect.setHeat(
          this._uv[0],
          this._uv[1],
          Math.min(1, (heat.radius * this._focal * 0.5) / depth),
          heat.strength,
        );

        return;
      }
    }

    this.effect.setHeat(0.5, 0.5, 0, 0);
  }

  /**
   * Smear along the camera's turn since last frame, nothing while frozen or across a cut; and measure the airflow its
   * speed blows across the lens.
   * @returns Airflow, 0 to 1.
   */
  private _motion(realDt: number, shot: CameraState): number {
    const q = shot.quaternion;
    const p = shot.position;
    const last = this._lastQuaternion;
    const lastPosition = this._lastPosition;
    let mx = 0;
    let my = 0;
    let roll = 0;
    let airflow = 0;

    if (this._hasLast && realDt > 0) {
      // The turn since last frame in last frame's camera axes: conj(last) * q.
      const ax = -last[0];
      const ay = -last[1];
      const az = -last[2];
      const aw = last[3];
      const dx = aw * q[0] + ax * q[3] + ay * q[2] - az * q[1];
      const dy = aw * q[1] - ax * q[2] + ay * q[3] + az * q[0];
      const dz = aw * q[2] + ax * q[1] - ay * q[0] + az * q[3];
      const dw = aw * q[3] - ax * q[0] - ay * q[1] - az * q[2];
      // Small-angle rotation vector, axis times angle, the short way round.
      const sign = dw < 0 ? -2 : 2;
      const pitch = dx * sign;
      const yaw = dy * sign;
      const turn = dz * sign;

      if (Math.hypot(pitch, yaw, turn) < CUT_ANGLE) {
        const k = SHUTTER / realDt;

        mx = (yaw * k * this._focal * 0.5) / this._aspect;
        my = pitch * k * this._focal * 0.5;

        const length = Math.hypot(mx * this._aspect, my);

        if (length > MAX_MOTION) {
          mx *= MAX_MOTION / length;
          my *= MAX_MOTION / length;
        }

        roll = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, turn * k));
      }

      const vx = (p[0] - lastPosition[0]) / realDt;
      const vy = (p[1] - lastPosition[1]) / realDt;
      const vz = (p[2] - lastPosition[2]) / realDt;

      airflow = smoothstep(AIRFLOW_FROM, AIRFLOW_TO, Math.hypot(vx, vy, vz));
    }

    last[0] = q[0];
    last[1] = q[1];
    last[2] = q[2];
    last[3] = q[3];
    lastPosition[0] = p[0];
    lastPosition[1] = p[1];
    lastPosition[2] = p[2];
    this._hasLast = true;
    this.effect.setMotion(mx, my, roll);

    return airflow;
  }

  /** Rotate a world-space offset into the shot's camera frame (looking down -z), into `_cam`. */
  private _toCamera(shot: CameraState, x: number, y: number, z: number): void {
    const q = shot.quaternion;
    // The inverse rotation: the conjugate quaternion.
    const qx = -q[0];
    const qy = -q[1];
    const qz = -q[2];
    const qw = q[3];
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    const cam = this._cam;

    cam[0] = x + qw * tx + (qy * tz - qz * ty);
    cam[1] = y + qw * ty + (qz * tx - qx * tz);
    cam[2] = z + qw * tz + (qx * ty - qy * tx);
  }

  /** Content UV (y down) of the camera-space point in `_cam` at a positive view depth, into `_uv`. */
  private _project(depth: number): void {
    const f = this._focal;

    this._uv[0] = 0.5 + ((this._cam[0] * f) / (depth * this._aspect)) * 0.5;
    this._uv[1] = 0.5 - ((this._cam[1] * f) / depth) * 0.5;
  }
}
