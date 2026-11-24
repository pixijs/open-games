import type { Fog, PostEffect, View3D, View3DOptions } from '@pixi/3d';
import { AmbientLight, DirectionalLight, Vector3 } from '@pixi/3d';
import { BloomEffect, TiltShiftEffect } from '@pixi/3d/extras';
import type { ColorSource } from 'pixi.js';

import type { KlippPixi } from '../KlippPixi';
import type { TruckPose } from '../race/truck';
import type { LensFx } from './LensFx';
import { LensRig } from './LensRig';
import type { BoltShape } from './NightSky';
import { horizonColor, MOON_DIRECTION, NightSky } from './NightSky';

/** Ground-plane tint: dark wet grass under the moon. */
export const GRASS_COLOR = 0x1e2c22;

/** The View3D settings of the night look; spread them into the View3D options. */
export type SceneViewOptions = Required<
  Pick<View3DOptions, 'shadowQuality' | 'toneMapping' | 'exposure' | 'environment' | 'background' | 'fog'>
>;

const [MOON_X, MOON_Y, MOON_Z] = MOON_DIRECTION;
/** How far up the moon ray the light sits from what it shadows; only the direction shades. */
const MOON_DISTANCE = 40;
const MOON_COLOR = 0xa8beff;
const MOON_INTENSITY = 1.5;
const EXPOSURE = 1.3;

/** Fog starts this far past the focus and is opaque this far past it: rain haze that swallows the far trees. */
const FOG_NEAR = 5;
const FOG_FAR = 60;
const DEFAULT_FOCUS = 16;
/** Screens with fewer pixels than this, at the display's resolution, skip bloom; there it costs more than it shows. */
const BLOOM_MIN_PIXELS = 1.2e6;
const DEG = Math.PI / 180;

// -- Lightning --

/** The bolt the race's strikes draw, turned to a new bearing each time. */
const BOLTS: readonly BoltShape[] = [{ bearing: -22, top: 34, foot: -1.2, lean: -3, crawlers: 2, seed: 7 }];

/** A strike's return strokes, `[seconds after it starts, brightness]`, and seconds for a stroke to fade to 1/e. */
const STROKES: readonly (readonly [number, number])[] = [
  [0.1, 1],
  [0.18, 0.55],
  [0.29, 0.95],
  [0.36, 0.45],
];
const STROKE_FADE = 0.045;

/** Where each bolt's flash lights the scene from: its bearing, high up. */
const STRIKE_ELEVATION = 62 * DEG;
const STRIKE_COLOR = 0xd4deff;
const STRIKE_INTENSITY = 3;
/** The whole cloud deck lights up too: an even blue fill at the stroke's peak, so the side away from the bolt reads. */
const STRIKE_FILL = 0.5;
const STRIKE_FILL_COLOR = 0xa8b8ff;
const STRIKE_DISTANCE = 40;
/** How hard a bolt flares the lens at a stroke's peak, and the moon always. */
const BOLT_FLARE = 1.5;
const BOLT_FLARE_COLOR = 0xd0d8ff;
const MOON_FLARE = 0.3;
const MOON_FLARE_COLOR = 0xb8c8ff;
/** How far out the moon's flare point sits: past the trees, inside the far plane. */
const MOON_FLARE_DISTANCE = 140;
/** Seconds before the first lightning strike. */
const GAME_FIRST_STRIKE = 8;
/** How much brighter the frame is exposed at a stroke's peak. */
const STRIKE_EXPOSURE = 0.25;
/** Above this the background swaps to the lit cloud deck. */
const STRIKE_SKY = 0.28;
/** Seconds between lightning strikes in the race. */
const GAME_STRIKE_MIN = 14;
const GAME_STRIKE_SPREAD = 22;

/**
 * Brightness of a strike some seconds after it starts: each stroke flashes on within a fraction of its fade and dies
 * away.
 * @param time - Seconds since the strike started.
 * @returns 0 to 1.
 */
