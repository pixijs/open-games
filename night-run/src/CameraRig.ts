import type {
  CameraPiece,
  CameraState,
  ClearShotCandidate,
  CustomBlend,
  DebugZone,
  VirtualCamera,
} from '@kvvasuu/klipp';
import {
  BasicMultiChannelPerlinNoise,
  BlendCurves,
  BlendHints,
  ClearShot,
  copyCameraState,
  createCameraState,
  createTargetPose,
  HardLockToTargetBody,
  ImpulseField,
  ImpulseListenerNoise,
  LensExtension,
  updateHardLookAt,
} from '@kvvasuu/klipp';
import { DebugOverlay } from '@kvvasuu/klipp/dom';
import type { Camera3D, View3D } from '@pixi/3d';
import { Vector3 } from '@pixi/3d';
import { Point } from 'pixi.js';

import { ChaseBody } from './ChaseBody';
import { DIORAMA_FOV, DIORAMA_OFFSET, DioramaBody } from './DioramaBody';
import { lookToFrame } from './framing';
import { KlippPixi } from './KlippPixi';
import { clamp, smoothstep } from './MathUtils';
import type { Occluders } from './Occluders';
import type { CourseView } from './race/course';
import { FINISH_LINE } from './race/route';
import type { TruckPose } from './race/truck';
import { BASE_TV_SPOTS } from './track/base';

/** The player-selectable shots; `C` cycles through them. */
export type CameraMode = 'iso' | 'chase' | 'tv';

/** Every player-selectable shot, in `C` order, starting from the one a race opens on until the player picks another. */
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'iso', 'tv'];

/** The HUD's name for every race camera, keyed by its klipp name. */
export const CAMERA_LABELS: Readonly<Record<string, string>> = {
  iso: 'Diorama',
  chase: 'Chase',
  tv: 'Trackside',
  finish: 'Photo finish',
};

// Arbitration: the highest active priority is on screen.
const FINISH_PRIORITY = 50;
const SELECTED_PRIORITY = 20;
const STANDBY_PRIORITY = 10;

const CHASE_FOV = 56;
/** Where the race camera the player last picked is kept between visits. */
const MODE_KEY = 'nightrun:camera';
/**
 * Impulse channels: hits reach every camera that shakes, a boost's jolt only the chase, so the diorama holds still
 * through a boost.
 */
const HIT_CHANNEL = 1;
const BOOST_CHANNEL = 2;
/** How much a hit shakes the diorama, against the chase's full shake. */
const ISO_HIT_GAIN = 0.35;

/**
 * A trackside camera whose sight line to the truck passes this close to scenery counts as blocked, and as this many
 * metres further away than it is.
 */
const TV_SIGHT_PAD = 0.35;
const TV_BLOCKED = 60;
/** World radius a trackside camera keeps in frame, so the lens zooms as the car gets further away. */
const TV_FRAME_RADIUS = 3.8;
/**
 * The photo finish keeps this much of the world either side of the truck in frame, widening from a telephoto as the
 * truck races up to the lens, and across the screen too on a tall phone, so the truck never overfills its narrow frame.
 */
const FINISH_FRAME_RADIUS = 1.5;
/**
 * Screen heights in CSS px between which the chase raises its truck clear of the touch stick and speed dial: not at all
 * from {@link SHORT_FROM} up, fully from {@link SHORT_FULL} down.
 */
const SHORT_FROM = 480;
const SHORT_FULL = 400;
/** Where the photo finish puts the truck down the screen: below the finish callout in the middle. */
const FINISH_DOWN = 0.68;

/**
 * A kick's envelope over its duration: out over the first fifth and back over the rest, both eased, so the lens's speed
 * never jumps from one frame to the next. Klipp's own shapes ramp linearly, which starts and stops the lens dead.
 */
function kickShape(t: number): number {
  return t < 0.2 ? smoothstep(t / 0.2) : 1 - smoothstep((t - 0.2) / 0.8);
}

