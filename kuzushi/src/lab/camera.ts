import { BasicMultiChannelPerlinNoise, BlendCurves, hardLookAt, ImpulseListenerNoise, VirtualCamera } from "@pmndrs/klipp"
import type { CustomBlend } from "@pmndrs/klipp"
import { vec3 } from "math"
import type { Vec3 } from "math"

import type { CameraRig } from "../camera/index.ts"
import type { ArenaLayout } from "../sim/index.ts"
import type { Framing, Insets } from "./scene.ts"

export const cameraPresets = ["play", "top", "side", "orbit"] as const
export type CameraPreset = (typeof cameraPresets)[number]

const FOV = 40
const TAN = Math.tan((FOV * Math.PI) / 360)
const PRIORITY = 60
const BLEND = { curve: BlendCurves.easeInOut, time: 0.45 } as const
const UP: Vec3 = [0, 1, 0]
/** The play camera's angle down, for a close-up asked of the play camera. */
const PLAY_PITCH = Math.PI / 3

const _lab_aim: Vec3 = [0, 0, 0]
const _lab_forward: Vec3 = [0, 0, 0]
const _lab_right: Vec3 = [0, 0, 0]
const _lab_up: Vec3 = [0, 0, 0]

/** The ground circle the lab cameras fit for a room: its floor's box and wall, its depth filling the frame. */
export const roomFraming = (layout: ArenaLayout): Framing => ({
  x: 0,
  z: 0,
  radius: Math.max(layout.halfDepth + layout.wall + 1.5, (layout.halfWidth + layout.wall + 1) / 1.3)
})

export interface LabCamera {
  readonly preset: CameraPreset
  set(preset: CameraPreset): void
  /**
   * The ground circle to fit; `side` is the ground direction (simulation radians) the low side camera stands in. A
   * new size of circle also puts the free orbit back in front of it.
   */
  frame(framing: Framing): void
  /** Free orbit: turns by pixels dragged. */
  orbit(dx: number, dy: number): void
  /** Free orbit: moves in (below 1) or out (above 1). */
  zoom(factor: number): void
  /** Every frame: keeps the play camera's subject in the screen the panel and the timeline leave free. */
  update(): void
  dispose(): void
}

/**
 * The lab's own shots, one Klipp camera above every game shot while on: straight down, low from the side, or a free
 * orbit dragged with the mouse, each fitting the scene's ground circle and eased when the scene moves it, and shifted
 * so the action sits in the middle of the screen the panel leaves free. "play" turns it off and leaves the game's
 * cameras, the special's cut-in included, on screen, with the play camera's subject moved into that free area too,
 * unless the scene asks for a close-up, which the lab films from the play camera's angle.
 */
export const createLabCamera = (rig: CameraRig, screen: () => { readonly width: number; readonly height: number }, insets: () => Insets): LabCamera => {
  let preset: CameraPreset = "play"
  const goal = { x: 0, z: 0, radius: 8, side: Math.PI / 2, close: false }
  const shown = { ...goal }
  const orbit = { yaw: Math.PI / 2, pitch: 0.75, distance: 18 }
  /** Puts the free orbit in front of the framed circle, from its side, three-quarters down. */
  const face = () => {
    orbit.yaw = goal.side
    orbit.pitch = 0.75
    orbit.distance = Math.max(4, (goal.radius / TAN) * 1.1)
  }

  const camera = new VirtualCamera("lab", { priority: PRIORITY, active: false, initialState: { fov: FOV } })
  camera.body = {
    update: (out, dt, justActivated) => {
      const ease = justActivated ? 1 : 1 - Math.exp(-dt * 6)
      shown.x += (goal.x - shown.x) * ease
      shown.z += (goal.z - shown.z) * ease
      shown.radius += (goal.radius - shown.radius) * ease
      shown.side += (goal.side - shown.side) * ease
      const { width, height } = screen()
      const free = insets()
      const aspect = Math.max(0.5, (width - free.right) / Math.max(1, height - free.bottom))
      const [yaw, pitch, distance, lift] = preset === "top" ? [Math.PI / 2, 1.5699, (shown.radius * 1.04) / (TAN * Math.min(1, aspect)), 0]
        : preset === "side" ? [shown.side, 0.45, Math.max(4, (shown.radius * 1.2) / (TAN * aspect)), 0.4]
        : preset === "play" ? [Math.PI / 2, PLAY_PITCH, (shown.radius * 1.15) / (TAN * Math.min(1, aspect)), 0.2]
        : [orbit.yaw, orbit.pitch, orbit.distance, 0.4]
      const across = Math.cos(pitch) * distance
      vec3.set(_lab_aim, shown.x, lift, shown.z)
      vec3.set(out.position, shown.x + Math.cos(yaw) * across, lift + Math.sin(pitch) * distance, shown.z + Math.sin(yaw) * across)
      vec3.normalize(_lab_forward, vec3.subtract(_lab_forward, _lab_aim, out.position))
      vec3.normalize(_lab_right, vec3.cross(_lab_right, _lab_forward, UP))
      vec3.cross(_lab_up, _lab_right, _lab_forward)
      const perPixel = (2 * distance * TAN) / Math.max(1, height)
      vec3.scale(_lab_right, _lab_right, (free.right / 2) * perPixel)
      vec3.scaleAndAdd(_lab_right, _lab_right, _lab_up, (-free.bottom / 2) * perPixel)
      vec3.add(out.position, out.position, _lab_right)
      vec3.add(_lab_aim, _lab_aim, _lab_right)
      out.fov = FOV
      hardLookAt.update(out, _lab_aim)
    }
  }
  camera.addNoise(new ImpulseListenerNoise({
    field: rig.impulses,
    gain: 0.6,
    shake: new BasicMultiChannelPerlinNoise({ positionAmplitude: [0.05, 0.05, 0], positionFrequency: [22, 19, 1], rotationAmplitude: [0.8, 0.8, 1.4], rotationFrequency: [18, 16, 11] })
  }))
  const blends: ReadonlyArray<CustomBlend> = [{ to: "lab", blend: BLEND }, { from: "lab", blend: BLEND }]
  rig.klipp.customBlends.unshift(...blends)
  const removeCamera = rig.klipp.add(camera)
  const apply = () => {
    camera.active = preset !== "play" || goal.close
  }

  return {
    get preset() {
      return preset
    },
    set: (next) => {
      if (next === "orbit" && preset !== "orbit") face()
      preset = next
      apply()
    },
    frame: (framing) => {
      const resized = Math.abs(framing.radius - goal.radius) > goal.radius * 0.15
      goal.x = framing.x
      goal.z = framing.z
      goal.radius = framing.radius
      goal.side = framing.side ?? Math.PI / 2
      goal.close = framing.close ?? false
      apply()
      if (resized) face()
    },
    orbit: (dx, dy) => {
      orbit.yaw += dx * 0.008
      orbit.pitch = Math.max(0.12, Math.min(1.5, orbit.pitch + dy * 0.006))
    },
    zoom: (factor) => {
      orbit.distance = Math.max(3, Math.min(70, orbit.distance * factor))
    },
    update: () => {
      const { width, height } = screen()
      const free = insets()
      rig.inset(free.right / Math.max(1, width), free.bottom / Math.max(1, height))
    },
    dispose: () => {
      rig.inset(0, 0)
      removeCamera()
      for (const blend of blends) {
        const at = rig.klipp.customBlends.indexOf(blend)
        if (at >= 0) rig.klipp.customBlends.splice(at, 1)
      }
    }
  }
}
