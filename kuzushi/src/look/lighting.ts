import { Box, DirectionalLight } from "@pixi/3d"
import type { View3D } from "@pixi/3d"

import { PALETTE } from "../art/palette.ts"

/**
 * One hard sun, so every prop throws a shadow across the floor. The ink materials carry their own fill, so the view
 * needs no environment. Each stage's world aims it (`aimSun`); main.ts makes the view with the finest shadow map
 * ("ultra") for crisp edges.
 */
export const addLighting = (view: View3D): DirectionalLight => {
  view.environment = null
  view.shadowFilter = "pcf"
  const sun = new DirectionalLight({ color: PALETTE.paper, intensity: 3.1, castShadow: true, shadow: { bias: 0.0006, normalBias: 0.02 } })
  view.root.addChild(sun)
  return sun
}

/** Where a stage's sun stands and what its shadow map covers. */
export interface SunSetup {
  /** Ground direction the light comes from, in simulation radians (0 from +x, π/2 from +z). */
  readonly azimuth: number
  /** Height above the horizon, radians. */
  readonly elevation: number
  readonly intensity: number
  /** The world box the shadow map covers. */
  readonly bounds: Box
}

/** The Courtyard's sun: low from the upper left, so shadows fall long down-right across the floor. */
export const COURTYARD_SUN: SunSetup = {
  azimuth: Math.atan2(-9, -15),
  elevation: Math.atan2(10.5, Math.hypot(15, 9)),
  intensity: 3.1,
  bounds: Box.fromCenterSize({ x: 0, y: 6, z: -2 }, { x: 78, y: 20, z: 52 })
}

/** Stands the sun for `setup`, turned to `azimuth` when given (a sun that wheels round). */
export const aimSun = (sun: DirectionalLight, setup: SunSetup, azimuth = setup.azimuth): void => {
  const reach = 20
  const across = Math.cos(setup.elevation) * reach
  sun.position.set(Math.cos(azimuth) * across, Math.sin(setup.elevation) * reach, Math.sin(azimuth) * across)
  sun.lookAt({ x: 0, y: 0, z: 0 })
  sun.intensity = setup.intensity
  sun.shadow.bounds = setup.bounds
}