const _focusPoint = new Vector3();
const _screen = new Point();
const _zero: [number, number, number] = [0, 0, 0];
const _impulsePos: [number, number, number] = [0, 0, 0];
const _impulseDir: [number, number, number] = [0, 0, 0];
const _impulse = {
  position: _impulsePos,
  direction: _impulseDir,
  shape: kickShape,
  duration: 0,
  radius: 25,
  dissipationDistance: 40,
  channel: HIT_CHANNEL,
};
const _crosshair: [number, number] = [0, 0];
const _finishLook: [number, number, number] = [0, 0, 0];
const _noZones: readonly DebugZone[] = [];

/** A camera state that sits at `position` and looks at `lookAt`. */
function shotAt(position: readonly number[], lookAt: readonly number[], fov: number): CameraState {
  const state = createCameraState();

  state.position[0] = position[0];
  state.position[1] = position[1];
  state.position[2] = position[2];
  state.fov = fov;
  updateHardLookAt(state, [lookAt[0], lookAt[1], lookAt[2]]);

  return state;
}

/**
 * Every race camera, run by one {@link KlippPixi} that the staging shots (`StageCameras`) share.
 *
 * Four virtual cameras compete on priority and Klipp blends between whichever wins:
 *
 * - `iso`: the original racer's follow camera, a {@link DioramaBody} at a fixed high three-quarter angle with lead and
 *   a dead zone; it holds still through speed, slides and boosts, and only a hit shakes it a little
 * - `chase`: a {@link ChaseBody} on an arm behind the truck that trails along the road and sees past the scenery
 * - `tv`: broadcast crane cams, a {@link ClearShot} cutting to the closest with a clear view, zooming to keep the car
 *   framed
 * - `finish`: a low telephoto shot by the line as the player takes the flag
 *
 * On the chase, speed widens the lens ({@link LensExtension}), engine and drift rumble it
 * ({@link BasicMultiChannelPerlinNoise}), and boosts kick it; wall hits kick every camera through a shared
 * {@link ImpulseField}.
 */
export class CameraRig {
  public readonly klipp: KlippPixi;
  public readonly impulses = new ImpulseField();
  /** The scenery the cameras see past; the staging shots use it too. */
  public readonly occluders: Occluders;

  /** The player's selected shot, live whenever no finish shot or staging shot outranks it. */
  public mode: CameraMode = readMode();

  private readonly _view: View3D;
  private readonly _car = createTargetPose();
  private readonly _finishSpot = createTargetPose();

  public readonly iso: VirtualCamera;
  public readonly chase: VirtualCamera;
  public readonly tv: VirtualCamera;
  public readonly finish: VirtualCamera;

  private readonly _isoBody = new DioramaBody();
  private readonly _chaseBody: ChaseBody;
  private readonly _chaseLens = new LensExtension({ fov: CHASE_FOV, fovDamping: 0.3 });
  private readonly _finishLens = new LensExtension({ fov: 30 });
  private readonly _chaseRumble = new BasicMultiChannelPerlinNoise({
    rotationAmplitude: [0.35, 0.25, 0.55],
    rotationFrequency: [9, 7, 5],
    amplitudeGain: 0,
    amplitudeDamping: 0.25,
  });

  /** The crane cams, and the evaluator that cuts between them; both are made again for each track's cranes. */
  private _tvShots: ClearShotCandidate[];
  private _clearShot: ClearShot;
  /** Blend overrides: the game's own, plus any added through {@link addCustomBlends}. */
  private readonly _blends: CustomBlend[] = [
    { to: 'tv', blend: { curve: BlendCurves.cut, time: 0 } },
    // The start shot looks up the straight from behind the truck, the diorama back across it from high on the far
    // side: a blend between them would whip the lens round half a turn.
    { from: 'start', to: 'iso', blend: { curve: BlendCurves.cut, time: 0 } },
    { from: 'tv', blend: { curve: BlendCurves.cubicOut, time: 0.7 } },
    // A blend would sweep the lens from under the arch, through the finish's confetti, down to the road.
    { to: 'finish', blend: { curve: BlendCurves.cut, time: 0 } },
    { from: 'finish', blend: { curve: BlendCurves.easeInOut, time: 1.1 } },
  ];