function strikeAt(time: number): number {
  const rise = STROKE_FADE * 0.15;
  let amount = 0;

  for (let i = 0; i < STROKES.length; i++) {
    const dt = time - STROKES[i][0];

    if (dt < 0) break;

    amount = Math.max(amount, STROKES[i][1] * Math.min(1, dt / rise) * Math.exp(-dt / STROKE_FADE));
  }

  return amount;
}

/** The bolt glows on between strokes while the channel is still hot, so it reads longer than the sky flash. */
function boltGlow(flash: number): number {
  return Math.min(1, 1.6 * Math.pow(flash, 0.7));
}

// -- Grade --

/** Cool teal the shadows lean to. */
const SHADOW_HUE = 0x00a6c4;
/** Magenta the highlights lean to, as normalised rgb. */
const HIGHLIGHT_HUE = new Float32Array([1, 0x3c / 255, 0xc0 / 255]);
/** Contrast pivots low, so it deepens the blacks rather than lifting the darks toward grey. */
const PIVOT = 0.3;
/** Most chromatic split the lens is given; the lens keeps the middle third clean and grows it toward the edges. */
const MAX_ABERRATION = 0.0024;
/** Most speed streak, as a fraction of the distance to the centre. */
const MAX_BLUR = 0.06;
/**
 * Sharp zone round the streak centre, in screen heights: wide while the streaks centre on the subject, so it and a
 * ring round it stay crisp, and the lens's default otherwise.
 */
const SUBJECT_CLEAR = 0.28;
const OPEN_CLEAR = 0.08;
/** How much a boost dims the bloom, so the flame doesn't wash the frame out. */
const BOOST_GLOW_CUT = 0.45;

/** Rich night: deep blacks, saturated neon, teal shadows and magenta highlights. */
const NIGHT = {
  streaks: 0.55,
  saturation: 1.16,
  contrast: 1.1,
  split: 0.55,
  vignette: 0.42,
  grain: 0.03,
  shimmer: 0.0008,
  exposure: 1,
  blacks: -0.006,
  glow: 0.9,
} as const;

/** Per camera: tilt-shift blur, and how much speed blur it takes (long lenses and the diorama want less). */
const CAMERA_FX: Readonly<Record<string, { tilt: number; speed: number }>> = {
  iso: { tilt: 4, speed: 0.6 },
  chase: { tilt: 0, speed: 1 },
  tv: { tilt: 6, speed: 0.2 },
  finish: { tilt: 7, speed: 0.2 },
};
/** Any other camera, such as a staging shot: a touch of depth of field and no speed blur. */
const OTHER_CAMERA_FX = { tilt: 3, speed: 0 };
/** Ground speed, world units per second, that counts as flat out. */
const FLAT_OUT = 12;

