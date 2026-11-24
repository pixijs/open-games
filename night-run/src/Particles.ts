import type { Container3D, PointData3D } from '@pixi/3d';
import { Vector3 } from '@pixi/3d';
import type { ParticleSpawnOverrides } from '@pixi/3d/extras';
import { BoxShape, ConeShape, SphereShape } from '@pixi/3d/extras';
import type { Ticker } from 'pixi.js';
import { Texture } from 'pixi.js';

import { CHARGE_COLORS } from './DriftBoost';
import { FxParticles } from './FxParticles';
import type { TruckPose } from './race/truck';
import { EXHAUST_LOCAL, truckPoint, WHEEL_LOCAL } from './race/truck';

// Sizes are matched to the racer this demo was ported from, whose point
// sprites had a pixel size decoupled from the field of view. Pixi3D particles
// are world-space diameters, so the base size is tan(fov/2) at the racing
// camera's 40°: the same pixel footprint, with proper FOV behaviour on top.
const BASE_SIZE = Math.tan((40 * Math.PI) / 180 / 2); // ≈ 0.364

const EMIT_THRESHOLD = 0.9;
const PER_WHEEL = 2;
const Y_OFFSET = 0.05;

const CONFETTI_COLORS = [0xff5a5f, 0xffc93c, 0x4fc3ff, 0x6ee26e, 0xe070ff, 0xffffff];

const _wheelPos = new Vector3();
const _velMin = new Vector3();
const _velMax = new Vector3();
const _velocity: readonly [Vector3, Vector3] = [_velMin, _velMax];
/** Spawn overrides refilled per call, so emitting allocates nothing. */
const _atWheel: ParticleSpawnOverrides = { position: _wheelPos };
const _withVelocity: ParticleSpawnOverrides = { position: _wheelPos, velocity: _velocity, color: 0xffffff };
const _flame: ParticleSpawnOverrides = { position: _wheelPos, velocity: _velocity };

/**
 * A round sprite drawn once on a canvas, for sparks and flames.
 * @param hot - A solid core with a short falloff, so an additive spark reads as a hot point rather than a soft orb,
 *   and a faint halo doesn't tint whatever is behind it.
 */
export function createGlowTexture(hot = false): Texture {
  const canvas = document.createElement('canvas');

  canvas.width = canvas.height = 32;

  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);

  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(hot ? 0.22 : 0.3, `rgba(255,255,255,${hot ? 1 : 0.85})`);
  if (hot) {
    gradient.addColorStop(0.42, 'rgba(255,255,255,0.3)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,0.04)');
  }
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);

  return Texture.from(canvas);
}

/**
 * Write a velocity box into the shared pair: `base` plus a random spread on each axis.
 * @param bx - Base velocity, x.
 * @param by - Base velocity, y.
 * @param bz - Base velocity, z.
 * @param spread - Horizontal spread either side.
 * @param upMin - Lowest upward kick.
 * @param upMax - Highest upward kick.
 */
function velocityBox(bx: number, by: number, bz: number, spread: number, upMin: number, upMax: number) {
  _velMin.set(bx - spread, by + upMin, bz - spread);
  _velMax.set(bx + spread, by + upMax, bz + spread);

  return _velocity;
}

/**
 * Every particle effect on the trucks, one {@link ParticleSystem3D} each shared by all of them, so four trucks cost
 * the same four draw calls as one, all driven from the game loop so slow motion slows them too:
 *
 * - smoke from the rear wheels while sliding
 * - additive sparks: drift-charge sparks that thicken as the charge builds and turn purple once the ultra boost is
 *   ready, and bursts where a truck hits a wall or another truck
 * - boost flames from the exhaust
 * - confetti from the finish arch on a new best lap
 *
 * Call {@link CarEffects.emit} for each truck, then {@link CarEffects.update} once.
 */
export class CarEffects {
  private readonly _glow: Texture;
  private readonly _smoke: FxParticles;
  private readonly _sparks: FxParticles;
  private readonly _flames: FxParticles;
  private readonly _confetti: FxParticles;