  private _finishTime = 0;
  private _boostKick = 0;
  private _chaseFov = CHASE_FOV;
  private _debug: DebugOverlay | null = null;

  /**
   * @param view - The view whose camera the rig drives.
   * @param occluders - The scenery the cameras see past; the track and the set fill it after.
   * @param course - The track, whose road the chase follows.
   */
  constructor(view: View3D, occluders: Occluders, course: CourseView) {
    this._view = view;
    this.occluders = occluders;

    const camera: Camera3D = view.camera;

    camera.fov = DIORAMA_FOV;
    camera.near = 0.1;
    camera.far = 200;

    this._car.extent.radius = 1;

    this.klipp = new KlippPixi(camera, {
      defaultBlend: { curve: BlendCurves.easeInOut, time: 0.9 },
      customBlends: this._blends,
    });

    // -- iso: the diorama camera. A fixed rotation; the body slides the lens over the ground after the truck.
    const isoRotation = shotAt(DIORAMA_OFFSET, _zero, DIORAMA_FOV).quaternion;

    this.iso = this.klipp.addCamera('iso', {
      priority: STANDBY_PRIORITY,
      hints: BlendHints.sphericalPosition,
      initialState: { fov: DIORAMA_FOV, quaternion: isoRotation },
    });
    this.iso.body = this._isoBody;
    this.iso.aim = fixedAim(isoRotation, this._car.position);
    this.iso.addNoise(this._impactListener(ISO_HIT_GAIN, HIT_CHANNEL));

    // -- chase: behind and above, trailing along the road through corners; it aims itself.
    this.chase = this.klipp.addCamera('chase', {
      priority: STANDBY_PRIORITY,
      hints: BlendHints.sphericalPosition,
      initialState: { fov: CHASE_FOV },
    });
    this._chaseBody = new ChaseBody(occluders, course);
    this.chase.body = this._chaseBody;
    this.chase.addExtension(this._chaseLens);
    this.chase.addNoise(this._chaseRumble);
    this.chase.addNoise(this._impactListener(1, HIT_CHANNEL | BOOST_CHANNEL));

    // -- tv: crane cams that cut to whichever is closest and zoom to keep the car the same size.
    this._tvShots = tvShots(BASE_TV_SPOTS);
    this._clearShot = this._cutter();

    const tvHandheld = new BasicMultiChannelPerlinNoise({
      rotationAmplitude: [0.35, 0.45, 0.15],
      rotationFrequency: [0.6, 0.5, 0.3],
    });

    this.tv = this.klipp.addCamera('tv', { priority: STANDBY_PRIORITY });
    this.tv.body = {
      update: (out, dt, justActivated) => {
        for (const shot of this._tvShots) {
          updateHardLookAt(shot.state, this._car.position);
          shot.state.fov = telephotoFov(distanceTo(shot.state, this._car.position));
        }

        copyCameraState(out, this._clearShot.tick(dt));
        tvHandheld.update(out, dt, justActivated);
      },
    };

    // -- finish: dropped beside the track ahead of the car, telephoto, as it crosses the line.
    this.finish = this.klipp.addCamera('finish', { priority: FINISH_PRIORITY, active: false });
    this.finish.body = new HardLockToTargetBody(this._finishSpot);
    this.finish.aim = {
      update: (out) => {
        const p = out.position;
        const car = this._car.position;

        updateHardLookAt(
          out,
          lookToFrame(_finishLook, p[0], p[1], p[2], car[0], car[1], car[2], FINISH_DOWN, this._finishLens.fov ?? 30),
        );
      },
    };
    this.finish.addExtension(this._finishLens);
    this.finish.addNoise(this._impactListener(0.5, HIT_CHANNEL));
    this.setMode(this.mode);
  }

  /**
   * Put the crane cams where a track's cranes stand. Only the evaluator is made again; the trackside camera reads it
   * each frame.
   * @param spots - Each crane's position, x, y and z.
   */
  public setTvSpots(spots: readonly (readonly [number, number, number])[]): void {
    this._tvShots = tvShots(spots);
    this._clearShot = this._cutter();
  }