const _cam = new Vector3();
const _uv = new Vector3();
const _aim = new Vector3();

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The night look: a cool low moon with cascaded shadows, a city-lit overcast with lightning now and then, neon
 * reflections, rain haze, and the post chain (the lens rig's reflections, tilt-shift, bloom, then the
 * {@link LensRig}'s lens pass for streaks, flares, grade, grain and flashes).
 *
 * It runs after the cameras and every effect: it reads klipp's finished shot for focus and fog, fires the lightning,
 * hands the frame's effect requests to the lens, and clears them.
 */
export class NightLook {
  /** Depth of field, focused on whatever the camera looks at. */
  public readonly tiltShift = new TiltShiftEffect({
    stage: 'afterToneMapping',
    focalNear: 3.5,
    focalFar: 15,
    maxBlur: 0,
  });
  /** Glow on lamps, neon, lightning and fire; switched off on small screens. */
  public readonly bloom = new BloomEffect({
    stage: 'afterToneMapping',
    levels: 5,
    resolution: 0.5,
    threshold: 0.6,
    intensity: NIGHT.glow,
    radius: 0.72,
  });
  /** The lens: wet-road reflections, flares, water, flashes, and the last pass in the chain. */
  public readonly lens = new LensRig();
  /**
   * The post chain, in order, for `View3D.passes`. The look was graded on the picture as it shows, so every effect
   * runs `'afterToneMapping'`; that keeps the scene in display space, with the tone curve in the materials.
   */
  public readonly passes: readonly PostEffect[];
  /** Shadows, tone mapping, exposure, the reflection cube, the sky and the fog. */
  public readonly viewOptions: SceneViewOptions;
  /** The low moon, along `MOON_DIRECTION`; it casts the cascaded shadows. */
  public readonly moon: DirectionalLight;
  public readonly sky: NightSky;

  /** The lightning's flash on the scene, from the bolt's side of the sky; off between strikes. */
  private readonly _strikeLight: DirectionalLight;
  /** The lit cloud deck's fill; ambient, so it costs no light slot. */
  private readonly _strikeFill = new AmbientLight({ color: STRIKE_FILL_COLOR, intensity: 0 });
  private _view: View3D | null = null;
  private _klipp: KlippPixi | null = null;
  private _fx: LensFx | null = null;
  private _fog: Fog | null = null;
  private _aspect = 16 / 9;

  private _boostFx = 0;
  private _speedScale = 0;
  private _time = 0;
  /** Time the current strike started, and the next one's. */
  private _strikeAt = -Infinity;
  private _nextStrike = GAME_FIRST_STRIKE;
  /** Bearing of the current strike's bolt, radians. */
  private _strikeYaw = 0;
  private _seed = 0x9e3779b9;

  constructor() {
    this.sky = new NightSky(BOLTS);

    const reflection = this.lens.reflection;

    this.passes = reflection
      ? [reflection, this.tiltShift, this.bloom, this.lens.effect]
      : [this.tiltShift, this.bloom, this.lens.effect];
    this.viewOptions = {
      shadowQuality: 'high',
      toneMapping: 'aces',
      exposure: EXPOSURE,
      environment: this.sky.environment,
      background: this.sky.background,
      fog: {
        type: 'linear',
        color: horizonColor(0, 1),
        near: DEFAULT_FOCUS + FOG_NEAR,
        far: DEFAULT_FOCUS + FOG_FAR,
      },
    };

    // Cascades follow the camera; the normal offset stays derived from each cascade's texel size, which is what
    // keeps grazing light on the asphalt free of acne without lifting shadows off the trucks.
    this.moon = new DirectionalLight({
      color: MOON_COLOR,
      intensity: MOON_INTENSITY,
      castShadow: true,
      shadow: { cascades: 3, maxDistance: 60, lambda: 0.7, bias: 0.0004 },
    });
    this.moon.position.set(MOON_X * MOON_DISTANCE, MOON_Y * MOON_DISTANCE, MOON_Z * MOON_DISTANCE);
    this.moon.lookAt({ x: 0, y: 0, z: 0 });

    this._strikeLight = new DirectionalLight({ color: STRIKE_COLOR, intensity: 0 });
    this._strikeLight.visible = false;
    this.lens.effect.aspect = this._aspect;
  }

  /**
   * Put the lights and the bolt in the scene and keep what the look reads every frame.
   * @param view - The view built from {@link NightLook.viewOptions} and {@link NightLook.passes}.
   * @param klipp - The camera director; its shot drives focus, fog and the lens.
   * @param fx - The effects' requests to the lens; the look hands them on and clears them every frame.
   */
  public attach(view: View3D, klipp: KlippPixi, fx: LensFx): void {
    this._view = view;
    this._klipp = klipp;
    this._fx = fx;
    this._fog = view.fog;
    view.root.addChild(this.moon, this._strikeLight, this._strikeFill, this.sky.dome);
  }

  /**
   * Match the screen: the aspect the lens draws at, and whether bloom is worth its cost.
   * @param width - Screen width in CSS pixels.
   * @param height - Screen height in CSS pixels.
   * @param resolution - The display's resolution, not the renderer's, so bloom stays put while the governor steps.
   */
  public layout(width: number, height: number, resolution: number): void {
    if (width <= 0 || height <= 0) return;

    const aspect = width / height;

    if (aspect !== this._aspect) {
      this._aspect = aspect;
      this.lens.effect.aspect = aspect;
    }

    const bloom = width * height * resolution * resolution >= BLOOM_MIN_PIXELS;

    if (this.bloom.enabled !== bloom) this.bloom.enabled = bloom;

    this.lens.layout(width, height, resolution);
  }

  /**
   * Flash the frame toward a colour; the lens keeps the strongest asked for each frame and fades it.
   * @param amount - Mix amount, 0 to 1.
   * @param color - Flash colour.
   * @param decay - How fast it fades, per second.
   */
  public flash(amount: number, color: ColorSource = 0xffffff, decay = 7): void {
    this._fx?.flash(amount, color, decay);
  }

  /** Strike lightning now, from a fresh bearing. */
  public strike(): void {
    this._strikeAt = this._time;
    this._strikeYaw = this._random() * Math.PI * 2;
    this._nextStrike = this._time + GAME_STRIKE_MIN + this._random() * GAME_STRIKE_SPREAD;
  }

  /**
   * One frame of the look: focus and fog on klipp's look-at target, tilt-shift and streak strength per camera, streaks
   * toward where the subject is heading, now and then lightning, and the lens.
   * @param realDt - Real seconds since the last frame.
   * @param camera - Klipp id of the camera on screen.
   * @param subject - The truck the shot is about, or null for none.
   */
  public update(realDt: number, camera: string | null, subject: Readonly<TruckPose> | null): void {
    const klipp = this._klipp;
    const fx = this._fx;

    if (!klipp || !fx) return;

    const cameraFx = CAMERA_FX[camera ?? ''] ?? OTHER_CAMERA_FX;
    const ease = Math.min(1, realDt * 3);
    const tilt = this.tiltShift;
    const shot = klipp.shot;
    const target = shot.hasLookAtTarget ? shot.lookAtTarget : shot.position;
    const x = subject ? subject.x : target[0];
    const y = subject ? subject.y : target[1];
    const z = subject ? subject.z : target[2];

    this._time += realDt;

    if (this._time >= this._nextStrike) this.strike();

    const flash = strikeAt(this._time - this._strikeAt);
    const yaw = this._strikeYaw;

    this.sky.dome.rotation.y = yaw;
    this._placeMoon(x, y, z);
    this._strike(flash, 0, BOLTS[0].bearing * DEG + yaw, x, y, z);

    const focus = this._focus();

    this._fogAround(focus, flash);

    tilt.focalDepth = focus;
    tilt.focalNear = 3.5;
    tilt.focalFar = 15;
    tilt.maxBlur += (cameraFx.tilt - tilt.maxBlur) * ease;
    tilt.enabled = tilt.maxBlur > 0.3;

    const boosting = subject?.boosting ? 1 : 0;

    this._boostFx += (boosting - this._boostFx) * Math.min(1, realDt * 5);
    this._speedScale += (cameraFx.speed - this._speedScale) * ease;

    const boost = this._boostFx;
    const scale = this._speedScale;
    const speed = subject ? subject.speed : 0;
    const heading = subject ? subject.heading : 0;
    const pace = speed / FLAT_OUT;

    this._streakCenter(x, y + 0.5, z, Math.sin(heading), Math.cos(heading), speed * 0.6);
    this._streaks((smoothstep(0.8, 1.3, pace) * 0.03 + boost * 0.05) * scale, NIGHT.shimmer + boost * 0.0008 * scale);
    this._grade(boost * 0.25 * scale, boost);
    this._skyFlares(fx, flash);
    fx.lightning = Math.max(fx.lightning, flash);
    this.lens.update(realDt, this._time, shot, fx);
    fx.clear();
  }

  public destroy(): void {
    this.moon.destroy();
    this._strikeLight.destroy();
    this._strikeFill.destroy();
    this.sky.destroy();
    this.tiltShift.destroy();
    this.bloom.destroy();
    this.lens.destroy();
    this._view = null;
    this._klipp = null;
    this._fx = null;
    this._fog = null;
  }

  /**
   * Hand the streaks and the chromatic split to the lens, capped so a boost can't smear the whole frame.
   * @param blur - Streak length asked for.
   * @param aberration - Chromatic split asked for.
   */
  private _streaks(blur: number, aberration: number): void {
    const effect = this.lens.effect;

    effect.blur = Math.min(MAX_BLUR, blur);
    effect.aberration = Math.min(MAX_ABERRATION, aberration);
  }

  /**
   * Hand the night grade and bloom to the lens.
   * @param vignette - Extra vignette, such as from a boost.
   * @param boost - Boost flame strength, 0 to 1; it dims the bloom.
   */
  private _grade(vignette: number, boost: number): void {
    const effect = this.lens.effect;

    effect.vignette = NIGHT.vignette + vignette;
    effect.exposure = NIGHT.exposure;
    effect.saturation = NIGHT.saturation;
    effect.contrast = NIGHT.contrast;
    effect.pivot = PIVOT;
    effect.lift = NIGHT.blacks;
    effect.splitTone = NIGHT.split;
    effect.setSplitTone(SHADOW_HUE, HIGHLIGHT_HUE);
    effect.grain = NIGHT.grain;
    this.bloom.intensity = NIGHT.glow * (1 - BOOST_GLOW_CUT * boost);
  }

  /**
   * Light the sky and the scene for a strike: the bolt, the lit cloud deck, a blue-white light from high on the bolt's
   * side with an even fill from the whole deck, and an exposure punch. The bolts hang on a dome kept on the lens, like
   * the background.
   * @param flash - Strike brightness, 0 to 1.
   * @param bolt - Which bolt.
   * @param bearing - Bearing the flash comes from, radians.
   * @param x - Where the camera looks, x; the light is placed over it.
   * @param y - Where the camera looks, y.
   * @param z - Where the camera looks, z.
   */
  private _strike(flash: number, bolt: number, bearing: number, x: number, y: number, z: number): void {
    const view = this._view;
    const light = this._strikeLight;
    const on = flash > 0.005;

    this.sky.showBolt(bolt, boltGlow(flash));
    this._strikeFill.intensity = STRIKE_FILL * flash;
    light.visible = on;

    if (on) {
      const c = Math.cos(STRIKE_ELEVATION);

      light.intensity = STRIKE_INTENSITY * flash;
      light.position.set(
        x + c * Math.sin(bearing) * STRIKE_DISTANCE,
        y + Math.sin(STRIKE_ELEVATION) * STRIKE_DISTANCE,
        z + c * Math.cos(bearing) * STRIKE_DISTANCE,
      );
      _aim.set(x, y, z);
      light.lookAt(_aim);
    }

    if (!view) return;

    const p = this._klipp!.shot.position;

    this.sky.dome.position.set(p[0], p[1], p[2]);
    view.background = flash > STRIKE_SKY ? this.sky.struck : this.sky.background;
    view.exposure = EXPOSURE * (1 + STRIKE_EXPOSURE * flash);
  }

  /** Ask the lens for the moon's soft flare, and the bolt's while it is lit. */
  private _skyFlares(fx: LensFx, flash: number): void {
    const p = this._klipp!.shot.position;
    const d = MOON_FLARE_DISTANCE;

    fx.flare(p[0] + MOON_X * d, p[1] + MOON_Y * d, p[2] + MOON_Z * d, MOON_FLARE_COLOR, MOON_FLARE);

    if (flash < 0.02) return;

    const dome = this.sky.dome;
    const core = this.sky.boltCores[0];
    const yaw = dome.rotation.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);

    fx.flare(
      dome.position.x + core[0] * c + core[2] * s,
      dome.position.y + core[1],
      dome.position.z - core[0] * s + core[2] * c,
      BOLT_FLARE_COLOR,
      BOLT_FLARE * flash,
    );
  }

  /** The next number from the lightning's dice, 0 to 1. */
  private _random(): number {
    this._seed = (Math.imul(this._seed, 1664525) + 1013904223) >>> 0;

    return this._seed / 4294967296;
  }

  /** View depth of klipp's look-at target, where the tilt-shift focuses and the fog starts counting from. */
  private _focus(): number {
    const shot = this._klipp!.shot;

    if (!shot.hasLookAtTarget) return DEFAULT_FOCUS;

    const p = shot.position;
    const t = shot.lookAtTarget;

    this._toCamera(t[0] - p[0], t[1] - p[1], t[2] - p[2]);

    return Math.max(0.5, -_cam.z);
  }

  /** Keep the light over what the camera looks at, along the moon ray. */
  private _placeMoon(x: number, y: number, z: number): void {
    this.moon.position.set(x + MOON_X * MOON_DISTANCE, y + MOON_Y * MOON_DISTANCE, z + MOON_Z * MOON_DISTANCE);
  }

  /**
   * Fog range from the focus, and its colour from the horizon the camera faces, so far trees melt into the sky;
   * lightning lights the haze with the cloud deck.
   */
  private _fogAround(focus: number, flash: number): void {
    const fog = this._fog;

    if (!fog) return;

    const q = this._klipp!.shot.quaternion;
    const forwardX = -2 * (q[0] * q[2] + q[3] * q[1]);
    const forwardZ = -(1 - 2 * (q[0] * q[0] + q[1] * q[1]));

    fog.near = focus + FOG_NEAR;
    fog.far = focus + FOG_FAR;
    fog.color = horizonColor(forwardX, forwardZ, flash > STRIKE_SKY ? 1 : 0);
  }

  /**
   * Centre the streaks on the subject whenever it is in frame, with a wide sharp zone, so it stays crisp and only its
   * surroundings streak. Off screen, they centre a little ahead of it, the point the shot rushes toward, and failing
   * that on the vanishing point of its line of travel.
   * @param x - Subject position, x.
   * @param y - Subject position, y.
   * @param z - Subject position, z.
   * @param travelX - Unit direction of travel, x.
   * @param travelZ - Unit direction of travel, z.
   * @param lead - How far ahead of the subject to centre, in world units.
   */
  private _streakCenter(x: number, y: number, z: number, travelX: number, travelZ: number, lead: number): void {
    const p = this._klipp!.shot.position;
    const effect = this.lens.effect;

    this._toCamera(x - p[0], y - p[1], z - p[2]);

    const onScreen = this._projectOnScreen();

    effect.clearRadius = onScreen ? SUBJECT_CLEAR : OPEN_CLEAR;

    if (!onScreen) {
      this._toCamera(x + travelX * lead - p[0], y - p[1], z + travelZ * lead - p[2]);

      if (!this._projectOnScreen()) {
        this._toCamera(travelX, 0, travelZ);
        if (_cam.z > 0) _cam.set(-_cam.x, -_cam.y, -_cam.z);
        if (!this._project(0.05)) _uv.set(0.5, 0.5, 0);
      }
    }

    effect.setCenter(clamp01(_uv.x), clamp01(_uv.y));
  }

  /** Like {@link NightLook._project}, and only true when the point lands inside the frame. */
  private _projectOnScreen(): boolean {
    return this._project(0.3) && _uv.x >= 0 && _uv.x <= 1 && _uv.y >= 0 && _uv.y <= 1;
  }

  /** Rotate a world-space offset into the camera's frame (looking down -z), into `_cam`. */
  private _toCamera(x: number, y: number, z: number): void {
    const q = this._klipp!.shot.quaternion;
    // The inverse rotation: the conjugate quaternion.
    const qx = -q[0];
    const qy = -q[1];
    const qz = -q[2];
    const qw = q[3];
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);

    _cam.set(x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx));
  }

  /**
   * Content UV (y down) of the camera-space point in `_cam`, into `_uv`.
   * @param minDepth - Points closer to the camera plane than this don't project.
   * @returns False when the point is behind or too near the lens.
   */
  private _project(minDepth: number): boolean {
    if (_cam.z > -minDepth) return false;

    const tanHalf = Math.tan(this._klipp!.shot.fov * DEG * 0.5);
    const depth = -_cam.z;

    _uv.set(0.5 + (_cam.x / (depth * tanHalf * this._aspect)) * 0.5, 0.5 - (_cam.y / (depth * tanHalf)) * 0.5, 0);

    return true;
  }
}
