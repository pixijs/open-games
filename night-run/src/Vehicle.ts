import type { RigidBody } from 'crashcat';
import { rigidBody } from 'crashcat';

import type { ControlsState } from './Controls';
import { clamp, lerp } from './MathUtils';
import type { PhysicsWorld } from './Physics';
import { TRUCK_BALL_RADIUS } from './Physics';
import type { TruckPose } from './race/truck';
import { angleDelta } from './race/truck';

const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 1.5;
/** Top speed while boosting, as a multiple of {@link MAX_SPEED}. */
const BOOST_FACTOR = 1.25;
/** Ground speed below which the direction of travel is the way the truck faces. */
const HEADING_SPEED = 0.3;

const _zero: [number, number, number] = [0, 0, 0];
const _spin: [number, number, number] = [0, 0, 0];
const _shove: [number, number, number] = [0, 0, 0];

function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

/**
 * The arcade driving model of a truck that's driven here, by a player or a bot: input turns a yaw and a target speed,
 * the speed spins a ball in the physics world, and the ball carries the truck. The body's pitch and roll and the
 * drift it reads as come from how the speed and steering change. Each frame it writes a {@link TruckPose}.
 */
export class Vehicle {
  public readonly body: RigidBody;

  public linearSpeed = 0;
  public angularSpeed = 0;
  public acceleration = 0;
  public yaw = 0;
  public inputX = 0;
  public inputZ = 0;
  public driftIntensity = 0;
  /** Multiplier on top speed; bots get a little more or less to keep the pack together. */
  public topSpeedScale = 1;

  /** Ball centre and velocity, as of the last update. */
  public readonly spherePos = { x: 0, y: 0, z: 0 };
  public readonly sphereVel = { x: 0, y: 0, z: 0 };

  private readonly _physics: PhysicsWorld;
  private _bodyPitch = 0;
  private _bodyRoll = 0;
  private _boostTime = 0;

  /**
   * @param physics - The world the ball lives in.
   * @param body - Its dynamic ball, from {@link PhysicsWorld.addTruckBall}.
   */
  constructor(physics: PhysicsWorld, body: RigidBody) {
    this._physics = physics;
    this.body = body;

    const p = body.position;

    this.spherePos.x = p[0];
    this.spherePos.y = p[1];
    this.spherePos.z = p[2];
  }

  /** Whether a boost is firing. */
  public get boosting(): boolean {
    return this._boostTime > 0;
  }

  /**
   * Fire a boost: top speed rises for `seconds`, and the car surges toward it.
   * @param seconds - How long the boost lasts.
   */
  public boost(seconds: number): void {
    this._boostTime = Math.max(this._boostTime, seconds);
  }

  /**
   * Put the truck somewhere at rest, as on the grid or back on the track.
   * @param x - Root position, x.
   * @param y - Root position, y: the ground under it.
   * @param z - Root position, z.
   * @param yaw - Facing.
   */
  public place(x: number, y: number, z: number, yaw: number): void {
    this._physics.teleport(this.body, x, y + TRUCK_BALL_RADIUS, z);
    this.spherePos.x = x;
    this.spherePos.y = y + TRUCK_BALL_RADIUS;
    this.spherePos.z = z;
    this.sphereVel.x = this.sphereVel.y = this.sphereVel.z = 0;
    this.yaw = yaw;
    this.linearSpeed = 0;
    this.angularSpeed = 0;
    this.acceleration = 0;
    this.driftIntensity = 0;
    this._bodyPitch = 0;
    this._bodyRoll = 0;
    this._boostTime = 0;
  }