  /** The chase's lens this frame, in degrees of vertical field of view. */
  public get chaseFov(): number {
    return this._chaseFov;
  }

  /**
   * Run the chase camera's body into another shot's state, so that shot can hand over to the chase by matching it and
   * cutting: the chase then carries on from where this left it.
   * @param out - Receives the chase's pose.
   * @param dt - Seconds since the last frame.
   */
  public chaseInto(out: CameraState, dt: number): void {
    this._chaseBody.update(out, dt);
  }

  /** Name of the virtual camera Klipp is heading to. */
  public get activeCamera(): string | null {
    return this.klipp.activeCameraId;
  }

  /** The crane cam the trackside camera has cut to, e.g. `cam-3`. */
  public get tvShot(): string | null {
    return this._clearShot.liveCameraId;
  }

  /**
   * Switch the race cameras on or off. Staging shots turn them off so only theirs run; turning them back on primes
   * them fresh on the truck, and Klipp blends over from whatever is on screen.
   * @param active - Whether the race cameras take part.
   */
  public setGameActive(active: boolean): void {
    this.iso.active = active;
    this.chase.active = active;
    this.tv.active = active;

    if (!active) {
      this.finish.active = false;
      this._finishTime = 0;
    }
  }

  /**
   * Add blend overrides after the game's own; Klipp picks the most specific match for each transition.
   * @param blends - Overrides to add.
   */
  public addCustomBlends(blends: readonly CustomBlend[]): void {
    this._blends.push(...blends);
    this.klipp.setCustomBlends(this._blends);
  }

