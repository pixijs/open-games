import { cameraState, Klipp } from "@pmndrs/klipp"
import type { CameraState, KlippOptions } from "@pmndrs/klipp"
import type { Camera3D } from "@pixi/3d"

const readCamera = (camera: Camera3D): CameraState => {
  const state = cameraState.create()
  const { position, quaternion } = camera
  state.position[0] = position.x
  state.position[1] = position.y
  state.position[2] = position.z
  state.quaternion[0] = quaternion.x
  state.quaternion[1] = quaternion.y
  state.quaternion[2] = quaternion.z
  state.quaternion[3] = quaternion.w
  state.fov = camera.fov
  state.near = camera.near
  state.far = camera.far
  return state
}

/**
 * Klipp driving a Pixi 3D camera: Klipp picks and blends the shot, and `write` copies it onto the camera.
 * Both sides agree on conventions (cameras face -Z, Y up, field of view in degrees), so fields copy across as they are.
 */
export class KlippPixi extends Klipp {
  readonly camera: Camera3D

  constructor(camera: Camera3D, options: Omit<KlippOptions, "initialCameraState"> = {}) {
    super({ ...options, initialCameraState: readCamera(camera) })
    this.camera = camera
  }

  protected override write(shot: CameraState, transformChanged: boolean, lensChanged: boolean): void {
    if (transformChanged) {
      const [px, py, pz] = shot.position
      const [qx, qy, qz, qw] = shot.quaternion
      this.camera.position.set(px, py, pz)
      this.camera.quaternion.set(qx, qy, qz, qw)
    }
    if (lensChanged) {
      this.camera.fov = shot.fov
      this.camera.near = shot.near
      this.camera.far = shot.far
    }
  }
}
