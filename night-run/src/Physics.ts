import type { Listener, RigidBody, World } from 'crashcat';
import {
  addBroadphaseLayer,
  addObjectLayer,
  box,
  createWorld,
  createWorldSettings,
  enableCollision,
  MotionQuality,
  MotionType,
  registerAll,
  rigidBody,
  sphere,
  updateWorld,
} from 'crashcat';

let _registered = false;

export interface WallSpec {
  halfExtents: [number, number, number];
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/** Radius of the ball every truck rides on. */
export const TRUCK_BALL_RADIUS = 0.5;

const _identity: [number, number, number, number] = [0, 0, 0, 1];
const _target: [number, number, number] = [0, 0, 0];

/**
 * The crashcat world: the ground, the walls, and one ball per truck. A driven truck's ball is dynamic and rolls under
 * its throttle; a remote truck's is kinematic, moved to wherever the network says it is, so a driven truck bumps into
 * it but can't shove it.
 */
export class PhysicsWorld {
  public readonly world: World;
  public readonly OL_STATIC: number;
  private readonly _olMoving: number;
  /** The ground and the walls, kept so another track's can replace them. */
  private readonly _statics: RigidBody[] = [];
  /** Receives contacts during {@link PhysicsWorld.step}. */
  public listener: Listener | undefined = undefined;

  constructor() {
    if (!_registered) {
      registerAll();
      _registered = true;
    }

    const settings = createWorldSettings();

    settings.gravity = [0, -9.81, 0];

    const BPL_MOVING = addBroadphaseLayer(settings);
    const BPL_STATIC = addBroadphaseLayer(settings);
    const OL_MOVING = addObjectLayer(settings, BPL_MOVING);
    const OL_STATIC = addObjectLayer(settings, BPL_STATIC);

    enableCollision(settings, OL_MOVING, OL_STATIC);
    enableCollision(settings, OL_MOVING, OL_MOVING);

    this.world = createWorld(settings);
    this.OL_STATIC = OL_STATIC;
    this._olMoving = OL_MOVING;
  }

  /**
   * Add a truck's ball.
   * @param x - Ball centre, x.
   * @param y - Ball centre, y.
   * @param z - Ball centre, z.
   * @param kinematic - Moved by hand rather than simulated, for a truck driven elsewhere.
   * @param userData - Whatever identifies the truck in contact callbacks.
   * @returns The body; remove it with {@link PhysicsWorld.removeBody}.
   */
  public addTruckBall(x: number, y: number, z: number, kinematic: boolean, userData: unknown): RigidBody {
    return rigidBody.create(this.world, {
      shape: sphere.create({ radius: TRUCK_BALL_RADIUS }),
      motionType: kinematic ? MotionType.KINEMATIC : MotionType.DYNAMIC,
      objectLayer: this._olMoving,
      position: [x, y, z],
      mass: 1000.0,
      friction: 5.0,
      restitution: 0.1,
      linearDamping: 0.1,
      angularDamping: 4.0,
      gravityFactor: 1.5,
      motionQuality: MotionQuality.LINEAR_CAST,
      allowSleeping: false,
      userData,
    });
  }

  /**
   * Move a kinematic ball to a point over the next step, so it has the velocity to push what it meets.
   * @param body - A ball from {@link PhysicsWorld.addTruckBall} with `kinematic` set.
   * @param x - Target centre, x.
   * @param y - Target centre, y.
   * @param z - Target centre, z.
   * @param dt - Seconds the move takes; the next step's.
   */
  public moveKinematic(body: RigidBody, x: number, y: number, z: number, dt: number): void {
    _target[0] = x;
    _target[1] = y;
    _target[2] = z;

    if (dt > 0) rigidBody.moveKinematic(body, _target, _identity, dt);
    else rigidBody.setPosition(this.world, body, _target, false);
  }

  /**
   * Put a ball somewhere at rest.
   * @param body - The ball.
   * @param x - Centre, x.
   * @param y - Centre, y.
   * @param z - Centre, z.
   */
  public teleport(body: RigidBody, x: number, y: number, z: number): void {
    _target[0] = x;
    _target[1] = y;
    _target[2] = z;
    rigidBody.setPosition(this.world, body, _target, true);
    _target[0] = _target[1] = _target[2] = 0;
    rigidBody.setLinearVelocity(this.world, body, _target);
    rigidBody.setAngularVelocity(this.world, body, _target);
  }

  public removeBody(body: RigidBody): void {
    rigidBody.remove(this.world, body);
  }

  /**
   * Add the ground slab a track's trucks roll on.
   * @param position - Its centre.
   * @param halfExtents - Half its size on each axis.
   * @returns The body; {@link PhysicsWorld.clearStatics} removes it.
   */
  public addStaticGround(position: [number, number, number], halfExtents: [number, number, number]): RigidBody {
    return this._addStatic(
      rigidBody.create(this.world, {
        shape: box.create({ halfExtents }),
        motionType: MotionType.STATIC,
        objectLayer: this.OL_STATIC,
        position,
        friction: 5.0,
        restitution: 0.0,
      }),
    );
  }

  /**
   * Add a wall.
   * @param spec - Its box.
   * @returns The body; {@link PhysicsWorld.clearStatics} removes it.
   */
  public addStaticBox(spec: WallSpec): RigidBody {
    return this._addStatic(
      rigidBody.create(this.world, {
        shape: box.create({ halfExtents: spec.halfExtents }),
        motionType: MotionType.STATIC,
        objectLayer: this.OL_STATIC,
        position: spec.position,
        quaternion: spec.quaternion,
        friction: 0.0,
        restitution: 0.1,
      }),
    );
  }

  /** How many static bodies there are: the ground and the walls. */
  public get staticCount(): number {
    return this._statics.length;
  }

  /** Remove the ground and every wall, so another track's can go in; the trucks' balls stay. */
  public clearStatics(): void {
    const statics = this._statics;

    // Last in, first out, so the world hands the same body slots back in the same order when they're added again.
    for (let i = statics.length - 1; i >= 0; i--) rigidBody.remove(this.world, statics[i]);

    statics.length = 0;
  }

  public step(dt: number): void {
    updateWorld(this.world, this.listener, dt);
  }

  private _addStatic(body: RigidBody): RigidBody {
    this._statics.push(body);

    return body;
  }
}