  /** Select the next player shot, and keep it for the next race and the next visit. */
  public cycleMode(): void {
    this.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length]);

    try {
      localStorage.setItem(MODE_KEY, this.mode);
    } catch {
      // Without storage the pick lasts until the page closes.
    }
  }

  public setMode(mode: CameraMode): void {
    this.mode = mode;
    this.iso.priority = mode === 'iso' ? SELECTED_PRIORITY : STANDBY_PRIORITY;
    this.chase.priority = mode === 'chase' ? SELECTED_PRIORITY : STANDBY_PRIORITY;
    this.tv.priority = mode === 'tv' ? SELECTED_PRIORITY : STANDBY_PRIORITY;
  }

  /**
   * Cut to the photo-finish shot for `seconds` of real time: a low camera just past the line, on the other side of the
   * track from the truck, so the truck races toward it and by.
   * @param subject - Truck crossing the line.
   * @param seconds - How long to hold the shot.
   */
  public playFinish(subject: Readonly<TruckPose>, seconds: number): void {
    // The line runs across +z; the driver's right there is -x.
    const side = subject.x - FINISH_LINE.x < 0 ? -2.4 : 2.4;
    const spot = this._finishSpot.position;

    spot[0] = FINISH_LINE.x - side;
    spot[1] = 0.25;
    spot[2] = FINISH_LINE.z + 8;

    this._finishTime = seconds;
    this.finish.active = true;
  }

  /**
   * Shake the cameras from a world-space hit.
   * @param x - Hit position, x.
   * @param y - Hit position, y.
   * @param z - Hit position, z.
   * @param dx - Kick direction, x; its length is the kick in world units.
   * @param dy - Kick direction, y.
   * @param dz - Kick direction, z.
   * @param duration - Seconds the kick lasts.
   */
  public impact(x: number, y: number, z: number, dx: number, dy: number, dz: number, duration: number): void {
    _impulsePos[0] = x;
    _impulsePos[1] = y;
    _impulsePos[2] = z;
    _impulseDir[0] = dx;
    _impulseDir[1] = dy;
    _impulseDir[2] = dz;
    _impulse.duration = duration;
    _impulse.channel = HIT_CHANNEL;
    this.impulses.generate(_impulse);
  }

  /**
   * A boost on the truck the cameras follow: the chase's lens punches wide and springs back through its damping, and
   * with the truck given, the chase jolts back along its heading. The diorama holds still.
   * @param amount - How hard, about 1 for a full boost.
   * @param pose - The boosting truck, for the jolt.
   */
  public boostKick(amount: number, pose: Readonly<TruckPose> | null = null): void {
    this._boostKick = Math.max(this._boostKick, amount);

    if (!pose) return;

    _impulsePos[0] = pose.x;
    _impulsePos[1] = pose.y;
    _impulsePos[2] = pose.z;
    _impulseDir[0] = -Math.sin(pose.yaw) * 0.3;
    _impulseDir[1] = 0;
    _impulseDir[2] = -Math.cos(pose.yaw) * 0.3;
    _impulse.duration = 0.4;
    _impulse.channel = BOOST_CHANNEL;
    this.impulses.generate(_impulse);
  }

  public resize(width: number, height: number): void {
    this.klipp.setSize(width, height);
  }

  /** Takes the race cameras off klipp and the framing overlay off the page. */
  public destroy(): void {
    this._debug?.disconnect();
    this._debug = null;
    this.klipp.remove(this.iso);
    this.klipp.remove(this.chase);
    this.klipp.remove(this.tv);
    this.klipp.remove(this.finish);
  }

  /** Toggle Klipp's DOM overlay: a crosshair on the truck the race cameras follow. */
  public toggleDebug(container: HTMLElement): void {
    if (this._debug) {
      this._debug.disconnect();
      this._debug = null;

      return;
    }

    this._debug = new DebugOverlay();
    this._debug.connect(container);
  }

  /**
   * Feed the truck the race cameras follow into the rig and advance Klipp one frame.
   * @param dt - Real seconds since last frame; the camera keeps real time through slow motion.
   * @param subject - The truck to follow, or null to hold the last one.
   * @param speed01 - Its speed, 0 at rest to 1 at top speed (more while boosting).
   * @param drift - Its drift intensity, 0 when gripping.
   */
  public update(dt: number, subject: Readonly<TruckPose> | null, speed01: number, drift: number): void {
    const car = this._car;

    if (subject) {
      const half = subject.yaw / 2;

      car.position[0] = subject.x;
      car.position[1] = subject.y + 0.35;
      car.position[2] = subject.z;
      car.rotation[0] = 0;
      car.rotation[1] = Math.sin(half);
      car.rotation[2] = 0;
      car.rotation[3] = Math.cos(half);
      car.hasRotation = true;
    }

    this._chaseBody.subject = subject ?? this._chaseBody.subject;
    this._isoBody.subject = subject ?? this._isoBody.subject;

    if (this._finishTime > 0) {
      this._finishTime -= dt;
      if (this._finishTime <= 0) this.finish.active = false;
    }

    this._boostKick *= Math.exp(-dt * 2.5);

    const sense = clamp(speed01, 0, 1.6);
    // 0 on landscape screens, 1 on a tall phone: portrait widens the lens and pulls the diorama back.
    const portrait = this.portrait;

    const aspect = this.klipp.height > 0 ? this.klipp.width / this.klipp.height : 16 / 9;

    this._isoBody.portrait = portrait;
    this._isoBody.aspect = aspect;
    this._chaseFov = CHASE_FOV + portrait * 14 + sense * 12 + this._boostKick * 14;
    this._chaseLens.fov = this._chaseFov;
    this._chaseBody.portrait = portrait;
    this._chaseBody.short = this.short;
    this._chaseBody.speed = Math.min(1, sense);
    this._chaseBody.fov = this._chaseFov;
    this._chaseBody.aspect = aspect;

    if (this.finish.active) {
      const spot = this._finishSpot.position;
      const reach = Math.hypot(spot[0] - car.position[0], spot[1] - car.position[1], spot[2] - car.position[2]);
      const aspect = this.klipp.height > 0 ? Math.min(1, this.klipp.width / this.klipp.height) : 1;

      this._finishLens.fov = clamp((2 * Math.atan(FINISH_FRAME_RADIUS / (reach * aspect)) * 180) / Math.PI, 18, 80);
    }
    this._chaseRumble.amplitudeGain = sense * sense * 0.8 + drift * 0.7 + this._boostKick;

    this.klipp.update(dt);

    if (this._debug) this._renderDebug();
  }

  /** 0 on landscape screens, 1 on a tall phone. */
  public get portrait(): number {
    const klipp = this.klipp;

    return klipp.height > 0 ? clamp((1.3 - klipp.width / klipp.height) / 0.85, 0, 1) : 0;
  }

  /** 0 on a screen taller than {@link SHORT_FROM} CSS px, 1 on one {@link SHORT_FULL} px tall or less: a landscape phone. */
  public get short(): number {
    const height = this.klipp.height;

    return height > 0 ? clamp((SHORT_FROM - height) / (SHORT_FROM - SHORT_FULL), 0, 1) : 0;
  }

  /**
   * A listener that turns impulses on `channels` into a kick plus a shake scaled by their strength. The shake only turns
   * the lens: a fast shake of its position would make it stutter along the track instead of jolt.
   */
  private _impactListener(gain: number, channels: number): ImpulseListenerNoise {
    return new ImpulseListenerNoise({
      field: this.impulses,
      channelMask: channels,
      gain,
      shake: new BasicMultiChannelPerlinNoise({
        rotationAmplitude: [1.4, 1.4, 2.4],
        rotationFrequency: [18, 16, 11],
      }),
    });
  }

  /** The trackside cut: the nearest crane whose sight line to the truck is clear of the scenery. */
  private _cutter(): ClearShot {
    return new ClearShot(this._tvShots, {
      evaluator: (shot) => {
        const car = this._car.position;
        const p = shot.state.position;
        const blocked = this.occluders.segmentHit(car[0], car[1], car[2], p[0], p[1], p[2], TV_SIGHT_PAD) < 1;

        return -distanceTo(shot.state, car) - (blocked ? TV_BLOCKED : 0);
      },
      defaultBlend: { curve: BlendCurves.cut, time: 0 },
      activateAfter: 0.2,
      minDuration: 1.4,
    });
  }

  /** A crosshair on klipp's overlay over the truck the race cameras follow. */
  private _renderDebug(): void {
    const focus = this._car.position;
    const screen = this._view.worldToScreen(_focusPoint.set(focus[0], focus[1], focus[2]), _screen);

    // A point near the camera plane projects far off screen; pin the crosshair to the frame edge.
    if (screen) {
      _crosshair[0] = clamp((screen.x / this.klipp.width) * 2 - 1, -1, 1);
      _crosshair[1] = clamp(1 - (screen.y / this.klipp.height) * 2, -1, 1);
    }

    this._debug?.render(_noZones, screen ? _crosshair : undefined);
  }
}

