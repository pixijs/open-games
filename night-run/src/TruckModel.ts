import type { Scene3DSource } from '@pixi/3d';
import { Container3D, Model3D, Quaternion, Vector3 } from '@pixi/3d';

import type { TruckPose } from './race/truck';
import { angleDelta, WHEEL_RADIUS } from './race/truck';

/** The trucks' glTF scale. */
export const MODEL_SCALE = 0.5;
/** Height of the body node in the model, in model units. */
const BODY_REST_Y = 0.3;
/** Front wheels' angle at full lock, in radians. */
const STEER_ANGLE = 1 / 1.5;

const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _zAxis = new Vector3(0, 0, 1);
const _qSteer = new Quaternion();
const _qSpin = new Quaternion();
const _qAxis = new Quaternion();

/**
 * The first node in a model whose label is `name`, ignoring case.
 * @param root - Where to start searching.
 * @param name - Lowercase label to match.
 * @returns The node, or null.
 */
function findNamedNode(root: Container3D, name: string): Container3D | null {
  if (root.label?.toLowerCase() === name) return root;

  for (const child of root.children) {
    const found = findNamedNode(child, name);

    if (found) return found;
  }

  return null;
}

/**
 * The first node in a model whose label contains every needle, ignoring case.
 * @param root - Where to start searching.
 * @param needles - Lowercase fragments the label must contain.
 * @returns The node, or null.
 */
function findNodeContaining(root: Container3D, ...needles: string[]): Container3D | null {
  const lower = root.label?.toLowerCase() ?? '';

  if (needles.every((n) => lower.includes(n))) return root;

  for (const child of root.children) {
    const found = findNodeContaining(child, ...needles);

    if (found) return found;
  }

  return null;
}

/**
 * One truck as drawn: a clone of a truck GLB posed from a {@link TruckPose}. The root takes the position and yaw, the
 * body node pitches and rolls on its suspension, the front wheels steer and every wheel spins with the ground speed.
 * It knows nothing of physics, so a driven truck and a remote puppet look the same.
 */
export class TruckModel {
  /** Root node; a direct child of the scene root, so its transform is world. */
  public readonly root = new Container3D();
  /** The node that pitches and rolls; lamps hang off it. */
  public readonly body: Container3D;
  /** Wheels in front-left, front-right, back-left, back-right order; null where the model has none. */
  public readonly wheels: readonly (Container3D | null)[];

  private readonly _model: Model3D;
  private readonly _bodyRest = new Quaternion();
  private _spin = 0;
  private _steer = 0;

  /** @param source - The truck GLB. */
  constructor(source: Scene3DSource) {
    this._model = new Model3D(source);
    this._model.scale.set(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    this.root.addChild(this._model);

    this.body = findNamedNode(this._model, 'body') ?? this._model;
    this.body.quaternion.copyTo(this._bodyRest);
    this.body.position.y = BODY_REST_Y;
    this.wheels = [
      findNodeContaining(this._model, 'wheel', 'front', 'left'),
      findNodeContaining(this._model, 'wheel', 'front', 'right'),
      findNodeContaining(this._model, 'wheel', 'back', 'left'),
      findNodeContaining(this._model, 'wheel', 'back', 'right'),
    ];
  }

  /**
   * Pose the truck for this frame.
   * @param pose - Where it is and what it's doing.
   * @param dt - Seconds since the last frame, for the wheels.
   */
  public update(pose: Readonly<TruckPose>, dt: number): void {
    const root = this.root;

    root.position.set(pose.x, pose.y, pose.z);
    root.quaternion.setFromAxisAngle(_yAxis, pose.yaw);

    this.body.quaternion
      .copyFrom(this._bodyRest)
      .multiply(_qAxis.setFromAxisAngle(_xAxis, pose.pitch))
      .multiply(_qAxis.setFromAxisAngle(_zAxis, pose.roll));

    const reversing = Math.abs(angleDelta(pose.yaw, pose.heading)) > Math.PI / 2;

    this._spin += ((reversing ? -pose.speed : pose.speed) / WHEEL_RADIUS) * dt;
    this._steer += (-pose.steer * STEER_ANGLE - this._steer) * Math.min(1, dt * 10);

    const wheels = this.wheels;

    for (let i = 0; i < 4; i++) {
      const wheel = wheels[i];

      if (!wheel) continue;

      _qSteer.setFromAxisAngle(_yAxis, i < 2 ? this._steer : 0);
      _qSpin.setFromAxisAngle(_xAxis, this._spin);
      wheel.quaternion.copyFrom(_qSteer.multiply(_qSpin));
    }
  }

  public destroy(): void {
    this.root.destroy({ children: true });
  }
}