  /**
   * Drive one step: before the physics step, so the ball rolls under this frame's input.
   * @param dt - Game seconds since the last step.
   * @param input - Stick and throttle.
   */
  public drive(dt: number, input: ControlsState): void {
    this.inputX = input.x;
    this.inputZ = input.z;

    const top = MAX_SPEED * this.topSpeedScale;

    if (input.touchActive && (this.inputX !== 0 || this.inputZ !== 0)) {
      const targetAngle = Math.atan2(this.inputX, this.inputZ);
      const slerpT = 1 - Math.exp(-3 * dt);

      this.yaw = lerpAngle(this.yaw, targetAngle, slerpT);

      const cross = Math.sin(this.yaw) * this.inputZ - Math.cos(this.yaw) * this.inputX;

      this.inputX = clamp(-cross * 2, -1, 1);
      this.linearSpeed = lerp(this.linearSpeed, top, dt * 1.5);
    } else {
      let direction = Math.sign(this.linearSpeed);

      if (direction === 0) direction = Math.abs(this.inputZ) > 0.1 ? Math.sign(this.inputZ) : 1;

      const steeringGrip = clamp(Math.abs(this.linearSpeed), 0.2, 1.0);
      const targetAngular = -this.inputX * steeringGrip * 4 * direction;

      this.angularSpeed = lerp(this.angularSpeed, targetAngular, dt * 4);
      this.yaw += this.angularSpeed * dt;

      const targetSpeed = this.inputZ;

      if (targetSpeed < 0 && this.linearSpeed > 0.01) {
        this.linearSpeed = lerp(this.linearSpeed, 0, dt * 8);
      } else if (targetSpeed < 0) {
        this.linearSpeed = lerp(this.linearSpeed, targetSpeed / 2, dt * 2);
      } else {
        this.linearSpeed = lerp(this.linearSpeed, targetSpeed * top, dt * 1.5);
      }
    }

    if (this._boostTime > 0) {
      this._boostTime -= dt;
      this.linearSpeed = Math.max(this.linearSpeed, lerp(this.linearSpeed, top * BOOST_FACTOR, dt * 6));
    }

    this.linearSpeed *= Math.max(0, 1 - LINEAR_DAMP * dt);

    // Spin the ball about the truck's right axis, world-X turned by the yaw.
    const drive = this.linearSpeed * 100 * dt;
    const angvel = this.body.motionProperties.angularVelocity;

    _spin[0] = angvel[0] + Math.cos(this.yaw) * drive;
    _spin[1] = angvel[1];
    _spin[2] = angvel[2] - Math.sin(this.yaw) * drive;
    rigidBody.setAngularVelocity(this._physics.world, this.body, _spin);
  }

  /**
   * Read the ball back after the physics step and settle the body.
   * @param dt - Game seconds since the last step.
   */
  public settle(dt: number): void {
    const p = this.body.position;
    const v = this.body.motionProperties.linearVelocity;

    this.spherePos.x = p[0];
    this.spherePos.y = p[1];
    this.spherePos.z = p[2];
    this.sphereVel.x = v[0];
    this.sphereVel.y = v[1];
    this.sphereVel.z = v[2];

    this.acceleration = lerp(
      this.acceleration,
      this.linearSpeed + 0.25 * this.linearSpeed * Math.abs(this.linearSpeed),
      dt,
    );
    this._bodyPitch = lerpAngle(this._bodyPitch, -(this.linearSpeed - this.acceleration) / 6, Math.min(1, dt * 10));
    this._bodyRoll = lerpAngle(this._bodyRoll, -(this.inputX / 5) * this.linearSpeed, Math.min(1, dt * 5));
    this.driftIntensity = Math.abs(this.linearSpeed - this.acceleration) + Math.abs(this._bodyRoll) * 2;
  }

  /**
   * Knock the ball sideways, as a hit from a truck driven on another screen does.
   * @param dx - Change of velocity, x, m/s.
   * @param dz - Change of velocity, z, m/s.
   */
  public shove(dx: number, dz: number): void {
    const v = this.body.motionProperties.linearVelocity;

    _shove[0] = v[0] + dx;
    _shove[1] = v[1];
    _shove[2] = v[2] + dz;
    rigidBody.setLinearVelocity(this._physics.world, this.body, _shove);
  }

  /** Stop the ball dead where it is, as at the end of a race. */
  public halt(): void {
    rigidBody.setLinearVelocity(this._physics.world, this.body, _zero);
    rigidBody.setAngularVelocity(this._physics.world, this.body, _zero);
    this.linearSpeed = 0;
    this.angularSpeed = 0;
  }

  /**
   * Write this frame's pose.
   * @param out - Receives the pose.
   * @param charge - The drift charge's stage, 0 to 3.
   */
  public writePose(out: TruckPose, charge: number): void {
    const v = this.sphereVel;
    const ground = Math.hypot(v.x, v.z);

    out.x = this.spherePos.x;
    out.y = this.spherePos.y - TRUCK_BALL_RADIUS;
    out.z = this.spherePos.z;
    out.yaw = this.yaw;
    out.pitch = this._bodyPitch;
    out.roll = this._bodyRoll;
    out.speed = ground;
    out.heading = ground > HEADING_SPEED ? Math.atan2(v.x, v.z) : this.yaw;
    out.steer = this.inputX;
    out.throttle = this.inputZ;
    out.drift = this.driftIntensity;
    out.charge = charge;
    out.boosting = this._boostTime > 0;
  }
}