/**
 * A custom Aim: Klipp pieces are plain `{ update }` objects. Holds a fixed rotation, and publishes the
 * car as the look-at target so blends in and out of this camera keep it framed.
 */
function fixedAim(rotation: readonly number[], lookAt: readonly number[]): CameraPiece {
  return {
    update: (out) => {
      out.quaternion[0] = rotation[0];
      out.quaternion[1] = rotation[1];
      out.quaternion[2] = rotation[2];
      out.quaternion[3] = rotation[3];
      out.lookAtTarget[0] = lookAt[0];
      out.lookAtTarget[1] = lookAt[1];
      out.lookAtTarget[2] = lookAt[2];
      out.hasLookAtTarget = true;
    },
  };
}

/** The race camera the player picked last time, or the one a race opens on. */
function readMode(): CameraMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);

    return CAMERA_MODES.find((mode) => mode === stored) ?? CAMERA_MODES[0];
  } catch {
    return CAMERA_MODES[0];
  }
}

/** A crane cam per spot, named `cam-1` on. */
function tvShots(spots: readonly (readonly [number, number, number])[]): ClearShotCandidate[] {
  return spots.map((spot, i) => ({ cameraId: `cam-${i + 1}`, state: shotAt(spot, _zero, 30), priority: 0 }));
}

function distanceTo(state: CameraState, point: readonly number[]): number {
  const p = state.position;

  return Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]);
}

/** Vertical FOV that keeps a {@link TV_FRAME_RADIUS} sphere filling the frame at `distance`. */
function telephotoFov(distance: number): number {
  return clamp((2 * Math.atan(TV_FRAME_RADIUS / distance) * 180) / Math.PI, 12, 50);
}
