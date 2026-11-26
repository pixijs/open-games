import { CubeGeometry, CylinderGeometry, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { BaseMaterial3D, Geometry3D } from "@pixi/3d"

import { inkMaterial } from "./shaders/ink.ts"
import type { InkOptions } from "./shaders/ink.ts"
import type { LookTextures } from "./textures.ts"

/** How far the ground outside a stage's walls sits below the floor. */
export const SUNKEN = 0.6

/** A wall's south run is a low kerb, so it never hides the player standing against it. */
export const KERB = 0.24

/**
 * The building blocks a stage's world is made of: unit boxes, columns and planes scaled into place, and ink
 * materials that share the concrete grain. Everything made here is released by `dispose`.
 */
export interface Parts {
  readonly cube: CubeGeometry
  readonly cylinder: CylinderGeometry
  /** An open tube: a band round a column with no caps. */
  readonly tube: CylinderGeometry
  /** A unit plane in XY with flipped V, for sprites and decals. */
  readonly plane: PlaneGeometry
  ink(options: Omit<InkOptions, "grain">): BaseMaterial3D
  /** Keeps a material or geometry made elsewhere, to release it with the rest. */
  keep<T extends BaseMaterial3D | Geometry3D>(owned: T): T
  /** A box from `bottom` to `top`, centred on (x, z), turned by `turn` about y. */
  box(x: number, z: number, halfWidth: number, halfDepth: number, bottom: number, top: number, material: BaseMaterial3D, turn?: number): Mesh3D
  column(x: number, z: number, radius: number, bottom: number, top: number, material: BaseMaterial3D, geometry?: Geometry3D): Mesh3D
  /** A plane lying flat at height `y`, `width` along x by `depth` along z. */
  flat(x: number, y: number, z: number, width: number, depth: number, material: BaseMaterial3D): Mesh3D
  dispose(): void
}

export const makeParts = (textures: LookTextures): Parts => {
  const cube = new CubeGeometry({ width: 1, height: 1, depth: 1 })
  const cylinder = new CylinderGeometry({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 56 })
  const tube = new CylinderGeometry({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 64, openEnded: true })
  const plane = new PlaneGeometry({ width: 1, height: 1, flipV: true })
  const owned: Array<BaseMaterial3D | Geometry3D> = []
  const keep = <T extends BaseMaterial3D | Geometry3D>(thing: T): T => {
    owned.push(thing)
    return thing
  }
  return {
    cube,
    cylinder,
    tube,
    plane,
    keep,
    ink: (options) => keep(inkMaterial({ grain: textures.concrete, ...options })),
    box: (x, z, halfWidth, halfDepth, bottom, top, material, turn = 0) =>
      new Mesh3D({
        geometry: cube,
        material,
        position: { x, y: (bottom + top) / 2, z },
        rotation: { x: 0, y: turn, z: 0 },
        scale: { x: halfWidth * 2, y: top - bottom, z: halfDepth * 2 }
      }),
    column: (x, z, radius, bottom, top, material, geometry = cylinder) =>
      new Mesh3D({ geometry, material, position: { x, y: (bottom + top) / 2, z }, scale: { x: radius, y: top - bottom, z: radius } }),
    flat: (x, y, z, width, depth, material) =>
      new Mesh3D({
        geometry: plane,
        material,
        rotation: { x: -Math.PI / 2, y: 0, z: 0 },
        position: { x, y, z },
        scale: { x: width, y: depth, z: 1 },
        castShadow: false,
        receiveShadow: false
      }),
    dispose: () => {
      cube.destroy()
      cylinder.destroy()
      tube.destroy()
      plane.destroy()
      for (const thing of owned) thing.destroy()
    }
  }
}
