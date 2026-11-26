import { Container3D, Mesh3D, PlaneGeometry } from "@pixi/3d"

import { spriteMaterial } from "../look/shaders/sprite.ts"
import { SUN } from "./staging.ts"
import type { TitleTextures } from "./textures.ts"

/**
 * Cloud shadows: where each stands as a loop starts, its size on the ground, and how fast the wind carries it east.
 * Placed so that while the wide shot looks down, one edge of shadow crosses the ring and another the courtyard's north.
 */
const CLOUDS = [
  { x: -15, z: -3, width: 24, depth: 11, speed: 0.9, texture: "cloud0" },
  { x: 11, z: 8.5, width: 18, depth: 8, speed: 0.7, texture: "cloud1" },
  { x: 14, z: -9, width: 22, depth: 10, speed: 1.1, texture: "cloud1" }
] as const

/** The span the cloud shadows wrap round in x. */
const CLOUD_SPAN = 64

export interface TitleSet {
  /** Puts the cloud shadows back where a loop starts them. */
  reset(): void
  /** Moves the cloud shadows on by `dt` seconds of wind. */
  update(dt: number): void
  show(on: boolean): void
  dispose(): void
}

/** What the title adds to the courtyard: the huge red sun low behind it and cloud shadows sliding over the floor. */
export const makeSet = (textures: TitleTextures, parent: Container3D): TitleSet => {
  const node = new Container3D({ label: "title-set" })
  parent.addChild(node)
  const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })
  const sunMaterial = spriteMaterial(textures.sun, 0xffffff, 1.05, "normal")

  node.addChild(new Mesh3D({ label: "title-sun", geometry: quad, material: sunMaterial, billboardMode: "spherical", position: { x: SUN.x, y: SUN.y, z: SUN.z }, scale: { x: SUN.size, y: SUN.size, z: 1 }, castShadow: false, receiveShadow: false }))
  const clouds = CLOUDS.map((cloud) => {
    const material = spriteMaterial(textures[cloud.texture], 0xffffff, 1, "normal")
    material.alpha = 0.5
    const mesh = new Mesh3D({ label: "title-cloud", geometry: quad, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: cloud.x, y: 0.035, z: cloud.z }, scale: { x: cloud.width, y: cloud.depth, z: 1 }, castShadow: false, receiveShadow: false })
    node.addChild(mesh)
    return { mesh, material, start: cloud.x, x: cloud.x, speed: cloud.speed }
  })

  return {
    reset: () => {
      for (const cloud of clouds) {
        cloud.x = cloud.start
        cloud.mesh.position.x = cloud.x
      }
    },
    update: (dt) => {
      for (const cloud of clouds) {
        cloud.x += cloud.speed * dt
        if (cloud.x > CLOUD_SPAN / 2) cloud.x -= CLOUD_SPAN
        cloud.mesh.position.x = cloud.x
      }
    },
    show: (on) => {
      node.visible = on
    },
    dispose: () => {
      node.destroy({ children: true })
      quad.destroy()
      sunMaterial.destroy()
      for (const cloud of clouds) cloud.material.destroy()
    }
  }
}