  constructor(parent: Container3D, smokeTexture: Texture) {
    this._glow = createGlowTexture();

    this._smoke = new FxParticles(
      {
        texture: smokeTexture,
        capacity: 2400,
        shape: new ConeShape({ angle: 25, radius: 0.09 }),
        life: 2.5,
        speed: [0.5, 1],
        size: [BASE_SIZE * 0.25, BASE_SIZE * 0.5],
        sizeEnd: [BASE_SIZE * 1.5, BASE_SIZE * 3],
        alpha: 0.18,
        alphaEnd: 0,
        // Cool grey under the floodlights.
        color: 0xc8ccd4,
        drag: 1,
      },
      2.5,
    );

    this._sparks = new FxParticles(
      {
        texture: this._glow,
        capacity: 1600,
        blendMode: 'add',
        shape: new SphereShape({ radius: 0.06 }),
        life: [0.18, 0.45],
        size: [0.07, 0.13],
        sizeEnd: 0.02,
        alphaEnd: 0.2,
        gravity: 14,
        drag: 1.2,
      },
      0.45,
    );

    this._flames = new FxParticles(
      {
        texture: this._glow,
        capacity: 800,
        blendMode: 'add',
        shape: new SphereShape({ radius: 0.05 }),
        life: [0.12, 0.26],
        size: [0.32, 0.45],
        sizeEnd: 0.06,
        alpha: 0.9,
        alphaEnd: 0,
        color: 0xffd36b,
        colorEnd: 0xff3d1f,
        drag: 3,
      },
      0.26,
    );

    this._confetti = new FxParticles(
      {
        capacity: 600,
        shape: new BoxShape({ width: 5, height: 0.2, depth: 0.6 }),
        life: [2.2, 3.2],
        size: [0.12, 0.2],
        spin: [-9, 9],
        startRotation: [0, Math.PI],
        gravity: 3.2,
        drag: 1.6,
        alphaEnd: 0,
      },
      3.2,
    );

    parent.addChild(this._smoke, this._sparks, this._flames, this._confetti);
  }

  /**
   * Spray sparks at a hit, back off whatever was hit and up.
   * @param position - Contact point.
   * @param nx - Normal pointing back toward the truck, x.
   * @param nz - Normal pointing back toward the truck, z.
   * @param strength - Impact speed; more speed, more sparks.
   */
  public impactSparks(position: PointData3D, nx: number, nz: number, strength: number): void {
    const count = Math.min(80, 12 + Math.round(strength * 8));

    this._sparks.spawn(count, {
      position,
      velocity: velocityBox(nx * 3, 0, nz * 3, 2.6, 1.2, 4.5),
      color: 0xffb347,
    });
  }

  /**
   * A puff of confetti in one colour, as a truck takes a new paint job.
   * @param position - Where it bursts from.
   * @param color - Its colour.
   */
  public colorBurst(position: PointData3D, color: number): void {
    this._confetti.spawn(36, { position, velocity: velocityBox(0, 0, 0, 2.4, 1.4, 4.2), color });
  }

  /** Confetti from the top of the finish arch. */
  public confetti(position: PointData3D): void {
    for (let i = 0; i < CONFETTI_COLORS.length; i++) {
      this._confetti.spawn(40, {
        position,
        velocity: velocityBox(0, 0, 0, 3.5, 1.5, 6),
        color: CONFETTI_COLORS[i],
      });
    }
  }

  /**
   * One truck's smoke, charge sparks and boost flame this frame.
   * @param pose - The truck.
   */
  public emit(pose: Readonly<TruckPose>): void {
    const fx = Math.sin(pose.yaw);
    const fz = Math.cos(pose.yaw);
    const sliding = pose.drift > EMIT_THRESHOLD && pose.speed > 1;
    const charged = pose.charge > 0;

    if (sliding || charged) {
      for (let w = 2; w < 4; w++) {
        const wheel = WHEEL_LOCAL[w];

        truckPoint(pose, wheel[0], 0, wheel[2], _wheelPos);
        _wheelPos.y = pose.y + Y_OFFSET;

        if (sliding) this._smoke.spawn(PER_WHEEL, _atWheel);

        if (charged) {
          velocityBox(-fx * 2.5, 0, -fz * 2.5, 1.4, 1, 2.4 + pose.charge * 0.6);
          _withVelocity.color = CHARGE_COLORS[pose.charge];
          this._sparks.spawn(pose.charge, _withVelocity);
        }
      }
    }

    if (pose.boosting) {
      truckPoint(pose, EXHAUST_LOCAL[0], EXHAUST_LOCAL[1], EXHAUST_LOCAL[2], _wheelPos);
      velocityBox(-fx * 5, 0, -fz * 5, 0.5, 0, 0.6);
      this._flames.spawn(3, _flame);
    }
  }

  /**
   * Advance every system one step.
   * @param ticker - Game-time step; slow motion shortens its `deltaMS`.
   */
  public update(ticker: Ticker): void {
    this._smoke.update(ticker);
    this._sparks.update(ticker);
    this._flames.update(ticker);
    this._confetti.update(ticker);
  }

  /** Kill every particle, as when a new race starts. */
  public clear(): void {
    this._smoke.clear();
    this._sparks.clear();
    this._flames.clear();
    this._confetti.clear();
  }

  /** Release every system and the glow sprite. */
  public destroy(): void {
    this._smoke.destroy();
    this._sparks.destroy();
    this._flames.destroy();
    this._confetti.destroy();
    this._glow.destroy(true);
  }
}
